import { spawn } from "node:child_process";
import pc from "picocolors";
import type { Context } from "../core/context.js";
import { ShipOneError } from "../core/errors.js";
import { TOKEN_ENV_VARS } from "../core/store.js";
import { ALL_PROVIDERS, isProviderName, PROVIDER_LABELS, type ProviderName } from "../core/types.js";
import { NetlifyHost, NETLIFY_TOKEN_URL } from "../providers/netlify.js";
import { RailwayHost, RAILWAY_TOKEN_URL } from "../providers/railway.js";
import { RenderHost, RENDER_TOKEN_URL } from "../providers/render.js";
import { VercelHost, VERCEL_TOKEN_URL } from "../providers/vercel.js";

export function openInBrowser(ctx: Context, url: string) {
  if (ctx.openUrl) return ctx.openUrl(url);
  if (!ctx.ui.interactive || ctx.env.SHIPONE_NO_BROWSER || ctx.env.CI) return;
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser available (SSH session, container): the URL is printed anyway.
  }
}

async function askToken(ctx: Context, provider: ProviderName, url: string, instructions: string): Promise<string> {
  ctx.ui.note(`${instructions}\n\n${pc.cyan(url)}`, `Connect ${PROVIDER_LABELS[provider]}`);
  openInBrowser(ctx, url);
  const token = await ctx.ui.password({
    message: `Paste your ${PROVIDER_LABELS[provider]} token`,
    validate: (v) => (v.trim() ? undefined : "A token is required"),
  });
  return token.trim();
}

const baseUrl = (ctx: Context, provider: ProviderName) => ctx.env[`SHIPONE_${provider.toUpperCase()}_API_URL`] || undefined;

export async function connectVercel(ctx: Context, opts: { token?: string } = {}) {
  const token =
    opts.token ??
    (await askToken(
      ctx,
      "vercel",
      VERCEL_TOKEN_URL,
      "Create a token in your Vercel account settings.\nScope it to the account/team you deploy to.",
    ));
  const host = new VercelHost(token, { fetch: ctx.fetch, baseUrl: baseUrl(ctx, "vercel") });

  const spin = ctx.ui.spinner();
  spin.start("Checking your Vercel token");
  let user: Awaited<ReturnType<VercelHost["whoami"]>>;
  let teams: Awaited<ReturnType<VercelHost["listTeams"]>>;
  try {
    user = await host.whoami();
    teams = await host.listTeams();
  } catch (err) {
    spin.fail("Vercel didn't accept that token");
    throw err;
  }
  spin.stop(`Token works: signed in as ${user.username}`);

  let scope = "__personal";
  if (teams.length > 0) {
    scope = await ctx.ui.select({
      message: "Where should ShipOne create Vercel projects?",
      choices: [
        { value: "__personal", label: `${user.username} (personal account)` },
        ...teams.map((t) => ({ value: t.id, label: t.name ?? t.slug, hint: t.slug })),
      ],
      initial: "__personal",
    });
  }
  const team = teams.find((t) => t.id === scope);

  ctx.store.setToken("vercel", token);
  ctx.store.updateConfig((c) => {
    c.vercel = team ? { teamId: team.id, teamSlug: team.slug } : {};
  });
  ctx.ui.success(`Connected Vercel as ${pc.bold(user.username)}${team ? ` (team ${team.slug})` : ""}.`);
}

export async function connectNetlify(ctx: Context, opts: { token?: string } = {}) {
  const token =
    opts.token ??
    (await askToken(
      ctx,
      "netlify",
      NETLIFY_TOKEN_URL,
      "Create a personal access token under User applications → Personal access tokens in the Netlify UI.",
    ));
  const host = new NetlifyHost(token, { fetch: ctx.fetch, baseUrl: baseUrl(ctx, "netlify") });

  const spin = ctx.ui.spinner();
  spin.start("Checking your Netlify token");
  let user: Awaited<ReturnType<NetlifyHost["whoami"]>>;
  let accounts: Awaited<ReturnType<NetlifyHost["listAccounts"]>>;
  try {
    user = await host.whoami();
    accounts = await host.listAccounts();
  } catch (err) {
    spin.fail("Netlify didn't accept that token");
    throw err;
  }
  spin.stop(`Token works: signed in as ${user.full_name ?? user.email ?? user.id}`);

  let account = accounts[0];
  if (accounts.length > 1) {
    const pick = await ctx.ui.select({
      message: "Which Netlify account (team) should ShipOne use?",
      choices: accounts.map((a) => ({ value: a.id, label: a.name, hint: a.slug })),
      initial: account?.id,
    });
    account = accounts.find((a) => a.id === pick)!;
  }

  ctx.store.setToken("netlify", token);
  ctx.store.updateConfig((c) => {
    c.netlify = account ? { accountId: account.id, accountName: account.name } : {};
  });
  ctx.ui.success(`Connected Netlify${account ? ` team ${pc.bold(account.name)}` : ""}.`);
}

export async function connectRender(ctx: Context, opts: { token?: string } = {}) {
  const token =
    opts.token ??
    (await askToken(ctx, "render", RENDER_TOKEN_URL, "Create an API key under Account Settings → API Keys in the Render dashboard."));
  const host = new RenderHost(token, { fetch: ctx.fetch, baseUrl: baseUrl(ctx, "render") });

  const spin = ctx.ui.spinner();
  spin.start("Checking your Render API key");
  let owners: Awaited<ReturnType<RenderHost["listOwners"]>>;
  try {
    owners = await host.listOwners();
  } catch (err) {
    spin.fail("Render didn't accept that API key");
    throw err;
  }
  if (owners.length === 0) {
    spin.fail("No workspaces found");
    throw new ShipOneError("That Render key can't see any workspace.", "Create the key from the Render account you deploy with.");
  }
  spin.stop("API key works");

  const ownerId = await ctx.ui.select({
    message: "Which Render workspace should ShipOne use?",
    choices: owners.map((o) => ({ value: o.id, label: o.name, hint: o.email ?? o.type })),
    initial: owners[0]!.id,
  });
  const owner = owners.find((o) => o.id === ownerId)!;

  ctx.store.setToken("render", token);
  ctx.store.updateConfig((c) => {
    c.render = { ...c.render, ownerId: owner.id, ownerName: owner.name };
  });
  ctx.ui.success(`Connected Render workspace ${pc.bold(owner.name)}.`);
}

export async function connectRailway(ctx: Context, opts: { token?: string } = {}) {
  const token =
    opts.token ??
    (await askToken(
      ctx,
      "railway",
      RAILWAY_TOKEN_URL,
      "Create a token under Account Settings → API Tokens in the Railway dashboard.\nUse an account token (or a team token for a specific workspace).",
    ));
  const host = new RailwayHost(token, { fetch: ctx.fetch, baseUrl: baseUrl(ctx, "railway") });

  const spin = ctx.ui.spinner();
  spin.start("Checking your Railway token");
  let me: Awaited<ReturnType<RailwayHost["whoami"]>>;
  try {
    me = await host.whoami();
  } catch (err) {
    spin.fail("Railway didn't accept that token");
    throw err;
  }
  spin.stop(`Token works: signed in as ${me.name}`);

  let workspace: { id: string; name: string } | undefined;
  if (me.workspaces.length > 0) {
    const pick = await ctx.ui.select({
      message: "Which Railway workspace should ShipOne deploy to?",
      choices: [
        { value: "__personal", label: `${me.name} (personal account)` },
        ...me.workspaces.map((w) => ({ value: w.id, label: w.name })),
      ],
      initial: "__personal",
    });
    workspace = me.workspaces.find((w) => w.id === pick);
  }

  ctx.store.setToken("railway", token);
  ctx.store.updateConfig((c) => {
    c.railway = workspace ? { workspaceId: workspace.id, workspaceName: workspace.name } : {};
  });
  ctx.ui.success(`Connected Railway${workspace ? ` workspace ${pc.bold(workspace.name)}` : ` as ${pc.bold(me.name)}`}.`);
}

export async function connect(ctx: Context, provider: string | undefined, opts: { token?: string }) {
  if (!provider) {
    const picked = await ctx.ui.select({
      message: "Which provider do you want to connect? (existing connections stay as they are)",
      choices: ALL_PROVIDERS.map((p) => ({
        value: p,
        label: `${PROVIDER_LABELS[p]}${ctx.store.getToken(p) ? pc.dim(" — already connected, this replaces the token") : ""}`,
      })),
    });
    provider = picked;
  }
  if (!isProviderName(provider)) {
    throw new ShipOneError(`Unknown provider "${provider}".`, `Supported: ${ALL_PROVIDERS.join(", ")}.`);
  }
  switch (provider) {
    case "vercel":
      return connectVercel(ctx, opts);
    case "netlify":
      return connectNetlify(ctx, opts);
    case "render":
      return connectRender(ctx, opts);
    case "railway":
      return connectRailway(ctx, opts);
  }
}

/** A provider needs more than a token before it can deploy (e.g. a workspace picked). */
function needsSetup(ctx: Context, provider: ProviderName): boolean {
  const cfg = ctx.store.readConfig();
  switch (provider) {
    // The config section appears (even empty) once connect has run.
    case "netlify":
      return cfg.netlify === undefined;
    case "railway":
      return cfg.railway === undefined;
    default:
      return false;
  }
}

/** Make sure we have a token; offer to connect right now if not. */
export async function ensureConnected(ctx: Context, provider: ProviderName) {
  if (ctx.store.getToken(provider)) {
    // Token from the environment, but the account/workspace was never picked: do it now.
    if (needsSetup(ctx, provider)) await connect(ctx, provider, { token: ctx.store.getToken(provider) });
    return;
  }
  if (!ctx.ui.interactive) {
    throw new ShipOneError(
      `${PROVIDER_LABELS[provider]} isn't connected.`,
      `Run \`shipone connect ${provider}\` or set ${TOKEN_ENV_VARS[provider]}.`,
    );
  }
  ctx.ui.info(`${PROVIDER_LABELS[provider]} isn't connected yet, so let's do that now.`);
  await connect(ctx, provider, {});
}

export function disconnect(ctx: Context, provider: string) {
  if (!isProviderName(provider)) {
    throw new ShipOneError(`Unknown provider "${provider}".`, `Supported: ${ALL_PROVIDERS.join(", ")}.`);
  }
  ctx.store.setToken(provider, undefined);
  ctx.ui.success(`Removed the stored ${PROVIDER_LABELS[provider]} token.`);
  if (ctx.env[TOKEN_ENV_VARS[provider]]) ctx.ui.warn(`${TOKEN_ENV_VARS[provider]} is still set in your environment.`);
}