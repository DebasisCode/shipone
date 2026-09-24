import { ShipOneError } from "../core/errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends ShipOneError {
  constructor(
    message: string,
    hint: string | undefined,
    readonly status: number,
    readonly code: string | undefined,
    readonly body: unknown,
  ) {
    super(message, hint);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  /** "Vercel" / "Render": used in error messages. */
  label: string;
  baseUrl: string;
  token: string;
  /** Command that fixes an auth problem, e.g. "shipone connect vercel". */
  reconnectCommand: string;
  fetch?: FetchLike;
  /** Query params added to every request (e.g. Vercel teamId). */
  defaultQuery?: Record<string, string | undefined>;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

type QueryValue = string | number | boolean | undefined | string[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Small JSON-over-HTTPS client shared by the providers:
 * bearer auth, retries on 429/5xx/network blips, timeouts, readable errors.
 */
export class ApiClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: ApiClientOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  url(path: string, query?: Record<string, QueryValue>): string {
    const u = new URL(this.opts.baseUrl.replace(/\/+$/, "") + path);
    const all: Record<string, QueryValue> = { ...this.opts.defaultQuery, ...query };
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((item) => u.searchParams.append(k, item));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async request<T>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<T> {
    const url = this.url(path, opts.query);
    const retries = this.opts.retries ?? 3;
    const baseDelay = this.opts.retryDelayMs ?? 1000;
    // Only retry a POST when the server tells us it didn't process it (429).
    const idempotent = method !== "POST";

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.opts.token}`,
            Accept: "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            "User-Agent": "shipone-cli",
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
      } catch (err) {
        if (idempotent && attempt < retries) {
          await sleep(baseDelay * 2 ** attempt);
          continue;
        }
        const reason = (err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message;
        throw new ShipOneError(`Couldn't reach ${this.opts.label} (${reason}).`, "Check your internet connection and try again.");
      }

      const retryable = res.status === 429 || (idempotent && res.status >= 500);
      if (retryable && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : baseDelay * 2 ** attempt);
        continue;
      }

      const text = await res.text();
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (res.ok) return body as T;
      throw this.toError(method, path, res.status, body);
    }
  }

  get<T>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }
  post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>) {
    return this.request<T>("POST", path, { body, query });
  }
  patch<T>(path: string, body?: unknown, query?: Record<string, QueryValue>) {
    return this.request<T>("PATCH", path, { body, query });
  }
  put<T>(path: string, body?: unknown, query?: Record<string, QueryValue>) {
    return this.request<T>("PUT", path, { body, query });
  }

  private toError(method: string, path: string, status: number, body: unknown): ApiError {
    const { message, code } = extractError(body);
    const label = this.opts.label;
    const detail = message ? `: ${message}` : "";
    if (status === 401) {
      return new ApiError(`${label} rejected your token${detail}.`, `Run \`${this.opts.reconnectCommand}\` with a fresh token.`, status, code, body);
    }
    if (status === 403) {
      return new ApiError(
        `${label} says your token isn't allowed to do this${detail}.`,
        `Make sure the token has access to the right account/team, then run \`${this.opts.reconnectCommand}\`.`,
        status,
        code,
        body,
      );
    }
    return new ApiError(`${label} API error (${status}) on ${method} ${path}${detail}`, undefined, status, code, body);
  }
}

function extractError(body: unknown): { message?: string; code?: string } {
  if (typeof body === "string") return { message: body.slice(0, 300) };
  if (typeof body !== "object" || body === null) return {};
  const b = body as Record<string, unknown>;
  // Vercel: { error: { code, message } }. Render: { id, message }.
  const inner = typeof b.error === "object" && b.error !== null ? (b.error as Record<string, unknown>) : b;
  const message = typeof inner.message === "string" ? inner.message : typeof b.message === "string" ? b.message : undefined;
  const code = typeof inner.code === "string" ? inner.code : typeof b.id === "string" ? b.id : undefined;
  return { message, code };
}
