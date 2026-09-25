import { ShipOneError } from "../core/errors.js";
import type { BackendRuntime } from "../core/detect.js";
import { repoUrl, type GitHubRepo } from "../core/git.js";
import { ApiClient, ApiError, type FetchLike } from "./http.js";
import type { BackendHost, BackendService, CommitRef, DeployState, DeployStatus, EnvVar } from "./types.js";

export const RENDER_API = "https://api.render.com/v1";
export const RENDER_TOKEN_URL = "https://dashboard.render.com/u/settings#api-keys";
const RENDER_GITHUB_APP = "https://github.com/apps/render/installations/new";

interface RenderService {
  id: string;
  name: string;
  repo?: string;
  branch?: string;
  dashboardUrl?: string;
  serviceDetails?: { url?: string; envSpecificDetails?: { buildCommand?: string; startCommand?: string; dockerfilePath?: string } };
}

interface RenderDeploy {
  id: string;
  status?: string;
  commit?: { id?: string };
  createdAt?: string;
}

function mapState(s: string | undefined): DeployState {
  switch (s) {
    case "live":
      return "ready";
    case "build_failed":
    case "update_failed":
    case "pre_deploy_failed":
      return "failed";
    case "canceled":
    case "deactivated":
      return "canceled";
    case "build_in_progress":
    case "update_in_progress":
    case "pre_deploy_in_progress":
      return "building";
    default:
      return "queued"; // created, queued
  }
}

const toStatus = (d: RenderDeploy): DeployStatus => ({
  id: d.id,
  state: mapState(d.status),
  rawState: d.status ?? "created",
  sha: d.commit?.id,
  createdAt: d.createdAt,
});

/** "https://github.com/Owner/Repo.git" → "owner/repo" */
export function repoFromUrl(url: string | undefined): string | undefined {
  const m = url?.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

export class RenderHost implements BackendHost {
  readonly name = "render" as const;
  readonly label = "Render";
  private readonly api: ApiClient;
  private readonly ownerId: string | undefined;
  private readonly region: string;
  private readonly plan: string;

  constructor(
    token: string,
    opts: { ownerId?: string; region?: string; plan?: string; fetch?: FetchLike; baseUrl?: string; retryDelayMs?: number } = {},
  ) {
    this.api = new ApiClient({
      label: "Render",
      baseUrl: opts.baseUrl ?? RENDER_API,
      token,
      reconnectCommand: "shipone connect render",
      fetch: opts.fetch,
      retryDelayMs: opts.retryDelayMs,
    });
    this.ownerId = opts.ownerId;
    this.region = opts.region ?? "oregon";
    this.plan = opts.plan ?? "free";
  }

  private requireOwner(): string {
    if (!this.ownerId) {
      throw new ShipOneError("No Render workspace selected.", "Run `shipone connect render` again to pick one.");
    }
    return this.ownerId;
  }

  // ---- account-level, used by `shipone connect render` ----

  async listOwners(): Promise<{ id: string; name: string; email?: string; type?: string }[]> {
    const res = await this.api.get<{ owner?: { id: string; name: string; email?: string; type?: string } }[]>("/owners", { limit: 100 });
    return res.map((r) => r.owner).filter((o): o is NonNullable<typeof o> => Boolean(o));
  }

  // ---- BackendHost ----

  async findService(name: string): Promise<BackendService | undefined> {
    const res = await this.api.get<{ service: RenderService }[]>("/services", { name, ownerId: this.ownerId, limit: 20 });
    const s = res.map((r) => r.service).find((svc) => svc.name === name);
    return s ? toService(s) : undefined;
  }

  async getService(id: string): Promise<BackendService | undefined> {
    try {
      return toService(await this.api.get<RenderService>(`/services/${id}`));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  async createService(input: {
    name: string;
    repo: GitHubRepo;
    branch: string;
    rootDir: string;
    runtime: BackendRuntime;
    buildCommand: string;
    startCommand: string;
    dockerfilePath?: string;
    env: EnvVar[];
  }): Promise<BackendService & { initialDeployId?: string }> {
    try {
      // Docker services build from a Dockerfile; the container's own CMD/ENTRYPOINT
      // is the start command, and Render needs the build/start fields left empty.
      const docker = input.runtime === "docker";
      const res = await this.api.post<{ service: RenderService; deployId?: string }>("/services", {
        type: "web_service",
        name: input.name,
        ownerId: this.requireOwner(),
        repo: repoUrl(input.repo),
        branch: input.branch,
        rootDir: input.rootDir === "." ? undefined : input.rootDir,
        // "Push now, deploy later": only `shipone deploy` deploys.
        autoDeploy: "no",
        envVars: input.env.map((e) => ({ key: e.key, value: e.value })),
        serviceDetails: {
          runtime: docker ? "docker" : input.runtime,
          plan: this.plan,
          region: this.region,
          envSpecificDetails: docker
            ? { dockerfilePath: input.dockerfilePath ?? "./Dockerfile", dockerCommand: "", dockerContext: "." }
            : { buildCommand: input.buildCommand, startCommand: input.startCommand },
        },
      });
      return { ...toService(res.service), initialDeployId: res.deployId };
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && /repo|git|access|install/i.test(err.message)) {
        throw new ShipOneError(
          err.message,
          `Render needs access to ${input.repo.owner}/${input.repo.repo}. Connect GitHub in Render and grant the Render GitHub app access to this repo: ${RENDER_GITHUB_APP}`,
        );
      }
      if (err instanceof ApiError && /free/i.test(err.message) && /limit|instance|plan/i.test(err.message)) {
        throw new ShipOneError(err.message, "You've hit Render's free tier limit. Delete an unused free service or set a paid plan: `shipone config set render.plan starter`.");
      }
      throw err;
    }
  }

  async configure(
    serviceId: string,
    opts: { branch?: string; disableAutoDeploy?: boolean; buildCommand?: string; startCommand?: string; dockerfilePath?: string },
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (opts.branch) body.branch = opts.branch;
    if (opts.disableAutoDeploy) body.autoDeploy = "no";
    const details: Record<string, unknown> = {};
    if (opts.buildCommand) details.buildCommand = opts.buildCommand;
    if (opts.startCommand) details.startCommand = opts.startCommand;
    if (opts.dockerfilePath) details.dockerfilePath = opts.dockerfilePath;
    if (Object.keys(details).length) body.serviceDetails = { envSpecificDetails: details };
    if (Object.keys(body).length) await this.api.patch(`/services/${serviceId}`, body);
  }

  async listEnvKeys(serviceId: string): Promise<Set<string>> {
    const res = await this.api.get<{ envVar: { key: string } }[]>(`/services/${serviceId}/env-vars`, { limit: 100 });
    return new Set(res.map((r) => r.envVar.key));
  }

  async setEnv(serviceId: string, vars: EnvVar[]): Promise<void> {
    // Per-key PUT: the bulk PUT endpoint *replaces* every env var on the service.
    for (const v of vars) {
      await this.api.put(`/services/${serviceId}/env-vars/${encodeURIComponent(v.key)}`, { value: v.value });
    }
  }

  async deploy(serviceId: string, commit: CommitRef): Promise<DeployStatus> {
    const d = await this.api.post<RenderDeploy | undefined>(`/services/${serviceId}/deploys`, { commitId: commit.sha });
    if (d?.id) return toStatus(d);
    // 202 Accepted (queued behind another deploy) has no body; look it up.
    const latest = await this.latestDeploy(serviceId);
    if (!latest) throw new ShipOneError("Render accepted the deploy but didn't report it yet.", "Run `shipone status` in a moment.");
    return latest;
  }

  async getDeploy(serviceId: string, deployId: string): Promise<DeployStatus> {
    return toStatus(await this.api.get<RenderDeploy>(`/services/${serviceId}/deploys/${deployId}`));
  }

  async latestDeploy(serviceId: string): Promise<DeployStatus | undefined> {
    const res = await this.api.get<{ deploy?: RenderDeploy }[]>(`/services/${serviceId}/deploys`, { limit: 1 });
    const d = res[0]?.deploy;
    return d ? toStatus(d) : undefined;
  }

  async logs(serviceId: string, limit: number): Promise<string[]> {
    const res = await this.api.get<{ logs?: { message: string; timestamp?: string }[] }>("/logs", {
      ownerId: this.requireOwner(),
      resource: [serviceId],
      direction: "backward",
      limit,
    });
    return (res.logs ?? []).map((l) => l.message).reverse();
  }
}

function toService(s: RenderService): BackendService {
  const details = s.serviceDetails?.envSpecificDetails as { buildCommand?: string; startCommand?: string; dockerfilePath?: string } | undefined;
  return {
    id: s.id,
    name: s.name,
    url: s.serviceDetails?.url ?? `https://${s.name}.onrender.com`,
    branch: s.branch,
    repo: repoFromUrl(s.repo),
    buildCommand: details?.buildCommand,
    startCommand: details?.startCommand,
    dashboardUrl: s.dashboardUrl,
  };
}
