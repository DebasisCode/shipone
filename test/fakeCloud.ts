import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * In-memory stand-in for the parts of the Vercel, Netlify, Render and Railway
 * APIs that ShipOne uses. Request/response shapes follow the official OpenAPI
 * specs (Vercel/Netlify/Render REST, Railway GraphQL). Builds progress one step
 * per status poll so tests exercise the waiting logic.
 */

export type FakeApi = "vercel" | "netlify" | "render" | "railway";

export interface RecordedRequest {
  api: FakeApi;
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

interface VProject {
  id: string;
  name: string;
  framework?: string;
  rootDirectory?: string | null;
  link?: { type: string; org: string; repo: string; repoId: number };
  gitProviderOptions?: { createDeployments: string };
  env: { id: string; key: string; value: string; type: string; target: string[] }[];
  domains: string[];
}

interface VDeployment {
  id: string;
  projectId: string;
  name: string;
  url: string;
  readyState: string;
  alias: string[];
  gitSource: { type: string; org: string; repo: string; ref: string; sha: string };
  createdAt: number;
  polls: number;
}

interface NSite {
  id: string;
  name: string;
  account_id: string;
  build_settings: { repo_path?: string; cmd?: string; stop_builds?: boolean };
  env: Map<string, string>;
}

interface NDeploy {
  id: string;
  siteId: string;
  state: string;
  commit_ref: string;
  error_message?: string;
  created_at: string;
  polls: number;
}

interface RService {
  id: string;
  name: string;
  ownerId: string;
  repo: string;
  branch: string;
  rootDir: string;
  autoDeploy: string;
  type: string;
  serviceDetails: Record<string, unknown> & { url: string; envSpecificDetails?: Record<string, unknown> };
  env: Map<string, string>;
}

interface RDeploy {
  id: string;
  serviceId: string;
  status: string;
  commit: { id: string };
  createdAt: string;
  polls: number;
}

interface RwProject {
  id: string;
  name: string;
  environmentId: string;
  services: Map<string, RwService>;
}

interface RwService {
  id: string;
  name: string;
  repo?: string;
  branch?: string;
  rootDirectory?: string;
  buildCommand?: string;
  startCommand?: string;
  dockerfilePath?: string;
  autoDeploy: boolean;
  domain?: string;
  env: Map<string, string>;
}

interface RwDeployment {
  id: string;
  serviceId: string;
  status: string;
  commitSha: string;
  createdAt: string;
  polls: number;
}

export interface FakeCloudOptions {
  vercelToken?: string;
  netlifyToken?: string;
  renderToken?: string;
  railwayToken?: string;
  /** Repos ("owner/repo") the providers' GitHub apps can see. */
  accessibleRepos?: string[];
  /** Branch tips on GitHub, used for automatic first deploys. */
  branchHeads?: Record<string, string>;
  /** Vercel assigns the production domain only after the first deploy. */
  vercelDomainAfterDeploy?: boolean;
  /** Vercel rejects gitProviderOptions updates. */
  vercelRejectsGitOptions?: boolean;
  failVercelBuild?: boolean;
  failRenderBuild?: boolean;
  failNetlifyBuild?: boolean;
  failRailwayBuild?: boolean;
  /** How many polls a build takes before finishing. */
  buildPolls?: number;
}

type Json = unknown;
type Reply = { status: number; body?: Json; headers?: Record<string, string> };

export class FakeCloud {
  readonly requests: RecordedRequest[] = [];
  readonly vercel = { projects: new Map<string, VProject>(), deployments: new Map<string, VDeployment>() };
  readonly netlify = { sites: new Map<string, NSite>(), deploys: new Map<string, NDeploy>() };
  readonly render = { services: new Map<string, RService>(), deploys: [] as RDeploy[] };
  readonly railway = { projects: new Map<string, RwProject>(), services: new Map<string, RwService>(), deploys: [] as RwDeployment[] };
  private seq = 0;

  constructor(readonly opts: FakeCloudOptions = {}) {}

  private nextId(prefix: string) {
    return `${prefix}${++this.seq}`;
  }

  /** A FetchLike that routes to this fake by hostname. */
  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const api = apiForHost(url.hostname);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = new Headers(init?.headers).get("authorization");
    const reply = this.handle(api, init?.method ?? "GET", url.pathname, url.searchParams, body, auth);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };

  /** Serve all APIs over real HTTP (for end-to-end CLI tests). */
  async listen(): Promise<{ vercelUrl: string; netlifyUrl: string; renderUrl: string; railwayUrl: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const seg = url.pathname.split("/")[1] as FakeApi;
        const path = url.pathname.replace(/^\/(vercel|netlify|render|railway)/, "");
        const reply = this.handle(
          apiForHost(seg),
          req.method ?? "GET",
          path,
          url.searchParams,
          data ? JSON.parse(data) : undefined,
          req.headers.authorization ?? null,
        );
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return {
      vercelUrl: `http://127.0.0.1:${port}/vercel`,
      netlifyUrl: `http://127.0.0.1:${port}/netlify/api/v1`,
      renderUrl: `http://127.0.0.1:${port}/render/v1`,
      railwayUrl: `http://127.0.0.1:${port}/railway/graphql/v2`,
      close: () => new Promise((r) => server.close(() => r())),
    };
  }

  requestsTo(api: FakeApi, method?: string, pathRe?: RegExp) {
    return this.requests.filter((r) => r.api === api && (!method || r.method === method) && (!pathRe || pathRe.test(r.path)));
  }

  private handle(api: FakeApi, method: string, path: string, query: URLSearchParams, body: Json, auth: string | null): Reply {
    this.requests.push({ api, method, path, query, body });
    const token = this.opts[`${api}Token` as keyof FakeCloudOptions] ?? `${api}-token`;
    if (auth !== `Bearer ${token}`) {
      switch (api) {
        case "vercel":
          return { status: 403, body: { error: { code: "forbidden", message: "Not authorized", invalidToken: true } } };
        default:
          return { status: 401, body: { code: 401, message: "unauthorized" } };
      }
    }
    switch (api) {
      case "vercel":
        return this.vercelRoute(method, path, query, body);
      case "netlify":
        return this.netlifyRoute(method, path.replace(/^\/api\/v1/, ""), query, body);
      case "render":
        return this.renderRoute(method, path.replace(/^\/v1/, ""), query, body);
      case "railway":
        return this.railwayRoute(method, path, body);
    }
  }

  private canAccess(repo: string) {
    return (this.opts.accessibleRepos ?? ["me/app"]).map((r) => r.toLowerCase()).includes(repo.toLowerCase());
  }

  // ------------------------------------------------------------------ Vercel

  private findProject(idOrName: string) {
    return this.vercel.projects.get(idOrName) ?? [...this.vercel.projects.values()].find((p) => p.name === idOrName);
  }

  private vercelRoute(method: string, path: string, query: URLSearchParams, body: any): Reply {
    const notFound = (what: string): Reply => ({ status: 404, body: { error: { code: "not_found", message: `${what} not found` } } });
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/v2/user") return { status: 200, body: { user: { id: "u1", username: "me", email: "me@example.com" } } };
    if (method === "GET" && path === "/v2/teams") return { status: 200, body: { teams: [] } };

    if (method === "POST" && path === "/v11/projects") {
      const repo: string = body?.gitRepository?.repo ?? "";
      if (!this.canAccess(repo)) {
        return { status: 400, body: { error: { code: "bad_request", message: `The provided GitHub repository (${repo}) can't be found.` } } };
      }
      if (this.findProject(body.name)) return { status: 409, body: { error: { code: "conflict", message: "Project already exists" } } };
      const [org, name] = repo.split("/");
      const p: VProject = {
        id: this.nextId("prj_"),
        name: body.name,
        framework: body.framework,
        rootDirectory: body.rootDirectory,
        link: { type: "github", org: org!, repo: name!, repoId: 1234 },
        env: [],
        domains: this.opts.vercelDomainAfterDeploy ? [] : [`${body.name}.vercel.app`],
      };
      this.vercel.projects.set(p.id, p);
      return { status: 200, body: p };
    }

    if ((m = path.match(/^\/v9\/projects\/([^/]+)$/))) {
      const p = this.findProject(decodeURIComponent(m[1]!));
      if (!p) return notFound("Project");
      if (method === "GET") return { status: 200, body: p };
      if (method === "PATCH") {
        if (body?.gitProviderOptions) {
          if (this.opts.vercelRejectsGitOptions) {
            return { status: 400, body: { error: { code: "bad_request", message: "Invalid request: should NOT have additional property `gitProviderOptions`." } } };
          }
          p.gitProviderOptions = body.gitProviderOptions;
        }
        return { status: 200, body: p };
      }
    }

    if ((m = path.match(/^\/v9\/projects\/([^/]+)\/domains$/)) && method === "GET") {
      const p = this.findProject(m[1]!);
      if (!p) return notFound("Project");
      return { status: 200, body: { domains: p.domains.map((name) => ({ name, apexName: "vercel.app", projectId: p.id, redirect: null, gitBranch: null })) } };
    }

    if ((m = path.match(/^\/v10\/projects\/([^/]+)\/env$/))) {
      const p = this.findProject(m[1]!);
      if (!p) return notFound("Project");
      if (method === "GET") return { status: 200, body: { envs: p.env.map(({ value: _v, ...rest }) => rest) } };
      if (method === "POST") {
        const items: any[] = Array.isArray(body) ? body : [body];
        for (const item of items) {
          const existing = p.env.find((e) => e.key === item.key);
          if (existing && query.get("upsert") !== "true") {
            return { status: 400, body: { error: { code: "ENV_ALREADY_EXISTS", message: `A variable with the name \`${item.key}\` already exists` } } };
          }
          if (existing) Object.assign(existing, { value: item.value, type: item.type, target: item.target });
          else p.env.push({ id: this.nextId("env_"), key: item.key, value: item.value, type: item.type, target: item.target });
        }
        return { status: 201, body: { created: items } };
      }
    }

    if (method === "POST" && path === "/v13/deployments") {
      const p = this.findProject(body.project ?? body.name);
      if (!p) return notFound("Project");
      const gs = body.gitSource;
      if (!gs || gs.type !== "github" || !gs.sha || !gs.ref) return { status: 400, body: { error: { code: "bad_request", message: "Invalid gitSource" } } };
      if (!this.canAccess(`${gs.org}/${gs.repo}`)) {
        return { status: 400, body: { error: { code: "incorrect_git_source_info", message: "The provided GitHub repository can't be found." } } };
      }
      const id = this.nextId("dpl_");
      const d: VDeployment = {
        id,
        projectId: p.id,
        name: p.name,
        url: `${p.name}-${id.replace("dpl_", "h")}-me.vercel.app`,
        readyState: "QUEUED",
        alias: [],
        gitSource: gs,
        createdAt: Date.now(),
        polls: 0,
      };
      this.vercel.deployments.set(id, d);
      return { status: 200, body: d };
    }

    if ((m = path.match(/^\/v13\/deployments\/([^/]+)$/)) && method === "GET") {
      const d = this.vercel.deployments.get(m[1]!);
      if (!d) return notFound("Deployment");
      this.advanceVercel(d);
      return { status: 200, body: d };
    }

    if (method === "GET" && path === "/v7/deployments") {
      const list = [...this.vercel.deployments.values()]
        .filter((d) => d.projectId === query.get("projectId"))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, Number(query.get("limit") ?? 20))
        .map((d) => ({ uid: d.id, url: d.url, readyState: d.readyState, created: d.createdAt, meta: { githubCommitSha: d.gitSource.sha } }));
      return { status: 200, body: { deployments: list, pagination: {} } };
    }

    if ((m = path.match(/^\/v3\/deployments\/([^/]+)\/events$/)) && method === "GET") {
      const d = this.vercel.deployments.get(m[1]!);
      if (!d) return notFound("Deployment");
      const lines = ["Cloning github.com/me/app", "Running \"npm run build\""];
      if (d.readyState === "ERROR") lines.push("Error: Could not resolve './missing'");
      // direction=backward → newest first
      return { status: 200, body: lines.map((text, i) => ({ type: "stdout", created: i, payload: { text } })).reverse() };
    }

    return { status: 404, body: { error: { code: "not_found", message: `No fake for ${method} ${path}` } } };
  }

  private advanceVercel(d: VDeployment) {
    if (d.readyState === "READY" || d.readyState === "ERROR") return;
    d.polls++;
    const total = this.opts.buildPolls ?? 2;
    if (d.polls < total) d.readyState = "BUILDING";
    else if (this.opts.failVercelBuild) d.readyState = "ERROR";
    else {
      d.readyState = "READY";
      const p = this.vercel.projects.get(d.projectId)!;
      if (p.domains.length === 0) p.domains.push(`${p.name}-me.vercel.app`);
      d.alias = [...p.domains, `${p.name}-git-${d.gitSource.ref}-me.vercel.app`];
    }
  }

  // ------------------------------------------------------------------ Netlify

  private findSite(idOrName: string) {
    return this.netlify.sites.get(idOrName) ?? [...this.netlify.sites.values()].find((s) => s.name === idOrName);
  }

  private netlifyRoute(method: string, path: string, query: URLSearchParams, body: any): Reply {
    const notFound = (): Reply => ({ status: 404, body: { code: 404, message: "Not found" } });
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/user") return { status: 200, body: { id: "u1", email: "me@example.com", full_name: "Me" } };
    if (method === "GET" && path === "/accounts") return { status: 200, body: [{ id: "acc_1", name: "Me", slug: "me" }] };

    if (method === "POST" && path === "/sites") {
      const repo: string = body?.build_settings?.repo_path ?? "";
      if (!this.canAccess(repo)) {
        return { status: 400, body: { code: 400, message: `Could not access the repository ${repo}. Make sure Netlify has access to it.` } };
      }
      if (this.findSite(body.name)) return { status: 422, body: { code: 422, message: "A site with this name already exists" } };
      const s: NSite = {
        id: this.nextId("site_"),
        name: body.name,
        account_id: body.account_id ?? "acc_1",
        build_settings: body.build_settings ?? {},
        env: new Map(),
      };
      this.netlify.sites.set(s.id, s);
      return { status: 201, body: this.siteJson(s) };
    }

    if ((m = path.match(/^\/sites\/([^/]+)$/))) {
      const s = this.findSite(decodeURIComponent(m[1]!));
      if (!s) return notFound();
      if (method === "GET") return { status: 200, body: this.siteJson(s) };
      if (method === "PATCH") {
        Object.assign(s.build_settings, body?.build_settings ?? {});
        return { status: 200, body: this.siteJson(s) };
      }
    }

    if ((m = path.match(/^\/sites\/([^/]+)\/env$/)) && method === "GET") {
      const s = this.findSite(decodeURIComponent(m[1]!));
      if (!s) return notFound();
      return { status: 200, body: [...s.env].map(([key]) => ({ key, scopes: ["builds"], values: [{ context: "all", value: "" }], updated_at: "now" })) };
    }

    if ((m = path.match(/^\/accounts\/([^/]+)\/env$/)) && method === "POST") {
      const siteId = query.get("site_id");
      const s = siteId ? this.findSite(siteId) : undefined;
      if (!s) return notFound();
      const items: any[] = Array.isArray(body) ? body : [body];
      for (const item of items) {
        const value = item.values?.[0]?.value ?? "";
        s.env.set(item.key, value);
      }
      return { status: 201, body: items.map((item) => ({ key: item.key })) };
    }

    if ((m = path.match(/^\/accounts\/([^/]+)\/env\/([^/]+)$/)) && method === "PATCH") {
      const siteId = query.get("site_id");
      const s = siteId ? this.findSite(siteId) : undefined;
      if (!s || !s.env.has(decodeURIComponent(m[2]!))) {
        return { status: 404, body: { code: 404, message: "Env var not found" } };
      }
      s.env.set(decodeURIComponent(m[2]!), body.value);
      return { status: 200, body: { key: m[2], ...body } };
    }

    if ((m = path.match(/^\/sites\/([^/]+)\/builds$/)) && method === "POST") {
      const s = this.findSite(decodeURIComponent(m[1]!));
      if (!s) return notFound();
      if (s.build_settings.stop_builds) {
        return { status: 403, body: { code: 403, message: "Builds are stopped for this site and cannot be triggered" } };
      }
      const branch = query.get("branch") ?? "main";
      const sha = this.opts.branchHeads?.[branch] ?? "tip-of-branch";
      const d: NDeploy = {
        id: this.nextId("ndep_"),
        siteId: s.id,
        state: "new",
        commit_ref: sha,
        created_at: new Date().toISOString(),
        polls: 0,
      };
      this.netlify.deploys.set(d.id, d);
      return { status: 200, body: { id: this.nextId("build_"), deploy_id: d.id, sha, done: false, created_at: d.created_at } };
    }

    if ((m = path.match(/^\/sites\/([^/]+)\/deploys$/)) && method === "GET") {
      const s = this.findSite(decodeURIComponent(m[1]!));
      if (!s) return notFound();
      const list = [...this.netlify.deploys.values()].filter((d) => d.siteId === s.id).reverse();
      return { status: 200, body: list.map((d) => this.deployJson(d)) };
    }

    if ((m = path.match(/^\/(sites\/[^/]+\/)?deploys\/([^/]+)$/)) && method === "GET") {
      const d = this.netlify.deploys.get(m[2]!);
      if (!d) return notFound();
      this.advanceNetlify(d);
      return { status: 200, body: this.deployJson(d) };
    }

    if ((m = path.match(/^\/deploys\/([^/]+)\/log$/)) && method === "GET") {
      const d = this.netlify.deploys.get(m[1]!);
      if (!d) return notFound();
      const lines = ["Starting build", "Running npm run build"];
      if (d.state === "error") lines.push("Error: Build failed with status 1");
      return { status: 200, body: { lines: lines.map((message) => ({ message, severity: "info" })) } };
    }

    return { status: 404, body: { code: 404, message: `No fake for ${method} ${path}` } };
  }

  private advanceNetlify(d: NDeploy) {
    if (["ready", "error", "rejected"].includes(d.state)) return;
    d.polls++;
    if (d.polls < (this.opts.buildPolls ?? 2)) d.state = "building";
    else d.state = this.opts.failNetlifyBuild ? "error" : "ready";
  }

  private siteJson(s: NSite) {
    const settings = { ...s.build_settings };
    return {
      id: s.id,
      name: s.name,
      url: `http://${s.name}.netlify.app`,
      ssl_url: `https://${s.name}.netlify.app`,
      admin_url: `https://app.netlify.com/sites/${s.name}`,
      account_id: s.account_id,
      build_settings: settings,
    };
  }

  private deployJson(d: NDeploy) {
    const s = this.netlify.sites.get(d.siteId);
    return {
      id: d.id,
      site_id: d.siteId,
      state: d.state,
      commit_ref: d.commit_ref,
      error_message: d.error_message ?? (d.state === "error" ? "Build failed" : null),
      created_at: d.created_at,
      ssl_url: `https://${s?.name}.netlify.app`,
      deploy_ssl_url: `https://${d.id}.${s?.name}.netlify.app`,
    };
  }

  // ------------------------------------------------------------------ Render

  private renderRoute(method: string, path: string, query: URLSearchParams, body: any): Reply {
    const notFound: Reply = { status: 404, body: { id: "not_found", message: "not found" } };
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/owners") {
      return { status: 200, body: [{ owner: { id: "own_1", name: "Me", email: "me@example.com", type: "user" }, cursor: "c1" }] };
    }

    if (path === "/services" && method === "GET") {
      const name = query.get("name");
      const list = [...this.render.services.values()].filter((s) => !name || s.name === name);
      return { status: 200, body: list.map((s) => ({ service: this.serviceJson(s), cursor: s.id })) };
    }

    if (path === "/services" && method === "POST") {
      if (!body?.ownerId) return { status: 400, body: { id: "invalid", message: "ownerId is required" } };
      const repoPath = String(body.repo ?? "").replace(/^https:\/\/github\.com\//, "");
      if (!this.canAccess(repoPath)) return { status: 400, body: { id: "invalid", message: "Could not access the repository. Make sure Render has access to it." } };
      const d = body.serviceDetails;
      const runtime = d?.runtime;
      const esd = d?.envSpecificDetails ?? {};
      const detailsOk =
        runtime === "docker" ? typeof esd.dockerfilePath === "string" : Boolean(esd.buildCommand && esd.startCommand);
      if (body.type !== "web_service" || !d?.plan || !detailsOk) {
        return { status: 400, body: { id: "invalid", message: "invalid service details" } };
      }
      if (runtime !== "docker" && !["node", "python", "go", "rust", "ruby", "elixir", "image"].includes(runtime)) {
        return { status: 400, body: { id: "invalid", message: `unsupported runtime ${runtime}` } };
      }
      const id = this.nextId("srv-");
      const s: RService = {
        id,
        name: body.name,
        ownerId: body.ownerId,
        repo: body.repo,
        branch: body.branch,
        rootDir: body.rootDir ?? "",
        autoDeploy: body.autoDeploy ?? "yes",
        type: body.type,
        serviceDetails: { ...d, url: `https://${body.name}.onrender.com` },
        env: new Map((body.envVars ?? []).map((e: any) => [e.key, e.value])),
      };
      this.render.services.set(id, s);
      // Creating a service kicks off a first deploy of the branch tip.
      const dep = this.addRenderDeploy(s, this.opts.branchHeads?.[s.branch] ?? "tip-of-branch");
      return { status: 201, body: { service: this.serviceJson(s), deployId: dep.id } };
    }

      if ((m = path.match(/^\/services\/([^/]+)$/))) {
      const s = this.render.services.get(m[1]!);
      if (!s) return notFound;
      if (method === "GET") return { status: 200, body: this.serviceJson(s) };
      if (method === "PATCH") {
        if (body.branch) s.branch = body.branch;
        if (body.autoDeploy) s.autoDeploy = body.autoDeploy;
        const esd = body.serviceDetails?.envSpecificDetails;
        if (esd) s.serviceDetails = { ...s.serviceDetails, envSpecificDetails: { ...(s.serviceDetails.envSpecificDetails ?? {}), ...esd } };
        return { status: 200, body: this.serviceJson(s) };
      }
    }

    if ((m = path.match(/^\/services\/([^/]+)\/env-vars$/))) {
      const s = this.render.services.get(m[1]!);
      if (!s) return notFound;
      if (method === "GET") return { status: 200, body: [...s.env].map(([key, value]) => ({ envVar: { key, value }, cursor: key })) };
      if (method === "PUT") {
        // Real API semantics: replaces ALL env vars.
        s.env = new Map((body as any[]).map((e) => [e.key, e.value]));
        return { status: 200, body: [...s.env].map(([key, value]) => ({ envVar: { key, value }, cursor: key })) };
      }
    }

    if ((m = path.match(/^\/services\/([^/]+)\/env-vars\/([^/]+)$/)) && method === "PUT") {
      const s = this.render.services.get(m[1]!);
      if (!s) return notFound;
      s.env.set(decodeURIComponent(m[2]!), body.value);
      return { status: 200, body: { key: m[2], value: body.value } };
    }

    if ((m = path.match(/^\/services\/([^/]+)\/deploys$/))) {
      const s = this.render.services.get(m[1]!);
      if (!s) return notFound;
      if (method === "POST") return { status: 201, body: this.renderDeployJson(this.addRenderDeploy(s, body?.commitId ?? "tip-of-branch")) };
      if (method === "GET") {
        const list = this.render.deploys.filter((d) => d.serviceId === s.id).reverse().slice(0, Number(query.get("limit") ?? 20));
        return { status: 200, body: list.map((d) => ({ deploy: this.renderDeployJson(d), cursor: d.id })) };
      }
    }

    if ((m = path.match(/^\/services\/([^/]+)\/deploys\/([^/]+)$/)) && method === "GET") {
      const d = this.render.deploys.find((x) => x.serviceId === m![1] && x.id === m![2]);
      if (!d) return notFound;
      this.advanceRender(d);
      return { status: 200, body: this.renderDeployJson(d) };
    }

    if (method === "GET" && path === "/logs") {
      if (!query.get("ownerId") || query.getAll("resource").length === 0) return { status: 400, body: { id: "invalid", message: "ownerId and resource required" } };
      const failed = this.opts.failRenderBuild;
      const logs = ["==> Running build command 'npm ci'", failed ? "Error: Cannot find module 'expresss'" : "Server listening on 10000"];
      return {
        status: 200,
        body: { hasMore: false, logs: logs.map((message, i) => ({ id: `l${i}`, message, timestamp: new Date(i).toISOString(), labels: [] })).reverse() },
      };
    }

    return { status: 404, body: { id: "not_found", message: `No fake for ${method} ${path}` } };
  }

  private addRenderDeploy(s: RService, commitId: string): RDeploy {
    const d: RDeploy = { id: this.nextId("dep-"), serviceId: s.id, status: "created", commit: { id: commitId }, createdAt: new Date().toISOString(), polls: 0 };
    this.render.deploys.push(d);
    return d;
  }

  private advanceRender(d: RDeploy) {
    if (["live", "build_failed", "canceled", "deactivated"].includes(d.status)) return;
    d.polls++;
    if (d.polls < (this.opts.buildPolls ?? 2)) d.status = "build_in_progress";
    else d.status = this.opts.failRenderBuild ? "build_failed" : "live";
  }

  private serviceJson(s: RService) {
    const { env: _env, ...rest } = s;
    return { ...rest, dashboardUrl: `https://dashboard.render.com/web/${s.id}`, suspended: "not_suspended" };
  }

  private renderDeployJson(d: RDeploy) {
    const { polls: _p, serviceId: _s, ...rest } = d;
    return rest;
  }

  // ------------------------------------------------------------------ Railway

  /** A tiny GraphQL executor: matches the operation name in the query text. */
  private railwayRoute(method: string, path: string, body: any): Reply {
    if (method !== "POST" || !/^\/graphql\/v2/.test(path)) {
      return { status: 404, body: { errors: [{ message: `No fake for ${method} ${path}` }] } };
    }
    const query: string = body?.query ?? "";
    const vars = (body?.variables ?? {}) as Record<string, any>;
    const q = (name: string, re: RegExp) => re.test(query);

    const gql = (data: Json) => ({ status: 200, body: { data } });
    const gqlError = (message: string, code = "INTERNAL_SERVER_ERROR") => ({ status: 200, body: { errors: [{ message, extensions: { code } }] } });

    if (q("me", /query\s*\{?\s*(\(|\{)?\s*me/)) {
      return gql({ me: { id: "u1", name: "Me", email: "me@example.com", workspaces: [{ id: "ws_1", name: "My Team" }] } });
    }

    if (q("projects", /projects\(/) ) {
      // The CLI asks for personal + workspace projects in one query.
      const edges = [...this.railway.projects.values()].map((p) => ({ node: { id: p.id, name: p.name } }));
      return gql({ personal: { edges }, ws: { edges: vars.workspaceId ? edges : [] } });
    }

    if (q("project", /project\(id:/)) {
      const p = this.railway.projects.get(vars.id);
      if (!p) return gqlError("Project not found");
      return gql({
        project: {
          id: p.id,
          name: p.name,
          environments: { edges: [{ node: { id: p.environmentId, name: "production" } }] },
          services: { edges: [...p.services.values()].map((s) => ({ node: { id: s.id, name: s.name } })) },
        },
      });
    }

    if (q("service", /service\(id:/) && !/serviceInstance/.test(query)) {
      const s = this.railway.services.get(vars.id);
      if (!s) return gqlError("Not Authorized");
      const p = this.findRailwayProjectOf(vars.id);
      const svc: Record<string, Json> = { id: s.id, name: s.name, projectId: p?.id ?? "prj_unknown" };
      if (/repoTriggers/.test(query)) svc.repoTriggers = { edges: [{ node: { branch: s.branch ?? null } }] };
      return gql({ service: svc });
    }

    if (q("serviceInstance", /serviceInstance\(serviceId:/)) {
      const s = this.railway.services.get(vars.serviceId);
      if (!s) return gqlError("Not Authorized");
      return gql({
        serviceInstance: {
          id: `${vars.serviceId}-inst`,
          serviceName: s.name,
          startCommand: s.startCommand ?? null,
          buildCommand: s.buildCommand ?? null,
          rootDirectory: s.rootDirectory ?? null,
          dockerfilePath: s.dockerfilePath ?? null,
          source: s.repo ? { repo: s.repo } : null,
          domains: { serviceDomains: s.domain ? [{ id: `${s.id}-dom`, domain: s.domain }] : [] },
        },
      });
    }

    if (q("projectCreate", /projectCreate\(/)) {
      const id = this.nextId("prj_");
      const p: RwProject = { id, name: vars.input?.name ?? "project", environmentId: this.nextId("env_"), services: new Map() };
      this.railway.projects.set(id, p);
      return gql({ projectCreate: { id, name: p.name } });
    }

    if (q("serviceCreate", /serviceCreate\(/)) {
      const p = this.railway.projects.get(vars.input?.projectId);
      if (!p) return gqlError("Project not found");
      const repo: string = vars.input?.source?.repo ?? "";
      if (!this.canAccess(repo)) {
        return gqlError(`Could not access the repository ${repo}. Make sure Railway has access to it.`);
      }
      const id = this.nextId("svc_");
      const s: RwService = {
        id,
        name: vars.input?.name ?? "service",
        repo,
        branch: vars.input?.branch ?? "main",
        autoDeploy: true,
        env: new Map(Object.entries(vars.input?.variables ?? {})),
      };
      p.services.set(id, s);
      this.railway.services.set(id, s);
      return gql({ serviceCreate: { id, name: s.name } });
    }

    if (q("serviceDomainCreate", /serviceDomainCreate\(/)) {
      const s = this.railway.services.get(vars.input?.serviceId);
      if (!s) return gqlError("Not Authorized");
      const domain = `${s.name}-${this.seq}.up.railway.app`;
      s.domain = domain;
      return gql({ serviceDomainCreate: { id: `${s.id}-dom`, domain } });
    }

    if (q("serviceInstanceAutoDeployUpdate", /serviceInstanceAutoDeployUpdate\(/)) {
      const s = this.railway.services.get(vars.input?.serviceId);
      if (!s) return gqlError("Not Authorized");
      s.autoDeploy = Boolean(vars.input?.enabled);
      return gql({ serviceInstanceAutoDeployUpdate: { enabled: s.autoDeploy } });
    }

    if (q("serviceConnect", /serviceConnect\(/)) {
      const s = this.railway.services.get(vars.id);
      if (!s) return gqlError("Not Authorized");
      if (vars.input?.branch) s.branch = vars.input.branch;
      return gql({ serviceConnect: { id: s.id } });
    }

    if (q("serviceInstanceUpdate", /serviceInstanceUpdate\(/)) {
      const s = this.railway.services.get(vars.serviceId);
      if (!s) return gqlError("Not Authorized");
      const input = vars.input ?? {};
      if (input.rootDirectory !== undefined && input.rootDirectory !== null) s.rootDirectory = input.rootDirectory;
      if (input.buildCommand !== undefined && input.buildCommand !== null) s.buildCommand = input.buildCommand;
      if (input.startCommand !== undefined && input.startCommand !== null) s.startCommand = input.startCommand;
      if (input.dockerfilePath !== undefined && input.dockerfilePath !== null) s.dockerfilePath = input.dockerfilePath;
      return gql({ serviceInstanceUpdate: { id: `${s.id}-inst` } });
    }

    if (q("variables", /variables\(projectId:/)) {
      const s = this.railway.services.get(vars.serviceId);
      if (!s) return gqlError("Not Authorized");
      return gql({ variables: Object.fromEntries(s.env) });
    }

    if (q("variableCollectionUpsert", /variableCollectionUpsert\(/)) {
      const s = this.railway.services.get(vars.input?.serviceId);
      if (!s) return gqlError("Not Authorized");
      for (const [k, v] of Object.entries(vars.input?.variables ?? {})) s.env.set(k, String(v));
      return gql({ variableCollectionUpsert: true });
    }

    if (q("variableUpsert", /variableUpsert\(/)) {
      const s = this.railway.services.get(vars.input?.serviceId);
      if (!s) return gqlError("Not Authorized");
      s.env.set(vars.input?.name, vars.input?.value);
      return gql({ variableUpsert: true });
    }

    if (q("serviceInstanceDeployV2", /serviceInstanceDeployV2\(/)) {
      const s = this.railway.services.get(vars.serviceId);
      if (!s) return gqlError("Not Authorized");
      const d: RwDeployment = {
        id: this.nextId("rwdep_"),
        serviceId: s.id,
        status: "QUEUED",
        commitSha: vars.commitSha ?? "tip-of-branch",
        createdAt: new Date().toISOString(),
        polls: 0,
      };
      this.railway.deploys.push(d);
      return gql({ serviceInstanceDeployV2: d.id });
    }

    if (q("deployments", /deployments\(input:/)) {
      const list = this.railway.deploys.filter((d) => d.serviceId === vars.input?.serviceId).reverse();
      return gql({ deployments: { edges: list.slice(0, vars.first ?? 20).map((node) => ({ node: this.railwayDeployJson(node) })), pageInfo: { hasNextPage: false } } });
    }

    if (q("deployment", /deployment\(id:/) && !/deployments\(/.test(query)) {
      const d = this.railway.deploys.find((x) => x.id === vars.id);
      if (!d) return gqlError("Not Authorized");
      this.advanceRailway(d);
      return gql({ deployment: this.railwayDeployJson(d) });
    }

    if (q("deploymentLogs", /deploymentLogs\(/) || q("buildLogs", /buildLogs\(/)) {
      const d = this.railway.deploys.find((x) => x.id === vars.deploymentId);
      if (!d) return gqlError("Not Authorized");
      const build = ["Building with Nixpacks", "npm ci"];
      const runtime = ["Deploying to Railway"];
      if (d.status === "FAILED") build.push("Error: build failed");
      const mk = (messages: string[]) => messages.map((message) => ({ message, severity: "info", timestamp: new Date().toISOString() }));
      const data: Record<string, Json> = {};
      if (/buildLogs\(/.test(query)) data.buildLogs = mk(build);
      if (/deploymentLogs\(/.test(query)) data.deploymentLogs = mk(runtime);
      return gql(data);
    }

    return { status: 200, body: { errors: [{ message: `No fake for query: ${query.slice(0, 120)}` }] } };
  }

  private findRailwayProjectOf(serviceId: string): RwProject | undefined {
    return [...this.railway.projects.values()].find((p) => p.services.has(serviceId));
  }

  private advanceRailway(d: RwDeployment) {
    if (["SUCCESS", "FAILED", "CRASHED"].includes(d.status)) return;
    d.polls++;
    if (d.polls < (this.opts.buildPolls ?? 2)) d.status = "BUILDING";
    else d.status = this.opts.failRailwayBuild ? "FAILED" : "SUCCESS";
  }

  private railwayDeployJson(d: RwDeployment) {
    const s = this.railway.services.get(d.serviceId);
    return {
      id: d.id,
      status: d.status,
      createdAt: d.createdAt,
      meta: { commitSha: d.commitSha, service: s?.name },
      staticUrl: `https://${d.status === "SUCCESS" ? "" : "build-"}logs.railway.com/${d.id}`,
      url: `https://logs.railway.com/${d.id}`,
    };
  }
}

function apiForHost(host: string): FakeApi {
  if (host.includes("vercel") || host === "vercel") return "vercel";
  if (host.includes("netlify") || host === "netlify") return "netlify";
  if (host.includes("render") || host === "render") return "render";
  if (host.includes("railway") || host === "railway") return "railway";
  throw new Error(`FakeCloud has no fake for host "${host}"`);
}