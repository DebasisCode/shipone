import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { uninstall } from "../src/commands/connect.js";
import { checkBackend, checkFrontend } from "../src/core/checks.js";
import { detectApps, detectBackend, detectFrontend, pickObvious } from "../src/core/detect.js";
import { parseEnv, planEnv } from "../src/core/envfile.js";
import { ShipOneError } from "../src/core/errors.js";
import { parseGitHubRemote, readGitInfo } from "../src/core/git.js";
import { resolveProvider } from "../src/core/preferences.js";
import { normalizeAppPath, readRepoConfig, validateRepoConfig, writeRepoConfig } from "../src/core/repoConfig.js";
import { Store } from "../src/core/store.js";
import { commitAll, FULLSTACK_FILES, git, makeRepo, tmpDir, writeFiles } from "./helpers.js";
import { ScriptedUI, testContext } from "./helpers.js";

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
    expect(() => validateRepoConfig({ backend: { path: "server", provider: "heroku" } })).toThrow(/backend.provider must be one of: render, railway/);
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
    if (process.platform !== "win32") {
      const mode = fs.statSync(path.join(home, "credentials.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
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

describe("shipone uninstall", () => {
  it("wipes the shipone home after a confirmation and explains what survives", async () => {
    const home = tmpDir("shipone-uninstall-");
    const ctx = testContext({ cwd: home, ui: new ScriptedUI(true, [{ match: /tokens for Vercel/, answer: true }]), home });
    ctx.store.setToken("vercel", "tok");
    ctx.store.updateRepoState("me/app", (s) => (s.frontend = { provider: "vercel", projectId: "p", projectName: "app" }));
    await uninstall(ctx);
    expect(fs.existsSync(path.join(home, "credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, "state.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, "config.json"))).toBe(false);
    expect(fs.existsSync(home)).toBe(false); // empty dir removed
    expect(ctx.ui.text_("success")).toContain("Removed tokens, service ids and config");
    expect(ctx.ui.text_("info")).toContain("keep running");
  });

  it("keeps everything when the user declines, and --force skips the prompt", async () => {
    const home = tmpDir("shipone-uninstall-");
    const declining = testContext({ cwd: home, ui: new ScriptedUI(true, [{ match: /tokens for Render/, answer: false }]), home });
    declining.store.setToken("render", "tok");
    await expect(uninstall(declining)).rejects.toThrow(/Nothing was removed/);
    expect(fs.existsSync(path.join(declining.store.dir, "credentials.json"))).toBe(true);

    // Non-interactive without --force fails instead of wiping.
    const scripted = testContext({ cwd: home, ui: new ScriptedUI(false, []), home });
    await expect(uninstall(scripted)).rejects.toThrow(/needs a confirmation/);

    const forced = testContext({ cwd: home, ui: new ScriptedUI(false, []), home });
    await uninstall(forced, { force: true });
    expect(fs.existsSync(path.join(forced.store.dir, "credentials.json"))).toBe(false);
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
      "srv/package.json": { dependencies: { express: "5" }, scripts: { build: "tsc", start: "node server.js" } },
      "srv/pnpm-lock.yaml": "",
      "srv/server.js": "",
      "bare/package.json": { dependencies: { koa: "2" } },
    });
    expect(detectBackend(root, "api")).toMatchObject({ framework: "fastify", buildCommand: "yarn install --frozen-lockfile && yarn build", startCommand: "yarn start" });
    expect(detectBackend(root, "srv")).toMatchObject({
      packageManager: "pnpm",
      buildCommand: "npx pnpm@latest-10 install --frozen-lockfile && npx pnpm@latest-10 build",
      startCommand: "npx pnpm@latest-10 start",
    });
    // Global installs (`npm i -g`, `corepack enable`) fail on Render's read-only system dirs.
    expect(detectBackend(root, "srv")?.buildCommand).not.toContain("npm install -g");
    expect(detectBackend(root, "srv")?.buildCommand).not.toContain("corepack");
    expect(detectBackend(root, "bare")).toMatchObject({ buildCommand: "npm install", startCommand: undefined });
  });

  it("ignores devDependency-only servers and picks the obvious folder", () => {
    const root = tmpDir();
    writeFiles(root, { "tools/package.json": { devDependencies: { express: "5" } } });
    expect(detectBackend(root, "tools")).toBeUndefined();
    expect(pickObvious("frontend", [{ path: "landing" }, { path: "client" }])?.path).toBe("client");
    expect(pickObvious("frontend", [{ path: "a" }, { path: "b" }])).toBeUndefined();
  });

  it("detects every supported JS frontend framework", () => {
    const root = tmpDir();
    writeFiles(root, {
      "ng/package.json": { dependencies: { "@angular/core": "19" } },
      "sv/package.json": { devDependencies: { "@sveltejs/kit": "2" } },
      "as/package.json": { dependencies: { astro: "5" } },
      "nx/package.json": { dependencies: { nuxt: "4" } },
      "ga/package.json": { dependencies: { gatsby: "5" } },
      "rm/package.json": { dependencies: { "@remix-run/react": "2" } },
    });
    expect(detectFrontend(root, "ng")).toMatchObject({ framework: "angular", apiUrlEnv: "NG_APP_API_URL", apiUrlEnvFromCode: false });
    expect(detectFrontend(root, "sv")).toMatchObject({ framework: "sveltekit", apiUrlEnv: "PUBLIC_API_URL" });
    expect(detectFrontend(root, "as")).toMatchObject({ framework: "astro", apiUrlEnv: "PUBLIC_API_URL" });
    expect(detectFrontend(root, "nx")).toMatchObject({ framework: "nuxt", apiUrlEnv: "NUXT_PUBLIC_API_URL" });
    expect(detectFrontend(root, "ga")).toMatchObject({ framework: "gatsby", apiUrlEnv: "GATSBY_API_URL" });
    expect(detectFrontend(root, "rm")).toMatchObject({ framework: "remix", apiUrlEnv: "REMIX_PUBLIC_API_URL" });
  });

  it("prefers the meta-framework over vite inside the same package.json", () => {
    const root = tmpDir();
    writeFiles(root, { "web/package.json": { dependencies: { astro: "5" }, devDependencies: { vite: "7" } } });
    expect(detectFrontend(root, "web")).toMatchObject({ framework: "astro" });
  });

  it("detects NestJS and Hono node backends", () => {
    const root = tmpDir();
    writeFiles(root, {
      "nest/package.json": { dependencies: { "@nestjs/core": "11" }, scripts: { start: "node dist/main.js" } },
      "nest/package-lock.json": "{}",
      "ho/package.json": { dependencies: { hono: "4" }, main: "server.js" },
      "ho/server.js": "",
    });
    expect(detectBackend(root, "nest")).toMatchObject({ framework: "nestjs", runtime: "node", startCommand: "npm start" });
    expect(detectBackend(root, "ho")).toMatchObject({ framework: "hono", runtime: "node", startCommand: "node server.js" });
  });

  it("detects Python backends: FastAPI, Flask and Django", () => {
    const root = tmpDir();
    writeFiles(root, {
      "fa/requirements.txt": "fastapi\nuvicorn[standard]==0.30.0\n",
      "fa/main.py": "app = ...\n",
      "fl/requirements.txt": "flask\ngunicorn\n",
      "fl/app.py": "app = ...\n",
      "dj/requirements.txt": "django\ngunicorn\n",
      "dj/manage.py": "",
      "dj/myapp/settings.py": "",
    });
    expect(detectBackend(root, "fa")).toMatchObject({
      framework: "fastapi",
      runtime: "python",
      packageManager: "pip",
      buildCommand: "pip install -r requirements.txt",
      startCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
    });
    expect(detectBackend(root, "fl")).toMatchObject({
      framework: "flask",
      runtime: "python",
      startCommand: "gunicorn -b 0.0.0.0:$PORT app:app",
    });
    expect(detectBackend(root, "dj")).toMatchObject({
      framework: "django",
      runtime: "python",
      startCommand: "gunicorn -b 0.0.0.0:$PORT myapp.wsgi",
    });
  });

  it("detects python backends without requirements.txt via pyproject.toml", () => {
    const root = tmpDir();
    writeFiles(root, { "pp/pyproject.toml": "[project]\nname = 'x'\ndependencies = ['fastapi']\n", "pp/main.py": "app = ...\n" });
    expect(detectBackend(root, "pp")).toMatchObject({ framework: "fastapi", runtime: "python", packageManager: "pip" });
    // No requirements.txt and no lockfile: pip can't install PEP 621 deps without building the project, uv can.
    expect(detectBackend(root, "pp")?.buildCommand).toBe("pip install uv && uv pip install -r pyproject.toml && pip install uvicorn");
    expect(detectBackend(root, "pp")?.startCommand).toBe("uvicorn main:app --host 0.0.0.0 --port $PORT");
  });

  it("detects Go backends and their framework from go.mod", () => {
    const root = tmpDir();
    writeFiles(root, {
      "gin-api/go.mod": "module example.com/api\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
      "plain/go.mod": "module example.com/plain\n\ngo 1.22\n",
      "cmdsvc/go.mod": "module example.com/cmdsvc\n\ngo 1.22\n",
      "cmdsvc/cmd/worker/main.go": "",
      "cmdsvc/cmd/server/main.go": "",
    });
    expect(detectBackend(root, "gin-api")).toMatchObject({ framework: "gin", runtime: "go", buildCommand: "go build -o app .", startCommand: "./app" });
    expect(detectBackend(root, "plain")).toMatchObject({ framework: "go", runtime: "go" });
    expect(detectBackend(root, "cmdsvc")?.buildCommand).toBe("go build -o app ./cmd/server");
  });

  it("detects Rust, Ruby and Dockerfile backends", () => {
    const root = tmpDir();
    writeFiles(root, {
      "rs/Cargo.toml": "[package]\nname = 'webapi'\n[dependencies]\naxum = '0.7'\n",
      "rb/Gemfile": "source 'https://rubygems.org'\ngem 'rails'\n",
      "dk/Dockerfile": "FROM node:22\nCMD [\"node\", \"server.js\"]\n",
    });
    expect(detectBackend(root, "rs")).toMatchObject({ framework: "axum", runtime: "rust", buildCommand: "cargo build --release", startCommand: "./target/release/webapi" });
    expect(detectBackend(root, "rb")).toMatchObject({ framework: "rails", runtime: "ruby", startCommand: "bundle exec rails server -b 0.0.0.0 -p $PORT" });
    expect(detectBackend(root, "dk")).toMatchObject({
      framework: "docker",
      runtime: "docker",
      dockerfilePath: "./Dockerfile",
      startCommand: undefined,
    });
  });

  it("still prefers a package.json frontend over a Dockerfile in the same folder", () => {
    const root = tmpDir();
    writeFiles(root, {
      "package.json": { dependencies: { express: "5" } },
      "server.js": "",
      "Dockerfile": "FROM node:22\n",
    });
    const d = detectApps(root);
    expect(d.backends).toHaveLength(1);
    expect(d.backends[0]).toMatchObject({ framework: "express", runtime: "node" });
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
    expect(msgs.some((m) => m.includes("PORT env var"))).toBe(true);
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

  it("applies runtime-specific PORT/listen checks to Python and Go", () => {
    const root = tmpDir();
    writeFiles(root, {
      "py/requirements.txt": "aiohttp\n",
      "py/app.py": "web.run_app(app)\nuvicorn.run(app, host='127.0.0.1')\n",
      "go/go.mod": "module x\n\ngo 1.22\n",
      "go/main.go": 'func main() { http.ListenAndServe("127.0.0.1:8080", nil) }\n',
    });
    const pyMsgs = checkBackend(root, detectBackend(root, "py")!).map((f) => f.message);
    expect(pyMsgs.some((m) => m.includes("PORT env var"))).toBe(true);
    expect(pyMsgs.some((m) => m.includes("only listens on localhost"))).toBe(true);
    const goMsgs = checkBackend(root, detectBackend(root, "go")!).map((f) => f.message);
    expect(goMsgs.some((m) => m.includes("PORT env var"))).toBe(true);

    // Fixed versions are quiet.
    writeFiles(root, {
      "py2/requirements.txt": "flask\n",
      "py2/app.py": 'import os\nport = int(os.getenv("PORT", 8000))\napp.run(host="0.0.0.0", port=port)\n',
      "go2/go.mod": "module x\n\ngo 1.22\n",
      "go2/main.go": 'func main() { port := os.Getenv("PORT"); http.ListenAndServe(":"+port, nil) }\n',
    });
    expect(checkBackend(root, detectBackend(root, "py2")!)).toEqual([]);
    expect(checkBackend(root, detectBackend(root, "go2")!)).toEqual([]);

    // gunicorn/uvicorn started by ShipOne with $PORT and 0.0.0.0: the dev-server call doesn't matter.
    writeFiles(root, { "py3/requirements.txt": "flask\n", "py3/app.py": "app = Flask(__name__)\nif __name__ == '__main__':\n    app.run(host='127.0.0.1')\n" });
    expect(detectBackend(root, "py3")?.startCommand).toBe("gunicorn -b 0.0.0.0:$PORT app:app");
    expect(checkBackend(root, detectBackend(root, "py3")!)).toEqual([]);
  });

  it("skips node-specific checks for Docker backends", () => {
    const root = tmpDir();
    writeFiles(root, { "Dockerfile": "FROM node:22\nEXPOSE 8080\n" });
    expect(checkBackend(root, detectBackend(root, ".")!)).toEqual([]);
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
