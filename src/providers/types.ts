import type { GitHubRepo } from "../core/git.js";
import type { BackendProviderName, FrontendProviderName } from "../core/types.js";

export type DeployState = "queued" | "building" | "ready" | "failed" | "canceled";

export interface DeployStatus {
  id: string;
  state: DeployState;
  /** The provider's own status string, for display. */
  rawState: string;
  sha?: string;
  createdAt?: string;
  /** Public URL once ready (frontend: production domain). */
  url?: string;
  error?: string;
}

export interface CommitRef extends GitHubRepo {
  branch: string;
  sha: string;
}

export interface EnvVar {
  key: string;
  value: string;
}

export interface FrontendProject {
  id: string;
  name: string;
  /** "owner/repo" the project is linked to, if any. */
  repo?: string;
}

export interface FrontendHost {
  readonly name: FrontendProviderName;
  readonly label: string;
  findProject(idOrName: string): Promise<FrontendProject | undefined>;
  createProject(input: { name: string; repo: GitHubRepo; rootDirectory: string; framework: string }): Promise<FrontendProject>;
  /** Stop the host from deploying on every git push. Returns false if it couldn't. */
  disableGitDeployments(projectId: string): Promise<boolean>;
  /** The stable production URL, if the host already knows it. */
  productionUrl(projectId: string): Promise<string | undefined>;
  listEnvKeys(projectId: string): Promise<Set<string>>;
  setEnv(projectId: string, vars: EnvVar[]): Promise<void>;
  deploy(project: FrontendProject, commit: CommitRef): Promise<DeployStatus>;
  getDeploy(projectId: string, deployId: string): Promise<DeployStatus>;
  latestDeploy(projectId: string): Promise<DeployStatus | undefined>;
  logs(deployId: string, limit: number): Promise<string[]>;
  dashboardUrl(project: FrontendProject): string;
}

export interface BackendService {
  id: string;
  name: string;
  url: string;
  branch?: string;
  /** "owner/repo" the service builds from, if any. */
  repo?: string;
  dashboardUrl?: string;
}

export interface BackendHost {
  readonly name: BackendProviderName;
  readonly label: string;
  findService(name: string): Promise<BackendService | undefined>;
  getService(id: string): Promise<BackendService | undefined>;
  createService(input: {
    name: string;
    repo: GitHubRepo;
    branch: string;
    rootDir: string;
    buildCommand: string;
    startCommand: string;
    env: EnvVar[];
  }): Promise<BackendService & { initialDeployId?: string }>;
  /** Point the service at `branch` and/or turn off deploy-on-push. */
  configure(serviceId: string, opts: { branch?: string; disableAutoDeploy?: boolean }): Promise<void>;
  listEnvKeys(serviceId: string): Promise<Set<string>>;
  setEnv(serviceId: string, vars: EnvVar[]): Promise<void>;
  deploy(serviceId: string, commit: CommitRef): Promise<DeployStatus>;
  getDeploy(serviceId: string, deployId: string): Promise<DeployStatus>;
  latestDeploy(serviceId: string): Promise<DeployStatus | undefined>;
  logs(serviceId: string, limit: number): Promise<string[]>;
}
