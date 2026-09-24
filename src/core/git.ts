import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ShipOneError } from "./errors.js";

const exec = promisify(execFile);

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export interface GitInfo extends GitHubRepo {
  root: string;
  branch: string;
  /** Local HEAD. */
  headSha: string;
  /** e.g. "origin/main"; undefined when the branch was never pushed. */
  upstream?: string;
  /** Branch name on GitHub, e.g. "main" for upstream "origin/main". */
  remoteBranch?: string;
  /** Commit on GitHub that corresponds to what we'd deploy (the upstream tip). */
  upstreamSha?: string;
  /** Local commits not on the upstream yet. */
  ahead: number;
  /** Uncommitted changes in the working tree. */
  dirty: boolean;
}

/**
 * Accepts the remote URL formats git produces for GitHub:
 *   https://github.com/owner/repo(.git)
 *   git@github.com:owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 */
export function parseGitHubRemote(url: string): GitHubRepo | undefined {
  const m = url
    .trim()
    .match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return undefined;
  return { owner: m[1]!, repo: m[2]! };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

export async function readGitInfo(cwd: string): Promise<GitInfo> {
  const root = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    throw new ShipOneError("This folder is not a git repository.", "Run ShipOne from inside your project's git repo.");
  }

  const remote = await tryGit(root, ["remote", "get-url", "origin"]);
  if (!remote) {
    throw new ShipOneError(
      "This repo has no `origin` remote.",
      "Create a GitHub repo and push to it first, e.g. `gh repo create --source . --push`.",
    );
  }
  const gh = parseGitHubRemote(remote);
  if (!gh) {
    throw new ShipOneError(`The origin remote (${remote}) is not a GitHub repository.`, "ShipOne v1 deploys from GitHub only.");
  }

  const headSha = await tryGit(root, ["rev-parse", "HEAD"]);
  if (!headSha) throw new ShipOneError("This repo has no commits yet.", "Commit and push your code first.");

  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])) || "HEAD";
  if (branch === "HEAD") {
    throw new ShipOneError("You're in a detached HEAD state.", "Check out the branch you want to deploy, e.g. `git switch main`.");
  }

  const upstream = await tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  let upstreamSha: string | undefined;
  let ahead = 0;
  if (upstream) {
    upstreamSha = await tryGit(root, ["rev-parse", "@{u}"]);
    ahead = Number((await tryGit(root, ["rev-list", "--count", "@{u}..HEAD"])) ?? 0);
  }
  const dirty = ((await tryGit(root, ["status", "--porcelain"])) ?? "").length > 0;

  const remoteBranch = upstream?.replace(/^[^/]+\//, "");

  return { ...gh, root, branch, headSha, upstream, remoteBranch, upstreamSha, ahead, dirty };
}

export const repoSlug = (r: GitHubRepo) => `${r.owner}/${r.repo}`;
export const repoUrl = (r: GitHubRepo) => `https://github.com/${r.owner}/${r.repo}`;
