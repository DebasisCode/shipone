import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ShipOneError } from "./errors.js";
import {
  BACKEND_PROVIDERS,
  FRONTEND_PROVIDERS,
  isBackendProvider,
  isFrontendProvider,
  type BackendProviderName,
  type FrontendProviderName,
} from "./types.js";

export const REPO_CONFIG_FILE = ".shipone.yml";

export interface FrontendConfig {
  path: string;
  provider?: FrontendProviderName;
  /** Env var the frontend reads the backend URL from, e.g. VITE_API_URL. */
  apiUrlEnv?: string;
}

export interface BackendConfig {
  path: string;
  provider?: BackendProviderName;
  buildCommand?: string;
  startCommand?: string;
}

/** The versioned, per-repo config. Highest priority in preference resolution. */
export interface RepoConfig {
  deploy?: boolean;
  /** Base name for the created services. Defaults to the GitHub repo name. */
  name?: string;
  frontend?: FrontendConfig;
  backend?: BackendConfig;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function optString(o: Obj, key: string, where: string, errors: string[]): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) {
    errors.push(`${where ? `${where}.` : ""}${key} must be a non-empty string`);
    return undefined;
  }
  return v.trim();
}

/** Normalise "./client/" → "client", "." / "./" → ".". Rejects paths escaping the repo. */
export function normalizeAppPath(p: string): string {
  const n = path.posix.normalize(p.replace(/\\/g, "/")).replace(/\/+$/, "");
  const cleaned = n === "" || n === "./" ? "." : n.replace(/^\.\//, "");
  if (cleaned.startsWith("..") || path.posix.isAbsolute(cleaned)) {
    throw new ShipOneError(`App path "${p}" must be inside the repository.`);
  }
  return cleaned || ".";
}

export function validateRepoConfig(raw: unknown): RepoConfig {
  if (raw === null || raw === undefined) return {};
  if (!isObj(raw)) throw new ShipOneError(`${REPO_CONFIG_FILE} must be a YAML mapping.`);

  const errors: string[] = [];
  const cfg: RepoConfig = {};

  if (raw.deploy !== undefined) {
    if (typeof raw.deploy !== "boolean") errors.push("deploy must be true or false");
    else cfg.deploy = raw.deploy;
  }
  cfg.name = optString(raw, "name", "", errors)?.toLowerCase();

  if (raw.frontend !== undefined) {
    const f = raw.frontend;
    if (!isObj(f)) errors.push("frontend must be a mapping like { path: ./client, provider: vercel }");
    else {
      const p = optString(f, "path", "frontend", errors);
      if (!p) errors.push("frontend.path is required");
      const provider = f.provider;
      if (provider !== undefined && !isFrontendProvider(provider)) {
        errors.push(`frontend.provider must be one of: ${FRONTEND_PROVIDERS.join(", ")}`);
      }
      const apiUrlEnv = optString(f, "apiUrlEnv", "frontend", errors);
      if (apiUrlEnv && !/^[A-Z_][A-Z0-9_]*$/.test(apiUrlEnv)) errors.push("frontend.apiUrlEnv must look like VITE_API_URL");
      if (p) cfg.frontend = { path: normalizeAppPath(p), provider: provider as FrontendProviderName | undefined, apiUrlEnv };
    }
  }

  if (raw.backend !== undefined) {
    const b = raw.backend;
    if (!isObj(b)) errors.push("backend must be a mapping like { path: ./server, provider: render }");
    else {
      const p = optString(b, "path", "backend", errors);
      if (!p) errors.push("backend.path is required");
      const provider = b.provider;
      if (provider !== undefined && !isBackendProvider(provider)) {
        errors.push(`backend.provider must be one of: ${BACKEND_PROVIDERS.join(", ")}`);
      }
      const buildCommand = optString(b, "buildCommand", "backend", errors);
      const startCommand = optString(b, "startCommand", "backend", errors);
      if (p) cfg.backend = { path: normalizeAppPath(p), provider: provider as BackendProviderName | undefined, buildCommand, startCommand };
    }
  }

  if (errors.length) {
    throw new ShipOneError(`${REPO_CONFIG_FILE} is invalid:\n  - ${errors.join("\n  - ")}`);
  }
  // Drop undefined keys so the file we write back stays tidy.
  return JSON.parse(JSON.stringify(cfg)) as RepoConfig;
}

export function readRepoConfig(root: string): RepoConfig | undefined {
  const file = path.join(root, REPO_CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (err) {
    throw new ShipOneError(`${REPO_CONFIG_FILE} is not valid YAML: ${(err as Error).message}`);
  }
  return validateRepoConfig(parsed);
}

export function writeRepoConfig(root: string, cfg: RepoConfig) {
  const doc = new YAML.Document(JSON.parse(JSON.stringify({ deploy: cfg.deploy ?? true, ...cfg })));
  doc.commentBefore =
    " ShipOne deploy settings (https://github.com/debasiscode/shipone).\n" +
    " Commit this file. Service ids/URLs are kept locally in ~/.shipone/state.json.";
  fs.writeFileSync(path.join(root, REPO_CONFIG_FILE), doc.toString());
}
