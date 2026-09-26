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
        SHIPONE_NETLIFY_API_URL: server.netlifyUrl,
        SHIPONE_RENDER_API_URL: server.renderUrl,
        SHIPONE_RAILWAY_API_URL: server.railwayUrl,
        SHIPONE_POLL_INTERVAL_MS: "10",
        SHIPONE_NO_BROWSER: "1",
        VERCEL_TOKEN: "",
        NETLIFY_AUTH_TOKEN: "",
        RENDER_API_KEY: "",
        RAILWAY_TOKEN: "",
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
    expect((await shipone(["--yes", "connect", "netlify", "--token", "netlify-token"])).out).toContain("Connected Netlify team Me");
    expect((await shipone(["--yes", "connect", "railway", "--token", "railway-token"])).out).toContain("Connected Railway as Me");

    const cfg = await shipone(["config"]);
    expect(cfg.out).toMatch(/Vercel\s+connected/);
    expect(cfg.out).toMatch(/Netlify\s+connected/);
    expect(cfg.out).toMatch(/Render\s+connected/);
    expect(cfg.out).toMatch(/Railway\s+connected/);
    expect(cfg.out).toMatch(/frontend\s+\(ask on first deploy\)/);
    expect(cfg.out).toMatch(/backend\s+\(ask on first deploy\)/);
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

  it("account shows live info for every connected provider", async () => {
    const res = await shipone(["account"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Accounts");
    expect(res.out).toMatch(/Vercel\s+connected/);
    expect(res.out).toContain("user  me");
    expect(res.out).toContain("team  (personal account)");
    expect(res.out).toMatch(/Netlify\s+connected/);
    expect(res.out).toMatch(/Render\s+connected/);
    expect(res.out).toContain("workspace  Me");
    expect(res.out).toMatch(/Railway\s+connected/);
  });

  it("deploys to Netlify + Railway when .shipone.yml picks them", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(path.join(repo.root, ".shipone.yml"), "frontend:\n  path: client\n  provider: netlify\nbackend:\n  path: server\n  provider: railway\n");
    const res = await shipone(["--yes", "deploy"], { SHIPONE_ENV_DATABASE_URL: "postgres://prod/db2", SHIPONE_ENV_JWT_SECRET: "y" });
    expect(res.out).toContain("https://app.netlify.app");
    expect(res.out).toMatch(/app-api-\d+\.up\.railway\.app/);
    expect(res.out).toContain("Your app is live.");
    expect(res.code).toBe(0);
    expect(cloud.netlify.sites.size).toBe(1);
    expect(cloud.railway.services.size).toBe(1);
  });

  it("fails with a helpful message outside a git repo", async () => {
    const res = await exec(process.execPath, ["--import", TSX, CLI, "status"], { cwd: tmpDir(), env: { ...process.env, SHIPONE_HOME: home } }).catch((e) => e);
    expect(res.code).toBe(1);
    expect(res.stdout + res.stderr).toContain("not a git repository");
  });
});
