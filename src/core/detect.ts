import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/**
 * Stack detection. Each detector looks at one folder and says whether it's a
 * frontend or backend it understands. Adding a framework = adding a detector.
 *
 * The commands produced here run on the host's build image (Render), not on
 * the user's machine, so they must not rely on anything installed globally
 * beyond the runtime itself: no `npm i -g`, no `corepack enable`.
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
  | "remix"
  | "react-router"
  | "solidstart"
  | "vue";

export type BackendRuntime = "node" | "python" | "go" | "rust" | "ruby" | "docker";

export type BackendFramework =
  | "express"
  | "fastify"
  | "koa"
  | "hapi"
  | "nestjs"
  | "hono"
  | "adonis"
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

export type BackendPackageManager =
  | "npm"
  | "yarn"
  | "pnpm"
  | "pip"
  | "poetry"
  | "uv"
  | "pipenv"
  | "go"
  | "cargo"
  | "bundler"
  | "docker";
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
  packageManager?: string;
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
  // React Router v7 (framework mode) and SolidStart are Vite apps.
  "react-router": "VITE_",
  solidstart: "VITE_",
  vue: "VUE_APP_",
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
  "react-router": "react-router",
  solidstart: "solidstart-1",
  vue: "vue",
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

const exists = (...parts: string[]) => fs.existsSync(path.join(...parts));

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const readPkg = (dir: string) => readJson<PackageJson>(path.join(dir, "package.json"));

const hasDep = (pkg: PackageJson, name: string) => Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);

function readSmall(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 512 * 1024) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Monorepo workspaces (pnpm-workspace.yaml, package.json "workspaces")
// ---------------------------------------------------------------------------

/** Workspace globs declared at the repo root, e.g. ["apps/*", "packages/*"]. Empty when not a monorepo. */
export function workspacePatterns(root: string): string[] {
  const out: string[] = [];
  const pnpmWs = readSmall(path.join(root, "pnpm-workspace.yaml"));
  if (pnpmWs) {
    try {
      const doc = YAML.parse(pnpmWs) as { packages?: unknown } | null;
      if (Array.isArray(doc?.packages)) out.push(...doc.packages.filter((p): p is string => typeof p === "string"));
    } catch {
      /* malformed yaml: treat as no workspaces */
    }
  }
  const ws = readPkg(root)?.workspaces;
  const list = Array.isArray(ws) ? ws : Array.isArray((ws as { packages?: unknown })?.packages) ? (ws as { packages: unknown[] }).packages : [];
  out.push(...list.filter((p): p is string => typeof p === "string"));
  return [...new Set(out.map((p) => p.replace(/^\.\//, "").replace(/\/+$/, "")))].filter((p) => p && !p.startsWith("!"));
}

function globToRegExp(glob: string): RegExp {
  const src = glob
    .split("/")
    .map((seg) => (seg === "**" ? ".*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
    .join("/");
  return new RegExp(`^${src.replace(/\/\.\*$/, "(?:/.*)?")}$`);
}

export function isWorkspaceMember(root: string, rel: string): boolean {
  if (rel === ".") return false;
  return workspacePatterns(root).some((p) => globToRegExp(p).test(rel));
}

/** Folders worth looking at: the root, its direct children, apps/*, packages/*, services/* and declared workspaces. */
export function candidateDirs(root: string): string[] {
  const out = new Set<string>(["."]);
  for (const c of subdirs(root)) {
    out.add(c);
    if (c === "apps" || c === "packages" || c === "services") for (const g of subdirs(path.join(root, c))) out.add(`${c}/${g}`);
  }
  for (const pattern of workspacePatterns(root)) {
    // Expand "dir/*" (and "dir/**", one level) plus literal paths. Deeper globs are rare for apps.
    const m = pattern.match(/^(.*?)\/\*\*?$/);
    if (m && !m[1]!.includes("*")) for (const g of subdirs(path.join(root, m[1]!))) out.add(`${m[1]}/${g}`);
    else if (!pattern.includes("*") && exists(root, pattern)) out.add(pattern);
  }
  return [...out];
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

// ---------------------------------------------------------------------------
// Node package managers
// ---------------------------------------------------------------------------

const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

function lockfileIn(dir: string): [string, PackageManager] | undefined {
  return LOCKFILES.find(([f]) => exists(dir, f));
}

/** "pnpm@9.15.0+sha512.abc" → { name: "pnpm", version: "9.15.0" } */
function parsePackageManagerField(v: string | undefined): { name: string; version: string } | undefined {
  const m = v?.match(/^(npm|pnpm|yarn)@(\d+(?:\.\d+){0,2}[^+\s]*)/);
  return m ? { name: m[1]!, version: m[2]! } : undefined;
}

export function detectPackageManager(root: string, appDir: string): PackageManager {
  for (const dir of [appDir, root]) {
    const lock = lockfileIn(dir);
    if (lock) return lock[1];
  }
  for (const dir of [appDir, root]) {
    const field = parsePackageManagerField(readPkg(dir)?.packageManager);
    if (field) return field.name as PackageManager;
  }
  return "npm";
}

interface NodeToolchain {
  pm: PackageManager;
  /** How to invoke the package manager itself on the build image. */
  bin: string;
  install: string;
  /** Command that runs a package.json script. */
  run: (script: string) => string;
  /** True when the app is part of a pnpm/yarn/npm workspace rooted at the repo root. */
  workspace: boolean;
}

/**
 * pnpm isn't on Render's image and it can't be installed globally there
 * (read-only /usr), so it runs through npx. Pin a version that can read the
 * lockfile: the packageManager field if there is one, else by lockfile format.
 */
function pnpmSpec(appDir: string, root: string, lockDir: string | undefined): string {
  for (const dir of [appDir, root]) {
    const field = parsePackageManagerField(readPkg(dir)?.packageManager);
    if (field?.name === "pnpm") return `pnpm@${field.version}`;
  }
  if (lockDir) {
    const head = readSmall(path.join(lockDir, "pnpm-lock.yaml")).slice(0, 200);
    const major = Number(head.match(/lockfileVersion:\s*['"]?(\d+)/)?.[1]);
    if (major === 5) return "pnpm@7";
    if (major === 6) return "pnpm@8";
  }
  return "pnpm@latest-10";
}

/** Yarn 2+ ("berry"). Render ships Yarn 1, which can't read a berry lockfile on its own. */
function yarnBerryMajor(appDir: string, root: string, lockDir: string | undefined): number | undefined {
  for (const dir of [appDir, root]) {
    const field = parsePackageManagerField(readPkg(dir)?.packageManager);
    if (field?.name === "yarn") {
      const major = Number(field.version.split(".")[0]);
      return major >= 2 ? major : undefined;
    }
  }
  if (lockDir && /^__metadata:/m.test(readSmall(path.join(lockDir, "yarn.lock")).slice(0, 2000))) return 4;
  if (exists(appDir, ".yarnrc.yml") || exists(root, ".yarnrc.yml")) return 4;
  return undefined;
}

function nodeToolchain(root: string, rel: string): NodeToolchain {
  const dir = path.join(root, rel);
  const own = lockfileIn(dir);
  const rootLock = rel === "." ? undefined : lockfileIn(root);
  const workspace = isWorkspaceMember(root, rel);
  // A lockfile only counts if the install will actually use it: the app's own,
  // or the workspace root's when the app is a workspace member.
  const lockDir = own ? dir : rootLock && workspace ? root : undefined;
  const pm = detectPackageManager(root, dir);
  const frozen = Boolean(lockDir);

  switch (pm) {
    case "pnpm": {
      const bin = `npx ${pnpmSpec(dir, root, lockDir)}`;
      return { pm, bin, install: `${bin} install${frozen ? " --frozen-lockfile" : ""}`, run: (s) => `${bin} ${s}`, workspace };
    }
    case "yarn": {
      const berry = yarnBerryMajor(dir, root, lockDir);
      if (berry) {
        const bin = `npx -y -p @yarnpkg/cli-dist@${berry} yarn`;
        return { pm, bin, install: `${bin} install${frozen ? " --immutable" : ""}`, run: (s) => `${bin} ${s}`, workspace };
      }
      return { pm, bin: "yarn", install: `yarn install${frozen ? " --frozen-lockfile" : ""}`, run: (s) => `yarn ${s}`, workspace };
    }
    default:
      return { pm, bin: "npm", install: frozen ? "npm ci" : "npm install", run: (s) => `npm run ${s}`, workspace };
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
  ["@react-router/dev", "react-router"],
  ["@remix-run/react", "remix"],
  ["@solidjs/start", "solidstart"],
  ["gatsby", "gatsby"],
  ["@angular/core", "angular"],
  ["@vue/cli-service", "vue"],
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

  // A server that lists vite as a devDependency (vitest, vite-node, SSR tooling)
  // isn't a frontend: a Vite SPA always has an index.html.
  if (framework === "vite" && serverDep(pkg) && !exists(dir, "index.html") && !exists(dir, "src", "index.html")) return undefined;

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

/** Frameworks built on top of others first (NestJS apps usually list express too). */
const SERVER_DEPS: [string, BackendFramework][] = [
  ["@nestjs/core", "nestjs"],
  ["@adonisjs/core", "adonis"],
  ["express", "express"],
  ["fastify", "fastify"],
  ["koa", "koa"],
  ["@hapi/hapi", "hapi"],
  ["hono", "hono"],
  ["@hono/node-server", "hono"],
  ["restify", "node"],
  ["@feathersjs/feathers", "node"],
];

/**
 * Libraries that are often a server but also show up in shared packages
 * (e.g. a tRPC router in packages/api). Only count them with a way to start.
 */
const MAYBE_SERVER_DEPS = ["@trpc/server", "@apollo/server", "graphql-yoga", "socket.io", "h3", "ws"];

const serverDep = (pkg: PackageJson) => SERVER_DEPS.find(([dep]) => pkg.dependencies?.[dep]);

const ENTRY_GUESSES = [
  "server.js",
  "index.js",
  "app.js",
  "main.js",
  "server.mjs",
  "index.mjs",
  "src/server.js",
  "src/index.js",
  "src/app.js",
  "src/main.js",
];

/** Folder names that are a backend even without a known framework (plain `http`). */
const BACKEND_DIR_NAMES = new Set(["server", "backend", "api"]);

function workspaceDeps(pkg: PackageJson): string[] {
  return Object.entries({ ...pkg.devDependencies, ...pkg.dependencies })
    .filter(([, v]) => typeof v === "string" && v.startsWith("workspace:"))
    .map(([k]) => k);
}

function detectNodeBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  const pkg = readPkg(dir);
  if (!pkg) return undefined;

  let startCommand: string | undefined;
  const tc = nodeToolchain(root, rel);
  if (pkg.scripts?.start) startCommand = tc.pm === "npm" ? "npm start" : tc.run("start");
  else if (pkg.main && exists(dir, pkg.main)) startCommand = `node ${pkg.main}`;
  else {
    const entry = ENTRY_GUESSES.find((f) => exists(dir, f));
    if (entry) startCommand = `node ${entry}`;
  }

  let framework = serverDep(pkg)?.[1];
  if (!framework && (pkg.scripts?.start || exists(dir, "server.js")) && MAYBE_SERVER_DEPS.some((d) => pkg.dependencies?.[d])) framework = "node";
  if (!framework && pkg.scripts?.start && BACKEND_DIR_NAMES.has(path.posix.basename(rel))) framework = "node";
  if (!framework) return undefined;

  let buildCommand = tc.install;
  const localDeps = tc.workspace ? workspaceDeps(pkg) : [];
  if (tc.pm === "pnpm" && localDeps.length && pkg.name) {
    // Build the workspace packages this app imports (in dependency order) before the app itself.
    buildCommand += ` && ${tc.bin} --filter "${pkg.name}..." run --if-present build`;
  } else if (pkg.scripts?.build) {
    buildCommand += ` && ${tc.run("build")}`;
  }

  return { role: "backend", path: rel, framework, runtime: "node", packageManager: tc.pm, buildCommand, startCommand };
}

// --- Python ---

/** Where Python web apps usually keep the object the server imports. */
const PYTHON_ENTRIES = [
  "main.py",
  "app.py",
  "server.py",
  "api.py",
  "application.py",
  "wsgi.py",
  "asgi.py",
  "app/main.py",
  "app/app.py",
  "app/__init__.py",
  "api/main.py",
  "src/main.py",
  "src/app.py",
  "src/app/main.py",
  "src/api/main.py",
];

const ASGI_CTORS = ["FastAPI", "Starlette", "Litestar", "Quart"];

interface PythonEntry {
  file: string;
  /** Dotted module path, relative to `appDir`. */
  module: string;
  /** Directory to run from/import relative to ("src" for src layouts), or "". */
  appDir: string;
  /** "app" or e.g. "create_app()" for a Flask factory. */
  target: string;
  kind?: "asgi" | "wsgi";
}

function pythonEntry(dir: string): PythonEntry | undefined {
  let fallback: PythonEntry | undefined;
  for (const file of PYTHON_ENTRIES) {
    const text = readSmall(path.join(dir, file));
    if (!text && !exists(dir, file)) continue;
    const srcLayout = file.startsWith("src/");
    const modPath = (srcLayout ? file.slice(4) : file).replace(/\.py$/, "").replace(/\/__init__$/, "").split("/").join(".");
    const base = { file, module: modPath, appDir: srcLayout ? "src" : "" };
    const ctor = (names: string[]) => text.match(new RegExp(`^(\\w+)\\s*(?::[^=\\n]+)?=\\s*(?:\\w+\\.)?(?:${names.join("|")})\\(`, "m"))?.[1];
    const asgi = ctor(ASGI_CTORS);
    if (asgi) return { ...base, target: asgi, kind: "asgi" };
    const wsgi = ctor(["Flask"]);
    if (wsgi) return { ...base, target: wsgi, kind: "wsgi" };
    if (/^def create_app\(/m.test(text)) return { ...base, target: "create_app()", kind: "wsgi" };
    fallback ??= { ...base, target: "app" };
  }
  return fallback;
}

/** The Django project package: from manage.py's DJANGO_SETTINGS_MODULE, else the folder holding wsgi.py/settings.py. */
function djangoWsgiModule(dir: string): string | undefined {
  const manage = readSmall(path.join(dir, "manage.py"));
  const settings = manage.match(/DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/)?.[1];
  const pkg = settings?.split(".settings")[0];
  if (pkg && pkg !== settings && exists(dir, ...pkg.split("."), "wsgi.py")) return `${pkg}.wsgi`;
  if (exists(dir, "wsgi.py") || exists(dir, "settings.py")) return "wsgi";
  for (const d of subdirs(dir)) if (exists(dir, d, "wsgi.py")) return `${d}.wsgi`;
  for (const d of subdirs(dir)) if (exists(dir, d, "settings.py") || exists(dir, d, "settings")) return `${d}.wsgi`;
  return undefined;
}

/** requirements.txt plus the files it pulls in with `-r` / `--requirement`, relative to `dir`. */
function requirementsFiles(dir: string, file: string, seen = new Set<string>()): string[] {
  if (seen.has(file) || seen.size > 10 || !exists(dir, file)) return [];
  seen.add(file);
  const out = [file];
  for (const m of readSmall(path.join(dir, file)).matchAll(/^\s*(?:-r|--requirement)[\s=]+(\S+)/gm)) {
    out.push(...requirementsFiles(dir, path.posix.join(path.posix.dirname(file), m[1]!), seen));
  }
  return out;
}

function detectPythonBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  const files = ["requirements.txt", "pyproject.toml", "Pipfile"].filter((f) => exists(dir, f));
  if (!files.length) return undefined;
  // Dependency declarations (following `-r other.txt` includes), lowercased for matching.
  const reqText = [...files.filter((f) => f !== "requirements.txt"), ...requirementsFiles(dir, "requirements.txt")]
    .map((f) => readSmall(path.join(dir, f)))
    .join("\n")
    .toLowerCase();
  const has = (name: string) => new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`, "m").test(reqText);
  const pyproject = readSmall(path.join(dir, "pyproject.toml"));

  let packageManager: BackendPackageManager;
  let buildCommand: string;
  let run = "";
  if (exists(dir, "poetry.lock") || (/^\[tool\.poetry\]/m.test(pyproject) && !exists(dir, "requirements.txt"))) {
    packageManager = "poetry";
    buildCommand = "pip install poetry && poetry install --no-interaction --no-root";
    run = "poetry run ";
  } else if (exists(dir, "uv.lock")) {
    packageManager = "uv";
    buildCommand = "pip install uv && uv sync --frozen";
    run = "uv run --no-sync ";
  } else if (exists(dir, "requirements.txt")) {
    packageManager = "pip";
    buildCommand = "pip install -r requirements.txt";
  } else if (exists(dir, "Pipfile")) {
    packageManager = "pipenv";
    buildCommand = `pip install pipenv && pipenv install --system${exists(dir, "Pipfile.lock") ? " --deploy" : ""}`;
  } else {
    // pyproject.toml with PEP 621 dependencies and no lockfile. pip can't read
    // dependencies without building the project; uv can.
    packageManager = "pip";
    buildCommand = /^\[build-system\]/m.test(pyproject) ? "pip install ." : "pip install uv && uv pip install -r pyproject.toml";
  }
  // Extra server packages go into the same environment as the app's deps.
  const addPkg = (name: string) => {
    buildCommand += packageManager === "uv" ? ` && uv pip install --python .venv ${name}` : ` && pip install ${name}`;
  };

  let framework: BackendFramework = "python";
  let startCommand: string | undefined;
  const entry = pythonEntry(dir);

  if (exists(dir, "manage.py")) {
    framework = "django";
    const wsgi = djangoWsgiModule(dir);
    if (wsgi) {
      if (!has("gunicorn")) addPkg("gunicorn");
      startCommand = `${run}gunicorn -b 0.0.0.0:$PORT ${wsgi}`;
    }
  } else if (entry?.kind === "asgi" || (has("fastapi") && entry)) {
    framework = has("fastapi") ? "fastapi" : "python";
    // fastapi[standard] / [all] bring uvicorn with them.
    if (!has("uvicorn") && !/fastapi\[(?:standard|all)/.test(reqText)) addPkg("uvicorn");
    const appDir = entry!.appDir ? ` --app-dir ${entry!.appDir}` : "";
    startCommand = `${run}uvicorn ${entry!.module}:${entry!.target} --host 0.0.0.0 --port $PORT${appDir}`;
  } else if (entry?.kind === "wsgi" || (has("flask") && entry)) {
    framework = has("flask") ? "flask" : "python";
    if (!has("gunicorn")) addPkg("gunicorn");
    const chdir = entry!.appDir ? ` --chdir ${entry!.appDir}` : "";
    const target = entry!.target.endsWith(")") ? `"${entry!.module}:${entry!.target}"` : `${entry!.module}:${entry!.target}`;
    startCommand = `${run}gunicorn -b 0.0.0.0:$PORT${chdir} ${target}`;
  } else if (entry && !entry.file.endsWith("__init__.py")) {
    startCommand = `${run}python ${entry.file}`;
  }

  return { role: "backend", path: rel, framework, runtime: "python", packageManager, buildCommand, startCommand };
}

// --- Go ---

const hasMainPackage = (dir: string) => {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith(".go") && !f.endsWith("_test.go") && /^package main\b/m.test(readSmall(path.join(dir, f))));
  } catch {
    return false;
  }
};

const PREFERRED_CMDS = ["server", "api", "web", "app", "http", "backend", "main"];

/** The package to build: the module root, cmd/<name>, cmd/, or another folder with a main package. */
function goMainPackage(dir: string, moduleName: string): string | undefined {
  if (hasMainPackage(dir)) return ".";
  const rank = (names: string[]) => {
    const base = moduleName.split("/").pop() ?? "";
    const preferred = [...PREFERRED_CMDS, base];
    return [...names].sort((a, b) => {
      const ia = preferred.indexOf(a);
      const ib = preferred.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  };
  const cmds = rank(subdirs(path.join(dir, "cmd")).filter((d) => hasMainPackage(path.join(dir, "cmd", d))));
  if (cmds.length) return `./cmd/${cmds[0]}`;
  if (hasMainPackage(path.join(dir, "cmd"))) return "./cmd";
  const others = rank(subdirs(dir).filter((d) => d !== "cmd" && d !== "internal" && d !== "pkg" && hasMainPackage(path.join(dir, d))));
  if (others.length) return `./${others[0]}`;
  // Couldn't read a main package anywhere: follow the cmd/<name> convention if it's there.
  const anyCmd = rank(subdirs(path.join(dir, "cmd")));
  return anyCmd.length ? `./cmd/${anyCmd[0]}` : undefined;
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

  const moduleName = goMod.match(/^module\s+(\S+)/m)?.[1] ?? "";
  const pkg = goMainPackage(dir, moduleName) ?? ".";
  // `go build -o app` writes *into* an existing app/ folder instead of creating the binary.
  const out = exists(dir, "app") ? ".bin/app" : "app";
  return { role: "backend", path: rel, framework, runtime: "go", packageManager: "go", buildCommand: `go build -o ${out} ${pkg}`, startCommand: `./${out}` };
}

// --- Rust ---

/** Value of `key = "..."` inside the first `[section]` / `[[section]]` table. */
function tomlValue(toml: string, section: string, key: string): string | undefined {
  const lines = toml.split(/\r?\n/);
  let inside = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
    if (header) {
      if (inside) return undefined;
      inside = header[1]!.trim() === section;
      continue;
    }
    if (!inside) continue;
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`));
    if (m) return m[1];
  }
  return undefined;
}

function detectRustBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  if (!exists(dir, "Cargo.toml")) return undefined;
  const cargo = readSmall(path.join(dir, "Cargo.toml"));
  const name = tomlValue(cargo, "package", "default-run") ?? tomlValue(cargo, "bin", "name") ?? tomlValue(cargo, "package", "name");
  const framework: BackendFramework = /\baxum\b/.test(cargo)
    ? "axum"
    : /actix-web/.test(cargo)
      ? "actix"
      : /\brocket\b/.test(cargo)
        ? "rocket"
        : "rust";

  // Workspace members build into the workspace root's target/, not their own.
  let targetDir = "./target";
  for (let up = dir; up !== root && up.startsWith(root); ) {
    up = path.dirname(up);
    if (/^\[workspace\]/m.test(readSmall(path.join(up, "Cargo.toml")))) {
      targetDir = path.relative(dir, path.join(up, "target")).split(path.sep).join("/");
      break;
    }
  }
  return {
    role: "backend",
    path: rel,
    framework,
    runtime: "rust",
    packageManager: "cargo",
    buildCommand: "cargo build --release",
    startCommand: name ? `${targetDir}/release/${name}` : undefined,
  };
}

// --- Ruby ---

function detectRubyBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  if (!exists(dir, "Gemfile")) return undefined;
  const gemfile = readSmall(path.join(dir, "Gemfile")).toLowerCase();
  const gem = (name: string) => new RegExp(`gem\\s+["']${name}["']`).test(gemfile);
  const framework: BackendFramework = gem("rails") ? "rails" : gem("sinatra") ? "sinatra" : "ruby";

  let startCommand: string | undefined;
  if (framework === "rails") {
    // Rails' generated config/puma.rb already reads $PORT.
    startCommand = exists(dir, "config", "puma.rb") ? "bundle exec puma -C config/puma.rb" : "bundle exec rails server -b 0.0.0.0 -p $PORT";
  } else if (exists(dir, "config.ru") && gem("puma")) {
    startCommand = "bundle exec puma -b tcp://0.0.0.0:$PORT";
  } else if (exists(dir, "config.ru") && (gem("rackup") || gem("thin"))) {
    startCommand = "bundle exec rackup config.ru -o 0.0.0.0 -p $PORT";
  } else if (exists(dir, "app.rb")) {
    // Sinatra's classic style binds to localhost:4567 unless told otherwise.
    startCommand = "bundle exec ruby app.rb -o 0.0.0.0 -p $PORT";
  } else if (exists(dir, "config.ru")) {
    startCommand = "bundle exec rackup config.ru -o 0.0.0.0 -p $PORT";
  }

  return { role: "backend", path: rel, framework, runtime: "ruby", packageManager: "bundler", buildCommand: "bundle install", startCommand };
}

// --- Docker ---

function detectDockerBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  const name = ["Dockerfile", "dockerfile"].find((n) => exists(dir, n));
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
  // A monorepo root holds tooling (turbo, vitest, a root Dockerfile...), not the
  // app itself, whenever its workspaces contain a real one.
  if (workspacePatterns(root).length) {
    const dropRoot = <T extends { path: string }>(apps: T[]) => (apps.length > 1 ? apps.filter((a) => a.path !== ".") : apps);
    return { frontends: dropRoot(frontends), backends: dropRoot(backends) };
  }
  return { frontends, backends };
}

const PREFERRED_NAMES: Record<"frontend" | "backend", string[]> = {
  frontend: ["client", "frontend", "web", "app", "ui", "www", "site"],
  backend: ["server", "backend", "api"],
};

/**
 * Pick the obvious candidate when there's more than one, e.g. prefer ./client
 * over ./landing (or apps/web over apps/docs). Returns undefined when it's
 * genuinely ambiguous.
 */
export function pickObvious<T extends { path: string }>(role: "frontend" | "backend", apps: T[]): T | undefined {
  if (apps.length === 1) return apps[0];
  const preferred = apps.filter((a) => PREFERRED_NAMES[role].includes(path.posix.basename(a.path)));
  return preferred.length === 1 ? preferred[0] : undefined;
}
