import fs from "node:fs";
import path from "node:path";

/** Minimal dotenv parser: KEY=value, quotes, `export ` prefix, # comments. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out.set(m[1]!, value);
  }
  return out;
}

export function readEnvFile(file: string): Map<string, string> | undefined {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const EXAMPLE_NAMES = [".env.example", ".env.sample", ".env.template", "example.env"];
const LOCAL_NAMES = [".env", ".env.local", ".env.production"];

export function findEnvExample(appDir: string): string | undefined {
  return EXAMPLE_NAMES.map((n) => path.join(appDir, n)).find((f) => fs.existsSync(f));
}

/** The developer's real local values, used as suggestions (never stored by ShipOne). */
export function readLocalEnv(appDir: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const n of LOCAL_NAMES) {
    for (const [k, v] of readEnvFile(path.join(appDir, n)) ?? []) if (!merged.has(k)) merged.set(k, v);
  }
  return merged;
}

/** Keys ShipOne fills in itself on the backend (all get the frontend URL). */
export const BACKEND_FRONTEND_URL_KEY = /^(?:CORS_ORIGINS?|FRONTEND_(?:URL|ORIGIN)|CLIENT_(?:URL|ORIGIN)|ALLOWED_ORIGINS?|ORIGIN|WEB_URL|APP_URL)$/;
/** Keys on the frontend that should get the backend URL. */
export const FRONTEND_BACKEND_URL_KEY = /^(?:VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*(?:API|BACKEND|SERVER)[A-Z0-9_]*(?:URL|URI|ORIGIN|HOST|BASE)[A-Z0-9_]*$/;
/** Keys the platform provides; setting them yourself breaks things. */
export const PLATFORM_KEYS = new Set(["PORT", "RENDER", "VERCEL", "VERCEL_URL", "VERCEL_ENV"]);

const SECRET_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|PASS\b|PRIVATE|API_?KEY|ACCESS_?KEY|CREDENTIAL|DATABASE_URL|DB_URL|MONGO|POSTGRES|REDIS_URL|_URI$|DSN|WEBHOOK|SMTP|STRIPE|CLIENT_SECRET/i;
const PLACEHOLDER = /^$|^<.*>$|^\[.*\]$|^\{.*\}$|your[_-]|changeme|change[_-]me|replace|xxx|placeholder|example|^\.\.\.$|^todo$|^secret$|^password$|^\*+$/i;
const LOCAL_VALUE = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/;

export const looksSecret = (key: string) => SECRET_NAME.test(key);
export const isPlaceholder = (value: string) => PLACEHOLDER.test(value.trim());
export const isLocalOnly = (value: string) => LOCAL_VALUE.test(value);

export type EnvPlan =
  | { key: string; kind: "managed" } // ShipOne sets it (URLs) or the platform does (PORT)
  | { key: string; kind: "default"; value: string } // non-secret example value, used as-is
  | { key: string; kind: "provided"; value: string } // passed as SHIPONE_ENV_<KEY>
  | { key: string; kind: "local"; value: string; secret: boolean } // taken from the developer's .env
  | { key: string; kind: "ask"; secret: boolean; reason: string };

/**
 * Decide, per key in .env.example, where its production value comes from.
 * Only keys that are truly unknown end up as "ask".
 */
export function planEnv(
  role: "frontend" | "backend",
  example: Map<string, string>,
  local: Map<string, string>,
  processEnv: NodeJS.ProcessEnv = {},
): EnvPlan[] {
  const plans: EnvPlan[] = [];
  for (const [key, exampleValue] of example) {
    if (PLATFORM_KEYS.has(key)) {
      plans.push({ key, kind: "managed" });
      continue;
    }
    if (role === "backend" && BACKEND_FRONTEND_URL_KEY.test(key)) {
      plans.push({ key, kind: "managed" });
      continue;
    }
    if (role === "frontend" && FRONTEND_BACKEND_URL_KEY.test(key)) {
      plans.push({ key, kind: "managed" });
      continue;
    }
    const secret = looksSecret(key);
    const fromProcess = processEnv[`SHIPONE_ENV_${key}`];
    if (fromProcess) {
      plans.push({ key, kind: "provided", value: fromProcess });
      continue;
    }
    const localValue = local.get(key);
    if (localValue && !isPlaceholder(localValue) && !isLocalOnly(localValue)) {
      plans.push({ key, kind: "local", value: localValue, secret });
      continue;
    }
    if (!secret && !isPlaceholder(exampleValue) && !isLocalOnly(exampleValue)) {
      plans.push({ key, kind: "default", value: exampleValue });
      continue;
    }
    const reason = localValue && isLocalOnly(localValue) ? "your local value points at localhost" : secret ? "secret" : "no value in .env.example";
    plans.push({ key, kind: "ask", secret, reason });
  }
  return plans;
}
