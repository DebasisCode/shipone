import { ShipOneError } from "../core/errors.js";
import type { Store } from "../core/store.js";
import { PROVIDER_LABELS, type BackendProviderName, type FrontendProviderName, type ProviderName } from "../core/types.js";
import type { FetchLike } from "./http.js";
import { RenderHost } from "./render.js";
import type { BackendHost, FrontendHost } from "./types.js";
import { VercelHost } from "./vercel.js";

export interface ProviderEnv {
  store: Store;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

export function requireToken(ctx: ProviderEnv, provider: ProviderName): string {
  const token = ctx.store.getToken(provider);
  if (!token) {
    throw new ShipOneError(`${PROVIDER_LABELS[provider]} isn't connected.`, `Run \`shipone connect ${provider}\`.`);
  }
  return token;
}

/** Test hooks: point the clients at a local mock server. */
const baseUrl = (ctx: ProviderEnv, provider: ProviderName) =>
  ctx.env[`SHIPONE_${provider.toUpperCase()}_API_URL`] || undefined;

export function vercelHost(ctx: ProviderEnv, token = requireToken(ctx, "vercel")): VercelHost {
  const cfg = ctx.store.readConfig().vercel;
  return new VercelHost(token, { teamId: cfg?.teamId, teamSlug: cfg?.teamSlug, fetch: ctx.fetch, baseUrl: baseUrl(ctx, "vercel") });
}

export function renderHost(ctx: ProviderEnv, token = requireToken(ctx, "render")): RenderHost {
  const cfg = ctx.store.readConfig().render;
  return new RenderHost(token, {
    ownerId: cfg?.ownerId,
    region: cfg?.region,
    plan: cfg?.plan,
    fetch: ctx.fetch,
    baseUrl: baseUrl(ctx, "render"),
  });
}

export function frontendHost(ctx: ProviderEnv, name: FrontendProviderName): FrontendHost {
  switch (name) {
    case "vercel":
      return vercelHost(ctx);
  }
}

export function backendHost(ctx: ProviderEnv, name: BackendProviderName): BackendHost {
  switch (name) {
    case "render":
      return renderHost(ctx);
  }
}
