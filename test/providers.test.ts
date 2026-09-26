import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../src/providers/http.js";
import { NetlifyHost } from "../src/providers/netlify.js";
import { RailwayHost } from "../src/providers/railway.js";
import { RenderHost, repoFromUrl } from "../src/providers/render.js";
import { VercelHost } from "../src/providers/vercel.js";
import { FakeCloud } from "./fakeCloud.js";

const commit = { owner: "me", repo: "app", branch: "main", sha: "abc1234def" };

function jsonResponse(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("ApiClient", () => {
  const client = (fetch: (url: string, init?: RequestInit) => Promise<Response>) =>
    new ApiClient({ label: "Test", baseUrl: "https://api.test/v1/", token: "t", reconnectCommand: "shipone connect test", fetch, retryDelayMs: 0 });

  it("sends bearer auth + JSON and builds query strings (incl. arrays)", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { ok: true }));
    await client(fetch).post("/things", { a: 1 }, { x: "1", skip: undefined, many: ["a", "b"] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/things?x=1&many=a&many=b");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t");
    expect(init.body).toBe('{"a":1}');
  });

  it("retries GETs on 5xx and network errors, and 429s for any method", async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(503, { message: "busy" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    expect(await client(flaky).get("/x")).toEqual({ ok: 1 });
    expect(flaky).toHaveBeenCalledTimes(3);

    const limited = vi.fn().mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after": "0" })).mockResolvedValueOnce(jsonResponse(201, { id: 1 }));
    expect(await client(limited).post("/x", {})).toEqual({ id: 1 });
  });

  it("never blindly retries a POST that failed server-side", async () => {
    const fetch = vi.fn(async () => jsonResponse(500, { message: "boom" }));
    await expect(client(fetch).post("/x", {})).rejects.toThrow(/Test API error \(500\) on POST \/x: boom/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("turns 401s into a reconnect hint and parses both error shapes", async () => {
    const e401 = (await client(async () => jsonResponse(401, { id: "unauthorized", message: "bad key" })).get("/x").catch((e) => e)) as ApiError;
    expect(e401).toBeInstanceOf(ApiError);
    expect(e401.message).toBe("Test rejected your token: bad key.");
    expect(e401.hint).toContain("shipone connect test");

    const vercelShape = (await client(async () => jsonResponse(400, { error: { code: "bad", message: "nope" } })).get("/x").catch((e) => e)) as ApiError;
    expect(vercelShape).toMatchObject({ status: 400, code: "bad" });
    expect(vercelShape.message).toContain("nope");
  });
});

describe("VercelHost against the fake API", () => {
  const setup = (opts = {}) => {
    const cloud = new FakeCloud(opts);
    return { cloud, host: new VercelHost("vercel-token", { fetch: cloud.fetch, retryDelayMs: 0 }) };
  };

  it("creates a GitHub-linked project and disables deploy-on-push", async () => {
    const { cloud, host } = setup();
    const p = await host.createProject({ name: "app", repo: { owner: "me", repo: "app" }, rootDirectory: "client", framework: "vite" });
    expect(p.repo).toBe("me/app");
    expect(cloud.requestsTo("vercel", "POST", /^\/v11\/projects$/)[0]!.body).toEqual({
      name: "app",
      framework: "vite",
      rootDirectory: "client",
      gitRepository: { type: "github", repo: "me/app" },
    });
    expect(await host.disableGitDeployments(p.id)).toBe(true);
    expect(cloud.vercel.projects.get(p.id)!.gitProviderOptions).toEqual({ createDeployments: "disabled" });
    expect(await host.productionUrl(p.id)).toBe("https://app.vercel.app");
    expect(await host.findProject("missing")).toBeUndefined();
  });

  it("gives an actionable hint when Vercel can't see the repo", async () => {
    const { host } = setup({ accessibleRepos: [] });
    const err = await host.createProject({ name: "app", repo: { owner: "me", repo: "app" }, rootDirectory: ".", framework: "vite" }).catch((e) => e);
    expect(err.hint).toContain("github.com/apps/vercel");
  });

  it("upserts env vars and deploys an exact commit", async () => {
    const { cloud, host } = setup();
    const p = await host.createProject({ name: "app", repo: { owner: "me", repo: "app" }, rootDirectory: "client", framework: "vite" });
    await host.setEnv(p.id, [{ key: "VITE_API_URL", value: "https://a" }]);
    await host.setEnv(p.id, [{ key: "VITE_API_URL", value: "https://b" }]);
    expect(cloud.vercel.projects.get(p.id)!.env).toMatchObject([{ key: "VITE_API_URL", value: "https://b", target: ["production", "preview"] }]);
    expect(await host.listEnvKeys(p.id)).toEqual(new Set(["VITE_API_URL"]));

    const d = await host.deploy(p, commit);
    expect(cloud.requestsTo("vercel", "POST", /deployments/)[0]!.body).toMatchObject({
      project: p.id,
      target: "production",
      gitSource: { type: "github", org: "me", repo: "app", ref: "main", sha: commit.sha },
    });
    expect(d.state).toBe("queued");
    expect((await host.getDeploy(p.id, d.id)).state).toBe("building");
    const done = await host.getDeploy(p.id, d.id);
    expect(done).toMatchObject({ state: "ready", url: "https://app.vercel.app" });
    expect(await host.latestDeploy(p.id)).toMatchObject({ id: d.id, state: "ready", sha: commit.sha });
    expect(await host.logs(d.id, 10)).toEqual(["Cloning github.com/me/app", 'Running "npm run build"']);
  });

  it("reports false (not an exception) if deploy-on-push can't be disabled", async () => {
    const { host } = setup({ vercelRejectsGitOptions: true });
    const p = await host.createProject({ name: "app", repo: { owner: "me", repo: "app" }, rootDirectory: ".", framework: "vite" });
    expect(await host.disableGitDeployments(p.id)).toBe(false);
  });
});

describe("RenderHost against the fake API", () => {
  const setup = (opts = {}) => {
    const cloud = new FakeCloud(opts);
    return { cloud, host: new RenderHost("render-token", { ownerId: "own_1", fetch: cloud.fetch, retryDelayMs: 0 }) };
  };
  const input = {
    name: "app-api",
    repo: { owner: "me", repo: "app" },
    branch: "main",
    rootDir: "server",
    runtime: "node" as const,
    buildCommand: "npm ci",
    startCommand: "npm start",
    env: [{ key: "CORS_ORIGIN", value: "https://app.vercel.app" }],
  };

  it("creates a web service with auto-deploy off and knows its URL immediately", async () => {
    const { cloud, host } = setup();
    const s = await host.createService(input);
    expect(s).toMatchObject({ name: "app-api", url: "https://app-api.onrender.com", repo: "me/app", initialDeployId: expect.any(String) });
    expect(cloud.requestsTo("render", "POST", /^\/v1\/services$/)[0]!.body).toEqual({
      type: "web_service",
      name: "app-api",
      ownerId: "own_1",
      repo: "https://github.com/me/app",
      branch: "main",
      rootDir: "server",
      autoDeploy: "no",
      envVars: [{ key: "CORS_ORIGIN", value: "https://app.vercel.app" }],
      serviceDetails: { runtime: "node", plan: "free", region: "oregon", envSpecificDetails: { buildCommand: "npm ci", startCommand: "npm start" } },
    });
    expect((await host.findService("app-api"))?.id).toBe(s.id);
    expect(await host.getService("srv-nope")).toBeUndefined();
  });

  it("sets env vars one key at a time so existing vars survive", async () => {
    const { cloud, host } = setup();
    const s = await host.createService(input);
    await host.setEnv(s.id, [{ key: "DATABASE_URL", value: "postgres://x" }]);
    expect(Object.fromEntries(cloud.render.services.get(s.id)!.env)).toEqual({ CORS_ORIGIN: "https://app.vercel.app", DATABASE_URL: "postgres://x" });
    expect(cloud.requestsTo("render", "PUT", /env-vars$/)).toHaveLength(0);
  });

  it("deploys a specific commit and reads status + logs", async () => {
    const { host } = setup();
    const s = await host.createService(input);
    const d = await host.deploy(s.id, commit);
    expect(d).toMatchObject({ state: "queued", sha: commit.sha });
    await host.getDeploy(s.id, d.id);
    expect(await host.getDeploy(s.id, d.id)).toMatchObject({ state: "ready", rawState: "live" });
    expect((await host.latestDeploy(s.id))?.id).toBe(d.id);
    expect(await host.logs(s.id, 50)).toEqual(["==> Running build command 'npm ci'", "Server listening on 10000"]);
  });

  it("gives an actionable hint when Render can't see the repo", async () => {
    const { host } = setup({ accessibleRepos: [] });
    const err = await host.createService(input).catch((e) => e);
    expect(err.hint).toContain("github.com/apps/render");
  });

  it("normalises repo URLs", () => {
    expect(repoFromUrl("https://github.com/Me/App.git")).toBe("me/app");
    expect(repoFromUrl(undefined)).toBeUndefined();
  });
});

describe("NetlifyHost against the fake API", () => {
  const setup = (opts = {}) => {
    const cloud = new FakeCloud(opts);
    return { cloud, host: new NetlifyHost("netlify-token", { fetch: cloud.fetch, retryDelayMs: 0 }) };
  };
  const commit = { owner: "me", repo: "app", branch: "main", sha: "abc1234def" };

  it("creates a GitHub-linked site and reports its production URL", async () => {
    const { cloud, host } = setup();
    const p = await host.createProject({ name: "app", repo: { owner: "me", repo: "app" }, rootDirectory: "client", framework: "vite" });
    expect(p.repo).toBe("me/app");
    const req = cloud.requestsTo("netlify", "POST", /^\/api\/v1\/sites$/)[0]!;
    expect(req.body).toMatchObject({ name: "app", build_settings: { provider: "github", repo_path: "me/app" } });
    expect((req.body as any).build_settings.cmd).toBe("cd client && npm run build");
    expect(await host.productionUrl(p.id)).toBe("https://app.netlify.app");
    // Netlify's deploy-on-push can't be disabled without breaking API builds.
    expect(await host.disableGitDeployments(p.id)).toBe(false);
    expect(await host.findProject("missing")).toBeUndefined();
  });

  it("upserts env vars via the account endpoint with site scope", async () => {
    const { cloud, host } = setup();
    const p = await host.createProject({ name: "app", repo: { owner: "me", repo: "app" }, rootDirectory: ".", framework: "vite" });
    await host.setEnv(p.id, [{ key: "VITE_API_URL", value: "https://a" }]);
    expect(cloud.requestsTo("netlify", "POST", /\/env$/)[0]!.body).toMatchObject([
      { key: "VITE_API_URL", values: [{ context: "all", value: "https://a" }] },
    ]);
    await host.setEnv(p.id, [{ key: "VITE_API_URL", value: "https://b" }]);
    expect(cloud.requestsTo("netlify", "PATCH", /\/env\/VITE_API_URL$/)).toHaveLength(1);
    expect(await host.listEnvKeys(p.id)).toEqual(new Set(["VITE_API_URL"]));
  });

  it("builds the branch tip and waits for the deploy", async () => {
    const { cloud, host } = setup({ branchHeads: { main: commit.sha } });
    const p = await host.createProject({ name: "app", repo: { owner: "me", repo: "app" }, rootDirectory: ".", framework: "vite" });
    const d = await host.deploy(p, commit);
    expect(d).toMatchObject({ state: "queued", sha: commit.sha });
    expect(cloud.requestsTo("netlify", "POST", /\/builds$/)[0]!.query.get("branch")).toBe("main");
    await host.getDeploy(p.id, d.id); // builds advance one step per poll
    expect(await host.getDeploy(p.id, d.id)).toMatchObject({ state: "ready", url: "https://app.netlify.app", sha: commit.sha });
    expect((await host.latestDeploy(p.id))?.id).toBe(d.id);
    expect(await host.logs(d.id, 10)).toContain("Starting build");
  });

  it("gives an actionable hint when Netlify can't see the repo", async () => {
    const { host } = setup({ accessibleRepos: [] });
    const err = await host.createProject({ name: "app", repo: { owner: "me", repo: "app" }, rootDirectory: ".", framework: "vite" }).catch((e) => e);
    expect(err.hint).toContain("github.com/apps/netlify");
  });
});

describe("RailwayHost against the fake API", () => {
  const setup = (opts = {}) => {
    const cloud = new FakeCloud(opts);
    return { cloud, host: new RailwayHost("railway-token", { fetch: cloud.fetch }) };
  };
  const commit = { owner: "me", repo: "app", branch: "main", sha: "abc1234def" };
  const input = {
    name: "app-api",
    repo: { owner: "me", repo: "app" },
    branch: "main",
    rootDir: "server",
    runtime: "node" as const,
    buildCommand: "npm ci",
    startCommand: "npm start",
    env: [{ key: "CORS_ORIGIN", value: "https://app.vercel.app" }],
  };

  it("creates a project + service with auto-deploy off and a domain", async () => {
    const { cloud, host } = setup();
    const s = await host.createService(input);
    expect(s).toMatchObject({ name: "app-api", repo: "me/app", url: expect.stringMatching(/\.up\.railway\.app$/) });
    const svc = [...cloud.railway.services.values()][0]!;
    expect(svc).toMatchObject({ repo: "me/app", branch: "main", rootDirectory: "server", buildCommand: "npm ci", startCommand: "npm start" });
    expect(svc.autoDeploy).toBe(false);
    expect(svc.env.get("CORS_ORIGIN")).toBe("https://app.vercel.app");
    expect(svc.env.get("PORT")).toBe("8080");
    expect((await host.findService("app-api"))?.id).toBe(s.id);
    expect(await host.findService("missing")).toBeUndefined();
  });

  it("upserts env vars and lists keys", async () => {
    const { cloud, host } = setup();
    const s = await host.createService(input);
    await host.setEnv(s.id, [{ key: "DATABASE_URL", value: "postgres://x" }]);
    const svc = [...cloud.railway.services.values()][0]!;
    expect(svc.env.get("DATABASE_URL")).toBe("postgres://x");
    expect(svc.env.get("CORS_ORIGIN")).toBe("https://app.vercel.app");
    expect(await host.listEnvKeys(s.id)).toContain("DATABASE_URL");
  });

  it("deploys an exact commit and reads status + logs", async () => {
    const { host } = setup();
    const s = await host.createService(input);
    const d = await host.deploy(s.id, commit);
    expect(d).toMatchObject({ state: "queued", sha: commit.sha });
    await host.getDeploy(s.id, d.id); // builds advance one step per poll
    expect(await host.getDeploy(s.id, d.id)).toMatchObject({ state: "ready", rawState: "SUCCESS", sha: commit.sha });
    expect((await host.latestDeploy(s.id))?.id).toBe(d.id);
    expect(await host.logs(s.id, 50)).toContain("Building with Nixpacks");
  });

  it("switches the branch and syncs drifted commands on an existing service", async () => {
    const { cloud, host } = setup();
    const s = await host.createService(input);
    await host.configure(s.id, { branch: "feature", disableAutoDeploy: true, buildCommand: "npm install", startCommand: "node server.js" });
    const svc = [...cloud.railway.services.values()][0]!;
    expect(svc.branch).toBe("feature");
    expect(svc.buildCommand).toBe("npm install");
    expect(svc.startCommand).toBe("node server.js");
    expect(svc.autoDeploy).toBe(false);
  });

  it("gives an actionable hint when Railway can't see the repo", async () => {
    const { host } = setup({ accessibleRepos: [] });
    const err = await host.createService(input).catch((e) => e);
    expect(err.hint).toContain("github.com/apps/railway");
  });
});
