import { ShipOneError } from "../core/errors.js";
import type { GitHubRepo } from "../core/git.js";
import { ApiClient, ApiError, type FetchLike } from "./http.js";
import type { CommitRef, DeployState, DeployStatus, EnvVar, FrontendHost, FrontendProject } from "./types.js";

export const NETLIFY_API = "https://api.netlify.com/api/v1";
export const NETLIFY_TOKEN_URL = "https://app.netlify.com/user/applications";
const NETLIFY_GITHUB_APP = "https://github.com/apps/netlify/installations/new";

interface NetlifySite {
  id: string;
  name: string;
  url?: string;
  ssl_url?: string;
  custom_domain?: string;
  admin_url?: string;
  account_id?: string;
  build_settings?: {
    repo_path?: string;
    repo_url?: string;
    repo_branch?: string;
    cmd?: string;
    dir?: string;
    stop_builds?: boolean;
  };
}

interface NetlifyDeploy {
  id: string;
  site_id?: string;
  state?: string;
  commit_ref?: string;
  created_at?: string;
  error_message?: string;
  deploy_ssl_url?: string;
  ssl_url?: string;
}

function mapState(s: string | undefined): DeployState {
  switch (s) {
    case "ready":
      return "ready";
    case "error":
      return "failed";
    case "rejected":
      return "canceled";
    case "building":
    case "processing":
    case "uploading":
    case "preparing":
      return "building";
    default:
      return "queued"; // new, enqueued, uploaded, ...
  }
}

/** "https://github.com/Owner/Repo" → "owner/repo" */
function repoFromUrl(url: string | undefined): string | undefined {
  const m = url?.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

/**
 * Netlify builds the configured branch's tip (the API can't pin a commit), which
 * is what ShipOne deploys anyway: it always deploys what's on GitHub.
 */
export class NetlifyHost implements FrontendHost {
  readonly name = "netlify" as const;
  readonly label = "Netlify";
  private readonly api: ApiClient;

  constructor(
    token: string,
    opts: { accountId?: string; fetch?: FetchLike; baseUrl?: string; retryDelayMs?: number } = {},
  ) {
    this.api = new ApiClient({
      label: "Netlify",
      baseUrl: opts.baseUrl ?? NETLIFY_API,
      token,
      reconnectCommand: "shipone connect netlify",
      fetch: opts.fetch,
      retryDelayMs: opts.retryDelayMs,
    });
    this.accountId = opts.accountId;
  }

  private accountId?: string;

  // ---- account-level calls, used by `shipone connect netlify` ----

  async whoami(): Promise<{ id: string; email?: string; full_name?: string }> {
    return this.api.get<{ id: string; email?: string; full_name?: string }>("/user");
  }

  async listAccounts(): Promise<{ id: string; name: string; slug?: string }[]> {
    return this.api.get<{ id: string; name: string; slug?: string }[]>("/accounts");
  }

  // ---- FrontendHost ----

  async findProject(idOrName: string): Promise<FrontendProject | undefined> {
    try {
      return toProject(await this.api.get<NetlifySite>(`/sites/${encodeURIComponent(idOrName)}`));
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async createProject(input: { name: string; repo: GitHubRepo; rootDirectory: string; framework: string }): Promise<FrontendProject> {
    try {
      // Netlify has no base-directory API setting, so a monorepo subdirectory is
      // handled by prefixing the build command; the publish dir is left to
      // Netlify's framework auto-detection.
      const s = await this.api.post<NetlifySite>("/sites", {
        name: input.name,
        ...(this.accountId ? { account_id: this.accountId } : {}),
        build_settings: {
          provider: "github",
          repo_path: `${input.repo.owner}/${input.repo.repo}`,
          repo_branch: "main",
          ...(input.rootDirectory !== "." ? { cmd: `cd ${input.rootDirectory} && npm run build` } : {}),
        },
      });
      if (s.account_id) this.accountId = s.account_id;
      return toProject(s);
    } catch (err) {
      throw withRepoAccessHint(err, input.repo);
    }
  }

  async disableGitDeployments(projectId: string): Promise<boolean> {
    // Netlify's stop_builds also blocks API-triggered builds (POST /builds
    // errors while builds are stopped), so deploy-on-push can't be turned
    // off without breaking `shipone deploy`. Pushes keep auto-building.
    void projectId;
    return false;
  }

  async productionUrl(projectId: string): Promise<string | undefined> {
    try {
      const s = await this.api.get<NetlifySite>(`/sites/${encodeURIComponent(projectId)}`);
      const url = s.ssl_url ?? s.url;
      return url ? https(url) : undefined;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async listEnvKeys(projectId: string): Promise<Set<string>> {
    try {
      const vars = await this.api.get<{ key: string }[]>(`/sites/${encodeURIComponent(projectId)}/env`);
      return new Set(vars.map((v) => v.key));
    } catch (err) {
      if (isNotFound(err)) return new Set();
      throw err;
    }
  }

  async setEnv(projectId: string, vars: EnvVar[]): Promise<void> {
    if (vars.length === 0) return;
    const accountId = await this.requireAccount(projectId);
    const existing = await this.listEnvKeys(projectId);
    const [updates, creates] = partition(vars, (v) => existing.has(v.key));
    if (creates.length) {
      await this.api.post(
        `/accounts/${encodeURIComponent(accountId)}/env`,
        creates.map((v) => ({ key: v.key, scopes: ["builds", "functions", "runtime"], values: [{ context: "all", value: v.value }] })),
        { site_id: projectId },
      );
    }
    for (const v of updates) {
      await this.api.patch(
        `/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(v.key)}`,
        { context: "all", value: v.value },
        { site_id: projectId },
      );
    }
  }

  async deploy(project: FrontendProject, commit: CommitRef): Promise<DeployStatus> {
    try {
      const b = await this.api.post<{ id: string; deploy_id: string; sha?: string; created_at?: string }>(
        `/sites/${encodeURIComponent(project.id)}/builds`,
        {},
        { branch: commit.branch, title: `shipone ${commit.sha.slice(0, 7)}` },
      );
      return {
        id: b.deploy_id,
        state: "queued",
        rawState: "new",
        sha: b.sha ?? commit.sha,
        createdAt: b.created_at,
      };
    } catch (err) {
      throw withDeployHint(err, commit);
    }
  }

  async getDeploy(projectId: string, deployId: string): Promise<DeployStatus> {
    const d = await this.api.get<NetlifyDeploy>(`/deploys/${encodeURIComponent(deployId)}`);
    const status = toStatus(d);
    if (status.state === "ready") status.url = (await this.productionUrl(projectId)) ?? https(d.deploy_ssl_url ?? d.ssl_url ?? "");
    return status;
  }

  async latestDeploy(projectId: string): Promise<DeployStatus | undefined> {
    const list = await this.api.get<NetlifyDeploy[]>(`/sites/${encodeURIComponent(projectId)}/deploys`, { page: 1, per_page: 1 });
    return list[0] ? toStatus(list[0]) : undefined;
  }

  async logs(deployId: string, limit: number): Promise<string[]> {
    try {
      const res = await this.api.get<{ lines?: { message: string }[] } | { message: string }[]>(
        `/deploys/${encodeURIComponent(deployId)}/log`,
        { limit },
      );
      const lines = Array.isArray(res) ? res : (res.lines ?? []);
      return lines.map((l) => l.message);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  dashboardUrl(project: FrontendProject): string {
    return `https://app.netlify.com/sites/${project.name}`;
  }

  private async requireAccount(projectId: string): Promise<string> {
    if (this.accountId) return this.accountId;
    const s = await this.api.get<NetlifySite>(`/sites/${encodeURIComponent(projectId)}`);
    if (!s.account_id) {
      throw new ShipOneError("Couldn't work out which Netlify account the site belongs to.", "Run `shipone connect netlify` to pick one.");
    }
    this.accountId = s.account_id;
    return s.account_id;
  }
}

function partition<T>(items: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (predicate(item) ? yes : no).push(item);
  return [yes, no];
}

const https = (host: string) => (host.startsWith("http") ? host : `https://${host}`);

function toProject(s: NetlifySite): FrontendProject {
  const repo = s.build_settings?.repo_path ?? repoFromUrl(s.build_settings?.repo_url);
  return { id: s.id, name: s.name, repo: repo?.toLowerCase() };
}

function toStatus(d: NetlifyDeploy): DeployStatus {
  const raw = d.state ?? "new";
  return {
    id: d.id,
    state: mapState(raw),
    rawState: raw,
    sha: d.commit_ref,
    createdAt: d.created_at,
    url: d.ssl_url ? https(d.ssl_url) : undefined,
    error: d.error_message ?? undefined,
  };
}

function withRepoAccessHint(err: unknown, repo: GitHubRepo): unknown {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && /repo|git|access|install/i.test(err.message)) {
    return new ShipOneError(
      err.message,
      `Netlify needs access to ${repo.owner}/${repo.repo}. Link GitHub in Netlify (Site configuration → Build & deploy) and grant the Netlify GitHub app access to this repo: ${NETLIFY_GITHUB_APP}`,
    );
  }
  return err;
}

function withDeployHint(err: unknown, commit: CommitRef): unknown {
  if (err instanceof ApiError && err.status === 403 && /stop/i.test(err.message)) {
    return new ShipOneError(
      "Netlify refused to trigger a build.",
      `Builds are stopped for this site. Activate them in the Netlify dashboard (site → Deploys → Activate builds), or make sure the Netlify GitHub app can see ${commit.owner}/${commit.repo}: ${NETLIFY_GITHUB_APP}`,
    );
  }
  return err;
}