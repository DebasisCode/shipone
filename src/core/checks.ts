import fs from "node:fs";
import path from "node:path";
import { sourceFiles, type BackendApp, type FrontendApp } from "./detect.js";

/**
 * Pre-flight checks for the mistakes that make a deploy "succeed" but not
 * work: hardcoded localhost URLs, a backend that ignores $PORT, etc.
 */

export interface Finding {
  level: "error" | "warn";
  role: "frontend" | "backend";
  message: string;
  /** Repo-relative "path:line", when it points at code. */
  location?: string;
  fix?: string;
}

const LOCALHOST_URL = /\b(?:https?|wss?|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s'"`)]*/;
const CONFIG_FILE = /(?:^|[\\/])(?:vite|next|webpack|vitest|jest|tailwind|postcss|eslint|babel|angular|svelte|astro|nuxt)\.config\.[mc]?[jt]s$|(?:^|[\\/])setupProxy\.js$/;
const TEST_FILE = /\.(?:test|spec)\.[mc]?[jt]sx?$|[\\/]__tests__[\\/]|_test\.go$|_spec\.rb$|test_.*\.py$|.*_test\.py$/;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function isComment(line: string) {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("#") ||
    /^console\.(?:log|info|debug|warn)\s*\(/.test(t)
  );
}

function scan(root: string, appPath: string, re: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles(path.join(root, appPath))) {
    if (CONFIG_FILE.test(file) || TEST_FILE.test(file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!re.test(text)) continue;
    const lines = text.split("\n");
    lines.forEach((l, i) => {
      if (!isComment(l) && re.test(l)) hits.push({ file: path.relative(root, file).split(path.sep).join("/"), line: i + 1, text: l.trim() });
    });
  }
  return hits;
}

function anyMatch(root: string, appPath: string, re: RegExp): boolean {
  for (const file of sourceFiles(path.join(root, appPath))) {
    try {
      if (re.test(fs.readFileSync(file, "utf8"))) return true;
    } catch {
      /* unreadable file: ignore */
    }
  }
  return false;
}

const IMPORT_META_ENV: FrontendApp["framework"][] = ["vite", "sveltekit", "astro", "react-router", "solidstart"];
const envAccess = (framework: FrontendApp["framework"], name: string) =>
  IMPORT_META_ENV.includes(framework) ? `import.meta.env.${name}` : `process.env.${name}`;

export function checkFrontend(root: string, app: FrontendApp, hasBackend: boolean): Finding[] {
  const findings: Finding[] = [];
  for (const h of scan(root, app.path, LOCALHOST_URL).slice(0, 10)) {
    findings.push({
      level: "warn",
      role: "frontend",
      location: `${h.file}:${h.line}`,
      message: `Hardcoded local URL: ${h.text.slice(0, 120)}`,
      fix: `Use ${envAccess(app.framework, app.apiUrlEnv)} instead; ShipOne sets it to your backend URL.`,
    });
  }
  if (app.framework !== "nextjs" && usesClientRouter(root, app) && !hasSpaRewrite(root, app)) {
    findings.push({
      level: "warn",
      role: "frontend",
      message: "This app uses client-side routing, so refreshing a page like /about will 404 on Vercel.",
      fix: `Add ${app.path === "." ? "" : `${app.path}/`}vercel.json with {"rewrites": [{"source": "/(.*)", "destination": "/index.html"}]}`,
    });
  }
  if (hasBackend && !app.apiUrlEnvFromCode && !anyMatch(root, app.path, new RegExp(`\\b${app.apiUrlEnv}\\b`))) {
    findings.push({
      level: "warn",
      role: "frontend",
      message: `The frontend never reads ${app.apiUrlEnv}, so it won't know where the backend lives.`,
      fix: `Call the API with \`\${${envAccess(app.framework, app.apiUrlEnv)}}/your-route\`.`,
    });
  }
  return findings;
}

/** Per-runtime hints for reading $PORT. Empty for runtimes where we can't scan it. */
const PORT_HINT: Partial<Record<BackendApp["runtime"], { re: RegExp; fix: string }>> = {
  node: { re: /process\.env\.PORT\b|process\.env\[["']PORT["']\]|\{[^}]*\bPORT\b[^}]*\}\s*=\s*process\.env/, fix: "app.listen(process.env.PORT || 5000)" },
  python: { re: /\b(?:PORT|port)\b\s*(?:=|\)|,|\bin\b)|--port\b|getenv\(\s*["']PORT["']|environ(?:\.get)?\(\s*["']PORT["']|\bint\(os\.environ\["PORT"\]\)/, fix: "port = int(os.getenv(\"PORT\", 8000))" },
  go: { re: /os\.Getenv\(\s*["']PORT["']\)|LookupEnv\(\s*["']PORT["']|\bPORT\b/, fix: 'port := os.Getenv("PORT")' },
  rust: { re: /env::var\(\s*["']PORT["']\)|\bPORT\b/, fix: 'let port = env::var("PORT").unwrap_or_else(|_| "8080".into());' },
  ruby: { re: /\bENV\[["']PORT["']\]|\bPORT\b|--port\b/, fix: "Port = ENV.fetch(\"PORT\", 3000)" },
};

export function checkBackend(root: string, app: BackendApp): Finding[] {
  const findings: Finding[] = [];

  // Docker: the image defines its own build and start; nothing else to check.
  if (app.runtime === "docker") return findings;

  if (!app.startCommand) {
    findings.push({
      level: "error",
      role: "backend",
      message: "Couldn't work out how to start the backend.",
      fix: `Set backend.startCommand in ${app.path === "." ? "" : `${app.path}/"`.replace(/\/"$/, "/")}.shipone.yml, or add a start script.`,
    });
  } else if (app.runtime === "node" && /\bnodemon\b/.test(readStartScript(root, app))) {
    findings.push({
      level: "warn",
      role: "backend",
      message: 'The "start" script uses nodemon, which is meant for local development.',
      fix: 'Use "node server.js" for "start" and move nodemon to a "dev" script.',
    });
  }

  // Start commands like `gunicorn -b 0.0.0.0:$PORT` / `uvicorn --port $PORT` bind the port themselves.
  const startBindsPort = /\$PORT\b|puma -C /.test(app.startCommand ?? "");

  const portHint = PORT_HINT[app.runtime];
  if (portHint && !startBindsPort && !anyMatch(root, app.path, portHint.re)) {
    findings.push({
      level: "warn",
      role: "backend",
      message: `The backend doesn't read the PORT env var. Render tells your app which port to use via $PORT.`,
      fix: portHint.fix,
    });
  }

  const listenHost = LISTEN_HOST[app.runtime];
  if (listenHost && !startBindsPort) {
    for (const h of scan(root, app.path, listenHost.re).slice(0, 3)) {
      findings.push({
        level: "warn",
        role: "backend",
        location: `${h.file}:${h.line}`,
        message: "The server only listens on localhost, so it won't accept outside traffic.",
        fix: listenHost.fix,
      });
    }
  }

  for (const h of scan(root, app.path, LOCALHOST_URL).slice(0, 10)) {
    findings.push({
      level: "warn",
      role: "backend",
      location: `${h.file}:${h.line}`,
      message: `Hardcoded local URL: ${h.text.slice(0, 120)}`,
      fix: /cors|origin/i.test(h.text)
        ? "Read it from an env var (e.g. CORS_ORIGIN); ShipOne sets it to your frontend URL."
        : "Read it from an env var (and list it in .env.example) so production can use a real value.",
    });
  }
  return findings;
}

/** Per-language "bound to 127.0.0.1" patterns. */
const LISTEN_HOST: Partial<Record<BackendApp["runtime"], { re: RegExp; fix: string }>> = {
  node: { re: /\.listen\([^)]*["'](?:localhost|127\.0\.0\.1)["']/, fix: "Drop the host argument (or use 0.0.0.0)." },
  python: { re: /(?:uvicorn|app\.run|run\()\s*[^)\n]*["'](?:127\.0\.0\.1|localhost)["']/, fix: "Bind to 0.0.0.0 (host=\"0.0.0.0\")." },
  go: { re: /(?:ListenAndServe|Listen)\(\s*["'](?:127\.0\.0\.1|localhost)/, fix: "Listen on \":PORT\" instead of \"127.0.0.1:PORT\"." },
  ruby: { re: /(?:set\s+:bind|:Host)\s*(?:=>|,)\s*["'](?:127\.0\.0\.1|localhost)["']/, fix: 'set :bind, "0.0.0.0".' },
};

function readStartScript(root: string, app: BackendApp): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, app.path, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts?.start ?? "";
  } catch {
    return "";
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const ROUTERS = ["react-router-dom", "react-router", "@tanstack/react-router", "vue-router", "wouter"];

function usesClientRouter(root: string, app: FrontendApp): boolean {
  const pkg = readJson(path.join(root, app.path, "package.json")) as { dependencies?: Record<string, string> } | undefined;
  return ROUTERS.some((r) => pkg?.dependencies?.[r]);
}

function hasSpaRewrite(root: string, app: FrontendApp): boolean {
  const cfg = readJson(path.join(root, app.path, "vercel.json"));
  return Boolean(cfg && (Array.isArray(cfg.rewrites) || Array.isArray(cfg.routes)));
}
