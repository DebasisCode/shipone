#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { createRequire } from "node:module";
import { configKeysHelp, configSet, configShow } from "./commands/config.js";
import { connect, disconnect } from "./commands/connect.js";
import { deploy } from "./commands/deploy.js";
import { envList, envSet, logs, status } from "./commands/project.js";
import { createContext, type Context } from "./core/context.js";
import { CancelledError, ShipOneError } from "./core/errors.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();

program
  .name("shipone")
  .description("Deploy a full-stack app to your own Vercel + Render accounts with one command, wired together.")
  .version(version)
  .option("-y, --yes", "never prompt; use defaults and fail if input is required")
  .showHelpAfterError();

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
  .argument("[provider]", "vercel or render")
  .option("--token <token>", "use this token instead of prompting (it's saved like a pasted one)")
  .description("connect a hosting provider (stores the token in ~/.shipone/credentials.json, readable only by you)")
  .action(run((ctx, provider: string | undefined, opts: { token?: string }) => connect(ctx, provider, opts)));

program
  .command("disconnect")
  .argument("<provider>", "vercel or render")
  .description("forget the stored token for a provider")
  .action(run((ctx, provider: string) => disconnect(ctx, provider)));

const config = program
  .command("config")
  .description("show account defaults and connected providers")
  .action(run((ctx) => configShow(ctx)));

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
