import { ShipOneError } from "../core/errors.js";
import type { BackendRuntime } from "../core/detect.js";
import type { GitHubRepo } from "../core/git.js";
import { ApiError, type FetchLike } from "./http.js";
import type { BackendHost, BackendService, CommitRef, DeployState, DeployStatus, EnvVar } from "./types.js";

export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
export const RAILWAY_TOKEN_URL = "https://railway.com/account/tokens";
const RAILWAY_GITHUB_APP = "https://github.com/apps/railway/installations/new";

/** The port new Railway services and their generated domain both use. */
const PORT = 8080;

interface GqlResponse<T> {
  data?: T | null;
  errors?: { message: string; path?: (string | number)[] }[];
}

interface Workspace {
  id: string;
  name: string;
}

interface RailwayProject {
  id: string;
  name: string;
  environments?: { edges: { node: { id: string; name: string } }[] };
  services?: { edges: { node: { id: string; name: string } }[] };
}

interface ServiceInstanceNode {
  id: string;
  serviceName: string;
  startCommand?: string | null;
  buildCommand?: string | null;
  rootDirectory?: string | null;
  dockerfilePath?: string | null;
  source?: { repo?: string | null } | null;
  domains?: { serviceDomains: { id: string; domain: string }[] } | null;
}

interface DeploymentNode {
  id: string;
  status: string;
  createdAt: string;
  meta?: unknown;
}

function mapState(s: string | undefined): DeployState {
  switch (s) {
    case "SUCCESS":
      return "ready";
    case "FAILED":
    case "CRASHED":
      return "failed";
    case "REMOVED":
    case "REMOVING":
    case "SKIPPED":
      return "canceled";
    case "BUILDING":
    case "DEPLOYING":
      return "building";
    default:
      return "queued"; // QUEUED, WAITING, INITIALIZING, NEEDS_APPROVAL
  }
}

const toStatus = (d: DeploymentNode): DeployStatus => ({
  id: d.id,
  state: mapState(d.status),
  rawState: d.status,
  sha: (d.meta as { commitSha?: string } | null | undefined)?.commitSha,
  createdAt: d.createdAt,
});

/** Service ids are only meaningful together with their project + environment. */
interface ServiceContext {
  serviceId: string;
  projectId: string;
  environmentId: string;
}

export class RailwayHost implements BackendHost {
  readonly name = "railway" as const;
  readonly label = "Railway";
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly workspaceId?: string;
  /** serviceId → project/environment, learned on lookup. */
  private readonly contexts = new Map<string, ServiceContext>();

  constructor(
    token: string,
    opts: { workspaceId?: string; fetch?: FetchLike; baseUrl?: string; retryDelayMs?: number } = {},
  ) {
    this.endpoint = opts.baseUrl ?? RAILWAY_API;
    this.token = token;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.workspaceId = opts.workspaceId;
    void opts.retryDelayMs;
  }

  /** Run one GraphQL operation; throws on data-level errors. */
  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "shipone-cli",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const reason = (err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message;
      throw new ShipOneError(`Couldn't reach Railway (${reason}).`, "Check your internet connection and try again.");
    }
    const body = (await res.json().catch(() => undefined)) as GqlResponse<T> | undefined;
    if (!body) throw new ShipOneError("Railway returned an unreadable response.", "Try again in a moment.");
    if (body.errors?.length) {
      const first = body.errors[0]!;
      // Railway answers "Not Authorized" both for bad tokens and for
      // resources the token can't see (e.g. a deleted service), so the
      // original message is kept for callers to interpret.
      const hint = /not authorized|unauthorized/i.test(first.message) ? "Run `shipone connect railway` with a fresh token." : undefined;
      throw new ApiError(first.message, hint, 200, undefined, body);
    }
    if (body.data === null || body.data === undefined) {
      throw new ShipOneError("Railway returned no data for the request.", "Try again in a moment.");
    }
    return body.data;
  }

  // ---- account-level calls, used by `shipone connect railway` ----

  async me(): Promise<{ id: string; name: string; email?: string; workspaces: Workspace[] }> {
    const data = await this.gql<{ me: { id: string; name: string; email?: string; workspaces: { id: string; name: string }[] } }>(
      `query { me { id name email workspaces { id name } } }`,
    );
    return { ...data.me, workspaces: data.me.workspaces ?? [] };
  }

  /** Validate the token; account tokens answer `me`, workspace tokens can still list their projects. */
  async whoami(): Promise<{ name: string; workspaces: Workspace[] }> {
    try {
      const me = await this.me();
      return { name: me.name ?? me.email ?? "me", workspaces: me.workspaces };
    } catch {
      // Workspace-scoped tokens can't query `me`: they can still list projects.
      const projects = await this.listProjects();
      if (projects.length === 0 && this.workspaceId === undefined) throw new ShipOneError("Railway rejected that token.", "Create it under Account Settings → API Tokens.");
      return { name: "Railway", workspaces: [] };
    }
  }

  // ---- helpers ----

  /** All projects the token can see (personal + chosen workspace). */
  private async listProjects(): Promise<RailwayProject[]> {
    const query = `query ($workspaceId: String) {
      personal: projects(first: 100) { edges { node { id name } } }
      ws: projects(workspaceId: $workspaceId, first: 100) { edges { node { id name } } }
    }`;
    const data = await this.gql<{
      personal: { edges: { node: { id: string; name: string } }[] };
      ws: { edges: { node: { id: string; name: string } }[] } | null;
    }>(query, { workspaceId: this.workspaceId });
    const seen = new Map<string, { id: string; name: string }>();
    for (const p of [...(data.personal?.edges ?? []), ...(data.ws?.edges ?? [])]) seen.set(p.node.id, p.node);
    return [...seen.values()];
  }

  private async loadProject(projectId: string): Promise<{ project: RailwayProject; environmentId: string }> {
    const data = await this.gql<{ project: RailwayProject }>(
      `query ($id: String!) {
        project(id: $id) {
          id
          name
          environments { edges { node { id name } } }
          services { edges { node { id name } } }
        }
      }`,
      { id: projectId },
    );
    const project = data.project;
    const env = project.environments?.edges.find((e) => e.node.name === "production")?.node ?? project.environments?.edges[0]?.node;
    if (!env) throw new ShipOneError(`Railway project "${project.name}" has no environment.`, "Create one in the Railway dashboard.");
    return { project, environmentId: env.id };
  }

  private async loadInstance(serviceId: string, environmentId: string): Promise<ServiceInstanceNode> {
    const data = await this.gql<{ serviceInstance: ServiceInstanceNode }>(
      `query ($serviceId: String!, $environmentId: String!) {
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          id
          serviceName
          startCommand
          buildCommand
          rootDirectory
          dockerfilePath
          source { repo }
          domains { serviceDomains { id domain } }
        }
      }`,
      { serviceId, environmentId },
    );
    return data.serviceInstance;
  }

  /** The branch the service's GitHub deploy trigger builds. */
  private async loadBranch(serviceId: string): Promise<string | undefined> {
    try {
      const data = await this.gql<{ service: { repoTriggers: { edges: { node: { branch?: string | null } }[] } } }>(
        `query ($id: String!) { service(id: $id) { id repoTriggers { edges { node { branch } } } } }`,
        { id: serviceId },
      );
      return data.service.repoTriggers.edges[0]?.node.branch ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Look a service up by id, learning its project + production environment. */
  private async contextFor(serviceId: string): Promise<ServiceContext> {
    const known = this.contexts.get(serviceId);
    if (known) return known;
    const svc = await this.gql<{ service: { id: string; name: string; projectId: string } }>(
      `query ($id: String!) { service(id: $id) { id name projectId } }`,
      { id: serviceId },
    );
    const { environmentId } = await this.loadProject(svc.service.projectId);
    const ctx = { serviceId, projectId: svc.service.projectId, environmentId };
    this.contexts.set(serviceId, ctx);
    return ctx;
  }

  private async toBackendService(serviceId: string, projectId: string, environmentId: string): Promise<BackendService> {
    const instance = await this.loadInstance(serviceId, environmentId);
    const domain = instance.domains?.serviceDomains[0]?.domain;
    this.contexts.set(serviceId, { serviceId, projectId, environmentId });
    return {
      id: serviceId,
      name: instance.serviceName,
      url: domain ? `https://${domain}` : `https://${serviceId}.up.railway.app`,
      branch: await this.loadBranch(serviceId),
      repo: instance.source?.repo?.toLowerCase() ?? undefined,
      buildCommand: instance.buildCommand ?? undefined,
      startCommand: instance.startCommand ?? undefined,
      dashboardUrl: `https://railway.com/project/${projectId}/service/${serviceId}`,
    };
  }

  // ---- BackendHost ----

  async findService(name: string): Promise<BackendService | undefined> {
    const projects = await this.listProjects();
    for (const p of projects) {
      const { project, environmentId } = await this.loadProject(p.id);
      const hit = project.services?.edges.find((e) => e.node.name === name);
      if (hit) return this.toBackendService(hit.node.id, p.id, environmentId);
    }
    return undefined;
  }

  async getService(id: string): Promise<BackendService | undefined> {
    try {
      const svc = await this.gql<{ service: { id: string; name: string; projectId: string } }>(
        `query ($id: String!) { service(id: $id) { id name projectId } }`,
        { id },
      );
      const { environmentId } = await this.loadProject(svc.service.projectId);
      return this.toBackendService(id, svc.service.projectId, environmentId);
    } catch (err) {
      if (err instanceof ApiError && /not found/i.test(err.message)) return undefined;
      if (err instanceof ApiError && /Not Authorized/i.test(err.message)) {
        // A deleted service's id: Railway errors instead of returning null.
        return undefined;
      }
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
    const fullRepo = `${input.repo.owner}/${input.repo.repo}`;
    try {
      // One Railway project per app, service inside it. The project carries the
      // production environment that's created with it.
      const created = await this.gql<{ projectCreate: { id: string } }>(
        `mutation ($input: ProjectCreateInput!) {
          projectCreate(input: $input) { id name }
        }`,
        {
          input: {
            name: input.name,
            ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
            defaultEnvironmentName: "production",
          },
        },
      );
      const projectId = created.projectCreate.id;
      const { environmentId } = await this.loadProject(projectId);

      const vars: Record<string, string> = Object.fromEntries(input.env.map((v) => [v.key, v.value]));
      if (input.runtime !== "docker") vars.PORT ??= String(PORT);

      const svc = await this.gql<{ serviceCreate: { id: string; name: string } }>(
        `mutation ($input: ServiceCreateInput!) {
          serviceCreate(input: $input) { id name }
        }`,
        {
          input: {
            projectId,
            name: input.name,
            source: { repo: fullRepo },
            branch: input.branch,
            variables: vars,
          },
        },
      );
      const serviceId = svc.serviceCreate.id;

      // "Push now, deploy later": only `shipone deploy` deploys.
      try {
        await this.gql(
          `mutation ($input: ServiceInstanceAutoDeployUpdateInput!) {
            serviceInstanceAutoDeployUpdate(input: $input) { enabled }
          }`,
          { input: { projectId, environmentId, serviceId, enabled: false } },
        );
      } catch {
        // Best effort: auto-deploy stays on if Railway refuses.
      }

      let url = `https://${serviceId}.up.railway.app`;
      try {
        const domain = await this.gql<{ serviceDomainCreate: { domain: string } }>(
          `mutation ($input: ServiceDomainCreateInput!) {
            serviceDomainCreate(input: $input) { id domain }
          }`,
          { input: { serviceId, environmentId, ...(input.runtime !== "docker" ? { targetPort: PORT } : {}) } },
        );
        url = `https://${domain.serviceDomainCreate.domain}`;
      } catch {
        // The *.up.railway.app fallback keeps deploys working without a domain.
      }

      const instanceInput: Record<string, unknown> = {
        rootDirectory: input.rootDir === "." ? undefined : input.rootDir,
        ...(input.runtime === "docker"
          ? { dockerfilePath: input.dockerfilePath ?? "./Dockerfile" }
          : { buildCommand: input.buildCommand, startCommand: input.startCommand }),
      };
      await this.gql(
        `mutation ($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
          serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) {
            id
          }
        }`,
        { serviceId, environmentId, input: instanceInput },
      );

      this.contexts.set(serviceId, { serviceId, projectId, environmentId });
      const service = await this.toBackendService(serviceId, projectId, environmentId);
      return { ...service, url };
    } catch (err) {
      throw withRepoAccessHint(err, fullRepo);
    }
  }

  async configure(
    serviceId: string,
    opts: { branch?: string; disableAutoDeploy?: boolean; buildCommand?: string; startCommand?: string; dockerfilePath?: string },
  ): Promise<void> {
    const ctx = await this.contextFor(serviceId);
    if (opts.branch) {
      await this.gql(
        `mutation ($id: String!, $input: ServiceConnectInput!) {
          serviceConnect(id: $id, input: $input) { id }
        }`,
        { id: serviceId, input: { branch: opts.branch } },
      );
    }
    if (opts.disableAutoDeploy) {
      try {
        await this.gql(
          `mutation ($input: ServiceInstanceAutoDeployUpdateInput!) {
            serviceInstanceAutoDeployUpdate(input: $input) { enabled }
          }`,
          { input: { projectId: ctx.projectId, environmentId: ctx.environmentId, serviceId, enabled: false } },
        );
      } catch {
        // Best effort.
      }
    }
    const instanceInput: Record<string, unknown> = {};
    if (opts.buildCommand !== undefined) instanceInput.buildCommand = opts.buildCommand;
    if (opts.startCommand !== undefined) instanceInput.startCommand = opts.startCommand;
    if (opts.dockerfilePath !== undefined) instanceInput.dockerfilePath = opts.dockerfilePath;
    if (Object.keys(instanceInput).length) {
      await this.gql(
        `mutation ($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
          serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) { id }
        }`,
        { serviceId, environmentId: ctx.environmentId, input: instanceInput },
      );
    }
  }

  async listEnvKeys(serviceId: string): Promise<Set<string>> {
    const ctx = await this.contextFor(serviceId);
    const data = await this.gql<{ variables: Record<string, string> | null }>(
      `query ($projectId: String!, $environmentId: String!, $serviceId: String) {
        variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
      }`,
      { projectId: ctx.projectId, environmentId: ctx.environmentId, serviceId },
    );
    return new Set(Object.keys(data.variables ?? {}));
  }

  async setEnv(serviceId: string, vars: EnvVar[]): Promise<void> {
    if (vars.length === 0) return;
    const ctx = await this.contextFor(serviceId);
    await this.gql(
      `mutation ($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }`,
      {
        input: {
          projectId: ctx.projectId,
          environmentId: ctx.environmentId,
          serviceId,
          variables: Object.fromEntries(vars.map((v) => [v.key, v.value])),
          skipDeploys: true,
        },
      },
    );
  }

  async deploy(serviceId: string, commit: CommitRef): Promise<DeployStatus> {
    const ctx = await this.contextFor(serviceId);
    const data = await this.gql<{ serviceInstanceDeployV2: string }>(
      `mutation ($serviceId: String!, $environmentId: String!, $commitSha: String) {
        serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
      }`,
      { serviceId, environmentId: ctx.environmentId, commitSha: commit.sha },
    );
    return { id: data.serviceInstanceDeployV2, state: "queued", rawState: "QUEUED", sha: commit.sha };
  }

  async getDeploy(serviceId: string, deployId: string): Promise<DeployStatus> {
    void serviceId;
    const data = await this.gql<{ deployment: DeploymentNode | null }>(
      `query ($id: String!) {
        deployment(id: $id) { id status createdAt meta }
      }`,
      { id: deployId },
    );
    if (!data.deployment) throw new ShipOneError("Railway deployment not found.", "Check `shipone status`.");
    return toStatus(data.deployment);
  }

  async latestDeploy(serviceId: string): Promise<DeployStatus | undefined> {
    const ctx = await this.contextFor(serviceId);
    const data = await this.gql<{ deployments: { edges: { node: DeploymentNode }[] } }>(
      `query ($input: DeploymentListInput!) {
        deployments(input: $input, first: 1) { edges { node { id status createdAt meta } } }
      }`,
      { input: { projectId: ctx.projectId, serviceId, environmentId: ctx.environmentId } },
    );
    const node = data.deployments.edges[0]?.node;
    return node ? toStatus(node) : undefined;
  }

  async logs(serviceId: string, limit: number): Promise<string[]> {
    const latest = await this.latestDeploy(serviceId);
    if (!latest) return [];
    const data = await this.gql<{ buildLogs: { message: string }[]; deploymentLogs: { message: string }[] }>(
      `query ($deploymentId: String!, $limit: Int) {
        buildLogs(deploymentId: $deploymentId, limit: $limit) { message }
        deploymentLogs(deploymentId: $deploymentId, limit: $limit) { message }
      }`,
      { deploymentId: latest.id, limit },
    );
    // Build output first (that's where failures show up), then runtime output.
    return [...data.buildLogs.map((l) => l.message), ...data.deploymentLogs.map((l) => l.message)];
  }
}

function withRepoAccessHint(err: unknown, fullRepo: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (/repo|git|access|install|integration/i.test(message)) {
    return new ShipOneError(
      message,
      `Railway needs access to ${fullRepo}. Connect GitHub in Railway and grant the Railway GitHub app access to this repo: ${RAILWAY_GITHUB_APP}`,
    );
  }
  return err;
}