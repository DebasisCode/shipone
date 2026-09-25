import fs from "node:fs";
import path from "node:path";

/**
 * Stack detection. Each detector looks at one folder and says whether it's a
 * frontend or backend it understands. Adding a framework = adding a detector.
 */

export type FrontendFramework =
  | "vite"
  | "nextjs"
  | "create-react-app"
  | "angular"
  | "sveltekit"
  | "astro"
  | "nuxt"
  | "gatsby"
  | "remix";

export type BackendRuntime = "node" | "python" | "go" | "rust" | "ruby" | "docker";

export type BackendFramework =
  | "express"
  | "fastify"
  | "koa"
  | "hapi"
  | "nestjs"
  | "hono"
  | "node"
  | "fastapi"
  | "flask"
  | "django"
  | "python"
  | "gin"
  | "echo"
  | "fiber"
  | "chi"
  | "go"
  | "axum"
  | "actix"
  | "rocket"
  | "rust"
  | "rails"
  | "sinatra"
  | "ruby"
  | "docker";

export type BackendPackageManager = "npm" | "yarn" | "pnpm" | "pip" | "poetry" | "uv" | "go" | "cargo" | "bundler" | "docker";
export type PackageManager = "npm" | "yarn" | "pnpm";

export interface FrontendApp {
  role: "frontend";
  /** Relative to repo root, posix style; "." for the root itself. */
  path: string;
  framework: FrontendFramework;
  /** Env var the frontend should read the backend URL from. */
  apiUrlEnv: string;
  /** True when apiUrlEnv was found in the code (vs the framework default). */
  apiUrlEnvFromCode: boolean;
}

export interface BackendApp {
  role: "backend";
  path: string;
  framework: BackendFramework;
  runtime: BackendRuntime;
  packageManager: BackendPackageManager;
  buildCommand: string;
  /** Undefined when we can't work out how to start it. Not needed for Docker images. */
  startCommand?: string;
  /** Repo-relative Dockerfile path when runtime is "docker". */
  dockerfilePath?: string;
}

export interface Detection {
  frontends: FrontendApp[];
  backends: BackendApp[];
}

interface PackageJson {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
}

export const ENV_PREFIX: Record<FrontendFramework, string> = {
  vite: "VITE_",
  nextjs: "NEXT_PUBLIC_",
  "create-react-app": "REACT_APP_",
  angular: "NG_APP_",
  sveltekit: "PUBLIC_",
  astro: "PUBLIC_",
  nuxt: "NUXT_PUBLIC_",
  gatsby: "GATSBY_",
  remix: "REMIX_PUBLIC_",
};

/** Vercel's own framework preset slugs (frameworks it can auto-configure). */
export const VERCEL_FRAMEWORK_SLUG: Record<FrontendFramework, string> = {
  vite: "vite",
  nextjs: "nextjs",
  "create-react-app": "create-react-app",
  angular: "angular",
  sveltekit: "sveltekit",
  astro: "astro",
  nuxt: "nuxtjs",
  gatsby: "gatsby",
  remix: "remix",
};

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "public",
  "docs",
  "test",
  "tests",
  "scripts",
  "vendor",
  "__pycache__",
  "target",
  "venv",
  ".venv",
]);
const SOURCE_EXT = /\.(m?[jt]sx?|vue|svelte|astro|py|go|rs|rb)$/;

function readPkg(dir: string): PackageJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

const hasDep = (pkg: PackageJson, name: string) => Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);

/** Folders worth looking at: the root, its direct children, and apps/* + packages/*. */
export function candidateDirs(root: string): string[] {
  const out = ["."];
  const children = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name))
      .map((e) => (rel === "." ? e.name : `${rel}/${e.name}`))
      .sort();
  };
  for (const c of children(".")) {
    out.push(c);
    if (c === "apps" || c === "packages") out.push(...children(c));
  }
  return out;
}

/** Walk source files of an app, skipping deps/build output. Capped so huge repos stay fast. */
export function* sourceFiles(dir: string, limit = 3000): Generator<string> {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (SOURCE_EXT.test(e.name)) {
        if (++seen > limit) return;
        yield full;
      }
    }
  }
}

function readSmall(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 512 * 1024) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * If the code already reads something like import.meta.env.VITE_BACKEND_URL,
 * use that name rather than forcing VITE_API_URL on the user.
 */
export function findApiUrlEnvInCode(dir: string, prefix: string): string | undefined {
  const re = new RegExp(`\\b(${prefix}[A-Z0-9_]*(?:API|BACKEND|SERVER)[A-Z0-9_]*(?:URL|URI|ORIGIN|HOST|BASE)[A-Z0-9_]*)\\b`, "g");
  const counts = new Map<string, number>();
  for (const file of sourceFiles(dir)) {
    if (/\.config\.[mc]?[jt]s$/.test(file)) continue;
    for (const m of readSmall(file).matchAll(re)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [name, n] of counts) if (!best || n > counts.get(best)!) best = name;
  return best;
}

export function detectPackageManager(root: string, appDir: string): PackageManager {
  for (const dir of [appDir, root]) {
    if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
    if (fs.existsSync(path.join(dir, "package-lock.json"))) return "npm";
  }
  return "npm";
}

function installCommand(pm: PackageManager, hasLockfile: boolean): string {
  switch (pm) {
    case "pnpm":
      // No global installs: Render's /usr/lib and /usr/bin are read-only, so both
      // `npm i -g pnpm` and `corepack enable` fail there. npx runs from the npm cache.
      return "npx pnpm@latest-10 install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    default:
      return hasLockfile ? "npm ci" : "npm install";
  }
}

/**
 * Run a package.json script on the host. pnpm isn't installed globally on the
 * build image (read-only /usr/lib), so it's invoked through npx.
 */
function scriptCommand(pm: PackageManager): (script: string) => string {
  switch (pm) {
    case "pnpm":
      return (script) => `npx pnpm@latest-10 ${script}`;
    case "yarn":
      return (script) => `yarn ${script}`;
    default:
      return (script) => `npm run ${script}`;
  }
}

// ---------------------------------------------------------------------------
// Frontend detectors
// ---------------------------------------------------------------------------

/** Meta/SSR frameworks first: they can pull in vite or a server lib as a detail. */
const FRONTEND_DEPS: [string, FrontendFramework][] = [
  ["next", "nextjs"],
  ["@sveltejs/kit", "sveltekit"],
  ["astro", "astro"],
  ["nuxt", "nuxt"],
  ["@remix-run/react", "remix"],
  ["gatsby", "gatsby"],
  ["@angular/core", "angular"],
  ["vite", "vite"],
  ["react-scripts", "create-react-app"],
];

export function detectFrontend(root: string, rel: string): FrontendApp | undefined {
  const dir = path.join(root, rel);
  const pkg = readPkg(dir);
  if (!pkg) return undefined;
  const hit = FRONTEND_DEPS.find(([dep]) => hasDep(pkg, dep));
  if (!hit) return undefined;
  const framework = hit[1];

  const prefix = ENV_PREFIX[framework];
  const fromCode = findApiUrlEnvInCode(dir, prefix);
  return {
    role: "frontend",
    path: rel,
    framework,
    apiUrlEnv: fromCode ?? `${prefix}API_URL`,
    apiUrlEnvFromCode: Boolean(fromCode),
  };
}

// ---------------------------------------------------------------------------
// Backend detectors: Node, Python, Go, Rust, Ruby, Docker
// ---------------------------------------------------------------------------

const SERVER_DEPS: [string, BackendFramework][] = [
  ["express", "express"],
  ["fastify", "fastify"],
  ["koa", "koa"],
  ["@hapi/hapi", "hapi"],
  ["@nestjs/core", "nestjs"],
  ["hono", "hono"],
];

const ENTRY_GUESSES = ["server.js", "index.js", "app.js", "src/server.js", "src/index.js", "src/app.js"];

const PYTHON_ENTRIES = ["main.py", "app.py", "server.py", "api.py", "src/main.py", "src/app.py"];

function detectNodeBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  const pkg = readPkg(dir);
  if (!pkg) return undefined;
  const hit = SERVER_DEPS.find(([dep]) => pkg.dependencies?.[dep]);
  if (!hit) return undefined;

  const pm = detectPackageManager(root, dir);
  const hasLockfile = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"].some((f) => fs.existsSync(path.join(dir, f)));
  const run = scriptCommand(pm);
  let buildCommand = installCommand(pm, hasLockfile);
  if (pkg.scripts?.build) buildCommand += ` && ${run("build")}`;

  let startCommand: string | undefined;
  if (pkg.scripts?.start) startCommand = pm === "npm" ? "npm start" : run("start");
  else if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) startCommand = `node ${pkg.main}`;
  else {
    const entry = ENTRY_GUESSES.find((f) => fs.existsSync(path.join(dir, f)));
    if (entry) startCommand = `node ${entry}`;
  }

  return { role: "backend", path: rel, framework: hit[1], runtime: "node", packageManager: pm, buildCommand, startCommand };
}

function findWsgiModule(dir: string): string | undefined {
  if (fs.existsSync(path.join(dir, "settings.py"))) return "";
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && fs.existsSync(path.join(dir, e.name, "settings.py"))) return e.name;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function detectPythonBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  const reqsFile = path.join(dir, "requirements.txt");
  const pyproject = path.join(dir, "pyproject.toml");
  if (!fs.existsSync(reqsFile) && !fs.existsSync(pyproject)) return undefined;
  // requirements.txt lines and pyproject.toml dependency strings, lowercased for matching.
  const reqText = `${readSmall(reqsFile)}\n${readSmall(pyproject)}`.toLowerCase();
  const has = (name: string) => reqText.includes(name);

  const entry = PYTHON_ENTRIES.find((f) => fs.existsSync(path.join(dir, f)));
  const hasPoetry = fs.existsSync(path.join(dir, "poetry.lock"));
  const hasUv = fs.existsSync(path.join(dir, "uv.lock"));
  const buildCommand = hasPoetry
    ? "pip install poetry && poetry install --no-interaction"
    : hasUv
      ? "pip install uv && uv sync --frozen"
      : "pip install -r requirements.txt";
  const packageManager: BackendPackageManager = hasPoetry ? "poetry" : hasUv ? "uv" : "pip";

  let framework: BackendFramework = "python";
  let startCommand: string | undefined;

  if (fs.existsSync(path.join(dir, "manage.py"))) {
    framework = "django";
    const wsgi = findWsgiModule(dir);
    if (wsgi !== undefined) {
      const module = wsgi ? `${wsgi}.wsgi` : "wsgi";
      startCommand = has("gunicorn") ? `gunicorn -b 0.0.0.0:$PORT ${module}` : `python manage.py runserver 0.0.0.0:$PORT`;
    }
  } else if (/\bfastapi\b/.test(reqText)) {
    framework = "fastapi";
    if (entry && !entry.includes("/") && /uvicorn/.test(reqText)) {
      startCommand = `uvicorn ${entry.replace(/\.py$/, "")}:app --host 0.0.0.0 --port $PORT`;
    }
  } else if (/\bflask\b/.test(reqText)) {
    framework = "flask";
    if (entry && !entry.includes("/")) {
      const mod = entry.replace(/\.py$/, "");
      startCommand = has("gunicorn") ? `gunicorn -b 0.0.0.0:$PORT ${mod}:app` : `python ${entry}`;
    }
  }
  if (!startCommand && entry) startCommand = `python ${entry}`;

  return { role: "backend", path: rel, framework, runtime: "python", packageManager, buildCommand, startCommand };
}

function detectGoBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  const goMod = readSmall(path.join(dir, "go.mod"));
  if (!goMod) return undefined;

  const framework: BackendFramework = /gin-gonic\/gin/.test(goMod)
    ? "gin"
    : /labstack\/echo/.test(goMod)
      ? "echo"
      : /gofiber\/fiber/.test(goMod)
        ? "fiber"
        : /go-chi\/chi/.test(goMod)
          ? "chi"
          : "go";

  let buildCommand = "go build -o app .";
  try {
    const cmds = fs
      .readdirSync(path.join(dir, "cmd"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (cmds.length) buildCommand = `go build -o app ./cmd/${cmds[0]}`;
  } catch {
    // no cmd/ dir: build the package at the folder root
  }

  return { role: "backend", path: rel, framework, runtime: "go", packageManager: "go", buildCommand, startCommand: "./app" };
}

function detectRustBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  if (!fs.existsSync(path.join(dir, "Cargo.toml"))) return undefined;
  const cargo = readSmall(path.join(dir, "Cargo.toml"));
  const name = cargo.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
  const framework: BackendFramework = /\baxum\b/.test(cargo)
    ? "axum"
    : /actix-web/.test(cargo)
      ? "actix"
      : /\brocket\b/.test(cargo)
        ? "rocket"
        : "rust";
  return {
    role: "backend",
    path: rel,
    framework,
    runtime: "rust",
    packageManager: "cargo",
    buildCommand: "cargo build --release",
    startCommand: name ? `./target/release/${name}` : undefined,
  };
}

function detectRubyBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  if (!fs.existsSync(path.join(dir, "Gemfile"))) return undefined;
  const gemfile = readSmall(path.join(dir, "Gemfile")).toLowerCase();
  const framework: BackendFramework = /gem\s+["']rails/.test(gemfile) ? "rails" : /gem\s+["']sinatra/.test(gemfile) ? "sinatra" : "ruby";

  let startCommand: string | undefined;
  if (fs.existsSync(path.join(dir, "config.ru"))) startCommand = "bundle exec rackup config.ru -o 0.0.0.0 -p $PORT";
  else if (framework === "rails") startCommand = "bundle exec rails server -b 0.0.0.0 -p $PORT";
  else if (fs.existsSync(path.join(dir, "app.rb"))) startCommand = "bundle exec ruby app.rb";

  return { role: "backend", path: rel, framework, runtime: "ruby", packageManager: "bundler", buildCommand: "bundle install", startCommand };
}

function detectDockerBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  const name = ["Dockerfile", "dockerfile"].find((n) => fs.existsSync(path.join(dir, n)));
  if (!name) return undefined;
  return {
    role: "backend",
    path: rel,
    framework: "docker",
    runtime: "docker",
    packageManager: "docker",
    buildCommand: "",
    startCommand: undefined,
    dockerfilePath: `./${name}`,
  };
}

const BACKEND_DETECTORS = [detectNodeBackend, detectPythonBackend, detectGoBackend, detectRustBackend, detectRubyBackend, detectDockerBackend];

export function detectBackend(root: string, rel: string): BackendApp | undefined {
  for (const detect of BACKEND_DETECTORS) {
    const app = detect(root, rel);
    if (app) return app;
  }
  return undefined;
}

export function detectApps(root: string): Detection {
  const frontends: FrontendApp[] = [];
  const backends: BackendApp[] = [];
  for (const rel of candidateDirs(root)) {
    // A Next.js app with a custom express server is still a frontend first.
    const fe = detectFrontend(root, rel);
    if (fe) {
      frontends.push(fe);
      continue;
    }
    const be = detectBackend(root, rel);
    if (be) backends.push(be);
  }
  return { frontends, backends };
}

const PREFERRED_NAMES: Record<"frontend" | "backend", string[]> = {
  frontend: ["client", "frontend", "web", "app", "ui", "apps/web", "apps/client", "apps/frontend"],
  backend: ["server", "backend", "api", "apps/api", "apps/server", "apps/backend"],
};

/**
 * Pick the obvious candidate when there's more than one, e.g. prefer ./client
 * over ./landing. Returns undefined when it's genuinely ambiguous.
 */
export function pickObvious<T extends { path: string }>(role: "frontend" | "backend", apps: T[]): T | undefined {
  if (apps.length === 1) return apps[0];
  const preferred = apps.filter((a) => PREFERRED_NAMES[role].includes(a.path));
  return preferred.length === 1 ? preferred[0] : undefined;
}