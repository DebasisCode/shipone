import { describe, expect, it } from "vitest";
import { candidateDirs, detectApps, detectBackend, detectFrontend, pickObvious, VERCEL_FRAMEWORK_SLUG, type BackendApp } from "../src/core/detect.js";
import { tmpDir, writeFiles } from "./helpers.js";

/**
 * Real-world repo shapes, one per test. Each fixture mirrors what the
 * framework's own generator (or a typical project) puts on disk, and the
 * expected commands are the ones that work on Render's build image.
 */

type Files = Record<string, string | object>;

function repo(files: Files): string {
  const root = tmpDir();
  writeFiles(root, files);
  return root;
}

const PNPM_LOCK_V9 = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n";

describe("monorepos", () => {
  // The shape that failed live: pnpm workspace, Fastify API in TypeScript, Vite web app, shared package.
  const PNPM_TURBO: Files = {
    "package.json": { name: "jobpilot", private: true, packageManager: "pnpm@10.12.1", devDependencies: { turbo: "2", vitest: "3", vite: "7" } },
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    "pnpm-lock.yaml": PNPM_LOCK_V9,
    "turbo.json": "{}",
    "apps/web/package.json": { name: "@jp/web", scripts: { build: "vite build" }, dependencies: { react: "19", "@jp/shared": "workspace:*" }, devDependencies: { vite: "7" } },
    "apps/web/index.html": "<div id=root></div>",
    "apps/web/src/api.ts": "export const base = import.meta.env.VITE_API_URL;\n",
    "apps/api/package.json": {
      name: "@jp/api",
      scripts: { build: "tsc", start: "node dist/index.js", dev: "tsx watch src/index.ts", test: "vitest" },
      dependencies: { fastify: "5", "@jp/shared": "workspace:*" },
      devDependencies: { typescript: "5", vite: "7", vitest: "3" },
    },
    "apps/api/src/index.ts": "import Fastify from 'fastify';\nFastify().listen({ port: Number(process.env.PORT), host: '0.0.0.0' });\n",
    "packages/shared/package.json": { name: "@jp/shared", main: "dist/index.js", scripts: { build: "tsc" } },
    "packages/shared/src/index.ts": "export const x = 1;\n",
    "packages/tsconfig/package.json": { name: "@jp/tsconfig" },
  };

  it("finds the web app and the API inside a pnpm/turbo workspace, not the repo root", () => {
    const d = detectApps(repo(PNPM_TURBO));
    expect(d.frontends.map((f) => f.path)).toEqual(["apps/web"]);
    expect(d.backends.map((b) => b.path)).toEqual(["apps/api"]);
  });

  it("builds the API's workspace dependencies first, with the pinned pnpm version and the root lockfile", () => {
    const api = detectBackend(repo(PNPM_TURBO), "apps/api")!;
    expect(api).toMatchObject({
      framework: "fastify",
      packageManager: "pnpm",
      buildCommand: 'npx pnpm@10.12.1 install --frozen-lockfile && npx pnpm@10.12.1 --filter "@jp/api..." run --if-present build',
      startCommand: "npx pnpm@10.12.1 start",
    });
  });

  it("doesn't mistake a server with vite/vitest devDependencies for a Vite frontend", () => {
    const root = repo({
      "server/package.json": { dependencies: { fastify: "5" }, devDependencies: { vite: "7", vitest: "3" }, scripts: { start: "node index.js" } },
      "server/index.js": "",
      "client/package.json": { devDependencies: { vite: "7" } },
      "client/index.html": "",
    });
    const d = detectApps(root);
    expect(d.frontends.map((f) => f.path)).toEqual(["client"]);
    expect(d.backends.map((b) => b.path)).toEqual(["server"]);
  });

  it("uses npm ci with an npm-workspaces root lockfile", () => {
    const root = repo({
      "package.json": { name: "root", private: true, workspaces: ["frontend", "backend"] },
      "package-lock.json": "{}",
      "frontend/package.json": { dependencies: { next: "15" } },
      "backend/package.json": { dependencies: { express: "5" }, scripts: { start: "node server.js" } },
    });
    const d = detectApps(root);
    expect(d.frontends).toMatchObject([{ path: "frontend", framework: "nextjs" }]);
    expect(d.backends).toMatchObject([{ path: "backend", buildCommand: "npm ci", startCommand: "npm start" }]);
  });

  it("doesn't use a frozen install when the root lockfile doesn't belong to the app", () => {
    // Root is a Vite app with its own pnpm lockfile; server/ is a separate, lockfile-less package.
    const root = repo({
      "package.json": { devDependencies: { vite: "7" } },
      "index.html": "",
      "pnpm-lock.yaml": PNPM_LOCK_V9,
      "server/package.json": { dependencies: { express: "5" }, scripts: { start: "node index.js" } },
    });
    expect(detectBackend(root, "server")).toMatchObject({ packageManager: "pnpm", buildCommand: "npx pnpm@latest-10 install" });
  });

  it("scans services/* and custom workspace folders", () => {
    const root = repo({
      "package.json": { private: true, workspaces: ["frontends/*", "services/*"] },
      "frontends/dashboard/package.json": { dependencies: { next: "15" } },
      "services/api/package.json": { dependencies: { koa: "2" }, scripts: { start: "node ." } },
      "services/worker/package.json": { dependencies: {} },
    });
    expect(candidateDirs(root)).toEqual(expect.arrayContaining(["frontends/dashboard", "services/api", "services/worker"]));
    const d = detectApps(root);
    expect(d.frontends.map((f) => f.path)).toEqual(["frontends/dashboard"]);
    expect(d.backends.map((b) => b.path)).toEqual(["services/api"]);
  });

  it("doesn't treat a shared tRPC/socket package as a deployable backend", () => {
    const root = repo({
      "apps/web/package.json": { dependencies: { next: "15", "@trpc/server": "11" } },
      "packages/api/package.json": { name: "@acme/api", main: "src/index.ts", dependencies: { "@trpc/server": "11" } },
      "packages/api/src/index.ts": "",
    });
    const d = detectApps(root);
    expect(d.backends).toEqual([]);
    expect(d.frontends.map((f) => f.path)).toEqual(["apps/web"]);
  });

  it("picks the obvious app by folder name at any depth", () => {
    expect(pickObvious("frontend", [{ path: "apps/docs" }, { path: "apps/web" }])?.path).toBe("apps/web");
    expect(pickObvious("backend", [{ path: "services/worker" }, { path: "services/api" }])?.path).toBe("services/api");
    expect(pickObvious("backend", [{ path: "." }, { path: "server" }])?.path).toBe("server");
    expect(pickObvious("frontend", [{ path: "apps/web" }, { path: "web" }])).toBeUndefined();
  });

  it("keeps a root app when the workspaces hold only libraries", () => {
    const root = repo({
      "package.json": { dependencies: { next: "15" }, workspaces: ["packages/*"] },
      "packages/ui/package.json": { name: "ui", dependencies: { react: "19" } },
    });
    expect(detectApps(root).frontends.map((f) => f.path)).toEqual(["."]);
  });
});

describe("node package managers", () => {
  it("pins pnpm to a version that can read old lockfiles", () => {
    const root = repo({
      "v6/package.json": { dependencies: { express: "4" }, scripts: { start: "node ." } },
      "v6/pnpm-lock.yaml": "lockfileVersion: '6.0'\n",
      "v5/package.json": { dependencies: { express: "4" }, scripts: { start: "node ." } },
      "v5/pnpm-lock.yaml": "lockfileVersion: 5.4\n",
      "field/package.json": { packageManager: "pnpm@9.15.4+sha512.b2dc20e2fc72b3e18848459b37359a32064663e5627a51e4c74b2c29dd8e8e0491483c3abb40789cfd578bf362fb6ba8261b05f0387d76792ed6e23ea3b1b6a0", dependencies: { express: "4" } },
      "field/pnpm-lock.yaml": PNPM_LOCK_V9,
    });
    expect(detectBackend(root, "v6")?.buildCommand).toBe("npx pnpm@8 install --frozen-lockfile");
    expect(detectBackend(root, "v5")?.buildCommand).toBe("npx pnpm@7 install --frozen-lockfile");
    expect(detectBackend(root, "field")?.buildCommand).toBe("npx pnpm@9.15.4 install --frozen-lockfile");
  });

  it("runs Yarn 2+ through its own CLI (Render only ships Yarn 1)", () => {
    const root = repo({
      "api/package.json": { packageManager: "yarn@4.5.0", dependencies: { express: "5" }, scripts: { build: "tsc", start: "node dist/index.js" } },
      "api/yarn.lock": '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"express@npm:5":\n',
      "api/.yarnrc.yml": "nodeLinker: node-modules\n",
      "classic/package.json": { dependencies: { express: "5" }, scripts: { start: "node index.js" } },
      "classic/yarn.lock": "# yarn lockfile v1\n",
    });
    expect(detectBackend(root, "api")).toMatchObject({
      packageManager: "yarn",
      buildCommand: "npx -y -p @yarnpkg/cli-dist@4 yarn install --immutable && npx -y -p @yarnpkg/cli-dist@4 yarn build",
      startCommand: "npx -y -p @yarnpkg/cli-dist@4 yarn start",
    });
    expect(detectBackend(root, "classic")).toMatchObject({ buildCommand: "yarn install --frozen-lockfile", startCommand: "yarn start" });
  });

  it("uses the packageManager field when there's no lockfile yet", () => {
    const root = repo({ "server/package.json": { packageManager: "pnpm@10.0.0", dependencies: { express: "5" }, scripts: { start: "node ." } } });
    expect(detectBackend(root, "server")).toMatchObject({ packageManager: "pnpm", buildCommand: "npx pnpm@10.0.0 install" });
  });

  it("never installs anything globally", () => {
    const root = repo({
      "a/package.json": { dependencies: { express: "5" }, scripts: { start: "node ." } },
      "a/pnpm-lock.yaml": PNPM_LOCK_V9,
      "b/package.json": { packageManager: "yarn@4.1.0", dependencies: { express: "5" }, scripts: { start: "node ." } },
    });
    for (const rel of ["a", "b"]) {
      const cmd = `${detectBackend(root, rel)?.buildCommand} ${detectBackend(root, rel)?.startCommand}`;
      expect(cmd).not.toMatch(/npm (?:i|install) -g|corepack enable/);
    }
  });
});

describe("node backends", () => {
  it("labels NestJS as nestjs even though it depends on express", () => {
    const root = repo({
      "api/package.json": {
        dependencies: { "@nestjs/core": "11", "@nestjs/platform-express": "11", express: "5" },
        scripts: { build: "nest build", start: "nest start", "start:prod": "node dist/main" },
      },
      "api/package-lock.json": "{}",
    });
    expect(detectBackend(root, "api")).toMatchObject({ framework: "nestjs", buildCommand: "npm ci && npm run build", startCommand: "npm start" });
  });

  it("detects a Hono app that only lists @hono/node-server", () => {
    const root = repo({ "api/package.json": { dependencies: { "@hono/node-server": "1" }, scripts: { start: "node dist/index.js" } } });
    expect(detectBackend(root, "api")).toMatchObject({ framework: "hono" });
  });

  it("detects a plain node:http server in a folder called server/backend/api", () => {
    const root = repo({
      "server/package.json": { scripts: { start: "node index.js" } },
      "server/index.js": "require('http').createServer().listen(process.env.PORT);\n",
      "tools/package.json": { scripts: { start: "node x.js" } },
    });
    expect(detectBackend(root, "server")).toMatchObject({ framework: "node", runtime: "node", startCommand: "npm start" });
    expect(detectBackend(root, "tools")).toBeUndefined();
  });

  it("finds main.js / src/main.js entry points without a start script", () => {
    const root = repo({
      "a/package.json": { dependencies: { express: "5" } },
      "a/main.js": "",
      "b/package.json": { dependencies: { express: "5" } },
      "b/src/main.js": "",
    });
    expect(detectBackend(root, "a")?.startCommand).toBe("node main.js");
    expect(detectBackend(root, "b")?.startCommand).toBe("node src/main.js");
  });
});

describe("python backends", () => {
  it("FastAPI in the app/ package layout (fastapi's own docs layout)", () => {
    const root = repo({
      "backend/requirements.txt": "fastapi[standard]==0.115.0\nsqlalchemy\n",
      "backend/app/__init__.py": "",
      "backend/app/main.py": "from fastapi import FastAPI\n\napp = FastAPI(title='x')\n",
    });
    expect(detectBackend(root, "backend")).toMatchObject({
      framework: "fastapi",
      buildCommand: "pip install -r requirements.txt",
      startCommand: "uvicorn app.main:app --host 0.0.0.0 --port $PORT",
    });
  });

  it("FastAPI with a src/ layout and a differently named app object", () => {
    const root = repo({
      "api/requirements.txt": "fastapi\nuvicorn\n",
      "api/src/main.py": "import fastapi\napi: fastapi.FastAPI = fastapi.FastAPI()\n",
    });
    expect(detectBackend(root, "api")?.startCommand).toBe("uvicorn main:api --host 0.0.0.0 --port $PORT --app-dir src");
  });

  it("installs uvicorn when FastAPI is listed without a server", () => {
    const root = repo({ "api/requirements.txt": "fastapi\npydantic\n", "api/main.py": "from fastapi import FastAPI\napp = FastAPI()\n" });
    expect(detectBackend(root, "api")).toMatchObject({
      buildCommand: "pip install -r requirements.txt && pip install uvicorn",
      startCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
    });
  });

  it("prefers the file that actually creates the app over a helper main.py", () => {
    const root = repo({
      "api/requirements.txt": "fastapi\nuvicorn\n",
      "api/main.py": "print('cli helper')\n",
      "api/app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    });
    expect(detectBackend(root, "api")?.startCommand).toBe("uvicorn app.main:app --host 0.0.0.0 --port $PORT");
  });

  it("Flask without gunicorn gets gunicorn instead of the localhost-only dev server", () => {
    const root = repo({ "api/requirements.txt": "Flask==3.0.0\nflask-cors\n", "api/app.py": "from flask import Flask\napp = Flask(__name__)\n" });
    expect(detectBackend(root, "api")).toMatchObject({
      framework: "flask",
      buildCommand: "pip install -r requirements.txt && pip install gunicorn",
      startCommand: "gunicorn -b 0.0.0.0:$PORT app:app",
    });
  });

  it("Flask application factory (create_app) in a package", () => {
    const root = repo({
      "api/requirements.txt": "flask\ngunicorn\n",
      "api/app/__init__.py": "from flask import Flask\n\ndef create_app():\n    return Flask(__name__)\n",
    });
    expect(detectBackend(root, "api")?.startCommand).toBe('gunicorn -b 0.0.0.0:$PORT "app:create_app()"');
  });

  it("Django with a settings/ package, found from manage.py", () => {
    const root = repo({
      "backend/requirements.txt": "Django>=5\npsycopg[binary]\n",
      "backend/manage.py": "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')\n",
      "backend/config/__init__.py": "",
      "backend/config/wsgi.py": "",
      "backend/config/settings/__init__.py": "",
      "backend/config/settings/base.py": "",
    });
    expect(detectBackend(root, "backend")).toMatchObject({
      framework: "django",
      buildCommand: "pip install -r requirements.txt && pip install gunicorn",
      startCommand: "gunicorn -b 0.0.0.0:$PORT config.wsgi",
    });
  });

  it("follows -r includes in requirements.txt", () => {
    const root = repo({
      "dj/requirements.txt": "-r requirements/prod.txt\n",
      "dj/requirements/prod.txt": "-r base.txt\ngunicorn\n",
      "dj/requirements/base.txt": "Django==5.1\n",
      "dj/manage.py": "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')\n",
      "dj/core/wsgi.py": "",
      "fa/requirements.txt": "--requirement requirements-base.txt\n",
      "fa/requirements-base.txt": "fastapi\nuvicorn\n",
      "fa/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    });
    expect(detectBackend(root, "dj")).toMatchObject({ framework: "django", buildCommand: "pip install -r requirements.txt", startCommand: "gunicorn -b 0.0.0.0:$PORT core.wsgi" });
    expect(detectBackend(root, "fa")).toMatchObject({ framework: "fastapi", buildCommand: "pip install -r requirements.txt" });
  });

  it("runs poetry and uv apps inside their environment", () => {
    const root = repo({
      "po/pyproject.toml": "[tool.poetry]\nname = 'svc'\n\n[tool.poetry.dependencies]\npython = '^3.12'\nfastapi = '*'\nuvicorn = '*'\n",
      "po/poetry.lock": "",
      "po/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      "uv/pyproject.toml": "[project]\nname = 'svc'\ndependencies = ['flask', 'gunicorn']\n",
      "uv/uv.lock": "",
      "uv/app.py": "from flask import Flask\napp = Flask(__name__)\n",
    });
    expect(detectBackend(root, "po")).toMatchObject({
      packageManager: "poetry",
      buildCommand: "pip install poetry && poetry install --no-interaction --no-root",
      startCommand: "poetry run uvicorn main:app --host 0.0.0.0 --port $PORT",
    });
    expect(detectBackend(root, "uv")).toMatchObject({
      packageManager: "uv",
      buildCommand: "pip install uv && uv sync --frozen",
      startCommand: "uv run --no-sync gunicorn -b 0.0.0.0:$PORT app:app",
    });
  });

  it("detects Pipfile projects", () => {
    const root = repo({ "api/Pipfile": '[packages]\nflask = "*"\ngunicorn = "*"\n', "api/Pipfile.lock": "{}", "api/app.py": "app = Flask(__name__)\n" });
    expect(detectBackend(root, "api")).toMatchObject({
      packageManager: "pipenv",
      buildCommand: "pip install pipenv && pipenv install --system --deploy",
      startCommand: "gunicorn -b 0.0.0.0:$PORT app:app",
    });
  });

  it("installs a pyproject package that declares a build system", () => {
    const root = repo({
      "api/pyproject.toml": "[build-system]\nrequires = ['hatchling']\nbuild-backend = 'hatchling.build'\n\n[project]\nname='svc'\ndependencies=['fastapi', 'uvicorn']\n",
      "api/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    });
    expect(detectBackend(root, "api")?.buildCommand).toBe("pip install .");
  });

  it("doesn't call Flask a FastAPI app because of a similarly named package", () => {
    const root = repo({ "api/requirements.txt": "flask\nfastapi-utils-docs\ngunicorn\n", "api/app.py": "from flask import Flask\napp = Flask(__name__)\n" });
    expect(detectBackend(root, "api")?.framework).toBe("flask");
  });
});

describe("go backends", () => {
  const GO_MOD = (deps = "") => `module github.com/me/svc\n\ngo 1.23\n${deps}`;

  it("builds cmd/api when that's where main lives", () => {
    const root = repo({
      "api/go.mod": GO_MOD("require github.com/go-chi/chi/v5 v5.1.0\n"),
      "api/cmd/api/main.go": "package main\n\nfunc main() {}\n",
      "api/cmd/migrate/main.go": "package main\n\nfunc main() {}\n",
      "api/internal/handlers/h.go": "package handlers\n",
    });
    expect(detectBackend(root, "api")).toMatchObject({ framework: "chi", buildCommand: "go build -o app ./cmd/api", startCommand: "./app" });
  });

  it("builds cmd/ itself when main.go is directly inside it", () => {
    const root = repo({ "svc/go.mod": GO_MOD(), "svc/cmd/main.go": "package main\n\nfunc main() {}\n" });
    expect(detectBackend(root, "svc")?.buildCommand).toBe("go build -o app ./cmd");
  });

  it("doesn't write the binary into an existing app/ folder", () => {
    const root = repo({
      "svc/go.mod": GO_MOD("require github.com/gofiber/fiber/v2 v2.52.0\n"),
      "svc/main.go": "package main\n\nfunc main() {}\n",
      "svc/app/routes.go": "package app\n",
    });
    expect(detectBackend(root, "svc")).toMatchObject({ framework: "fiber", buildCommand: "go build -o .bin/app .", startCommand: "./.bin/app" });
  });

  it("prefers the root main package over cmd/ tools", () => {
    const root = repo({
      "svc/go.mod": GO_MOD("require github.com/labstack/echo/v4 v4.12.0\n"),
      "svc/main.go": "// entry\npackage main\n\nfunc main() {}\n",
      "svc/cmd/seed/main.go": "package main\n",
    });
    expect(detectBackend(root, "svc")).toMatchObject({ framework: "echo", buildCommand: "go build -o app ." });
  });
});

describe("rust backends", () => {
  it("uses the [[bin]] name and a workspace's shared target dir", () => {
    const root = repo({
      "Cargo.toml": "[workspace]\nmembers = ['crates/*', 'api']\n",
      "api/Cargo.toml": "[package]\nname = 'my-api'\nversion = '0.1.0'\n\n[[bin]]\nname = 'server'\npath = 'src/main.rs'\n\n[dependencies]\naxum = '0.8'\n",
    });
    expect(detectBackend(root, "api")).toMatchObject({ framework: "axum", startCommand: "../target/release/server" });
  });

  it("ignores `name` keys in dependency tables", () => {
    const root = repo({
      "svc/Cargo.toml": "[dependencies]\nactix-web = '4'\n\n[package]\nname = 'svc-bin'\nversion = '0.1.0'\n",
    });
    expect(detectBackend(root, "svc")).toMatchObject({ framework: "actix", startCommand: "./target/release/svc-bin" });
  });
});

describe("ruby backends", () => {
  it("starts Rails with its puma config (rackup isn't bundled with Rails 7.1+)", () => {
    const root = repo({
      "api/Gemfile": "source 'https://rubygems.org'\ngem \"rails\", \"~> 8.0\"\ngem \"puma\"\n",
      "api/config.ru": "require_relative 'config/environment'\nrun Rails.application\n",
      "api/config/puma.rb": "port ENV.fetch('PORT', 3000)\n",
    });
    expect(detectBackend(root, "api")).toMatchObject({ framework: "rails", startCommand: "bundle exec puma -C config/puma.rb" });
  });

  it("binds Sinatra to 0.0.0.0:$PORT", () => {
    const root = repo({
      "classic/Gemfile": "gem 'sinatra'\ngem 'puma'\n",
      "classic/app.rb": "require 'sinatra'\nget('/') { 'ok' }\n",
      "modular/Gemfile": "gem 'sinatra'\ngem 'puma'\n",
      "modular/config.ru": "require './app'\nrun App\n",
      "modular/app.rb": "",
    });
    expect(detectBackend(root, "classic")?.startCommand).toBe("bundle exec ruby app.rb -o 0.0.0.0 -p $PORT");
    expect(detectBackend(root, "modular")?.startCommand).toBe("bundle exec puma -b tcp://0.0.0.0:$PORT");
  });
});

describe("frontends", () => {
  it("detects Vue CLI, React Router v7 and SolidStart with the right env prefix", () => {
    const root = repo({
      "vue/package.json": { dependencies: { vue: "3" }, devDependencies: { "@vue/cli-service": "5" } },
      "rr/package.json": { dependencies: { "react-router": "7" }, devDependencies: { "@react-router/dev": "7", vite: "6" } },
      "solid/package.json": { dependencies: { "@solidjs/start": "1", vinxi: "0.5" } },
    });
    expect(detectFrontend(root, "vue")).toMatchObject({ framework: "vue", apiUrlEnv: "VUE_APP_API_URL" });
    expect(detectFrontend(root, "rr")).toMatchObject({ framework: "react-router", apiUrlEnv: "VITE_API_URL" });
    expect(detectFrontend(root, "solid")).toMatchObject({ framework: "solidstart", apiUrlEnv: "VITE_API_URL" });
  });

  it("keeps a Vite SPA that also has an express dependency (e.g. for a dev proxy) as a frontend", () => {
    const root = repo({ "web/package.json": { dependencies: { express: "5", react: "19" }, devDependencies: { vite: "7" } }, "web/index.html": "" });
    expect(detectFrontend(root, "web")?.framework).toBe("vite");
  });

  it("maps every framework to a Vercel preset slug", () => {
    expect(VERCEL_FRAMEWORK_SLUG.nuxt).toBe("nuxtjs");
    for (const slug of Object.values(VERCEL_FRAMEWORK_SLUG)) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("every detected backend is deployable on Render", () => {
  // One fixture per popular stack. Whatever else changes, each must come out
  // with a start command, bind $PORT where we choose the port, and never
  // touch read-only system dirs.
  const STACKS: Files = {
    "express/package.json": { dependencies: { express: "5" }, scripts: { start: "node index.js" } },
    "express/package-lock.json": "{}",
    "fastify-pnpm/package.json": { dependencies: { fastify: "5" }, scripts: { build: "tsc", start: "node dist/index.js" } },
    "fastify-pnpm/pnpm-lock.yaml": PNPM_LOCK_V9,
    "nest/package.json": { dependencies: { "@nestjs/core": "11" }, scripts: { build: "nest build", start: "node dist/main" } },
    "nest/yarn.lock": "",
    "fastapi/requirements.txt": "fastapi\nuvicorn\n",
    "fastapi/main.py": "app = FastAPI()\n",
    "flask/requirements.txt": "flask\n",
    "flask/app.py": "app = Flask(__name__)\n",
    "django/requirements.txt": "django\n",
    "django/manage.py": "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings')\n",
    "django/mysite/wsgi.py": "",
    "gin/go.mod": "module x\n\ngo 1.23\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
    "gin/main.go": "package main\n",
    "axum/Cargo.toml": "[package]\nname = 'api'\n\n[dependencies]\naxum = '0.8'\n",
    "rails/Gemfile": "gem 'rails'\n",
    "sinatra/Gemfile": "gem 'sinatra'\n",
    "sinatra/app.rb": "",
  };

  const root = repo(STACKS);
  const names = [...new Set(Object.keys(STACKS).map((k) => k.split("/")[0]!))];
  it.each(names)("%s", (name) => {
    const app = detectBackend(root, name) as BackendApp;
    expect(app, name).toBeDefined();
    expect(app.startCommand, name).toBeTruthy();
    expect(`${app.buildCommand} ${app.startCommand}`).not.toMatch(/npm (?:i|install) -g|corepack enable|sudo|apt-get/);
    if (app.runtime === "python" || app.runtime === "ruby") expect(app.startCommand).toMatch(/\$PORT|puma -C/);
  });
});
