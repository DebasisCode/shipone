import { spawn } from "node:child_process";
import pc from "picocolors";
import type { Context } from "../core/context.js";
import { ShipOneError } from "../core/errors.js";
import { TOKEN_ENV_VARS } from "../core/store.js";
import { ALL_PROVIDERS, isProviderName, PROVIDER_LABELS, type ProviderName } from "../core/types.js";
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
    c.defaults.frontend ??= "vercel";
  });
  ctx.ui.success(`Connected Vercel as ${pc.bold(user.username)}${team ? ` (team ${team.slug})` : ""}.`);
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
    c.defaults.backend ??= "render";
  });
  ctx.ui.success(`Connected Render workspace ${pc.bold(owner.name)}.`);
}

export async function connect(ctx: Context, provider: string | undefined, opts: { token?: string }) {
  if (!provider) {
    provider = await ctx.ui.select({
      message: "Which provider do you want to connect?",
      choices: ALL_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] })),
    });
  }
  if (!isProviderName(provider)) {
    throw new ShipOneError(`Unknown provider "${provider}".`, `Supported: ${ALL_PROVIDERS.join(", ")}.`);
  }
  if (provider === "vercel") await connectVercel(ctx, opts);
  else await connectRender(ctx, opts);
}

/** Make sure we have a token; offer to connect right now if not. */
export async function ensureConnected(ctx: Context, provider: ProviderName) {
  if (ctx.store.getToken(provider)) {
    if (provider === "render" && !ctx.store.readConfig().render?.ownerId) {
      // Token from RENDER_API_KEY but never picked a workspace: do it now.
      await connectRender(ctx, { token: ctx.store.getToken("render") });
    }
    return;
  }
  if (!ctx.ui.interactive) {
    throw new ShipOneError(
      `${PROVIDER_LABELS[provider]} isn't connected.`,
      `Run \`shipone connect ${provider}\` or set ${TOKEN_ENV_VARS[provider]}.`,
    );
  }
  ctx.ui.info(`${PROVIDER_LABELS[provider]} isn't connected yet, so let's do that now.`);
  if (provider === "vercel") await connectVercel(ctx);
  else await connectRender(ctx);
}

export function disconnect(ctx: Context, provider: string) {
  if (!isProviderName(provider)) {
    throw new ShipOneError(`Unknown provider "${provider}".`, `Supported: ${ALL_PROVIDERS.join(", ")}.`);
  }
  ctx.store.setToken(provider, undefined);
  ctx.ui.success(`Removed the stored ${PROVIDER_LABELS[provider]} token.`);
  if (ctx.env[TOKEN_ENV_VARS[provider]]) ctx.ui.warn(`${TOKEN_ENV_VARS[provider]} is still set in your environment.`);
}
