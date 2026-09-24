import type { AccountConfig, RepoOverride } from "./store.js";
import type { RepoConfig } from "./repoConfig.js";
import type { BackendProviderName, FrontendProviderName, Role } from "./types.js";

export type PreferenceSource = "repo-file" | "repo-override" | "account-default";

export interface Resolved<T> {
  provider: T;
  source: PreferenceSource;
}

type ProviderFor<R extends Role> = R extends "frontend" ? FrontendProviderName : BackendProviderName;

/**
 * Which provider hosts `role` for this repo. Highest priority first:
 *   1. .shipone.yml in the repo
 *   2. per-repo override (`shipone config set --repo ...`)
 *   3. account defaults (`shipone config set ...`)
 * Returns undefined when nothing is set, meaning "ask the user".
 */
export function resolveProvider<R extends Role>(
  role: R,
  repoConfig: RepoConfig | undefined,
  repoOverride: RepoOverride | undefined,
  account: AccountConfig,
): Resolved<ProviderFor<R>> | undefined {
  const fromFile = repoConfig?.[role]?.provider;
  if (fromFile) return { provider: fromFile as ProviderFor<R>, source: "repo-file" };
  const fromOverride = repoOverride?.[role];
  if (fromOverride) return { provider: fromOverride as ProviderFor<R>, source: "repo-override" };
  const fromDefault = account.defaults[role];
  if (fromDefault) return { provider: fromDefault as ProviderFor<R>, source: "account-default" };
  return undefined;
}
