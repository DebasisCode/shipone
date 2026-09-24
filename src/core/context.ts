import type { FetchLike } from "../providers/http.js";
import { Store } from "./store.js";
import { TerminalUI, type UI } from "./ui.js";

/** Everything a command needs from the outside world, injectable for tests. */
export interface Context {
  ui: UI;
  store: Store;
  cwd: string;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  /** How often to poll deploy status. */
  pollIntervalMs: number;
  /** Give up waiting on a single deploy after this long. */
  deployTimeoutMs: number;
  openUrl?: (url: string) => void;
}

export function createContext(opts: { yes?: boolean } = {}): Context {
  const env = process.env;
  return {
    ui: new TerminalUI({ yes: opts.yes }),
    store: new Store(env),
    cwd: process.cwd(),
    env,
    pollIntervalMs: Number(env.SHIPONE_POLL_INTERVAL_MS) || 3000,
    deployTimeoutMs: Number(env.SHIPONE_DEPLOY_TIMEOUT_MS) || 20 * 60 * 1000,
  };
}
