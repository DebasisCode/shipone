# shipone

Deploy a full-stack app to **your own** Vercel and Render accounts with one command. ShipOne creates the services, connects them to each other (API URL, CORS, env vars) and deploys the exact commit you pushed.

```bash
git push
shipone deploy
```

```
◇  Deploy plan
│  Frontend  ./client (vite) → Vercel project "todo"
│             backend URL goes in VITE_API_URL
│  Backend   ./server (express) → Render service "todo-api"
│             build: npm ci
│             start: npm start
│             frontend URL goes in CORS_ORIGIN and FRONTEND_URL
│  Commit    me/todo@main 1a5f9fe
│
◇  Deployed 1a5f9fe
│  Frontend  https://todo.vercel.app  ● live
│  Backend   https://todo-api.onrender.com  ● live
```

## Install

Requires Node 22.12+ and git.

```bash
npm install -g shipone
```

Or run directly without installing:

```bash
npx shipone
```

## One-time setup

```bash
shipone connect vercel   # opens vercel.com/account/tokens, paste a token
shipone connect render   # opens Render → Account Settings → API Keys, paste a key
```

Tokens are checked right away and stored in `~/.shipone/credentials.json`, which only you can read. `VERCEL_TOKEN` and `RENDER_API_KEY` env vars work too and take precedence.

Vercel and Render build from GitHub, so their GitHub apps need access to your repo. If they can't see it, ShipOne tells you which app to install.

## Commands

| Command | What it does |
| --- | --- |
| `shipone deploy` | First run: find the frontend/backend folders, create the Vercel project + Render service, wire the URLs, set env vars, deploy. Later runs: redeploy the latest pushed commit. |
| `shipone deploy --dry-run` | Show the plan and pre-flight warnings; changes nothing. |
| `shipone status` | Live URLs, deploy state, and whether GitHub has newer code. |
| `shipone logs [backend\|frontend] [-n 200]` | Backend runtime logs / frontend build logs. |
| `shipone env set KEY=value ...` | Set production env vars. `VITE_`/`NEXT_PUBLIC_`/`REACT_APP_` keys go to the frontend, others to the backend (override with `--frontend` / `--backend`). |
| `shipone env ls` | List env var names on each side. |
| `shipone config` / `config set <key> <value> [--repo]` | Account defaults (frontend → vercel, backend → render, `render.region`, `render.plan`). |
| `shipone connect` / `disconnect <provider>` | Manage provider tokens. |

Add `--yes` before any command to run without prompts (CI, scripts). It fails with a clear message when it needs an answer.

## What `shipone deploy` does

1. **Checks git.** Your branch must be on GitHub. If you have unpushed commits, it stops, or offers to deploy what's already on GitHub.
2. **Detects the stack.** It looks in `client/`, `frontend/`, `web/`, `server/`, `backend/`, `api/`, `apps/*`, `packages/*`, `services/*`, any folder listed in your pnpm/npm/yarn workspaces, and the repo root.
   - **Frontends:** Vite, Next.js, Create React App, Vue CLI, Angular, SvelteKit, Astro, Nuxt, Gatsby, Remix, React Router v7, SolidStart (npm, yarn or pnpm).
   - **Backends:** Node (Express, Fastify, Koa, Hapi, NestJS, Hono, AdonisJS, or a plain `node:http` server in `server/`/`backend/`/`api/`), Python (FastAPI, Flask, Django — pip, Poetry, uv or Pipenv), Go (Gin, Echo, Fiber, chi, `net/http`), Rust (Axum, Actix, Rocket), Ruby (Rails, Sinatra) — or anything with a `Dockerfile`.
   - **Monorepos:** pnpm/npm/yarn workspaces and Turborepo layouts. The backend's workspace dependencies are built before it (pnpm), the root lockfile is used, and the pnpm version is pinned from `packageManager` or the lockfile format.
   - Env-var names are matched per framework: `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `VUE_APP_`, `NG_APP_`, `PUBLIC_` (SvelteKit/Astro), `NUXT_PUBLIC_`, `GATSBY_`, `REMIX_PUBLIC_`.
3. **Pre-flight checks.** It flags hardcoded `http://localhost:5000` URLs (with file:line), a backend that ignores `process.env.PORT` or only listens on localhost, `nodemon` in `start`, and missing SPA rewrites for React Router.
4. **Asks only for real secrets.** It reads `.env.example`. Keys it can fill itself (API URL, CORS, `PORT`) are handled automatically. Values from your local `.env` are offered, unless they point at localhost. Non-secret defaults are used as-is. For the rest it prompts, or reads `SHIPONE_ENV_<KEY>` in `--yes` mode. Keys already set on the provider aren't asked for again. All of this happens **before** anything is created.
5. **Creates or reuses services.** It creates or reuses the Vercel project (linked to GitHub, deploy-on-push off) and the Render web service (auto-deploy off, free plan by default). The backend URL goes into `VITE_API_URL` (or whatever name your code already uses). The frontend URL goes into `CORS_ORIGIN` and `FRONTEND_URL`, plus any matching key in `.env.example` such as `CLIENT_URL`.
6. **Deploys the exact commit** on both sides and waits. If a build fails, it prints the last log lines.

Deploys only happen when you run `shipone deploy`. Pushing to GitHub never deploys.

## `.shipone.yml`

Written on the first deploy. Commit it.

```yaml
deploy: true              # false = never deploy this repo
name: todo                # optional base name for the services
frontend:
  path: client
  provider: vercel
  apiUrlEnv: VITE_API_URL # optional; detected from your code
backend:
  path: server
  provider: render
  buildCommand: npm ci    # optional overrides
  startCommand: npm start
  dockerfilePath: ./Dockerfile # when the backend builds from a Dockerfile
```

Providers are chosen in this order: `.shipone.yml`, then the per-repo override (`shipone config set backend render --repo`), then account defaults, then ShipOne asks you.

Service ids and URLs live in `~/.shipone/state.json`. If that file is lost (for example on a new laptop), ShipOne finds the existing services by name and repo instead of creating duplicates.

## Your backend should

- Listen on `process.env.PORT`: `app.listen(process.env.PORT || 5000)`
- Allow the frontend origin: `app.use(cors({ origin: process.env.CORS_ORIGIN }))`

And your frontend should call the API through the env var: `` fetch(`${import.meta.env.VITE_API_URL}/api/todos`) ``.

## Development

```bash
npm install
npm test          # unit tests + end-to-end CLI tests against a local fake of the Vercel/Render APIs
npm run typecheck
npm run dev -- deploy --dry-run   # run from source
npm run smoke     # slow: install, build and boot a real app per supported stack (see below)
```

`npm run smoke` writes a small real project for each popular stack (pnpm monorepo + TypeScript Fastify, Express, Hono, Yarn 4, FastAPI, Flask, Django, uv, Poetry, Pipenv, Go, Sinatra, ...), runs ShipOne's detection on it, then runs the detected build and start commands in a Render-like environment (no global pnpm, Python in a virtualenv, `$PORT` set) and checks the server answers HTTP. Add `--all` to include Rust, or pass words to filter: `npm run smoke -- fastapi go`. Stacks whose toolchain isn't installed are skipped.

See [docs/PLAN.md](docs/PLAN.md) for the design, v1 scope and roadmap.
