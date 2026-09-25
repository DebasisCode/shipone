/**
 * Minimal but real projects for the smoke test: each one installs, builds and
 * serves HTTP on $PORT when its commands are right. `setup` runs on the
 * "developer machine" (full PATH) to produce what a real repo would commit,
 * e.g. lockfiles. Detection and the build/start commands then run in a
 * Render-like environment.
 */

export interface SmokeFixture {
  name: string;
  /** Which backend folder detection should pick. */
  expectBackend: string;
  expectFrontend?: string;
  files: Record<string, string | object>;
  /** Shell commands run from the repo root before detection (lockfile generation etc.). */
  setup?: string[];
  /** Slow fixtures (compiling Rust) only run with --all. */
  slow?: boolean;
}

const nodeHttp = (framework: "express" | "fastify" | "koa" | "hono") => {
  switch (framework) {
    case "express":
      return "const express = require('express');\nconst app = express();\napp.get('/', (_q, r) => r.send('ok'));\napp.listen(process.env.PORT || 5000);\n";
    case "fastify":
      return "const f = require('fastify')();\nf.get('/', async () => 'ok');\nf.listen({ port: Number(process.env.PORT) || 5000, host: '0.0.0.0' });\n";
    case "koa":
      return "const Koa = require('koa');\nconst app = new Koa();\napp.use((ctx) => { ctx.body = 'ok'; });\napp.listen(process.env.PORT || 5000);\n";
    case "hono":
      return "const { Hono } = require('hono');\nconst { serve } = require('@hono/node-server');\nconst app = new Hono();\napp.get('/', (c) => c.text('ok'));\nserve({ fetch: app.fetch, port: Number(process.env.PORT) || 5000 });\n";
  }
};

const VITE_WEB = {
  "package.json": { name: "web", private: true, scripts: { build: "vite build" }, devDependencies: { vite: "^7.0.0" } },
  "index.html": "<!doctype html><div id=app></div><script type=module src=/src/main.js></script>",
  "src/main.js": "fetch(`${import.meta.env.VITE_API_URL}/`);\n",
};

const prefix = (dir: string, files: Record<string, string | object>) => Object.fromEntries(Object.entries(files).map(([k, v]) => [`${dir}/${k}`, v]));

const TSCONFIG = { compilerOptions: { target: "ES2022", module: "commonjs", outDir: "dist", rootDir: "src", declaration: true, strict: true, esModuleInterop: true, skipLibCheck: true } };

export const FIXTURES: SmokeFixture[] = [
  {
    name: "node: vite client + express server (npm)",
    expectFrontend: "client",
    expectBackend: "server",
    files: {
      ...prefix("client", VITE_WEB),
      "server/package.json": { name: "server", private: true, scripts: { start: "node index.js" }, dependencies: { express: "^5.1.0" } },
      "server/index.js": nodeHttp("express"),
    },
    setup: ["cd server && npm install --package-lock-only --silent"],
  },
  {
    name: "node: pnpm workspace, TypeScript fastify API importing a workspace package (the jobPilot shape)",
    expectFrontend: "apps/web",
    expectBackend: "apps/api",
    files: {
      "package.json": { name: "mono", private: true, packageManager: "pnpm@10.12.1", devDependencies: { vite: "^7.0.0" } },
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
      ...prefix("apps/web", VITE_WEB),
      "apps/api/package.json": {
        name: "@mono/api",
        private: true,
        scripts: { build: "tsc", start: "node dist/index.js", test: "vitest" },
        dependencies: { fastify: "^5.4.0", "@mono/shared": "workspace:*" },
        devDependencies: { typescript: "^5.8.0", "@types/node": "^22.0.0", vite: "^7.0.0" },
      },
      "apps/api/tsconfig.json": TSCONFIG,
      "apps/api/src/index.ts":
        "import Fastify from 'fastify';\nimport { greeting } from '@mono/shared';\nconst app = Fastify();\napp.get('/', async () => greeting);\napp.listen({ port: Number(process.env.PORT) || 5000, host: '0.0.0.0' });\n",
      "packages/shared/package.json": { name: "@mono/shared", private: true, main: "dist/index.js", types: "dist/index.d.ts", scripts: { build: "tsc" }, devDependencies: { typescript: "^5.8.0" } },
      "packages/shared/tsconfig.json": TSCONFIG,
      "packages/shared/src/index.ts": "export const greeting = 'ok';\n",
    },
    setup: ["npx -y pnpm@10.12.1 install --lockfile-only --silent"],
  },
  {
    name: "node: fastify server with vite/vitest devDependencies (pnpm, lockfile v9, no packageManager field)",
    expectBackend: "server",
    files: {
      "server/package.json": { name: "server", private: true, scripts: { start: "node index.js" }, dependencies: { fastify: "^5.4.0" }, devDependencies: { vite: "^7.0.0", vitest: "^3.2.0" } },
      "server/index.js": nodeHttp("fastify"),
    },
    setup: ["cd server && npx -y pnpm@10.12.1 install --lockfile-only --silent"],
  },
  {
    name: "node: hono with @hono/node-server (yarn classic)",
    expectBackend: "api",
    files: {
      "api/package.json": { name: "api", private: true, scripts: { start: "node index.js" }, dependencies: { hono: "^4.7.0", "@hono/node-server": "^1.14.0" } },
      "api/index.js": nodeHttp("hono"),
    },
    setup: ["cd api && yarn install --silent && rm -rf node_modules"],
  },
  {
    name: "node: express with Yarn 4 (Plug'n'Play)",
    expectBackend: "server",
    files: {
      "server/package.json": { name: "server", private: true, packageManager: "yarn@4.9.2", scripts: { start: "node index.js" }, dependencies: { express: "^5.1.0" } },
      "server/index.js": nodeHttp("express"),
    },
    setup: ["cd server && touch yarn.lock && npx -y -p @yarnpkg/cli-dist@4 yarn install --mode=update-lockfile && rm -rf .yarn/cache .yarn/install-state.gz .pnp.*"],
  },
  {
    name: "node: npm workspaces, koa backend, lockfile at the root",
    expectBackend: "backend",
    files: {
      "package.json": { name: "root", private: true, workspaces: ["backend"] },
      "backend/package.json": { name: "backend", private: true, scripts: { start: "node index.js" }, dependencies: { koa: "^2.16.0" } },
      "backend/index.js": nodeHttp("koa"),
    },
    setup: ["npm install --package-lock-only --silent"],
  },
  {
    name: "python: FastAPI, app/main.py, fastapi[standard]",
    expectBackend: "backend",
    files: {
      "backend/requirements.txt": "fastapi[standard]>=0.115\n",
      "backend/app/__init__.py": "",
      "backend/app/main.py": "from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get('/')\ndef root():\n    return {'ok': True}\n",
    },
  },
  {
    name: "python: FastAPI without uvicorn in requirements, src/ layout",
    expectBackend: "api",
    files: {
      "api/requirements.txt": "fastapi\n",
      "api/src/main.py": "from fastapi import FastAPI\n\napi = FastAPI()\n\n@api.get('/')\ndef root():\n    return 'ok'\n",
    },
  },
  {
    name: "python: Flask app factory, no gunicorn",
    expectBackend: "server",
    files: {
      "server/requirements.txt": "Flask>=3\n",
      "server/app/__init__.py": "from flask import Flask\n\ndef create_app():\n    app = Flask(__name__)\n\n    @app.get('/')\n    def root():\n        return 'ok'\n\n    return app\n",
    },
  },
  {
    name: "python: Django with a settings/ package",
    expectBackend: "backend",
    files: {
      "backend/requirements.txt": "Django>=5,<6\n",
      "backend/manage.py":
        "#!/usr/bin/env python\nimport os, sys\n\nif __name__ == '__main__':\n    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.base')\n    from django.core.management import execute_from_command_line\n    execute_from_command_line(sys.argv)\n",
      "backend/config/__init__.py": "",
      "backend/config/settings/__init__.py": "",
      "backend/config/settings/base.py":
        "SECRET_KEY = 'x'\nDEBUG = False\nALLOWED_HOSTS = ['*']\nROOT_URLCONF = 'config.urls'\nINSTALLED_APPS = []\nMIDDLEWARE = []\nDATABASES = {}\n",
      "backend/config/urls.py": "from django.http import HttpResponse\nfrom django.urls import path\n\nurlpatterns = [path('', lambda r: HttpResponse('ok'))]\n",
      "backend/config/wsgi.py":
        "import os\nfrom django.core.wsgi import get_wsgi_application\n\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.base')\napplication = get_wsgi_application()\n",
    },
  },
  {
    name: "python: uv project at the repo root (FastAPI)",
    expectBackend: ".",
    files: {
      "pyproject.toml": "[project]\nname = 'svc'\nversion = '0.1.0'\nrequires-python = '>=3.10'\ndependencies = ['fastapi', 'uvicorn']\n",
      "main.py": "from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get('/')\ndef root():\n    return 'ok'\n",
    },
    setup: ["uv lock -q"],
  },
  {
    name: "python: uv project in a subfolder (Flask, gunicorn)",
    expectBackend: "api",
    files: {
      "api/pyproject.toml": "[project]\nname = 'svc'\nversion = '0.1.0'\nrequires-python = '>=3.10'\ndependencies = ['flask', 'gunicorn']\n",
      "api/app.py": "from flask import Flask\n\napp = Flask(__name__)\n\n@app.get('/')\ndef root():\n    return 'ok'\n",
    },
    setup: ["cd api && uv lock -q"],
  },
  {
    name: "python: Poetry project whose name doesn't match a package folder",
    expectBackend: "server",
    files: {
      "server/pyproject.toml":
        "[project]\nname = 'my-service'\nversion = '0.1.0'\nrequires-python = '>=3.10'\ndependencies = ['flask', 'gunicorn']\n\n[build-system]\nrequires = ['poetry-core>=2.0.0']\nbuild-backend = 'poetry.core.masonry.api'\n",
      "server/app.py": "from flask import Flask\n\napp = Flask(__name__)\n\n@app.get('/')\ndef root():\n    return 'ok'\n",
    },
    setup: ["cd server && poetry lock -q"],
  },
  {
    name: "python: pyproject.toml only, no lockfile, no requirements.txt",
    expectBackend: "api",
    files: {
      "api/pyproject.toml": "[project]\nname = 'svc'\nversion = '0.1.0'\ndependencies = ['fastapi']\n",
      "api/main.py": "from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get('/')\ndef root():\n    return 'ok'\n",
    },
  },
  {
    name: "python: Pipfile without a lock",
    expectBackend: "api",
    files: {
      "api/Pipfile": '[[source]]\nurl = "https://pypi.org/simple"\nverify_ssl = true\nname = "pypi"\n\n[packages]\nflask = "*"\n',
      "api/app.py": "from flask import Flask\n\napp = Flask(__name__)\n\n@app.get('/')\ndef root():\n    return 'ok'\n",
    },
  },
  {
    name: "go: chi with cmd/api and cmd/migrate",
    expectBackend: "api",
    files: {
      "api/go.mod": "module github.com/me/api\n\ngo 1.22\n\nrequire github.com/go-chi/chi/v5 v5.2.1\n",
      "api/cmd/api/main.go":
        'package main\n\nimport (\n\t"net/http"\n\t"os"\n\n\t"github.com/go-chi/chi/v5"\n)\n\nfunc main() {\n\tr := chi.NewRouter()\n\tr.Get("/", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })\n\thttp.ListenAndServe(":"+os.Getenv("PORT"), r)\n}\n',
      "api/cmd/migrate/main.go": "package main\n\nfunc main() {}\n",
    },
    setup: ["cd api && go mod tidy"],
  },
  {
    name: "go: net/http with an app/ package next to main.go",
    expectBackend: "server",
    files: {
      "server/go.mod": "module github.com/me/server\n\ngo 1.22\n",
      "server/main.go":
        'package main\n\nimport (\n\t"net/http"\n\t"os"\n\n\t"github.com/me/server/app"\n)\n\nfunc main() {\n\thttp.ListenAndServe(":"+os.Getenv("PORT"), app.Handler())\n}\n',
      "server/app/app.go": 'package app\n\nimport "net/http"\n\nfunc Handler() http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })\n}\n',
    },
  },
  {
    name: "ruby: Sinatra classic app.rb",
    expectBackend: "api",
    files: {
      "api/Gemfile": "source 'https://rubygems.org'\ngem 'sinatra', '~> 4.0'\ngem 'puma'\ngem 'rackup'\n",
      "api/app.rb": "require 'sinatra'\n\nget('/') { 'ok' }\n",
    },
  },
  {
    name: "ruby: Sinatra modular with config.ru + puma",
    expectBackend: "api",
    files: {
      "api/Gemfile": "source 'https://rubygems.org'\ngem 'sinatra', '~> 4.0'\ngem 'puma'\n",
      "api/app.rb": "require 'sinatra/base'\n\nclass App < Sinatra::Base\n  get('/') { 'ok' }\nend\n",
      "api/config.ru": "require './app'\nrun App\n",
    },
  },
  {
    name: "rust: axum in a cargo workspace with a [[bin]] name",
    expectBackend: "api",
    slow: true,
    files: {
      "Cargo.toml": "[workspace]\nresolver = '2'\nmembers = ['api']\n",
      "api/Cargo.toml":
        "[package]\nname = 'my-api'\nversion = '0.1.0'\nedition = '2021'\n\n[[bin]]\nname = 'server'\npath = 'src/main.rs'\n\n[dependencies]\naxum = '0.8'\ntokio = { version = '1', features = ['rt-multi-thread', 'macros', 'net'] }\n",
      "api/src/main.rs":
        '#[tokio::main]\nasync fn main() {\n    let app = axum::Router::new().route("/", axum::routing::get(|| async { "ok" }));\n    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());\n    let l = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.unwrap();\n    axum::serve(l, app).await.unwrap();\n}\n',
    },
  },
];
