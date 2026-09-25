/**
 * Smoke test: for each fixture in ./fixtures.ts, write a real project, let
 * ShipOne detect it, then actually run the detected build and start commands
 * in a Render-like environment and check the server answers HTTP on $PORT.
 *
 * This downloads packages and compiles code, so it isn't part of `npm test`.
 *
 *   npm run smoke                 # every fixture except slow ones
 *   npm run smoke -- --all        # include slow ones (Rust)
 *   npm run smoke -- fastapi go   # only fixtures whose name contains a word
 *
 * The Render-like environment: node, npm, npx and Yarn 1 are on PATH but pnpm
 * isn't (and global installs aren't possible there); Python runs inside a
 * virtualenv at the repo root, like Render's /opt/render/project/src/.venv.
 * Needs bash plus whichever toolchains the fixtures use (node, python3, go,
 * ruby/bundler, cargo); fixtures whose toolchain is missing are skipped.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { detectApps, pickObvious, type BackendApp } from "../../src/core/detect.js";
import { writeFiles } from "../helpers.js";
import { FIXTURES, type SmokeFixture } from "./fixtures.js";

const args = process.argv.slice(2);
const includeSlow = args.includes("--all");
const filters = args.filter((a) => !a.startsWith("--")).map((a) => a.toLowerCase());
const BUILD_TIMEOUT_MS = 10 * 60_000;
const START_TIMEOUT_MS = 120_000;
const CONCURRENCY = Number(process.env.SMOKE_CONCURRENCY ?? 3);

const which = (bin: string): string | undefined => {
  const r = spawnSync("bash", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

/** A bin dir holding only the tools Render's native runtimes provide. Notably no pnpm. */
function renderBinDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipone-smoke-bin-"));
  const nodeDir = path.dirname(process.execPath);
  for (const bin of ["node", "npm", "npx", "corepack"]) {
    const src = path.join(nodeDir, bin);
    if (fs.existsSync(src)) fs.symlinkSync(src, path.join(dir, bin));
  }
  for (const bin of ["yarn", "python3", "go", "gofmt", "cargo", "rustc", "ruby", "gem", "bundle", "bundler", "git"]) {
    const src = which(bin);
    if (src) fs.symlinkSync(src, path.join(dir, bin));
  }
  const yarnVersion = spawnSync(path.join(dir, "yarn"), ["--version"], { encoding: "utf8" }).stdout?.trim();
  if (yarnVersion && !yarnVersion.startsWith("1.")) console.warn(`! yarn on this machine is ${yarnVersion}; Render ships Yarn 1.`);
  return dir;
}

function renderEnv(binDir: string, root: string, app: BackendApp, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: "C.UTF-8",
    TMPDIR: os.tmpdir(),
    PORT: String(port),
    PATH: `${binDir}:/usr/bin:/bin`,
    CI: "true",
  };
  // Keep proxy/CA settings so package downloads work behind a corporate/sandbox proxy.
  for (const [k, v] of Object.entries(process.env)) {
    if (/proxy|_CA_|SSL_CERT|CERT_FILE|CARGO_HOME|RUSTUP_HOME|GOPATH|GOMODCACHE|GOFLAGS|GOPROXY|GEM_HOME|GEM_PATH|BUNDLE_/i.test(k)) env[k] = v;
  }
  if (app.runtime === "ruby") {
    // Gem executables (puma, rackup, rails) live in Gem.bindir, which is on PATH on Render.
    const gemBin = spawnSync("ruby", ["-e", "print Gem.bindir"], { encoding: "utf8" }).stdout?.trim();
    if (gemBin) env.PATH = `${gemBin}:${env.PATH}`;
  }
  if (app.runtime === "python") {
    const venv = path.join(root, ".venv");
    env.VIRTUAL_ENV = venv;
    env.PATH = `${venv}/bin:${env.PATH}`;
  }
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function sh(cmd: string, cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", cmd], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout!.on("data", (d) => (out += d));
    proc.stderr!.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      out += `\n(timed out after ${Math.round(timeout / 1000)}s)`;
      kill(proc);
    }, timeout);
    proc.on("error", (err) => (out += `\n${err.message}`));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out });
    });
  });
}

function kill(proc: ReturnType<typeof spawn>) {
  try {
    process.kill(-proc.pid!, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Probe through a non-loopback address when there is one: Render's router
 * reaches the app from outside, so a server bound to 127.0.0.1 must fail here too.
 */
const PROBE_HOST =
  Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal)?.address ?? "127.0.0.1";

async function waitForHttp(port: number, proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return undefined;
    try {
      const res = await fetch(`http://${PROBE_HOST}:${port}/`, { signal: AbortSignal.timeout(2000) });
      return res.status;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return undefined;
}

const TOOLCHAIN: Record<BackendApp["runtime"], string[]> = {
  node: ["node"],
  python: ["python3"],
  go: ["go"],
  rust: ["cargo"],
  ruby: ["ruby", "bundle"],
  docker: ["docker"],
};

interface Result {
  fixture: SmokeFixture;
  status: "pass" | "fail" | "skip";
  stage?: string;
  detail?: string;
  app?: BackendApp;
  ms: number;
}

async function runFixture(f: SmokeFixture, binDir: string): Promise<Result> {
  const started = Date.now();
  const done = (r: Omit<Result, "fixture" | "ms">): Result => ({ fixture: f, ms: Date.now() - started, ...r });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shipone-smoke-"));
  writeFiles(root, f.files);

  for (const cmd of f.setup ?? []) {
    const r = await sh(cmd, root, process.env, BUILD_TIMEOUT_MS);
    if (!r.ok) return done({ status: "skip", stage: "setup", detail: `${cmd}\n${tail(r.out)}` });
  }

  const found = detectApps(root);
  const app = pickObvious("backend", found.backends);
  if (!app || app.path !== f.expectBackend) {
    return done({ status: "fail", stage: "detect", detail: `expected backend "${f.expectBackend}", detected [${found.backends.map((b) => b.path).join(", ")}]` });
  }
  if (f.expectFrontend !== undefined && pickObvious("frontend", found.frontends)?.path !== f.expectFrontend) {
    return done({ status: "fail", stage: "detect", app, detail: `expected frontend "${f.expectFrontend}", detected [${found.frontends.map((x) => x.path).join(", ")}]` });
  }
  if (!app.startCommand) return done({ status: "fail", stage: "detect", app, detail: "no start command" });
  const missing = TOOLCHAIN[app.runtime].filter((t) => !which(t));
  if (missing.length) return done({ status: "skip", stage: "toolchain", app, detail: `missing ${missing.join(", ")}` });

  const port = await freePort();
  const env = renderEnv(binDir, root, app, port);
  const cwd = path.join(root, app.path);
  if (app.runtime === "python") {
    const r = await sh("python3 -m venv .venv", root, env, 120_000);
    if (!r.ok) return done({ status: "skip", stage: "venv", app, detail: tail(r.out) });
  }

  const build = await sh(app.buildCommand, cwd, env, BUILD_TIMEOUT_MS);
  if (!build.ok) return done({ status: "fail", stage: "build", app, detail: tail(build.out) });

  const proc = spawn("bash", ["-c", app.startCommand], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d));
  proc.stderr!.on("data", (d) => (log += d));
  const status = await waitForHttp(port, proc, START_TIMEOUT_MS);
  kill(proc);
  if (status === undefined || status >= 500) {
    return done({ status: "fail", stage: "start", app, detail: `${status ? `HTTP ${status}` : "never answered on $PORT"}\n${tail(log)}` });
  }
  fs.rmSync(root, { recursive: true, force: true });
  return done({ status: "pass", app, detail: `HTTP ${status}` });
}

const tail = (s: string, n = 25) => s.trim().split("\n").slice(-n).join("\n");

async function main() {
  const selected = FIXTURES.filter((f) => (includeSlow || !f.slow) && (!filters.length || filters.some((w) => f.name.toLowerCase().includes(w))));
  if (!selected.length) {
    console.error("No fixtures match.");
    process.exit(2);
  }
  const binDir = renderBinDir();
  console.log(`Running ${selected.length} smoke fixture(s), ${CONCURRENCY} at a time, probing ${PROBE_HOST}...\n`);
  if (PROBE_HOST === "127.0.0.1") console.warn("! No non-loopback network interface: servers bound to localhost only won't be caught.\n");

  const results: Result[] = [];
  const queue = [...selected];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const r = await runFixture(f, binDir).catch((err: Error): Result => ({ fixture: f!, status: "fail", stage: "harness", detail: err.stack, ms: 0 }));
        results.push(r);
        const icon = r.status === "pass" ? "PASS" : r.status === "skip" ? "SKIP" : "FAIL";
        console.log(`${icon}  ${f.name}  (${Math.round(r.ms / 1000)}s)`);
        if (r.app) console.log(`      build: ${r.app.buildCommand}\n      start: ${r.app.startCommand}`);
        if (r.status !== "pass") console.log(`      [${r.stage}] ${r.detail?.split("\n").join("\n      ")}`);
      }
    }),
  );

  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skip");
  console.log(`\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  fs.rmSync(binDir, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

void main();
