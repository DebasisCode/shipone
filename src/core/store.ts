import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ShipOneError } from "./errors.js";
import type { BackendProviderName, FrontendProviderName, ProviderName } from "./types.js";

/**
 * Everything ShipOne remembers lives under ~/.shipone (override with SHIPONE_HOME):
 *
 *   config.json       account defaults + per-repo overrides (safe to share)
 *   credentials.json  provider tokens, mode 0600
 *   state.json        ids/URLs of the services ShipOne created, per repo
 */
export function shiponeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHIPONE_HOME || path.join(os.homedir(), ".shipone");
}

export interface RepoOverride {
  frontend?: FrontendProviderName;
  backend?: BackendProviderName;
}

export interface AccountConfig {
  defaults: { frontend?: FrontendProviderName; backend?: BackendProviderName };
  /** Keyed by "owner/repo". */
  repos: Record<string, RepoOverride>;
  vercel?: { teamId?: string; teamSlug?: string };
  netlify?: { accountId?: string; accountName?: string };
  render?: { ownerId?: string; ownerName?: string; region?: string; plan?: string };
  railway?: { workspaceId?: string; workspaceName?: string };
}

export type Credentials = Partial<Record<ProviderName, string>>;

export interface FrontendState {
  provider: FrontendProviderName;
  projectId: string;
  projectName: string;
  url?: string;
}

export interface BackendState {
  provider: BackendProviderName;
  serviceId: string;
  serviceName: string;
  url: string;
}

export interface RepoState {
  frontend?: FrontendState;
  backend?: BackendState;
  lastDeploy?: { sha: string; at: string };
}

export type StateFile = Record<string, RepoState>;

/** Env vars that take precedence over stored credentials (handy for CI). */
export const TOKEN_ENV_VARS: Record<ProviderName, string> = {
  vercel: "VERCEL_TOKEN",
  netlify: "NETLIFY_AUTH_TOKEN",
  render: "RENDER_API_KEY",
  railway: "RAILWAY_TOKEN",
};

export class Store {
  readonly dir: string;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.dir = shiponeHome(env);
  }

  private file(name: string) {
    return path.join(this.dir, name);
  }

  private read<T>(name: string, fallback: T): T {
    const file = this.file(name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new ShipOneError(`${file} is not valid JSON.`, `Fix or delete the file, then try again.`);
    }
  }

  private write(name: string, data: unknown, mode = 0o644) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
    fs.renameSync(tmp, file);
    // renameSync keeps the tmp file's mode, but be explicit in case the file pre-existed with looser perms.
    fs.chmodSync(file, mode);
  }

  readConfig(): AccountConfig {
    const cfg = this.read<Partial<AccountConfig>>("config.json", {});
    return { ...cfg, defaults: cfg.defaults ?? {}, repos: cfg.repos ?? {} };
  }

  writeConfig(cfg: AccountConfig) {
    this.write("config.json", cfg);
  }

  updateConfig(fn: (cfg: AccountConfig) => void): AccountConfig {
    const cfg = this.readConfig();
    fn(cfg);
    this.writeConfig(cfg);
    return cfg;
  }

  readCredentials(): Credentials {
    return this.read<Credentials>("credentials.json", {});
  }

  /** Token from the environment first, then from credentials.json. */
  getToken(provider: ProviderName): string | undefined {
    return this.env[TOKEN_ENV_VARS[provider]] || this.readCredentials()[provider] || undefined;
  }

  setToken(provider: ProviderName, token: string | undefined) {
    const creds = this.readCredentials();
    if (token) creds[provider] = token;
    else delete creds[provider];
    this.write("credentials.json", creds, 0o600);
  }

  readState(): StateFile {
    return this.read<StateFile>("state.json", {});
  }

  getRepoState(slug: string): RepoState {
    return this.readState()[slug] ?? {};
  }

  updateRepoState(slug: string, fn: (s: RepoState) => void): RepoState {
    const all = this.readState();
    const s = all[slug] ?? {};
    fn(s);
    all[slug] = s;
    this.write("state.json", all);
    return s;
  }
}
