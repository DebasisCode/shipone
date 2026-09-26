#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { createRequire } from "node:module";
import { accountInfo, configKeysHelp, configSet, configShow } from "./commands/config.js";
import { connect, disconnect, uninstall } from "./commands/connect.js";
import { deploy } from "./commands/deploy.js";
import { envList, envSet, logs, status } from "./commands/project.js";
import { createContext, type Context } from "./core/context.js";
import { CancelledError, ShipOneError } from "./core/errors.js";
import { ALL_PROVIDERS, PROVIDER_LABELS, type ProviderName } from "./core/types.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();

function printBanner(ver: string, connected: Map<ProviderName, boolean>) {
  const S = ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████╗", "╚══════╝"];
  const H = ["██╗  ██╗", "██║  ██║", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"];
  const I = ["██╗", "██║", "██║", "██║", "██║", "╚═╝"];
  const P = ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "╚═╝     "];
  const O = [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "];
  const N = ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"];
  const E = ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"];

  console.log();
  for (let row = 0; row < 6; row++) {
    const line =
      pc.bold(pc.cyan(S[row])) + " " +
      pc.bold(pc.cyan(H[row])) + " " +
      pc.bold(pc.blue(I[row])) + " " +
      pc.bold(pc.blue(P[row])) + "  " +
      pc.bold(pc.magenta(O[row])) + " " +
      pc.bold(pc.magenta(N[row])) + " " +
      pc.bold(pc.yellow(E[row]));
    console.log("  " + line);
  }
  console.log("  " + pc.dim("─".repeat(61)));
  console.log(`  ${pc.bold(pc.cyan("ShipOne"))} ${pc.dim(`v${ver}`)} ${pc.dim("•")} ${pc.white("One-Command Full-Stack Deployment")}`);
  console.log(`  ${pc.dim("Deploy local apps to Vercel, Netlify, Render & Railway, wired automatically.")}`);

  const parts = ALL_PROVIDERS.map((p) => {
    const state = connected.get(p) ? pc.green("● connected") : pc.yellow("○ not connected");
    return `${pc.bold(PROVIDER_LABELS[p])} ${state}`;
  });
  console.log(`  ${pc.dim("Providers:")} ${parts.join(`  ${pc.dim("│")}  `)}`);
  console.log("  " + pc.dim("─".repeat(61)));
  console.log();
}

async function runInteractiveMenu(ctx: Context) {
  const connectedNow = () => {
    const map = new Map<ProviderName, boolean>();
    for (const p of ALL_PROVIDERS) map.set(p, Boolean(ctx.store.getToken(p)));
    return map;
  };

  printBanner(version, connectedNow());

  if ([...connectedNow().values()].every((v) => !v)) {
    ctx.ui.info("No hosting providers connected yet.");
    const firstChoice = await ctx.ui.select({
      message: "What would you like to do?",
      choices: [
        { value: "connect", label: "Connect a hosting provider", hint: "recommended first step" },
        { value: "help", label: "Show CLI commands and help" },
        { value: "exit", label: "Exit" },
      ],
    });

    if (firstChoice === "help") {
      program.help();
      return;
    }
    if (firstChoice === "exit") {
      return;
    }

    await connect(ctx, undefined, {});
    printBanner(version, connectedNow());

    // Offer the other side of the stack (frontend or backend) as well.
    const feDone = connectedNow().get("vercel") || connectedNow().get("netlify");
    const beDone = connectedNow().get("render") || connectedNow().get("railway");
    if (feDone && !beDone) {
      const wantBackend = await ctx.ui.confirm({
        message: "Connect a backend provider (Render or Railway) too?",
        initial: true,
      });
      if (wantBackend) {
        await connect(ctx, undefined, {});
        printBanner(version, connectedNow());
      }
    }
  }

  const notConnected = ALL_PROVIDERS.filter((p) => !ctx.store.getToken(p));
  const action = await ctx.ui.select({
    message: "What would you like to do?",
    choices: [
      { value: "deploy", label: "Deploy this project", hint: "detect stack, wire URLs and CORS, and deploy" },
      { value: "dry-run", label: "Preview deploy plan (dry-run)", hint: "inspect what would happen without deploying" },
      { value: "status", label: "Check deployment status", hint: "live URLs and current deploy state" },
      { value: "logs", label: "View deployment logs", hint: "backend runtime or frontend build logs" },
      ...(notConnected.length
        ? [
            {
              value: "add-provider",
              label: `Connect another provider (${notConnected.map((p) => PROVIDER_LABELS[p]).join(", ")})`,
              hint: "existing connections stay as they are",
            },
          ]
        : []),
      { value: "connect", label: "Manage provider tokens", hint: "connect more, or update/disconnect existing ones" },
      { value: "config", label: "Account defaults and config", hint: "view or edit default providers and regions" },
      { value: "account", label: "Account info", hint: "who you are on each connected provider" },
      { value: "help", label: "Show CLI commands and help", hint: "view all command-line flags and options" },
    ],
  });

  switch (action) {
    case "deploy":
      await deploy(ctx, {});
      break;
    case "dry-run":
      await deploy(ctx, { dryRun: true });
      break;
    case "status":
      await status(ctx);
      break;
    case "logs":
      await logs(ctx, undefined, {});
      break;
    case "add-provider":
      await connect(ctx, undefined, {});
      printBanner(version, connectedNow());
      break;
    case "connect":
      await connect(ctx, undefined, {});
      break;
    case "config":
      await configShow(ctx);
      break;
    case "account":
      await accountInfo(ctx);
      break;
    case "help":
      program.help();
      break;
  }
}

program
  .name("shipone")
  .description("Ship your full-stack project in under 1 minute — with one command. Deploys into your own Vercel, Netlify, Render or Railway accounts, wired together.")
  .version(version)
  .option("-y, --yes", "never prompt; use defaults and fail if input is required")
  .showHelpAfterError()
  .action(
    run(async (ctx) => {
      if (!ctx.ui.interactive) {
        program.help();
        return;
      }
      await runInteractiveMenu(ctx);
    }),
  );

/** Run a command with a fresh context and friendly error output. */
function run<A extends unknown[]>(fn: (ctx: Context, ...args: A) => Promise<unknown> | unknown) {
  return async (...args: A) => {
    const ctx = createContext({ yes: Boolean(program.opts().yes) });
    try {
      await fn(ctx, ...args);
    } catch (err) {
      process.exitCode = handleError(err);
    }
  };
}

function handleError(err: unknown): number {
  if (err instanceof CancelledError) {
    clack.cancel("Cancelled.");
    return 130;
  }
  if (err instanceof ShipOneError) {
    clack.log.error(err.message + (err.hint ? `\n${pc.dim("→")} ${err.hint}` : ""));
    return 1;
  }
  clack.log.error(
    `Unexpected error: ${(err as Error)?.stack ?? String(err)}\n` +
      pc.dim("This is probably a ShipOne bug. Please open an issue with the output above."),
  );
  return 1;
}

const positiveInt = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("must be a positive whole number");
  return n;
};

program
  .command("connect")
  .argument("[provider]", "vercel, netlify, render or railway")
  .option("--token <token>", "use this token instead of prompting (it's saved like a pasted one)")
  .description("connect a hosting provider (stores the token in ~/.shipone/credentials.json, readable only by you)")
  .action(run((ctx, provider: string | undefined, opts: { token?: string }) => connect(ctx, provider, opts)));

program
  .command("disconnect")
  .argument("<provider>", "vercel, netlify, render or railway")
  .description("forget the stored token for a provider")
  .action(run((ctx, provider: string) => disconnect(ctx, provider)));

program
  .command("uninstall")
  .option("--force", "remove without asking")
  .description("remove everything ShipOne stored on this machine (~/.shipone: tokens, service ids, config). Deployed apps keep running.")
  .action(run((ctx, opts: { force?: boolean }) => uninstall(ctx, opts)));

const config = program
  .command("config")
  .description("show account defaults and connected providers")
  .action(run((ctx) => configShow(ctx)));

program
  .command("account")
  .description("show who you are on each connected provider (user, team/workspace)")
  .action(run((ctx) => accountInfo(ctx)));

config
  .command("set")
  .argument("<key>", "setting name")
  .argument("<value>", "new value")
  .option("--repo", "only for the current repo (overrides account defaults)")
  .description("change a setting")
  .addHelpText("after", `\nSettings:\n${configKeysHelp()}`)
  .action(run((ctx, key: string, value: string, opts: { repo?: boolean }) => configSet(ctx, key, value, opts)));

config
  .command("unset")
  .argument("<key>", "setting name")
  .option("--repo", "clear the current repo's override")
  .description("clear a setting")
  .action(run((ctx, key: string, opts: { repo?: boolean }) => configSet(ctx, key, undefined, opts)));

program
  .command("deploy")
  .description("first run: create + wire everything; later runs: redeploy the latest pushed commit")
  .option("--dry-run", "show what would happen without creating or deploying anything")
  .option("--force", "deploy even if pre-flight checks found errors")
  .action(run((ctx, opts: { dryRun?: boolean; force?: boolean }) => deploy(ctx, opts)));

program
  .command("status")
  .description("live URLs and deploy state for this repo")
  .action(run((ctx) => status(ctx)));

program
  .command("logs")
  .argument("[target]", "backend (default) or frontend")
  .option("-n, --lines <n>", "how many lines", positiveInt, 100)
  .description("recent runtime logs (backend) or build logs (frontend)")
  .action(run((ctx, target: string | undefined, opts: { lines?: number }) => logs(ctx, target, opts)));

const env = program.command("env").description("manage production env vars");

env
  .command("set")
  .argument("<KEY=value...>", "one or more assignments")
  .option("--frontend", "set on the frontend (default for VITE_/NEXT_PUBLIC_/REACT_APP_ keys)")
  .option("--backend", "set on the backend (default otherwise)")
  .description("set env vars on the deployed services")
  .action(run((ctx, pairs: string[], opts: { frontend?: boolean; backend?: boolean }) => envSet(ctx, pairs, opts)));

env
  .command("list")
  .alias("ls")
  .option("--frontend", "only the frontend")
  .option("--backend", "only the backend")
  .description("list env var names on the deployed services")
  .action(run((ctx, opts: { frontend?: boolean; backend?: boolean }) => envList(ctx, opts)));

await program.parseAsync();