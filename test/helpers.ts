import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "../src/core/context.js";
import { CancelledError } from "../src/core/errors.js";
import { Store } from "../src/core/store.js";
import type { SelectChoice, Spinner, UI } from "../src/core/ui.js";
import type { FetchLike } from "../src/providers/http.js";

export function tmpDir(prefix = "shipone-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(root: string, files: Record<string, string | object>) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

export function commitAll(cwd: string, message = "commit"): string {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** Mark the current HEAD as pushed to origin/<branch> without a network. */
export function fakePush(cwd: string, branch = "main") {
  git(cwd, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
  git(cwd, "branch", `--set-upstream-to=origin/${branch}`);
}

/** A git repo whose origin is github.com/<slug>, with the given files committed and "pushed". */
export function makeRepo(files: Record<string, string | object>, opts: { slug?: string; push?: boolean } = {}): { root: string; sha: string } {
  const root = tmpDir("shipone-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", `https://github.com/${opts.slug ?? "me/app"}.git`);
  writeFiles(root, files);
  const sha = commitAll(root, "initial");
  if (opts.push !== false) fakePush(root);
  return { root, sha };
}

/** A full-stack Vite + Express project like the ones ShipOne targets. */
export const FULLSTACK_FILES: Record<string, string | object> = {
  "client/package.json": { name: "client", scripts: { build: "vite build" }, dependencies: { react: "^19.0.0" }, devDependencies: { vite: "^7.0.0" } },
  "client/src/api.js": "export const api = (p) => fetch(`${import.meta.env.VITE_API_URL}${p}`);\n",
  "client/.env.example": "VITE_API_URL=http://localhost:5000\n",
  "server/package.json": { name: "server", main: "index.js", scripts: { start: "node index.js" }, dependencies: { express: "^5.0.0", cors: "^2.8.5" } },
  "server/package-lock.json": "{}",
  "server/index.js":
    "const express = require('express');\nconst cors = require('cors');\nconst app = express();\napp.use(cors({ origin: process.env.CORS_ORIGIN }));\napp.listen(process.env.PORT || 5000);\n",
  "server/.env.example": "DATABASE_URL=\nJWT_SECRET=\nCORS_ORIGIN=http://localhost:5173\nLOG_LEVEL=info\n",
};

export interface ScriptedAnswer {
  match: RegExp;
  answer: string | boolean | ((choices?: SelectChoice<string>[]) => string);
}

/** A UI that records output and answers prompts from a script. */
export class ScriptedUI implements UI {
  readonly out: { level: string; text: string }[] = [];
  readonly asked: string[] = [];

  constructor(
    readonly interactive = false,
    private readonly answers: ScriptedAnswer[] = [],
  ) {}

  private log(level: string, text: string) {
    this.out.push({ level, text });
  }
  text_(level?: string) {
    return this.out
      .filter((o) => !level || o.level === level)
      .map((o) => o.text)
      .join("\n");
  }

  intro(t: string) {
    this.log("intro", t);
  }
  outro(t: string) {
    this.log("outro", t);
  }
  info(t: string) {
    this.log("info", t);
  }
  success(t: string) {
    this.log("success", t);
  }
  warn(t: string) {
    this.log("warn", t);
  }
  error(t: string) {
    this.log("error", t);
  }
  note(body: string, title?: string) {
    this.log("note", `${title ?? ""}\n${body}`);
  }

  private answer(message: string, fallback: () => string | boolean, choices?: SelectChoice<string>[]) {
    this.asked.push(message);
    const a = this.answers.find((x) => x.match.test(message));
    if (!a) {
      if (!this.interactive) return fallback();
      throw new Error(`Unexpected prompt: ${message}`);
    }
    if (typeof a.answer === "function") return a.answer(choices);
    return a.answer;
  }

  async text(o: { message: string; defaultValue?: string }) {
    return String(this.answer(o.message, () => o.defaultValue ?? ""));
  }
  async password(o: { message: string }) {
    return String(this.answer(o.message, () => ""));
  }
  async select<T extends string>(o: { message: string; choices: SelectChoice<T>[]; initial?: T }): Promise<T> {
    if (o.choices.length === 1) return o.choices[0]!.value;
    const v = this.answer(o.message, () => o.initial ?? o.choices[0]!.value, o.choices as SelectChoice<string>[]);
    if (v === "__cancel") throw new CancelledError();
    return v as T;
  }
  async confirm(o: { message: string; initial?: boolean }) {
    return Boolean(this.answer(o.message, () => o.initial ?? true));
  }
  spinner(): Spinner {
    return {
      start: (m) => this.log("spin", m),
      message: () => {},
      stop: (m) => this.log("spin", m),
      fail: (m) => this.log("spin-fail", m),
    };
  }
}

export function testContext(opts: { cwd: string; ui?: UI; fetch?: FetchLike; env?: NodeJS.ProcessEnv; home?: string }): Context & { ui: ScriptedUI } {
  const env = { SHIPONE_HOME: opts.home ?? tmpDir("shipone-home-"), ...opts.env };
  return {
    ui: (opts.ui ?? new ScriptedUI()) as ScriptedUI,
    store: new Store(env),
    cwd: opts.cwd,
    env,
    fetch: opts.fetch,
    pollIntervalMs: 0,
    deployTimeoutMs: 5000,
    openUrl: () => {},
  };
}
