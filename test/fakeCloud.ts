import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * In-memory stand-in for the parts of the Vercel and Render REST APIs that
 * ShipOne uses. Request/response shapes follow the official OpenAPI specs
 * (@vercel/sdk models, Render public API schema). Builds progress one step
 * per status poll so tests exercise the waiting logic.
 */

export interface RecordedRequest {
  api: "vercel" | "render";
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

interface RService {
  id: string;
  name: string;
  ownerId: string;
  repo: string;
  branch: string;
  rootDir: string;
  autoDeploy: string;
  type: string;
  serviceDetails: Record<string, unknown> & { url: string };
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

export interface FakeCloudOptions {
  vercelToken?: string;
  renderToken?: string;
  /** Repos ("owner/repo") the providers' GitHub apps can see. */
  accessibleRepos?: string[];
  /** Branch tip on GitHub, used for Render's automatic first deploy. */
  branchHeads?: Record<string, string>;
  /** Vercel assigns the production domain only after the first deploy. */
  vercelDomainAfterDeploy?: boolean;
  /** Vercel rejects gitProviderOptions updates. */
  vercelRejectsGitOptions?: boolean;
  failVercelBuild?: boolean;
  failRenderBuild?: boolean;
  /** How many polls a build takes before finishing. */
  buildPolls?: number;
}

type Json = unknown;
type Reply = { status: number; body?: Json; headers?: Record<string, string> };

export class FakeCloud {
  readonly requests: RecordedRequest[] = [];
  readonly vercel = { projects: new Map<string, VProject>(), deployments: new Map<string, VDeployment>() };
  readonly render = { services: new Map<string, RService>(), deploys: [] as RDeploy[] };
  private seq = 0;

  constructor(readonly opts: FakeCloudOptions = {}) {}

  private nextId(prefix: string) {
    return `${prefix}${++this.seq}`;
  }

  /** A FetchLike that routes to this fake. URLs: https://api.vercel.com/... and https://api.render.com/v1/... */
  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const api = url.hostname.includes("vercel") ? "vercel" : "render";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = new Headers(init?.headers).get("authorization");
    const reply = this.handle(api, init?.method ?? "GET", url.pathname, url.searchParams, body, auth);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };

  /** Serve both APIs over real HTTP (for end-to-end CLI tests). */
  async listen(): Promise<{ vercelUrl: string; renderUrl: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const api = url.pathname.startsWith("/vercel") ? "vercel" : "render";
        const path = url.pathname.replace(/^\/(vercel|render)/, "");
        const reply = this.handle(api, req.method ?? "GET", path, url.searchParams, data ? JSON.parse(data) : undefined, req.headers.authorization ?? null);
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return {
      vercelUrl: `http://127.0.0.1:${port}/vercel`,
      renderUrl: `http://127.0.0.1:${port}/render/v1`,
      close: () => new Promise((r) => server.close(() => r())),
    };
  }

  requestsTo(api: "vercel" | "render", method?: string, pathRe?: RegExp) {
    return this.requests.filter((r) => r.api === api && (!method || r.method === method) && (!pathRe || pathRe.test(r.path)));
  }

  private handle(api: "vercel" | "render", method: string, path: string, query: URLSearchParams, body: Json, auth: string | null): Reply {
    this.requests.push({ api, method, path, query, body });
    const token = api === "vercel" ? (this.opts.vercelToken ?? "vercel-token") : (this.opts.renderToken ?? "render-token");
    if (auth !== `Bearer ${token}`) {
      return api === "vercel"
        ? { status: 403, body: { error: { code: "forbidden", message: "Not authorized", invalidToken: true } } }
        : { status: 401, body: { id: "unauthorized", message: "unauthorized" } };
    }
    return api === "vercel" ? this.vercelRoute(method, path, query, body) : this.renderRoute(method, path.replace(/^\/v1/, ""), query, body);
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
      if (body.type !== "web_service" || !d?.runtime || !d?.plan || !d?.envSpecificDetails?.buildCommand || !d?.envSpecificDetails?.startCommand) {
        return { status: 400, body: { id: "invalid", message: "invalid service details" } };
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
}
