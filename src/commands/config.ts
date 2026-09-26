import pc from "picocolors";
import type { Context } from "../core/context.js";
import { ShipOneError } from "../core/errors.js";
import { readGitInfo, repoSlug } from "../core/git.js";
import { TOKEN_ENV_VARS, type AccountConfig } from "../core/store.js";
import {
  ALL_PROVIDERS,
  BACKEND_PROVIDERS,
  FRONTEND_PROVIDERS,
  isBackendProvider,
  isFrontendProvider,
  PROVIDER_LABELS,
  type ProviderName,
} from "../core/types.js";
import { netlifyHost, railwayHost, renderHost, vercelHost } from "../providers/index.js";

const RENDER_REGIONS = ["oregon", "ohio", "virginia", "frankfurt", "singapore"];

const KEYS: Record<string, { describe: string; set: (c: AccountConfig, v: string | undefined) => void; repo?: boolean }> = {
  frontend: {
    describe: `default frontend provider (${FRONTEND_PROVIDERS.join(", ")})`,
    repo: true,
    set: (c, v) => {
      if (v !== undefined && !isFrontendProvider(v)) throw new ShipOneError(`frontend must be one of: ${FRONTEND_PROVIDERS.join(", ")}`);
      c.defaults.frontend = v;
    },
  },
  backend: {
    describe: `default backend provider (${BACKEND_PROVIDERS.join(", ")})`,
    repo: true,
    set: (c, v) => {
      if (v !== undefined && !isBackendProvider(v)) throw new ShipOneError(`backend must be one of: ${BACKEND_PROVIDERS.join(", ")}`);
      c.defaults.backend = v;
    },
  },
  "render.region": {
    describe: `region for new Render services (${RENDER_REGIONS.join(", ")})`,
    set: (c, v) => {
      if (v !== undefined && !RENDER_REGIONS.includes(v)) throw new ShipOneError(`render.region must be one of: ${RENDER_REGIONS.join(", ")}`);
      c.render = { ...c.render, region: v };
    },
  },
  "render.plan": {
    describe: "instance type for new Render services (free, starter, ...)",
    set: (c, v) => {
      c.render = { ...c.render, plan: v };
    },
  },
};

function lookupKey(key: string) {
  const k = KEYS[key];
  if (!k) throw new ShipOneError(`Unknown setting "${key}".`, `Settings: ${Object.keys(KEYS).join(", ")}`);
  return k;
}

async function currentSlug(ctx: Context) {
  return repoSlug(await readGitInfo(ctx.cwd));
}

export async function configSet(ctx: Context, key: string, value: string | undefined, opts: { repo?: boolean }) {
  const k = lookupKey(key);
  if (opts.repo) {
    if (!k.repo) throw new ShipOneError(`"${key}" can't be set per repo.`);
    const slug = await currentSlug(ctx);
    ctx.store.updateConfig((c) => {
      // Validate using the same rules, on a scratch copy.
      const scratch: AccountConfig = { defaults: {}, repos: {} };
      k.set(scratch, value);
      const override = { ...c.repos[slug] };
      if (key === "frontend") override.frontend = scratch.defaults.frontend;
      if (key === "backend") override.backend = scratch.defaults.backend;
      c.repos[slug] = JSON.parse(JSON.stringify(override));
      if (Object.keys(c.repos[slug]!).length === 0) delete c.repos[slug];
    });
    ctx.ui.success(value === undefined ? `Cleared ${key} for ${slug}.` : `${slug}: ${key} → ${value}`);
    return;
  }
  ctx.store.updateConfig((c) => k.set(c, value));
  ctx.ui.success(value === undefined ? `Cleared ${key}.` : `${key} → ${value}`);
}

export async function configShow(ctx: Context) {
  const cfg = ctx.store.readConfig();
  const creds = ctx.store.readCredentials();
  const lines: string[] = [];

  lines.push(pc.bold("Connected providers"));
  for (const p of ALL_PROVIDERS) {
    const fromEnv = Boolean(ctx.env[TOKEN_ENV_VARS[p]]);
    const connected = fromEnv || Boolean(creds[p]);
    const team =
      p === "vercel" && cfg.vercel?.teamSlug
        ? ` (team ${cfg.vercel.teamSlug})`
        : p === "netlify" && cfg.netlify?.accountName
          ? ` (${cfg.netlify.accountName})`
          : p === "render" && cfg.render?.ownerName
            ? ` (${cfg.render.ownerName})`
            : p === "railway" && cfg.railway?.workspaceName
              ? ` (${cfg.railway.workspaceName})`
              : "";
    lines.push(
      `  ${PROVIDER_LABELS[p].padEnd(8)} ${connected ? pc.green("connected") : pc.dim(`not connected: shipone connect ${p}`)}${team}${fromEnv ? pc.dim(` via ${TOKEN_ENV_VARS[p]}`) : ""}`,
    );
  }

  lines.push("", pc.bold("Account defaults"));
  lines.push(`  frontend  ${cfg.defaults.frontend ?? pc.dim("(ask on first deploy)")}`);
  lines.push(`  backend   ${cfg.defaults.backend ?? pc.dim("(ask on first deploy)")}`);
  lines.push(`  render.region  ${cfg.render?.region ?? pc.dim("oregon")}`);
  lines.push(`  render.plan    ${cfg.render?.plan ?? pc.dim("free")}`);

  const slug = await currentSlug(ctx).catch(() => undefined);
  if (slug) {
    const o = cfg.repos[slug];
    lines.push("", pc.bold(`This repo (${slug})`));
    lines.push(o && (o.frontend || o.backend) ? `  overrides: ${JSON.stringify(o)}` : pc.dim("  no overrides"));
  }
  lines.push("", pc.dim(`Stored in ${ctx.store.dir}. Change with: shipone config set <key> <value> [--repo]`));
  ctx.ui.note(lines.join("\n"), "ShipOne config");
}

export function configKeysHelp(): string {
  return Object.entries(KEYS)
    .map(([k, v]) => `  ${k.padEnd(14)} ${v.describe}${v.repo ? " [--repo ok]" : ""}`)
    .join("\n");
}

/**
 * Live account details for every connected provider: who the token belongs to,
 * which team/workspace is in use, and how the token got there. Nothing here
 * can change or deploy anything.
 */
export async function accountInfo(ctx: Context) {
  const cfg = ctx.store.readConfig();
  const lines: string[] = [];

  const one = async (provider: ProviderName): Promise<string[]> => {
    if (!ctx.store.getToken(provider)) {
      return [`  ${PROVIDER_LABELS[provider].padEnd(8)} ${pc.dim("not connected — shipone connect " + provider)}`];
    }
    const out = [`  ${PROVIDER_LABELS[provider].padEnd(8)} ${pc.green("connected")}`];
    try {
      switch (provider) {
        case "vercel": {
          const host = vercelHost(ctx);
          const [user, teams] = await Promise.all([host.whoami(), host.listTeams()]);
          out.push(`           user  ${user.username}${user.email ? pc.dim(` <${user.email}>`) : ""}`);
          out.push(`           team  ${cfg.vercel?.teamSlug ? cfg.vercel.teamSlug : pc.dim("(personal account)")}`);
          if (teams.length) out.push(`           other teams: ${teams.map((t) => t.name ?? t.slug).join(", ")} ${pc.dim("(shipone connect vercel to switch)")}`);
          break;
        }
        case "netlify": {
          const host = netlifyHost(ctx);
          const [user, accounts] = await Promise.all([host.whoami(), host.listAccounts()]);
          out.push(`           user  ${user.full_name ?? user.email ?? user.id}`);
          out.push(`           team  ${cfg.netlify?.accountName ?? pc.dim("(personal account)")}`);
          if (accounts.length > 1) out.push(`           other teams: ${accounts.map((a) => a.name).filter((n) => n !== cfg.netlify?.accountName).join(", ")}`);
          break;
        }
        case "render": {
          const host = renderHost(ctx);
          const owners = await host.listOwners();
          const owner = owners.find((o) => o.id === cfg.render?.ownerId);
          out.push(`           workspace  ${owner?.name ?? cfg.render?.ownerName ?? pc.dim("(none selected)")}`);
          if (owner?.email) out.push(`             email  ${owner.email}`);
          if (owners.length > 1) out.push(`           other workspaces: ${owners.filter((o) => o.id !== owner?.id).map((o) => o.name).join(", ")}`);
          break;
        }
        case "railway": {
          const host = railwayHost(ctx);
          const me = await host.whoami();
          out.push(`           user  ${me.name}`);
          out.push(`           workspace  ${cfg.railway?.workspaceName ?? pc.dim("(personal account)")}`);
          if (me.workspaces.length) {
            out.push(`           other workspaces: ${me.workspaces.filter((w) => w.id !== cfg.railway?.workspaceId).map((w) => w.name).join(", ")}`);
          }
          break;
        }
      }
    } catch (err) {
      out.push(`           ${pc.yellow(`couldn't reach ${PROVIDER_LABELS[provider]}: ${(err as Error).message}`)}`);
    }
    if (ctx.env[TOKEN_ENV_VARS[provider]]) out.push(`           token from env var ${TOKEN_ENV_VARS[provider]}`);
    return out;
  };

  // Ask all connected providers at once; a slow one shouldn't stall the rest.
  const blocks = await Promise.all(ALL_PROVIDERS.map((p) => one(p)));
  lines.push(pc.bold("Accounts"), ...blocks.flat());

  lines.push("", pc.bold("Deploy defaults"));
  lines.push(`  frontend  ${cfg.defaults.frontend ?? pc.dim("(ask on deploy)")}`);
  lines.push(`  backend   ${cfg.defaults.backend ?? pc.dim("(ask on deploy)")}`);

  lines.push("", pc.dim(`Providers are added or removed with: shipone connect <provider> / shipone disconnect <provider>`));
  ctx.ui.note(lines.join("\n"), "ShipOne account info");
}
