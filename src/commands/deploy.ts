import path from "node:path";
import pc from "picocolors";
import { checkBackend, checkFrontend, type Finding } from "../core/checks.js";
import type { Context } from "../core/context.js";
import { detectApps, detectBackend, detectFrontend, pickObvious, VERCEL_FRAMEWORK_SLUG, type BackendApp, type FrontendApp } from "../core/detect.js";
import {
  BACKEND_FRONTEND_URL_KEY,
  findEnvExample,
  FRONTEND_BACKEND_URL_KEY,
  planEnv,
  readEnvFile,
  readLocalEnv,
} from "../core/envfile.js";
import { ShipOneError } from "../core/errors.js";
import { pushBranch, readGitInfo, repoSlug, type GitInfo } from "../core/git.js";
import { resolveProvider } from "../core/preferences.js";
import { readRepoConfig, REPO_CONFIG_FILE, writeRepoConfig, type RepoConfig } from "../core/repoConfig.js";
import type { RepoState } from "../core/store.js";
import {
  BACKEND_PROVIDERS,
  FRONTEND_PROVIDERS,
  PROVIDER_LABELS,
  type BackendProviderName,
  type FrontendProviderName,
} from "../core/types.js";
import { backendHost, frontendHost } from "../providers/index.js";
import type { BackendHost, BackendService, CommitRef, DeployStatus, EnvVar, FrontendHost, FrontendProject } from "../providers/types.js";
import { ensureConnected } from "./connect.js";

export interface DeployOptions {
  dryRun?: boolean;
  /** Deploy even if pre-flight checks found errors. */
  force?: boolean;
}

export interface DeployPlan {
  git: GitInfo;
  commit: CommitRef;
  slug: string;
  repoConfig: RepoConfig;
  /** True when .shipone.yml doesn't exist yet or changed. */
  writeConfig: boolean;
  frontend?: { app: FrontendApp; provider: FrontendProviderName; name: string };
  backend?: {
    app: BackendApp;
    provider: BackendProviderName;
    name: string;
    buildCommand: string;
    startCommand?: string;
    dockerfilePath?: string;
  };
  findings: Finding[];
}

export interface DeployResult {
  frontend?: { url?: string; status: DeployStatus };
  backend?: { url: string; status: DeployStatus };
}

const short = (sha: string) => sha.slice(0, 7);

/** Provider-safe name: lowercase letters, digits and single dashes. */
export function serviceName(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "app"
  );
}

// ---------------------------------------------------------------------------
// 1. Git: make sure what we deploy is actually on GitHub
// ---------------------------------------------------------------------------

async function resolveCommit(ctx: Context, git: GitInfo): Promise<CommitRef> {
  const { ui } = ctx;
  if (!git.upstream || !git.remoteBranch || !git.upstreamSha) {
    if (ui.interactive) {
      const doPush = await ui.confirm({
        message: `Branch "${git.branch}" hasn't been pushed to GitHub with tracking yet. Push to GitHub now?`,
        initial: true,
      });
      if (doPush) {
        const spin = ui.spinner();
        spin.start(`Pushing "${git.branch}" to GitHub`);
        try {
          await pushBranch(git.root, git.branch);
          spin.stop(`Pushed "${git.branch}" to GitHub.`);
          git = await readGitInfo(git.root);
        } catch (err) {
          spin.fail("Failed to push to GitHub.");
          throw new ShipOneError(`Could not push to GitHub: ${(err as Error).message}`, "Push manually with `git push -u origin <branch>`.");
        }
      } else {
        throw new ShipOneError(
          `Branch "${git.branch}" isn't on GitHub yet, so the hosting provider can't build it.`,
          `Push it first: git push -u origin ${git.branch}`,
        );
      }
    } else {
      throw new ShipOneError(
        `Branch "${git.branch}" isn't on GitHub yet, so the hosting provider can't build it.`,
        `Push it first: git push -u origin ${git.branch}`,
      );
    }
  }
  let sha = git.headSha;
  if (git.ahead > 0) {
    ui.warn(`${git.ahead} local commit${git.ahead === 1 ? "" : "s"} ${git.ahead === 1 ? "isn't" : "aren't"} on GitHub yet.`);
    const useRemote =
      ui.interactive &&
      (await ui.confirm({
        message: `Deploy what's on GitHub (${short(git.upstreamSha!)}) without them? Choose "No" to push first.`,
        initial: false,
      }));
    if (!useRemote) {
      if (ui.interactive) {
        const doPush = await ui.confirm({
          message: "Push your local commits to GitHub now and deploy latest?",
          initial: true,
        });
        if (doPush) {
          const spin = ui.spinner();
          spin.start("Pushing commits to GitHub");
          try {
            await pushBranch(git.root, git.branch);
            spin.stop("Pushed latest commits to GitHub.");
            git = await readGitInfo(git.root);
            sha = git.headSha;
          } catch (err) {
            spin.fail("Failed to push to GitHub.");
            throw new ShipOneError(`Could not push: ${(err as Error).message}`, "Push manually: git push");
          }
        } else {
          throw new ShipOneError("Push your commits first so the deploy includes them.", "git push && shipone deploy");
        }
      } else {
        throw new ShipOneError("Push your commits first so the deploy includes them.", "git push && shipone deploy");
      }
    } else {
      sha = git.upstreamSha!;
    }
  } else if (git.headSha !== git.upstreamSha) {
    // Behind or diverged: HEAD isn't on GitHub.
    sha = git.upstreamSha!;
    ui.warn(`Your local branch differs from ${git.upstream}; deploying ${short(sha)} from GitHub.`);
  }
  if (git.dirty) ui.warn("You have uncommitted changes. They won't be part of this deploy.");
  return { owner: git.owner, repo: git.repo, branch: git.remoteBranch!, sha };
}

// ---------------------------------------------------------------------------
// 2. Plan: which folders, which providers, which names
// ---------------------------------------------------------------------------

async function chooseApp<T extends { path: string }>(ctx: Context, role: "frontend" | "backend", apps: T[]): Promise<T | undefined> {
  if (apps.length === 0) return undefined;
  const obvious = pickObvious(role, apps);
  if (obvious) return obvious;
  return ctx.ui
    .select({
      message: `Found several ${role} apps. Which one should ShipOne deploy?`,
      choices: apps.map((a) => ({ value: a.path, label: a.path === "." ? "(repo root)" : a.path })),
    })
    .then((p) => apps.find((a) => a.path === p));
}

/** Which provider hosts `role`: explicit config wins; otherwise the account
 *  default preselects, one connected provider is used directly, and several
 *  connected providers are asked about (the answer sticks via .shipone.yml). */
async function chooseProviderGeneric<R extends "frontend" | "backend">(
  ctx: Context,
  role: R,
  repoConfig: RepoConfig,
  slug: string,
): Promise<FrontendProviderName | BackendProviderName> {
  const account = ctx.store.readConfig();
  const resolved = resolveProvider(role, repoConfig, account.repos[slug], account);
  // .shipone.yml and per-repo overrides are explicit choices: use them as-is.
  if (resolved && resolved.source !== "account-default") return resolved.provider;
  // The account default only preselects the question below (older versions
  // pinned it on connect, but it mustn't silence the question forever).
  const defaultProvider = resolved?.provider;
  const options = role === "frontend" ? ([...FRONTEND_PROVIDERS] as (FrontendProviderName | BackendProviderName)[]) : [...BACKEND_PROVIDERS];
  const connected = options.filter((p) => ctx.store.getToken(p));

  if (connected.length === 1 && (!defaultProvider || defaultProvider === connected[0])) {
    const only = connected[0]!;
    if (ctx.ui.interactive) {
      ctx.ui.info(`Using ${PROVIDER_LABELS[only]} for the ${role} — it's the only ${role} provider connected.`);
    }
    return only;
  }
  // Several (or no) providers connected: ask, preselecting the account default
  // when it's a valid choice. Non-interactive mode takes the preselect as-is.
  const offered = defaultProvider && !connected.includes(defaultProvider) ? options : connected.length ? connected : options;
  const initial = defaultProvider && offered.includes(defaultProvider) ? defaultProvider : offered[0]!;
  return await ctx.ui.select({
    message: `Where should the ${role} be deployed?`,
    choices: offered.map((p) => ({
      value: p,
      label: PROVIDER_LABELS[p],
      hint: ctx.store.getToken(p) ? "connected" : "not connected yet",
    })),
    initial,
  });
}

async function chooseProvider(
  ctx: Context,
  role: "frontend",
  repoConfig: RepoConfig,
  slug: string,
): Promise<FrontendProviderName>;
async function chooseProvider(
  ctx: Context,
  role: "backend",
  repoConfig: RepoConfig,
  slug: string,
): Promise<BackendProviderName>;
async function chooseProvider(
  ctx: Context,
  role: "frontend" | "backend",
  repoConfig: RepoConfig,
  slug: string,
): Promise<FrontendProviderName | BackendProviderName> {
  return chooseProviderGeneric(ctx, role, repoConfig, slug);
}

export async function buildPlan(ctx: Context, git: GitInfo, commit: CommitRef): Promise<DeployPlan> {
  const slug = repoSlug(git);
  const existing = readRepoConfig(git.root);
  const repoConfig: RepoConfig = structuredClone(existing ?? {});

  // Which folders? .shipone.yml wins; otherwise detect.
  let frontendApp: FrontendApp | undefined;
  let backendApp: BackendApp | undefined;
  if (repoConfig.frontend || repoConfig.backend) {
    if (repoConfig.frontend) {
      frontendApp = detectFrontend(git.root, repoConfig.frontend.path);
      if (!frontendApp) {
        throw new ShipOneError(
          `${REPO_CONFIG_FILE} says the frontend is in "${repoConfig.frontend.path}", but no frontend app was found there. Supported: Vite, Next.js, CRA, Vue CLI, Angular, SvelteKit, Astro, Nuxt, Gatsby, Remix, React Router, SolidStart.`,
        );
      }
    }
    if (repoConfig.backend) {
      backendApp = detectBackend(git.root, repoConfig.backend.path);
      if (!backendApp) {
        throw new ShipOneError(
          `${REPO_CONFIG_FILE} says the backend is in "${repoConfig.backend.path}", but no backend was found there. Supported: Node (Express, Fastify, Koa, Hapi, NestJS, Hono), Python (FastAPI, Flask, Django), Go, Rust, Ruby and Docker.`,
        );
      }
    }
  } else {
    const found = detectApps(git.root);
    frontendApp = await chooseApp(ctx, "frontend", found.frontends);
    backendApp = await chooseApp(ctx, "backend", found.backends);
  }
  if (!frontendApp && !backendApp) {
    throw new ShipOneError(
      "Couldn't find a frontend (Vite, Next.js, CRA, Vue CLI, Angular, SvelteKit, Astro, Nuxt, Gatsby, Remix, React Router, SolidStart) or backend (Node, Python, Go, Rust, Ruby, Docker) in this repo.",
      `If your app lives somewhere unusual, create ${REPO_CONFIG_FILE} with frontend.path / backend.path.`,
    );
  }

  if (repoConfig.frontend?.apiUrlEnv && frontendApp) {
    frontendApp = { ...frontendApp, apiUrlEnv: repoConfig.frontend.apiUrlEnv, apiUrlEnvFromCode: true };
  }

  const base = repoConfig.name ?? serviceName(git.repo);
  const plan: DeployPlan = { git, commit, slug, repoConfig, writeConfig: false, findings: [] };

  if (frontendApp) {
    const provider = await chooseProvider(ctx, "frontend", repoConfig, slug);
    plan.frontend = { app: frontendApp, provider, name: base };
    repoConfig.frontend = { ...repoConfig.frontend, path: frontendApp.path, provider };
    plan.findings.push(...checkFrontend(git.root, frontendApp, Boolean(backendApp)));
  }
  if (backendApp) {
    const provider = await chooseProvider(ctx, "backend", repoConfig, slug);
    plan.backend = {
      app: backendApp,
      provider,
      name: frontendApp ? `${base}-api` : base,
      buildCommand: repoConfig.backend?.buildCommand ?? backendApp.buildCommand,
      startCommand: repoConfig.backend?.startCommand ?? backendApp.startCommand,
      dockerfilePath: backendApp.dockerfilePath,
    };
    repoConfig.backend = { ...repoConfig.backend, path: backendApp.path, provider };
    const withStart = { ...backendApp, startCommand: plan.backend.startCommand };
    plan.findings.push(...checkBackend(git.root, withStart));
  }
  repoConfig.deploy ??= true;
  plan.writeConfig = JSON.stringify(existing ?? null) !== JSON.stringify(repoConfig);
  return plan;
}

function describePlan(plan: DeployPlan): string {
  const lines: string[] = [];
  const at = (p: string) => (p === "." ? "(repo root)" : `./${p}`);
  if (plan.frontend) {
    const f = plan.frontend;
    lines.push(`${pc.bold("Frontend")}  ${at(f.app.path)} (${f.app.framework}) → ${PROVIDER_LABELS[f.provider]} project "${f.name}"`);
    if (plan.backend) lines.push(`           backend URL goes in ${pc.cyan(f.app.apiUrlEnv)}`);
  }
  if (plan.backend) {
    const b = plan.backend;
    lines.push(`${pc.bold("Backend")}   ${at(b.app.path)} (${b.app.framework}) → ${PROVIDER_LABELS[b.provider]} service "${b.name}"`);
    if (b.app.runtime === "docker") lines.push(`           dockerfile: ${b.dockerfilePath ?? "./Dockerfile"} (image CMD starts the service)`);
    else {
      lines.push(`           build: ${b.buildCommand}`);
      lines.push(`           start: ${b.startCommand ?? pc.red("(unknown)")}`);
    }
    if (plan.frontend) lines.push(`           frontend URL goes in ${pc.cyan("CORS_ORIGIN")} and ${pc.cyan("FRONTEND_URL")}`);
  }
  lines.push(`${pc.bold("Commit")}    ${plan.commit.owner}/${plan.commit.repo}@${plan.commit.branch} ${short(plan.commit.sha)}`);
  return lines.join("\n");
}

function reportFindings(ctx: Context, findings: Finding[]) {
  for (const f of findings) {
    const where = f.location ? `${pc.dim(f.location)} ` : "";
    const msg = `${pc.dim(`[${f.role}]`)} ${where}${f.message}${f.fix ? `\n${pc.dim("fix:")} ${f.fix}` : ""}`;
    if (f.level === "error") ctx.ui.error(msg);
    else ctx.ui.warn(msg);
  }
}

// ---------------------------------------------------------------------------
// 3. Env vars from .env.example
// ---------------------------------------------------------------------------

async function collectEnv(ctx: Context, role: "frontend" | "backend", root: string, appPath: string, alreadySet: Set<string>): Promise<EnvVar[]> {
  const dir = path.join(root, appPath);
  const exampleFile = findEnvExample(dir);
  if (!exampleFile) return [];
  const example = readEnvFile(exampleFile) ?? new Map<string, string>();
  const plans = planEnv(role, example, readLocalEnv(dir), ctx.env).filter((p) => p.kind !== "managed" && !alreadySet.has(p.key));
  if (plans.length === 0) return [];

  const rel = path.relative(root, dir) || ".";
  const fromLocal = plans.filter((p) => p.kind === "local");
  let useLocal = true;
  if (fromLocal.length && ctx.ui.interactive) {
    useLocal = await ctx.ui.confirm({
      message: `Use the values from your local ${rel}/.env for ${fromLocal.map((p) => p.key).join(", ")}?`,
      initial: true,
    });
  }

  const out: EnvVar[] = [];
  const missing: string[] = [];
  for (const p of plans) {
    if (p.kind === "default" || p.kind === "provided") out.push({ key: p.key, value: p.value });
    else if (p.kind === "local" && useLocal) out.push({ key: p.key, value: p.value });
    else if (p.kind === "local" || p.kind === "ask") {
      if (!ctx.ui.interactive) {
        missing.push(p.key);
        continue;
      }
      const why = p.kind === "ask" ? ` ${pc.dim(`(${p.reason})`)}` : "";
      const message = `${role} ${pc.cyan(p.key)}${why}. Leave empty to skip.`;
      const value = p.secret ? await ctx.ui.password({ message }) : await ctx.ui.text({ message, defaultValue: "" });
      if (value.trim()) out.push({ key: p.key, value: value.trim() });
      else ctx.ui.warn(`Skipped ${p.key}. Set it later with \`shipone env set ${p.key}=...\`.`);
    }
  }
  if (missing.length) {
    throw new ShipOneError(
      `No production value for ${missing.join(", ")} (listed in ${rel}/${path.basename(exampleFile)}).`,
      `Run \`shipone deploy\` interactively, or pass values as ${missing.map((k) => `SHIPONE_ENV_${k}=...`).join(" ")}.`,
    );
  }
  return out;
}

/** Keys in .env.example (besides the standard ones) that should also get the other side's URL. */
function urlKeysFromExample(root: string, appPath: string, re: RegExp): string[] {
  const file = findEnvExample(path.join(root, appPath));
  if (!file) return [];
  return [...(readEnvFile(file) ?? new Map<string, string>()).keys()].filter((k) => re.test(k));
}

// ---------------------------------------------------------------------------
// 4. Provisioning: find-or-create, idempotently
// ---------------------------------------------------------------------------

/**
 * Look up (never create) the frontend project: by saved id, then by name.
 * `needsSetup` is true when ShipOne hasn't configured it yet (new or adopted).
 */
async function findProject(
  ctx: Context,
  host: FrontendHost,
  plan: NonNullable<DeployPlan["frontend"]>,
  git: GitInfo,
  saved: RepoState["frontend"],
): Promise<{ project?: FrontendProject; name: string; needsSetup: boolean }> {
  const slug = repoSlug(git).toLowerCase();
  if (saved?.provider === host.name) {
    const p = await host.findProject(saved.projectId);
    if (p) return { project: p, name: p.name, needsSetup: false };
    ctx.ui.warn(`The ${host.label} project "${saved.projectName}" no longer exists; creating a new one.`);
  }
  for (const name of [plan.name, serviceName(`${plan.name}-${git.owner}`)]) {
    const existing = await host.findProject(name);
    if (existing && existing.repo?.toLowerCase() === slug) return { project: existing, name, needsSetup: true };
    if (!existing) return { name, needsSetup: true };
    // Otherwise the name is taken by an unrelated project: try the next one.
  }
  throw new ShipOneError(
    `The ${host.label} project name "${plan.name}" is already used by another project.`,
    `Pick another base name with \`name: my-app\` in ${REPO_CONFIG_FILE}.`,
  );
}

async function findService(
  ctx: Context,
  host: BackendHost,
  plan: NonNullable<DeployPlan["backend"]>,
  git: GitInfo,
  saved: RepoState["backend"],
): Promise<{ service?: BackendService; name: string }> {
  const slug = repoSlug(git).toLowerCase();
  if (saved?.provider === host.name) {
    const s = await host.getService(saved.serviceId);
    if (s) return { service: s, name: s.name };
    ctx.ui.warn(`The ${host.label} service "${saved.serviceName}" no longer exists; creating a new one.`);
  }
  for (const name of [plan.name, serviceName(`${plan.name}-${git.owner}`)]) {
    const existing = await host.findService(name);
    if (existing && existing.repo === slug) return { service: existing, name };
    if (!existing) return { name };
  }
  throw new ShipOneError(
    `The ${host.label} service name "${plan.name}" is already used by another service.`,
    `Pick another base name with \`name: my-app\` in ${REPO_CONFIG_FILE}.`,
  );
}

// ---------------------------------------------------------------------------
// 5. Waiting on builds
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(ctx: Context, label: string, get: () => Promise<DeployStatus>): Promise<DeployStatus> {
  const spin = ctx.ui.spinner();
  const started = Date.now();
  spin.start(`${label}: starting`);
  for (;;) {
    const s = await get();
    const secs = Math.round((Date.now() - started) / 1000);
    if (s.state === "ready") {
      spin.stop(`${label}: live ${pc.dim(`(${secs}s)`)}`);
      return s;
    }
    if (s.state === "failed" || s.state === "canceled") {
      spin.fail(`${label}: ${s.rawState}${s.error ? ` (${s.error})` : ""}`);
      return s;
    }
    if (Date.now() - started > ctx.deployTimeoutMs) {
      spin.fail(`${label}: still ${s.rawState} after ${secs}s`);
      throw new ShipOneError(`Timed out waiting for ${label}.`, "It may still finish; check with `shipone status`.");
    }
    spin.message(`${label}: ${s.rawState.toLowerCase().replace(/_/g, " ")} ${pc.dim(`(${secs}s)`)}`);
    await sleep(ctx.pollIntervalMs);
  }
}

async function showFailureLogs(ctx: Context, title: string, fetchLogs: () => Promise<string[]>) {
  try {
    const lines = await fetchLogs();
    if (lines.length) ctx.ui.note(lines.slice(-40).join("\n"), title);
  } catch {
    // Logs are best-effort; the failure itself was already reported.
  }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export async function deploy(ctx: Context, opts: DeployOptions = {}): Promise<DeployResult | undefined> {
  const { ui, store } = ctx;
  ui.intro("shipone deploy");

  const git = await readGitInfo(ctx.cwd);
  const existingConfig = readRepoConfig(git.root);
  if (existingConfig?.deploy === false) {
    ui.outro(`${REPO_CONFIG_FILE} has \`deploy: false\`, so there's nothing to do.`);
    return undefined;
  }

  const commit = await resolveCommit(ctx, git);
  const plan = await buildPlan(ctx, git, commit);
  ui.note(describePlan(plan), opts.dryRun ? "Deploy plan (dry run)" : "Deploy plan");
  reportFindings(ctx, plan.findings);

  if (plan.findings.some((f) => f.level === "error") && !opts.force) {
    throw new ShipOneError("Fix the problems above first.", "Or re-run with --force to deploy anyway.");
  }
  if (opts.dryRun) {
    ui.outro(`Dry run: nothing was created or deployed.${plan.writeConfig ? ` (${REPO_CONFIG_FILE} would be written.)` : ""}`);
    return undefined;
  }

  const saved = store.getRepoState(plan.slug);
  const firstRun = !saved.frontend && !saved.backend;
  if (firstRun && ui.interactive) {
    const ok = await ui.confirm({ message: "Create these services and deploy?", initial: true });
    if (!ok) throw new ShipOneError("Nothing was deployed.");
  }

  if (plan.frontend) await ensureConnected(ctx, plan.frontend.provider);
  if (plan.backend) await ensureConnected(ctx, plan.backend.provider);

  if (plan.writeConfig) {
    writeRepoConfig(git.root, plan.repoConfig);
    ui.info(`Saved ${REPO_CONFIG_FILE}. Commit it so these settings stick.`);
  }

  const spin = ui.spinner();
  const result: DeployResult = {};
  const feHost = plan.frontend ? frontendHost(ctx, plan.frontend.provider) : undefined;
  const beHost = plan.backend ? backendHost(ctx, plan.backend.provider) : undefined;

  // --- Look up what already exists. Nothing is created until every question is answered. ---
  const feFound = feHost && plan.frontend ? await findProject(ctx, feHost, plan.frontend, git, saved.frontend) : undefined;
  const beFound = beHost && plan.backend ? await findService(ctx, beHost, plan.backend, git, saved.backend) : undefined;

  const beSecrets =
    beHost && beFound && plan.backend
      ? await collectEnv(ctx, "backend", git.root, plan.backend.app.path, beFound.service ? await beHost.listEnvKeys(beFound.service.id) : new Set())
      : [];
  const feVars =
    feHost && feFound && plan.frontend
      ? await collectEnv(ctx, "frontend", git.root, plan.frontend.app.path, feFound.project ? await feHost.listEnvKeys(feFound.project.id) : new Set())
      : [];

  let switchBranch = false;
  const tracked = beFound?.service?.branch;
  if (beHost && tracked && tracked !== commit.branch) {
    switchBranch = await ui.confirm({
      message: `The ${beHost.label} service deploys branch "${tracked}". Switch it to "${commit.branch}"?`,
      initial: true,
    });
    if (!switchBranch) throw new ShipOneError("Nothing was deployed.", `Check out "${tracked}" and run shipone deploy again.`);
  }
  if (plan.backend && !beFound?.service && !plan.backend.startCommand && plan.backend.app.runtime !== "docker") {
    throw new ShipOneError("Can't create the backend without a start command.");
  }

  // --- Frontend project first: its production domain is usually known right away ---
  let fe: { host: FrontendHost; project: FrontendProject; url?: string } | undefined;
  if (feHost && feFound && plan.frontend) {
    spin.start(feFound.project ? `Using ${feHost.label} project "${feFound.name}"` : `Creating ${feHost.label} project "${feFound.name}"`);
    const project =
      feFound.project ??
      (await feHost.createProject({ name: feFound.name, repo: git, rootDirectory: plan.frontend.app.path, framework: VERCEL_FRAMEWORK_SLUG[plan.frontend.app.framework] }));
    const gitDeploysOff = !feFound.needsSetup || (await feHost.disableGitDeployments(project.id));
    spin.stop(`${feHost.label} project "${project.name}" ready`);
    if (!gitDeploysOff) {
      ui.warn(
        `Couldn't turn off ${feHost.label}'s deploy-on-push, so pushes may deploy automatically.\n` +
          (feHost.name === "vercel"
            ? `To stop that, add {"git": {"deploymentEnabled": false}} to ${plan.frontend.app.path}/vercel.json.`
            : `To stop that, turn off deploy-on-push in the ${feHost.label} dashboard (${feHost.dashboardUrl(project)}).`),
      );
    }
    const url = (await feHost.productionUrl(project.id)) ?? saved.frontend?.url;
    store.updateRepoState(plan.slug, (s) => {
      s.frontend = { provider: feHost.name, projectId: project.id, projectName: project.name, url };
    });
    fe = { host: feHost, project, url };
  }

  // --- Backend service: its URL is known as soon as it's created ---
  let be: { host: BackendHost; service: BackendService; deployId?: string; frontendUrlSet?: string } | undefined;
  if (beHost && beFound && plan.backend) {
    const urlKeys = new Set(["CORS_ORIGIN", "FRONTEND_URL", ...urlKeysFromExample(git.root, plan.backend.app.path, BACKEND_FRONTEND_URL_KEY)]);
    const managed = fe?.url ? [...urlKeys].map((key) => ({ key, value: fe!.url! })) : [];

    if (!beFound.service) {
      spin.start(`Creating ${beHost.label} service "${beFound.name}"`);
      const created = await beHost.createService({
        name: beFound.name,
        repo: git,
        branch: commit.branch,
        rootDir: plan.backend.app.path,
        runtime: plan.backend.app.runtime,
        buildCommand: plan.backend.buildCommand,
        startCommand: plan.backend.startCommand!,
        dockerfilePath: plan.backend.dockerfilePath,
        env: [...beSecrets, ...managed],
      });
      spin.stop(`Created ${beHost.label} service ${pc.cyan(created.url)}`);
      be = { host: beHost, service: created, deployId: created.initialDeployId, frontendUrlSet: fe?.url };
    } else {
      const svc = beFound.service;
      const adopted = !saved.backend || saved.backend.serviceId !== svc.id;
      // Sync drifted build/start commands (e.g. a fixed generator or a .shipone.yml change).
      const commandsDrifted = svc.buildCommand !== plan.backend.buildCommand || svc.startCommand !== plan.backend.startCommand;
      if (switchBranch || adopted || commandsDrifted) {
        if (commandsDrifted) ui.info(`Updating build/start commands on ${beHost.label} to match the current plan.`);
        await beHost.configure(svc.id, {
          branch: switchBranch ? commit.branch : undefined,
          disableAutoDeploy: adopted,
          buildCommand: commandsDrifted ? plan.backend.buildCommand : undefined,
          startCommand: commandsDrifted ? plan.backend.startCommand : undefined,
          dockerfilePath: commandsDrifted && plan.backend.app.runtime === "docker" ? plan.backend.dockerfilePath : undefined,
        });
      }
      const updates = [...beSecrets, ...managed];
      if (updates.length) {
        spin.start(`Updating ${beHost.label} env vars`);
        await beHost.setEnv(svc.id, updates);
        spin.stop(`Updated ${updates.length} ${beHost.label} env var${updates.length === 1 ? "" : "s"}`);
      }
      be = { host: beHost, service: svc, frontendUrlSet: fe?.url };
    }
    store.updateRepoState(plan.slug, (s) => {
      s.backend = { provider: beHost.name, serviceId: be!.service.id, serviceName: be!.service.name, url: be!.service.url };
    });
  }

  // --- Frontend env: backend URL + anything from .env.example ---
  if (fe && plan.frontend) {
    const vars = [...feVars];
    if (be) {
      const keys = new Set([plan.frontend.app.apiUrlEnv, ...urlKeysFromExample(git.root, plan.frontend.app.path, FRONTEND_BACKEND_URL_KEY)]);
      for (const key of keys) vars.push({ key, value: be.service.url });
    }
    if (vars.length) {
      spin.start(`Setting ${fe.host.label} env vars`);
      await fe.host.setEnv(fe.project.id, vars);
      spin.stop(`Set ${vars.map((v) => v.key).join(", ")} on ${fe.host.label}`);
    }
  }

  // --- Deploy: kick off the backend now when we already know the frontend URL ---
  if (be && !be.deployId && (!fe || be.frontendUrlSet)) {
    be.deployId = (await be.host.deploy(be.service.id, commit)).id;
  }

  let failed = false;
  if (fe) {
    const started = await fe.host.deploy(fe.project, commit);
    const status = await waitFor(ctx, `Frontend on ${fe.host.label}`, () => fe!.host.getDeploy(fe!.project.id, started.id));
    result.frontend = { url: status.url ?? fe.url, status };
    if (status.state !== "ready") {
      failed = true;
      await showFailureLogs(ctx, "Frontend build log (last lines)", () => fe!.host.logs(started.id, 100));
    } else if (status.url) {
      fe.url = status.url;
      store.updateRepoState(plan.slug, (s) => {
        if (s.frontend) s.frontend.url = status.url;
      });
    }
  }

  if (be) {
    // The frontend's real URL wasn't known (or changed): wire it into CORS and (re)deploy.
    if (fe?.url && fe.url !== be.frontendUrlSet) {
      const urlKeys = new Set(["CORS_ORIGIN", "FRONTEND_URL", ...urlKeysFromExample(git.root, plan.backend!.app.path, BACKEND_FRONTEND_URL_KEY)]);
      await be.host.setEnv(
        be.service.id,
        [...urlKeys].map((key) => ({ key, value: fe!.url! })),
      );
      ui.info(`Set CORS_ORIGIN/FRONTEND_URL on ${be.host.label} to ${fe.url}`);
      be.deployId = (await be.host.deploy(be.service.id, commit)).id;
    } else if (!be.deployId) {
      be.deployId = (await be.host.deploy(be.service.id, commit)).id;
    }
    const deployId = be.deployId;
    const status = await waitFor(ctx, `Backend on ${be.host.label}`, () => be!.host.getDeploy(be!.service.id, deployId));
    result.backend = { url: be.service.url, status };
    if (status.state !== "ready") {
      failed = true;
      await showFailureLogs(ctx, "Backend logs (last lines)", () => be!.host.logs(be!.service.id, 100));
    }
  }

  store.updateRepoState(plan.slug, (s) => {
    if (!failed) s.lastDeploy = { sha: commit.sha, at: new Date().toISOString() };
  });

  const summary: string[] = [];
  if (result.frontend) summary.push(`${pc.bold("Frontend")}  ${result.frontend.url ?? "(no URL yet)"}  ${stateBadge(result.frontend.status)}`);
  if (result.backend) summary.push(`${pc.bold("Backend")}   ${result.backend.url}  ${stateBadge(result.backend.status)}`);
  ui.note(summary.join("\n"), `Deployed ${short(commit.sha)}`);

  if (failed) {
    throw new ShipOneError("The deploy didn't finish cleanly.", "See the log lines above, fix, push, and run `shipone deploy` again. More: `shipone logs`.");
  }
  if (be?.host.name === "render" && (store.readConfig().render?.plan ?? "free") === "free") {
    ui.info(pc.dim("Render free services sleep after ~15 min idle; the first request after that can take up to a minute."));
  }
  ui.outro(pc.green("Your app is live."));
  return result;
}

export function stateBadge(s: DeployStatus): string {
  switch (s.state) {
    case "ready":
      return pc.green("● live");
    case "failed":
      return pc.red(`● ${s.rawState}`);
    case "canceled":
      return pc.yellow(`● ${s.rawState}`);
    default:
      return pc.yellow(`● ${s.rawState}`);
  }
}
