import { ShipOneError } from "../core/errors.js";
import type { GitHubRepo } from "../core/git.js";
import { ApiClient, ApiError, type FetchLike } from "./http.js";
import type { CommitRef, DeployState, DeployStatus, EnvVar, FrontendHost, FrontendProject } from "./types.js";

export const VERCEL_API = "https://api.vercel.com";
export const VERCEL_TOKEN_URL = "https://vercel.com/account/tokens";
const VERCEL_GITHUB_APP = "https://github.com/apps/vercel/installations/new";

interface VercelProject {
  id: string;
  name: string;
  link?: { type?: string; org?: string; repo?: string };
}

interface VercelDeployment {
  id?: string;
  uid?: string;
  url?: string;
  readyState?: string;
  state?: string;
  alias?: string[];
  errorMessage?: string | null;
  createdAt?: number;
  created?: number;
  meta?: Record<string, string | undefined>;
  gitSource?: { sha?: string };
}

type VercelEvent = { text?: string; payload?: { text?: string } } | null;

function mapState(s: string | undefined): DeployState {
  switch (s) {
    case "READY":
      return "ready";
    case "ERROR":
      return "failed";
    case "CANCELED":
      return "canceled";
    case "BUILDING":
      return "building";
    default:
      return "queued"; // QUEUED, INITIALIZING
  }
}

const https = (host: string) => (host.startsWith("http") ? host : `https://${host}`);

export function isNotFound(err: unknown) {
  return err instanceof ApiError && err.status === 404;
}

export class VercelHost implements FrontendHost {
  readonly name = "vercel" as const;
  readonly label = "Vercel";
  private readonly api: ApiClient;

  constructor(
    token: string,
    opts: { teamId?: string; teamSlug?: string; fetch?: FetchLike; baseUrl?: string; retryDelayMs?: number } = {},
  ) {
    this.api = new ApiClient({
      label: "Vercel",
      baseUrl: opts.baseUrl ?? VERCEL_API,
      token,
      reconnectCommand: "shipone connect vercel",
      fetch: opts.fetch,
      defaultQuery: { teamId: opts.teamId },
      retryDelayMs: opts.retryDelayMs,
    });
    this.teamSlug = opts.teamSlug;
  }

  private readonly teamSlug?: string;

  // ---- account-level calls, used by `shipone connect vercel` ----

  async whoami(): Promise<{ username: string; email?: string }> {
    const res = await this.api.get<{ user: { username: string; email?: string } }>("/v2/user");
    return res.user;
  }

  async listTeams(): Promise<{ id: string; slug: string; name?: string }[]> {
    const res = await this.api.get<{ teams?: { id: string; slug: string; name?: string }[] }>("/v2/teams", { limit: 100 });
    return res.teams ?? [];
  }

  // ---- FrontendHost ----

  async findProject(idOrName: string): Promise<FrontendProject | undefined> {
    try {
      const p = await this.api.get<VercelProject>(`/v9/projects/${encodeURIComponent(idOrName)}`);
      return toProject(p);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async createProject(input: { name: string; repo: GitHubRepo; rootDirectory: string; framework: string }): Promise<FrontendProject> {
    try {
      const p = await this.api.post<VercelProject>("/v11/projects", {
        name: input.name,
        framework: input.framework,
        rootDirectory: input.rootDirectory === "." ? null : input.rootDirectory,
        gitRepository: { type: "github", repo: `${input.repo.owner}/${input.repo.repo}` },
      });
      return toProject(p);
    } catch (err) {
      throw withRepoAccessHint(err, input.repo);
    }
  }

  async disableGitDeployments(projectId: string): Promise<boolean> {
    try {
      await this.api.patch(`/v9/projects/${projectId}`, { gitProviderOptions: { createDeployments: "disabled" } });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401) return false;
      throw err;
    }
  }

  async productionUrl(projectId: string): Promise<string | undefined> {
    try {
      const res = await this.api.get<{ domains?: { name: string; redirect?: string | null; gitBranch?: string | null }[] }>(
        `/v9/projects/${projectId}/domains`,
        { production: "true" },
      );
      const candidates = (res.domains ?? []).filter((d) => !d.redirect && !d.gitBranch).map((d) => d.name);
      // Prefer a custom domain if the user added one, otherwise the *.vercel.app one.
      const custom = candidates.find((d) => !d.endsWith(".vercel.app"));
      const chosen = custom ?? candidates.sort((a, b) => a.length - b.length)[0];
      return chosen ? https(chosen) : undefined;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async listEnvKeys(projectId: string): Promise<Set<string>> {
    const res = await this.api.get<{ envs?: { key: string; target?: string | string[] }[] }>(`/v10/projects/${projectId}/env`);
    const keys = new Set<string>();
    for (const e of res.envs ?? []) {
      const targets = Array.isArray(e.target) ? e.target : e.target ? [e.target] : [];
      if (targets.length === 0 || targets.includes("production")) keys.add(e.key);
    }
    return keys;
  }

  async setEnv(projectId: string, vars: EnvVar[]): Promise<void> {
    if (vars.length === 0) return;
    await this.api.post(
      `/v10/projects/${projectId}/env`,
      vars.map((v) => ({ key: v.key, value: v.value, type: "encrypted", target: ["production", "preview"] })),
      { upsert: "true" },
    );
  }

  async deploy(project: FrontendProject, commit: CommitRef): Promise<DeployStatus> {
    try {
      const d = await this.api.post<VercelDeployment>(
        "/v13/deployments",
        {
          name: project.name,
          project: project.id,
          target: "production",
          gitSource: { type: "github", org: commit.owner, repo: commit.repo, ref: commit.branch, sha: commit.sha },
        },
        { skipAutoDetectionConfirmation: "1" },
      );
      return toStatus(d);
    } catch (err) {
      throw withRepoAccessHint(err, commit);
    }
  }

  async getDeploy(projectId: string, deployId: string): Promise<DeployStatus> {
    const d = await this.api.get<VercelDeployment>(`/v13/deployments/${deployId}`);
    const status = toStatus(d);
    if (status.state === "ready") status.url = (await this.productionUrl(projectId)) ?? pickAlias(d) ?? status.url;
    return status;
  }

  async latestDeploy(projectId: string): Promise<DeployStatus | undefined> {
    const res = await this.api.get<{ deployments?: VercelDeployment[] }>("/v7/deployments", { projectId, limit: 1, target: "production" });
    const d = res.deployments?.[0];
    return d ? toStatus(d) : undefined;
  }

  async logs(deployId: string, limit: number): Promise<string[]> {
    const events = await this.api.get<VercelEvent[] | VercelEvent>(`/v3/deployments/${deployId}/events`, {
      builds: 1,
      direction: "backward",
      limit,
    });
    const list = Array.isArray(events) ? events : [events];
    return list
      .map((e) => e?.text ?? e?.payload?.text)
      .filter((t): t is string => typeof t === "string" && t.length > 0)
      .reverse();
  }

  dashboardUrl(project: FrontendProject): string {
    return `https://vercel.com/${this.teamSlug ?? "dashboard"}/${project.name}`;
  }
}

function toProject(p: VercelProject): FrontendProject {
  const repo = p.link?.org && p.link?.repo ? `${p.link.org}/${p.link.repo}` : undefined;
  return { id: p.id, name: p.name, repo };
}

function pickAlias(d: VercelDeployment): string | undefined {
  const aliases = (d.alias ?? []).filter((a) => !a.includes("-git-"));
  const shortest = aliases.sort((a, b) => a.length - b.length)[0];
  return shortest ? https(shortest) : undefined;
}

function toStatus(d: VercelDeployment): DeployStatus {
  const raw = d.readyState ?? d.state ?? "QUEUED";
  return {
    id: (d.id ?? d.uid)!,
    state: mapState(raw),
    rawState: raw,
    sha: d.gitSource?.sha ?? d.meta?.githubCommitSha,
    createdAt: new Date(d.createdAt ?? d.created ?? Date.now()).toISOString(),
    url: d.url ? https(d.url) : undefined,
    error: d.errorMessage ?? undefined,
  };
}

function withRepoAccessHint(err: unknown, repo: GitHubRepo): unknown {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && /repo|git|install|integration/i.test(err.message)) {
    return new ShipOneError(
      err.message,
      `Vercel needs access to ${repo.owner}/${repo.repo}. Connect GitHub in Vercel and grant the Vercel GitHub app access to this repo: ${VERCEL_GITHUB_APP}`,
    );
  }
  return err;
}
