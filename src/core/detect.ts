import fs from "node:fs";
import path from "node:path";

/**
 * Stack detection. Each detector looks at one folder and says whether it's a
 * frontend or backend it understands. Adding a framework = adding a detector.
 */

export type FrontendFramework = "vite" | "nextjs" | "create-react-app";
export type BackendFramework = "express" | "fastify" | "koa" | "hapi" | "node";
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
  runtime: "node";
  packageManager: PackageManager;
  buildCommand: string;
  /** Undefined when we can't work out how to start it. */
  startCommand?: string;
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
};

const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "public", "docs", "test", "tests", "scripts"]);
const SOURCE_EXT = /\.(m?[jt]sx?|vue|svelte|astro)$/;

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
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
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
      return "npm install -g pnpm && pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    default:
      return hasLockfile ? "npm ci" : "npm install";
  }
}

const runScript = (pm: PackageManager, script: string) => (pm === "npm" ? `npm run ${script}` : `${pm} ${script}`);

export function detectFrontend(root: string, rel: string): FrontendApp | undefined {
  const dir = path.join(root, rel);
  const pkg = readPkg(dir);
  if (!pkg) return undefined;
  let framework: FrontendFramework | undefined;
  if (hasDep(pkg, "next")) framework = "nextjs";
  else if (hasDep(pkg, "vite")) framework = "vite";
  else if (hasDep(pkg, "react-scripts")) framework = "create-react-app";
  if (!framework) return undefined;

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

const SERVER_DEPS: [string, BackendFramework][] = [
  ["express", "express"],
  ["fastify", "fastify"],
  ["koa", "koa"],
  ["@hapi/hapi", "hapi"],
];

const ENTRY_GUESSES = ["server.js", "index.js", "app.js", "src/server.js", "src/index.js", "src/app.js"];

export function detectBackend(root: string, rel: string): BackendApp | undefined {
  const dir = path.join(root, rel);
  const pkg = readPkg(dir);
  if (!pkg) return undefined;
  const hit = SERVER_DEPS.find(([dep]) => pkg.dependencies?.[dep]);
  if (!hit) return undefined;

  const pm = detectPackageManager(root, dir);
  const hasLockfile = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"].some((f) => fs.existsSync(path.join(dir, f)));
  let buildCommand = installCommand(pm, hasLockfile);
  if (pkg.scripts?.build) buildCommand += ` && ${runScript(pm, "build")}`;

  let startCommand: string | undefined;
  if (pkg.scripts?.start) startCommand = pm === "npm" ? "npm start" : `${pm} start`;
  else if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) startCommand = `node ${pkg.main}`;
  else {
    const entry = ENTRY_GUESSES.find((f) => fs.existsSync(path.join(dir, f)));
    if (entry) startCommand = `node ${entry}`;
  }

  return { role: "backend", path: rel, framework: hit[1], runtime: "node", packageManager: pm, buildCommand, startCommand };
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
