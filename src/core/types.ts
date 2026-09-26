/** Hosts ShipOne can deploy a frontend to. Add new ones here and in providers/index.ts. */
export const FRONTEND_PROVIDERS = ["vercel", "netlify"] as const;
/** Hosts ShipOne can deploy a backend to. */
export const BACKEND_PROVIDERS = ["render", "railway"] as const;

export type FrontendProviderName = (typeof FRONTEND_PROVIDERS)[number];
export type BackendProviderName = (typeof BACKEND_PROVIDERS)[number];
export type ProviderName = FrontendProviderName | BackendProviderName;
export const ALL_PROVIDERS: readonly ProviderName[] = [...FRONTEND_PROVIDERS, ...BACKEND_PROVIDERS];

export type Role = "frontend" | "backend";

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  vercel: "Vercel",
  netlify: "Netlify",
  render: "Render",
  railway: "Railway",
};

export function isFrontendProvider(v: unknown): v is FrontendProviderName {
  return typeof v === "string" && (FRONTEND_PROVIDERS as readonly string[]).includes(v);
}

export function isBackendProvider(v: unknown): v is BackendProviderName {
  return typeof v === "string" && (BACKEND_PROVIDERS as readonly string[]).includes(v);
}

export function isProviderName(v: unknown): v is ProviderName {
  return isFrontendProvider(v) || isBackendProvider(v);
}
