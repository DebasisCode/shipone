import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCloud } from "./fakeCloud.js";
import { FULLSTACK_FILES, makeRepo, tmpDir } from "./helpers.js";

/**
 * Runs the real CLI (as a subprocess, over real HTTP) against a local server
 * that mimics the Vercel and Render APIs.
 */

const exec = promisify(execFile);
const CLI = path.resolve(__dirname, "../src/cli.ts");
// Absolute loader URL so the CLI can run from any cwd (tsx isn't installed in the temp repos).
const TSX = import.meta.resolve("tsx");

let cloud: FakeCloud;
let server: Awaited<ReturnType<FakeCloud["listen"]>>;
let repo: { root: string; sha: string };
let home: string;

beforeAll(async () => {
  repo = makeRepo(FULLSTACK_FILES);
  cloud = new FakeCloud({ branchHeads: { main: repo.sha }, buildPolls: 1 });
  server = await cloud.listen();
  home = tmpDir("shipone-e2e-home-");
});
afterAll(() => server.close());

async function shipone(args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--import", TSX, CLI, ...args], {
      cwd: repo.root,
      env: {
        ...process.env,
        SHIPONE_HOME: home,
        SHIPONE_VERCEL_API_URL: server.vercelUrl,
        SHIPONE_RENDER_API_URL: server.renderUrl,
        SHIPONE_POLL_INTERVAL_MS: "10",
        SHIPONE_NO_BROWSER: "1",
        VERCEL_TOKEN: "",
        RENDER_API_KEY: "",
        NO_COLOR: "1",
        ...env,
      },
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
}

describe("shipone CLI end to end", () => {
  it("connects providers with tokens", async () => {
    const bad = await shipone(["connect", "vercel", "--token", "wrong"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("Vercel says your token isn't allowed");

    expect((await shipone(["connect", "vercel", "--token", "vercel-token"])).out).toContain("Connected Vercel as me");
    expect((await shipone(["--yes", "connect", "render", "--token", "render-token"])).out).toContain("Connected Render workspace Me");

    const cfg = await shipone(["config"]);
    expect(cfg.out).toMatch(/Vercel\s+connected/);
    expect(cfg.out).toMatch(/frontend\s+vercel/);
    expect(cfg.out).toMatch(/backend\s+render/);
  });

  it("deploys the full stack with one command", async () => {
    const res = await shipone(["--yes", "deploy"], { SHIPONE_ENV_DATABASE_URL: "postgres://prod/db", SHIPONE_ENV_JWT_SECRET: "x" });
    expect(res.out).toContain("https://app.vercel.app");
    expect(res.out).toContain("https://app-api.onrender.com");
    expect(res.out).toContain("Your app is live.");
    expect(res.code).toBe(0);
    expect(cloud.vercel.projects.size).toBe(1);
    expect(cloud.render.services.size).toBe(1);
  });

  it("status, env and logs work against the deployed services", async () => {
    const st = await shipone(["status"]);
    expect(st.code).toBe(0);
    expect(st.out).toContain("live");

    const set = await shipone(["env", "set", "SENTRY_DSN=https://x"]);
    expect(set.out).toContain("Set SENTRY_DSN on Render");
    const ls = await shipone(["env", "ls", "--backend"]);
    expect(ls.out).toContain("SENTRY_DSN");

    const logs = await shipone(["logs", "backend", "-n", "20"]);
    expect(logs.out).toContain("Server listening on 10000");
  });

  it("fails with a helpful message outside a git repo", async () => {
    const res = await exec(process.execPath, ["--import", TSX, CLI, "status"], { cwd: tmpDir(), env: { ...process.env, SHIPONE_HOME: home } }).catch((e) => e);
    expect(res.code).toBe(1);
    expect(res.stdout + res.stderr).toContain("not a git repository");
  });
});
