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
const CONFIG_FILE = /(?:^|[\\/])(?:vite|next|webpack|vitest|jest|tailwind|postcss|eslint|babel)\.config\.[mc]?[jt]s$|(?:^|[\\/])setupProxy\.js$/;
const TEST_FILE = /\.(?:test|spec)\.[mc]?[jt]sx?$|[\\/]__tests__[\\/]/;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function isComment(line: string) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#");
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

const envAccess = (framework: FrontendApp["framework"], name: string) =>
  framework === "vite" ? `import.meta.env.${name}` : `process.env.${name}`;

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

export function checkBackend(root: string, app: BackendApp): Finding[] {
  const findings: Finding[] = [];
  if (!app.startCommand) {
    findings.push({
      level: "error",
      role: "backend",
      message: "Couldn't work out how to start the backend.",
      fix: `Add a "start" script to ${app.path}/package.json (e.g. "node server.js"), or set backend.startCommand in .shipone.yml.`,
    });
  } else if (/\bnodemon\b/.test(readStartScript(root, app))) {
    findings.push({
      level: "warn",
      role: "backend",
      message: 'The "start" script uses nodemon, which is meant for local development.',
      fix: 'Use "node server.js" for "start" and move nodemon to a "dev" script.',
    });
  }

  if (!anyMatch(root, app.path, /process\.env\.PORT\b|process\.env\[["']PORT["']\]|\{[^}]*\bPORT\b[^}]*\}\s*=\s*process\.env/)) {
    findings.push({
      level: "warn",
      role: "backend",
      message: "The backend doesn't read process.env.PORT. Render tells your app which port to use via $PORT.",
      fix: "app.listen(process.env.PORT || 5000)",
    });
  }

  for (const h of scan(root, app.path, /\.listen\([^)]*["'](?:localhost|127\.0\.0\.1)["']/).slice(0, 3)) {
    findings.push({
      level: "warn",
      role: "backend",
      location: `${h.file}:${h.line}`,
      message: "The server only listens on localhost, so it won't accept outside traffic.",
      fix: "Drop the host argument (or use 0.0.0.0).",
    });
  }

  for (const h of scan(root, app.path, LOCALHOST_URL).slice(0, 10)) {
    findings.push({
      level: "warn",
      role: "backend",
      location: `${h.file}:${h.line}`,
      message: `Hardcoded local URL: ${h.text.slice(0, 120)}`,
      fix: /cors|origin/i.test(h.text)
        ? "Use process.env.CORS_ORIGIN; ShipOne sets it to your frontend URL."
        : "Read it from an env var (and list it in .env.example) so production can use a real value.",
    });
  }
  return findings;
}

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
