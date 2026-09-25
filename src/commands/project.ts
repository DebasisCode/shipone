import pc from "picocolors";
import type { Context } from "../core/context.js";
import { ShipOneError } from "../core/errors.js";
import { readGitInfo, repoSlug, type GitInfo } from "../core/git.js";
import type { RepoState } from "../core/store.js";
import { backendHost, frontendHost } from "../providers/index.js";
import { stateBadge } from "./deploy.js";

/** Commands that act on the services ShipOne already created for this repo. */

async function loadRepo(ctx: Context): Promise<{ git: GitInfo; state: RepoState }> {
  const git = await readGitInfo(ctx.cwd);
  const state = ctx.store.getRepoState(repoSlug(git));
  if (!state.frontend && !state.backend) {
    throw new ShipOneError(`ShipOne hasn't deployed ${repoSlug(git)} from this machine yet.`, "Run `shipone deploy` first.");
  }
  return { git, state };
}

const short = (sha?: string) => (sha ? sha.slice(0, 7) : "?");

export async function status(ctx: Context) {
  const { git, state } = await loadRepo(ctx);
  const lines: string[] = [];
  let deployedSha: string | undefined;

  if (state.frontend) {
    const host = frontendHost(ctx, state.frontend.provider);
    const d = await host.latestDeploy(state.frontend.projectId);
    const url = (await host.productionUrl(state.frontend.projectId)) ?? state.frontend.url ?? "(no URL yet)";
    lines.push(`${pc.bold("Frontend")}  ${url}  ${d ? `${stateBadge(d)} ${pc.dim(short(d.sha))}` : pc.dim("never deployed")}`);
    lines.push(pc.dim(`           ${host.label} project ${state.frontend.projectName}`));
    deployedSha ??= d?.sha;
  }
  if (state.backend) {
    const host = backendHost(ctx, state.backend.provider);
    const d = await host.latestDeploy(state.backend.serviceId);
    lines.push(`${pc.bold("Backend")}   ${state.backend.url}  ${d ? `${stateBadge(d)} ${pc.dim(short(d.sha))}` : pc.dim("never deployed")}`);
    lines.push(pc.dim(`           ${host.label} service ${state.backend.serviceName}`));
    deployedSha ??= d?.sha;
  }
  ctx.ui.note(lines.join("\n"), repoSlug(git));

  const target = git.upstreamSha ?? git.headSha;
  if (deployedSha && target && !target.startsWith(deployedSha) && !deployedSha.startsWith(target)) {
    ctx.ui.info(`GitHub has newer code (${short(target)}) than what's deployed. Run \`shipone deploy\` to ship it.`);
  }
}

export async function logs(ctx: Context, target: string | undefined, opts: { lines?: number }) {
  const { state } = await loadRepo(ctx);
  const which = target ?? (state.backend ? "backend" : "frontend");
  const limit = Math.min(Math.max(opts.lines ?? 100, 1), 1000);

  if (which === "backend") {
    if (!state.backend) throw new ShipOneError("This repo has no backend deployed.");
    const host = backendHost(ctx, state.backend.provider);
    print(await host.logs(state.backend.serviceId, limit));
  } else if (which === "frontend") {
    if (!state.frontend) throw new ShipOneError("This repo has no frontend deployed.");
    const host = frontendHost(ctx, state.frontend.provider);
    const d = await host.latestDeploy(state.frontend.projectId);
    if (!d) throw new ShipOneError("The frontend hasn't been deployed yet.");
    print(await host.logs(d.id, limit));
  } else {
    throw new ShipOneError(`Unknown target "${which}".`, "Use `shipone logs backend` or `shipone logs frontend`.");
  }

  function print(lines: string[]) {
    if (lines.length === 0) ctx.ui.info("No log lines yet.");
    for (const l of lines) console.log(l);
  }
}

const FRONTEND_PREFIX = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|NG_APP_|PUBLIC_|NUXT_PUBLIC_|GATSBY_|REMIX_PUBLIC_)/;

function pickTarget(state: RepoState, key: string, opts: { frontend?: boolean; backend?: boolean }): "frontend" | "backend" {
  if (opts.frontend && opts.backend) throw new ShipOneError("Pass only one of --frontend / --backend.");
  const t = opts.frontend ? "frontend" : opts.backend ? "backend" : FRONTEND_PREFIX.test(key) ? "frontend" : "backend";
  if (!state[t]) {
    throw new ShipOneError(`This repo has no ${t} deployed.`, t === "backend" ? "Use --frontend to target the frontend." : undefined);
  }
  return t;
}

export async function envSet(ctx: Context, pairs: string[], opts: { frontend?: boolean; backend?: boolean }) {
  const { state } = await loadRepo(ctx);
  const parsed = pairs.map((p) => {
    const i = p.indexOf("=");
    const key = i > 0 ? p.slice(0, i).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ShipOneError(`"${p}" isn't KEY=value.`, "Example: shipone env set DATABASE_URL=postgres://...");
    }
    return { key, value: p.slice(i + 1) };
  });

  const groups = new Map<"frontend" | "backend", { key: string; value: string }[]>();
  for (const v of parsed) {
    const t = pickTarget(state, v.key, opts);
    groups.set(t, [...(groups.get(t) ?? []), v]);
  }

  for (const [t, vars] of groups) {
    if (t === "frontend") {
      const host = frontendHost(ctx, state.frontend!.provider);
      await host.setEnv(state.frontend!.projectId, vars);
      ctx.ui.success(`Set ${vars.map((v) => v.key).join(", ")} on ${host.label} (${state.frontend!.projectName}).`);
    } else {
      const host = backendHost(ctx, state.backend!.provider);
      await host.setEnv(state.backend!.serviceId, vars);
      ctx.ui.success(`Set ${vars.map((v) => v.key).join(", ")} on ${host.label} (${state.backend!.serviceName}).`);
    }
  }
  ctx.ui.info("Run `shipone deploy` to apply the change.");
}

export async function envList(ctx: Context, opts: { frontend?: boolean; backend?: boolean }) {
  const { state } = await loadRepo(ctx);
  const showFe = state.frontend && !opts.backend;
  const showBe = state.backend && !opts.frontend;
  if (showFe) {
    const host = frontendHost(ctx, state.frontend!.provider);
    const keys = [...(await host.listEnvKeys(state.frontend!.projectId))].sort();
    ctx.ui.note(keys.join("\n") || pc.dim("(none)"), `Frontend env on ${host.label}`);
  }
  if (showBe) {
    const host = backendHost(ctx, state.backend!.provider);
    const keys = [...(await host.listEnvKeys(state.backend!.serviceId))].sort();
    ctx.ui.note(keys.join("\n") || pc.dim("(none)"), `Backend env on ${host.label}`);
  }
}
