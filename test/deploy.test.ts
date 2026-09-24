import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deploy } from "../src/commands/deploy.js";
import { envSet, status } from "../src/commands/project.js";
import { readRepoConfig } from "../src/core/repoConfig.js";
import { FakeCloud, type FakeCloudOptions } from "./fakeCloud.js";
import { commitAll, fakePush, FULLSTACK_FILES, git, makeRepo, ScriptedUI, testContext, writeFiles, type ScriptedAnswer } from "./helpers.js";

const TOKENS = { VERCEL_TOKEN: "vercel-token", RENDER_API_KEY: "render-token" };
/** Secrets for server/.env.example, supplied the non-interactive way. */
const SECRETS = { SHIPONE_ENV_DATABASE_URL: "postgres://prod/db", SHIPONE_ENV_JWT_SECRET: "s3cret" };

function setup(opts: { files?: Record<string, string | object>; cloud?: FakeCloudOptions; env?: NodeJS.ProcessEnv; answers?: ScriptedAnswer[]; interactive?: boolean } = {}) {
  const repo = makeRepo(opts.files ?? FULLSTACK_FILES);
  const cloud = new FakeCloud({ branchHeads: { main: repo.sha }, ...opts.cloud });
  const ui = new ScriptedUI(opts.interactive ?? false, opts.answers);
  const ctx = testContext({ cwd: repo.root, ui, fetch: cloud.fetch, env: { ...TOKENS, ...SECRETS, ...opts.env } });
  // Pick the Render workspace once, as `shipone connect render` would.
  ctx.store.updateConfig((c) => (c.render = { ownerId: "own_1", ownerName: "Me" }));
  return { ...repo, cloud, ui, ctx };
}

describe("shipone deploy: first run", () => {
  it("creates both services, wires URLs both ways, and deploys the exact commit", async () => {
    const { root, sha, cloud, ctx } = setup();
    const result = await deploy(ctx);

    // Frontend project, linked to GitHub, auto-deploy off, backend URL injected before the build.
    const [project] = [...cloud.vercel.projects.values()];
    expect(project).toMatchObject({ name: "app", framework: "vite", rootDirectory: "client", gitProviderOptions: { createDeployments: "disabled" } });
    expect(project!.env.map((e) => [e.key, e.value])).toEqual([["VITE_API_URL", "https://app-api.onrender.com"]]);

    // Backend service: auto-deploy off, secrets from env, CORS set to the frontend URL at creation.
    const [service] = [...cloud.render.services.values()];
    expect(service).toMatchObject({ name: "app-api", rootDir: "server", branch: "main", autoDeploy: "no" });
    expect(Object.fromEntries(service!.env)).toEqual({
      DATABASE_URL: "postgres://prod/db",
      JWT_SECRET: "s3cret",
      LOG_LEVEL: "info",
      CORS_ORIGIN: "https://app.vercel.app",
      FRONTEND_URL: "https://app.vercel.app",
    });

    // One deploy each, for the pushed commit (Render's automatic first deploy is reused).
    expect([...cloud.vercel.deployments.values()].map((d) => d.gitSource.sha)).toEqual([sha]);
    expect(cloud.render.deploys.map((d) => d.commit.id)).toEqual([sha]);

    expect(result).toMatchObject({
      frontend: { url: "https://app.vercel.app", status: { state: "ready" } },
      backend: { url: "https://app-api.onrender.com", status: { state: "ready" } },
    });

    // Remembered: .shipone.yml in the repo, ids in ~/.shipone/state.json.
    expect(readRepoConfig(root)).toEqual({
      deploy: true,
      frontend: { path: "client", provider: "vercel" },
      backend: { path: "server", provider: "render" },
    });
    expect(ctx.store.getRepoState("me/app")).toMatchObject({
      frontend: { projectId: project!.id, url: "https://app.vercel.app" },
      backend: { serviceId: service!.id, url: "https://app-api.onrender.com" },
      lastDeploy: { sha },
    });
  });

  it("fixes CORS and redeploys the backend when the frontend URL is only known after its build", async () => {
    const { cloud, ctx, sha, ui } = setup({ cloud: { vercelDomainAfterDeploy: true } });
    await deploy(ctx);
    const [service] = [...cloud.render.services.values()];
    expect(service!.env.get("CORS_ORIGIN")).toBe("https://app-me.vercel.app");
    // Initial deploy + one more with the right CORS origin.
    expect(cloud.render.deploys.map((d) => d.commit.id)).toEqual([sha, sha]);
    expect(ui.text_("info")).toContain("Set CORS_ORIGIN/FRONTEND_URL on Render to https://app-me.vercel.app");
  });

  it("deploys a frontend-only repo", async () => {
    const files = Object.fromEntries(Object.entries(FULLSTACK_FILES).filter(([k]) => k.startsWith("client/")));
    const { cloud, ctx } = setup({ files });
    const result = await deploy(ctx);
    expect(result?.backend).toBeUndefined();
    expect(cloud.render.services.size).toBe(0);
    expect(cloud.requestsTo("render")).toHaveLength(0);
    expect(cloud.vercel.projects.size).toBe(1);
  });

  it("warns with the vercel.json fallback when deploy-on-push can't be disabled", async () => {
    const { ctx, ui } = setup({ cloud: { vercelRejectsGitOptions: true } });
    await deploy(ctx);
    expect(ui.text_("warn")).toContain('"deploymentEnabled": false');
  });

  it("uses local .env values and prompts only for the rest (interactive)", async () => {
    const files = { ...FULLSTACK_FILES, "server/.env": "DATABASE_URL=postgres://from-local/db\nJWT_SECRET=\n" };
    const { cloud, ctx, ui } = setup({
      files,
      env: { SHIPONE_ENV_DATABASE_URL: "", SHIPONE_ENV_JWT_SECRET: "" },
      interactive: true,
      answers: [
        { match: /Create these services/, answer: true },
        { match: /Use the values from your local server\/.env for DATABASE_URL/, answer: true },
        { match: /JWT_SECRET/, answer: "typed-secret" },
      ],
    });
    await deploy(ctx);
    const [service] = [...cloud.render.services.values()];
    expect(service!.env.get("DATABASE_URL")).toBe("postgres://from-local/db");
    expect(service!.env.get("JWT_SECRET")).toBe("typed-secret");
    expect(ui.asked).toHaveLength(3);
  });
});

describe("shipone deploy: later runs", () => {
  it("is idempotent: reuses services, doesn't re-ask for secrets, deploys the new commit", async () => {
    const { root, cloud, ctx } = setup();
    await deploy(ctx);
    writeFiles(root, { "server/index.js": fs.readFileSync(path.join(root, "server/index.js"), "utf8") + "// v2\n" });
    const sha2 = commitAll(root, "v2");
    fakePush(root);

    const before = cloud.requests.length;
    // No secrets in the environment this time: they're already on Render, so nothing is asked.
    ctx.env.SHIPONE_ENV_DATABASE_URL = "";
    ctx.env.SHIPONE_ENV_JWT_SECRET = "";
    await deploy(ctx);
    const second = cloud.requests.slice(before);

    expect(second.filter((r) => r.method === "POST" && /\/(v11\/projects|v1\/services)$/.test(r.path))).toHaveLength(0);
    expect(cloud.vercel.projects.size).toBe(1);
    expect(cloud.render.services.size).toBe(1);
    expect([...cloud.vercel.deployments.values()].at(-1)!.gitSource.sha).toBe(sha2);
    expect(cloud.render.deploys.at(-1)!.commit.id).toBe(sha2);
    expect(ctx.store.getRepoState("me/app").lastDeploy?.sha).toBe(sha2);
  });

  it("re-adopts existing services by name when local state is lost (new laptop)", async () => {
    const { cloud, ctx } = setup();
    await deploy(ctx);
    fs.rmSync(path.join(ctx.store.dir, "state.json"));
    await deploy(ctx);
    expect(cloud.vercel.projects.size).toBe(1);
    expect(cloud.render.services.size).toBe(1);
  });

  it("recreates a service that was deleted in the dashboard", async () => {
    const { cloud, ctx, ui } = setup();
    await deploy(ctx);
    cloud.render.services.clear();
    await deploy(ctx);
    expect(cloud.render.services.size).toBe(1);
    expect(ui.text_("warn")).toContain('Render service "app-api" no longer exists');
  });

  it("picks another name when the default one belongs to a different repo", async () => {
    const { cloud, ctx } = setup({ cloud: { accessibleRepos: ["me/app", "someone/else"] } });
    cloud.vercel.projects.set("prj_x", { id: "prj_x", name: "app", link: { type: "github", org: "someone", repo: "else", repoId: 9 }, env: [], domains: ["app.vercel.app"] });
    await deploy(ctx);
    expect([...cloud.vercel.projects.values()].map((p) => p.name)).toEqual(["app", "app-me"]);
  });
});

describe("shipone deploy: guard rails", () => {
  it("refuses to deploy unpushed commits non-interactively", async () => {
    const { root, ctx, cloud } = setup();
    commitAll(root, "local only");
    await expect(deploy(ctx)).rejects.toThrow(/Push your commits first/);
    expect(cloud.requests).toHaveLength(0);
  });

  it("offers to deploy what's on GitHub when there are unpushed commits", async () => {
    const { root, sha, ctx, cloud } = setup({
      interactive: true,
      answers: [
        { match: /Deploy what's on GitHub/, answer: true },
        { match: /Create these services/, answer: true },
      ],
    });
    commitAll(root, "local only");
    await deploy(ctx);
    expect([...cloud.vercel.deployments.values()][0]!.gitSource.sha).toBe(sha);
  });

  it("requires the branch to be pushed at all", async () => {
    const repo = makeRepo(FULLSTACK_FILES, { push: false });
    const ctx = testContext({ cwd: repo.root, env: TOKENS });
    await expect(deploy(ctx)).rejects.toThrow(/isn't on GitHub yet/);
  });

  it("dry run plans without touching any API or writing files", async () => {
    const { root, ctx, cloud, ui } = setup({ env: { VERCEL_TOKEN: "", RENDER_API_KEY: "" } });
    await deploy(ctx, { dryRun: true });
    expect(cloud.requests).toHaveLength(0);
    expect(fs.existsSync(path.join(root, ".shipone.yml"))).toBe(false);
    expect(ui.text_("note")).toContain("client (vite) → Vercel project \"app\"");
    expect(ui.text_("note")).toContain("server (express) → Render service \"app-api\"");
  });

  it("respects deploy: false", async () => {
    const { ctx, cloud } = setup({ files: { ...FULLSTACK_FILES, ".shipone.yml": "deploy: false\n" } });
    expect(await deploy(ctx)).toBeUndefined();
    expect(cloud.requests).toHaveLength(0);
  });

  it("stops on pre-flight errors unless --force", async () => {
    const files = { ...FULLSTACK_FILES, "server/package.json": { dependencies: { express: "5" } } };
    const { ctx, cloud } = setup({ files: { ...files, "server/index.js": "require('express')().listen(process.env.PORT)" } });
    fs.rmSync(path.join(ctx.cwd, "server/index.js"));
    commitAll(ctx.cwd, "no entry");
    fakePush(ctx.cwd);
    await expect(deploy(ctx)).rejects.toThrow(/Fix the problems above first/);
    expect(cloud.requests).toHaveLength(0);
  });

  it("fails clearly when secrets are missing, before creating anything", async () => {
    const { ctx, cloud } = setup({ env: { SHIPONE_ENV_JWT_SECRET: "" } });
    const err = await deploy(ctx).catch((e) => e);
    expect(err.message).toContain("No production value for JWT_SECRET");
    expect(err.hint).toContain("SHIPONE_ENV_JWT_SECRET=");
    expect(cloud.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("asks before switching the backend to a different branch", async () => {
    const { root, cloud, ctx } = setup();
    await deploy(ctx);
    git(root, "switch", "-q", "-c", "feature");
    fakePush(root, "feature");
    await deploy(ctx); // non-interactive default: yes
    const [service] = [...cloud.render.services.values()];
    expect(service!.branch).toBe("feature");
    expect([...cloud.vercel.deployments.values()].at(-1)!.gitSource.ref).toBe("feature");

    const declining = testContext({ cwd: root, ui: new ScriptedUI(true, [{ match: /Switch it to "main"/, answer: false }]), fetch: cloud.fetch, env: ctx.env, home: ctx.store.dir });
    git(root, "switch", "-q", "main");
    await expect(deploy(declining)).rejects.toThrow(/Nothing was deployed/);
  });

  it("explains missing provider connections non-interactively", async () => {
    const { ctx } = setup({ env: { VERCEL_TOKEN: "" } });
    const err = await deploy(ctx).catch((e) => e);
    expect(err.message).toBe("Vercel isn't connected.");
    expect(err.hint).toContain("shipone connect vercel");
  });

  it("surfaces the build log when a build fails", async () => {
    const { ctx, ui } = setup({ cloud: { failRenderBuild: true } });
    await expect(deploy(ctx)).rejects.toThrow(/didn't finish cleanly/);
    expect(ui.text_("note")).toContain("Cannot find module 'expresss'");
    expect(ctx.store.getRepoState("me/app").lastDeploy).toBeUndefined();
  });

  it("explains GitHub access problems", async () => {
    const { ctx } = setup({ cloud: { accessibleRepos: [] } });
    const err = await deploy(ctx).catch((e) => e);
    expect(err.hint).toContain("github.com/apps/vercel");
  });
});

describe("after deploying", () => {
  it("status shows URLs and env set routes keys to the right side", async () => {
    const { cloud, ctx, ui } = setup();
    await deploy(ctx);
    await status(ctx);
    expect(ui.text_("note")).toContain("https://app-api.onrender.com");

    await envSet(ctx, ["STRIPE_KEY=sk_test_1", "VITE_TITLE=Hello=World"], {});
    const [service] = [...cloud.render.services.values()];
    expect(service!.env.get("STRIPE_KEY")).toBe("sk_test_1");
    const [project] = [...cloud.vercel.projects.values()];
    expect(project!.env.find((e) => e.key === "VITE_TITLE")?.value).toBe("Hello=World");

    await expect(envSet(ctx, ["nope"], {})).rejects.toThrow(/isn't KEY=value/);
  });
});
