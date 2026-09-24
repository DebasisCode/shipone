import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkBackend, checkFrontend } from "../src/core/checks.js";
import { detectApps, detectBackend, detectFrontend, pickObvious } from "../src/core/detect.js";
import { parseEnv, planEnv } from "../src/core/envfile.js";
import { ShipOneError } from "../src/core/errors.js";
import { parseGitHubRemote, readGitInfo } from "../src/core/git.js";
import { resolveProvider } from "../src/core/preferences.js";
import { normalizeAppPath, readRepoConfig, validateRepoConfig, writeRepoConfig } from "../src/core/repoConfig.js";
import { Store } from "../src/core/store.js";
import { commitAll, FULLSTACK_FILES, git, makeRepo, tmpDir, writeFiles } from "./helpers.js";

describe("parseGitHubRemote", () => {
  it.each([
    ["https://github.com/me/app.git", "me", "app"],
    ["https://github.com/me/app", "me", "app"],
    ["https://token@github.com/Me/My.App.git", "Me", "My.App"],
    ["git@github.com:me/app.git", "me", "app"],
    ["ssh://git@github.com/me/app.git", "me", "app"],
    ["ssh://git@github.com:22/me/app", "me", "app"],
  ])("%s", (url, owner, repo) => {
    expect(parseGitHubRemote(url)).toEqual({ owner, repo });
  });

  it("rejects non-GitHub remotes", () => {
    expect(parseGitHubRemote("https://gitlab.com/me/app.git")).toBeUndefined();
    expect(parseGitHubRemote("https://github.com/me")).toBeUndefined();
  });
});

describe("readGitInfo", () => {
  it("reads repo, branch, sha and push state", async () => {
    const { root, sha } = makeRepo({ "a.txt": "a" });
    const info = await readGitInfo(path.join(root));
    expect(info).toMatchObject({ owner: "me", repo: "app", branch: "main", headSha: sha, upstreamSha: sha, remoteBranch: "main", ahead: 0, dirty: false });
  });

  it("counts unpushed commits and dirty files", async () => {
    const { root } = makeRepo({ "a.txt": "a" });
    writeFiles(root, { "b.txt": "b" });
    commitAll(root, "second");
    writeFiles(root, { "c.txt": "c" });
    const info = await readGitInfo(root);
    expect(info.ahead).toBe(1);
    expect(info.dirty).toBe(true);
  });

  it("explains a missing upstream / remote / repo", async () => {
    const unpushed = makeRepo({ "a.txt": "a" }, { push: false });
    expect((await readGitInfo(unpushed.root)).upstream).toBeUndefined();

    const noRemote = tmpDir();
    git(noRemote, "init", "-q");
    await expect(readGitInfo(noRemote)).rejects.toThrow(/no `origin` remote/);

    const gitlab = makeRepo({ "a.txt": "a" });
    git(gitlab.root, "remote", "set-url", "origin", "https://gitlab.com/me/app.git");
    await expect(readGitInfo(gitlab.root)).rejects.toThrow(/not a GitHub repository/);
  });
});

describe(".shipone.yml", () => {
  it("normalises paths and validates providers", () => {
    expect(normalizeAppPath("./client/")).toBe("client");
    expect(normalizeAppPath(".")).toBe(".");
    expect(normalizeAppPath("./")).toBe(".");
    expect(() => normalizeAppPath("../elsewhere")).toThrow(ShipOneError);

    expect(validateRepoConfig({ deploy: true, frontend: { path: "./client", provider: "vercel" }, backend: { path: "server" } })).toEqual({
      deploy: true,
      frontend: { path: "client", provider: "vercel" },
      backend: { path: "server" },
    });
    expect(() => validateRepoConfig({ backend: { path: "server", provider: "heroku" } })).toThrow(/backend.provider must be one of: render/);
    expect(() => validateRepoConfig({ deploy: "yes" })).toThrow(/deploy must be true or false/);
    expect(() => validateRepoConfig({ frontend: {} })).toThrow(/frontend.path is required/);
  });

  it("round-trips through the file", () => {
    const root = tmpDir();
    expect(readRepoConfig(root)).toBeUndefined();
    writeRepoConfig(root, { frontend: { path: "client", provider: "vercel" }, backend: { path: "server", provider: "render" } });
    const text = fs.readFileSync(path.join(root, ".shipone.yml"), "utf8");
    expect(text).toContain("deploy: true");
    expect(readRepoConfig(root)).toEqual({ deploy: true, frontend: { path: "client", provider: "vercel" }, backend: { path: "server", provider: "render" } });
  });

  it("reports YAML syntax errors clearly", () => {
    const root = tmpDir();
    writeFiles(root, { ".shipone.yml": "frontend: [unclosed" });
    expect(() => readRepoConfig(root)).toThrow(/not valid YAML/);
  });
});

describe("resolveProvider", () => {
  const account = { defaults: { frontend: "vercel" as const, backend: "render" as const }, repos: {} };
  it("follows repo file > repo override > account default > ask", () => {
    expect(resolveProvider("backend", { backend: { path: "s", provider: "render" } }, undefined, account)?.source).toBe("repo-file");
    expect(resolveProvider("backend", {}, { backend: "render" }, account)?.source).toBe("repo-override");
    expect(resolveProvider("backend", {}, undefined, account)).toEqual({ provider: "render", source: "account-default" });
    expect(resolveProvider("frontend", {}, undefined, { defaults: {}, repos: {} })).toBeUndefined();
  });
});

describe("Store", () => {
  it("keeps credentials private and lets env vars win", () => {
    const home = tmpDir();
    const store = new Store({ SHIPONE_HOME: home });
    store.setToken("vercel", "tok");
    const mode = fs.statSync(path.join(home, "credentials.json")).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(store.getToken("vercel")).toBe("tok");
    expect(new Store({ SHIPONE_HOME: home, VERCEL_TOKEN: "from-env" }).getToken("vercel")).toBe("from-env");
    store.setToken("vercel", undefined);
    expect(store.getToken("vercel")).toBeUndefined();
  });

  it("persists per-repo state", () => {
    const store = new Store({ SHIPONE_HOME: tmpDir() });
    store.updateRepoState("me/app", (s) => (s.lastDeploy = { sha: "abc", at: "now" }));
    expect(store.getRepoState("me/app").lastDeploy?.sha).toBe("abc");
    expect(store.getRepoState("me/other")).toEqual({});
  });

  it("explains corrupt JSON", () => {
    const home = tmpDir();
    fs.writeFileSync(path.join(home, "config.json"), "{nope");
    expect(() => new Store({ SHIPONE_HOME: home }).readConfig()).toThrow(/not valid JSON/);
  });
});

describe("stack detection", () => {
  it("finds a Vite client and an Express server", () => {
    const root = tmpDir();
    writeFiles(root, FULLSTACK_FILES);
    const d = detectApps(root);
    expect(d.frontends).toEqual([{ role: "frontend", path: "client", framework: "vite", apiUrlEnv: "VITE_API_URL", apiUrlEnvFromCode: true }]);
    expect(d.backends).toEqual([
      { role: "backend", path: "server", framework: "express", runtime: "node", packageManager: "npm", buildCommand: "npm ci", startCommand: "npm start" },
    ]);
  });

  it("reuses the env var name the code already reads", () => {
    const root = tmpDir();
    writeFiles(root, {
      "web/package.json": { dependencies: { next: "15" } },
      "web/lib/api.ts": "export const base = process.env.NEXT_PUBLIC_BACKEND_URL;\n",
    });
    expect(detectFrontend(root, "web")).toMatchObject({ framework: "nextjs", apiUrlEnv: "NEXT_PUBLIC_BACKEND_URL", apiUrlEnvFromCode: true });
  });

  it("defaults the env var name per framework", () => {
    const root = tmpDir();
    writeFiles(root, { "package.json": { dependencies: { "react-scripts": "5" } }, "src/App.js": "export default () => null" });
    expect(detectFrontend(root, ".")).toMatchObject({ framework: "create-react-app", apiUrlEnv: "REACT_APP_API_URL", apiUrlEnvFromCode: false });
  });

  it("works out build/start commands for yarn, pnpm and entry files", () => {
    const root = tmpDir();
    writeFiles(root, {
      "api/package.json": { dependencies: { fastify: "5" }, scripts: { build: "tsc", start: "node dist/index.js" } },
      "api/yarn.lock": "",
      "srv/package.json": { dependencies: { express: "5" } },
      "srv/pnpm-lock.yaml": "",
      "srv/server.js": "",
      "bare/package.json": { dependencies: { koa: "2" } },
    });
    expect(detectBackend(root, "api")).toMatchObject({ framework: "fastify", buildCommand: "yarn install --frozen-lockfile && yarn build", startCommand: "yarn start" });
    expect(detectBackend(root, "srv")).toMatchObject({ packageManager: "pnpm", startCommand: "node server.js" });
    expect(detectBackend(root, "srv")?.buildCommand).toContain("pnpm install --frozen-lockfile");
    expect(detectBackend(root, "bare")).toMatchObject({ buildCommand: "npm install", startCommand: undefined });
  });

  it("ignores devDependency-only servers and picks the obvious folder", () => {
    const root = tmpDir();
    writeFiles(root, { "tools/package.json": { devDependencies: { express: "5" } } });
    expect(detectBackend(root, "tools")).toBeUndefined();
    expect(pickObvious("frontend", [{ path: "landing" }, { path: "client" }])?.path).toBe("client");
    expect(pickObvious("frontend", [{ path: "a" }, { path: "b" }])).toBeUndefined();
  });
});

describe("pre-flight checks", () => {
  it("flags hardcoded localhost URLs with file:line, but not dev proxy config", () => {
    const root = tmpDir();
    writeFiles(root, {
      "client/package.json": { devDependencies: { vite: "7" } },
      "client/vite.config.js": "export default { server: { proxy: { '/api': 'http://localhost:5000' } } }",
      "client/src/api.js": "// talk to http://localhost:5000 in dev\nconst base = 'http://localhost:5000';\n",
    });
    const app = detectFrontend(root, "client")!;
    const findings = checkFrontend(root, app, true);
    expect(findings.map((f) => f.location)).toContain("client/src/api.js:2");
    expect(findings.some((f) => f.location?.includes("vite.config"))).toBe(false);
    expect(findings.some((f) => f.message.includes("never reads VITE_API_URL"))).toBe(true);
  });

  it("flags backend problems: no PORT, localhost-only listen, nodemon, missing start", () => {
    const root = tmpDir();
    writeFiles(root, {
      "server/package.json": { dependencies: { express: "5" }, scripts: { start: "nodemon index.js" } },
      "server/index.js": "const app = require('express')();\napp.listen(5000, 'localhost');\nmongoose.connect('mongodb://localhost:27017/db');\n",
    });
    const app = detectBackend(root, "server")!;
    const msgs = checkBackend(root, app).map((f) => f.message);
    expect(msgs.some((m) => m.includes("process.env.PORT"))).toBe(true);
    expect(msgs.some((m) => m.includes("only listens on localhost"))).toBe(true);
    expect(msgs.some((m) => m.includes("nodemon"))).toBe(true);
    expect(msgs.some((m) => m.includes("mongodb://localhost"))).toBe(true);

    const noStart = checkBackend(root, { ...app, startCommand: undefined });
    expect(noStart.find((f) => f.level === "error")?.message).toMatch(/start the backend/);
  });

  it("warns about SPA deep links without a Vercel rewrite", () => {
    const root = tmpDir();
    writeFiles(root, { "client/package.json": { dependencies: { "react-router-dom": "7" }, devDependencies: { vite: "7" } } });
    const app = detectFrontend(root, "client")!;
    expect(checkFrontend(root, app, false).map((f) => f.message).join()).toContain("client-side routing");
    writeFiles(root, { "client/vercel.json": { rewrites: [{ source: "/(.*)", destination: "/index.html" }] } });
    expect(checkFrontend(root, app, false)).toEqual([]);
  });

  it("is quiet for a well-behaved app", () => {
    const root = tmpDir();
    writeFiles(root, FULLSTACK_FILES);
    const d = detectApps(root);
    expect(checkFrontend(root, d.frontends[0]!, true)).toEqual([]);
    expect(checkBackend(root, d.backends[0]!)).toEqual([]);
  });
});

describe(".env handling", () => {
  it("parses dotenv syntax", () => {
    const env = parseEnv(`# comment\nexport A=1\nB="two words" # trailing\nC='x#y'\nD=val # comment\nE=\nbad line\n`);
    expect(Object.fromEntries(env)).toEqual({ A: "1", B: "two words", C: "x#y", D: "val", E: "" });
  });

  it("only asks for values it can't figure out", () => {
    const example = parseEnv("PORT=5000\nCORS_ORIGIN=http://localhost:5173\nDATABASE_URL=\nJWT_SECRET=your_secret_here\nLOG_LEVEL=info\nMONGO_URI=mongodb://localhost/db\nSTRIPE_KEY=\n");
    const local = parseEnv("DATABASE_URL=postgres://real.host/db\nMONGO_URI=mongodb://localhost/db\n");
    const plans = planEnv("backend", example, local, { SHIPONE_ENV_STRIPE_KEY: "sk_live" });
    const byKey = Object.fromEntries(plans.map((p) => [p.key, p]));
    expect(byKey.PORT?.kind).toBe("managed");
    expect(byKey.CORS_ORIGIN?.kind).toBe("managed");
    expect(byKey.DATABASE_URL).toMatchObject({ kind: "local", value: "postgres://real.host/db", secret: true });
    expect(byKey.JWT_SECRET).toMatchObject({ kind: "ask", secret: true });
    expect(byKey.LOG_LEVEL).toMatchObject({ kind: "default", value: "info" });
    expect(byKey.MONGO_URI).toMatchObject({ kind: "ask", reason: "your local value points at localhost" });
    expect(byKey.STRIPE_KEY).toMatchObject({ kind: "provided", value: "sk_live" });
  });

  it("treats the frontend's backend-URL keys as managed", () => {
    const plans = planEnv("frontend", parseEnv("VITE_API_URL=http://localhost:5000\nVITE_SERVER_BASE_URL=\nVITE_TITLE=My App\n"), new Map());
    expect(plans.map((p) => [p.key, p.kind])).toEqual([
      ["VITE_API_URL", "managed"],
      ["VITE_SERVER_BASE_URL", "managed"],
      ["VITE_TITLE", "default"],
    ]);
  });
});
