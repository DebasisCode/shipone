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
} from "../core/types.js";

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
    const extra =
      p === "vercel" && cfg.vercel?.teamSlug ? ` (team ${cfg.vercel.teamSlug})` : p === "render" && cfg.render?.ownerName ? ` (${cfg.render.ownerName})` : "";
    lines.push(
      `  ${PROVIDER_LABELS[p].padEnd(8)} ${connected ? pc.green("connected") : pc.dim(`not connected: shipone connect ${p}`)}${extra}${fromEnv ? pc.dim(` via ${TOKEN_ENV_VARS[p]}`) : ""}`,
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
