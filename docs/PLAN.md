# ShipOne plan

The goal: `git push` then `shipone deploy` takes a local full-stack project to a live frontend and backend that are wired together, with no manual steps.

This version is a local-only personal tool. There's no server, no dashboard and no accounts. The SaaS ideas from the concept doc are listed under "Later" and are deliberately left out.

## Does the user's stack matter?

Only a little. ShipOne doesn't build anything itself. Vercel and Render build from GitHub. ShipOne only needs to know, for each framework:

| | Example |
| --- | --- |
| How to recognise it | `vite` in package.json, `express` in dependencies |
| Env var the frontend reads the API URL from | `VITE_API_URL` / `NEXT_PUBLIC_API_URL` / `REACT_APP_API_URL` (or whatever name the code already uses) |
| Backend build and start commands | `npm ci` / `npm start` |

Supporting a new framework means adding one detector in `src/core/detect.ts`. Supporting a new host means implementing one interface in `src/providers/types.ts`.

## v1 scope (this PR)

- Hosts: Vercel for frontends, Render for backends.
- Frontends: Vite, Next.js, Create React App, Angular, SvelteKit, Astro, Nuxt, Gatsby, Remix. Backends: Node (Express, Fastify, Koa, Hapi, NestJS, Hono), Python (FastAPI, Flask, Django), Go (Gin, Echo, Fiber, chi), Rust (Axum, Actix, Rocket), Ruby (Rails, Sinatra), or a Dockerfile. With npm, yarn, pnpm, pip, Poetry, uv, cargo or bundler.
- Layouts: `client/` + `server/`, the other common folder names, `apps/*`, `packages/*`, or a single app at the repo root. Frontend-only and backend-only repos also work.
- Commands: `connect`, `disconnect`, `config`, `deploy` (+ `--dry-run`, `--force`), `status`, `logs`, `env set`, `env ls`, and a global `--yes`.

### Changes from the concept doc, and why

| Concept doc | v1 | Why |
| --- | --- | --- |
| Vercel OAuth ("Connect Vercel" button) | Paste a Vercel token | OAuth needs a registered Vercel integration and a client secret, and a secret can't live safely inside a CLI. That means a server. A token is one paste and works today. |
| `shipone login` with GitHub device flow | Dropped for now | GitHub identity only matters for syncing preferences across machines, which is a SaaS feature. Local git already gives the repo and commit. |
| Tokens in the OS keychain (keytar) | `~/.shipone/credentials.json`, mode 0600, or env vars | keytar is archived and its native builds often break. A private file is what `gh` and `vercel` fall back to anyway. Can be revisited. |
| Service ids in `.shipone.yml` | `.shipone.yml` holds settings; ids live in `~/.shipone/state.json` | Keeps the committed file clean. Lost state is recovered by finding services by name and repo. |

## How the wiring avoids the chicken-and-egg problem

The frontend needs the backend URL at build time. The backend needs the frontend URL for CORS.

1. Create the Vercel project. Its production domain (`<name>.vercel.app`) is usually known immediately.
2. Create the Render service with `CORS_ORIGIN` / `FRONTEND_URL` already set. Its URL is known at creation, and Render starts its first build right away.
3. Set `VITE_API_URL` on Vercel to the Render URL, then deploy the frontend for the exact commit.
4. If the frontend's real URL turns out to differ (the domain wasn't assigned yet, or a custom domain was added), update CORS and redeploy the backend once.

In the usual case each side builds exactly once.

## Reliability decisions

- **Nothing is created until every input is known.** Lookups, secret prompts and branch confirmations all happen before the first create call, so a missing secret can't leave half-created services.
- **Idempotent.** Services are reused by saved id, then by name plus linked repo. A service deleted in the dashboard gets recreated. A name that belongs to a different repo gets a suffix (`app` → `app-<owner>`).
- **Render env vars are set one key at a time.** Render's bulk endpoint replaces all vars, which would wipe values set in the dashboard.
- **HTTP.** Retries on 429 (honouring `Retry-After`), on 5xx, and on network blips for idempotent calls. A POST is never retried after a server error. Every request has a 30s timeout. 401, 403 and "can't access repo" errors come with the exact fix.
- **Exact commit.** It deploys the commit that is on GitHub, not local HEAD, and refuses (or asks) when there are unpushed commits.
- **Push doesn't deploy.** Render `autoDeploy: no`. On Vercel, `gitProviderOptions.createDeployments: disabled`, with a printed `vercel.json` fallback if the API refuses.

## Testing

- `test/core.test.ts`: git parsing, `.shipone.yml` validation, preference order, storage permissions, stack detection, pre-flight checks, `.env` planning.
- `test/providers.test.ts`: the HTTP client (retries, errors) and both provider clients, checked against request shapes from the official specs (Render's public OpenAPI schema, `@vercel/sdk` models).
- `test/deploy.test.ts`: the whole deploy flow against an in-memory fake of both APIs. Covers first run, redeploys, lost state, deleted services, name clashes, late frontend URL, branch switches, build failures, missing secrets, dry runs and `deploy: false`.
- `test/cli.e2e.test.ts`: the real CLI as a subprocess over HTTP against the fake APIs.
- `test/detect.test.ts`: real-world repo shapes per stack (pnpm/turbo monorepos, Yarn 4, npm workspaces, FastAPI/Flask/Django layouts, Poetry/uv/Pipenv, Go `cmd/` layouts, Cargo workspaces, Rails/Sinatra) and the exact build/start commands they must produce.
- `npm run smoke` (`test/smoke/`): not part of `npm test`. Writes a small real project per stack, runs detection, then actually runs the detected build and start commands in a Render-like environment (no global pnpm, Python inside a virtualenv, `$PORT` set) and checks the server answers HTTP.

### Still to verify against real accounts

The fake APIs follow the official schemas, but these behaviours can only be confirmed live:

- [ ] `PATCH /v9/projects/:id { gitProviderOptions: { createDeployments: "disabled" } }` is accepted (otherwise ShipOne prints the `vercel.json` fallback)
- [ ] The Vercel production domain appears in `/v9/projects/:id/domains` right after the project is created
- [ ] A Render service created with `plan: "free"` via the API works on a free workspace
- [ ] A Render deploy with `commitId` builds that exact commit
- [ ] Monorepo root directories build correctly on both platforms

Smoke test: create a small Vite + Express repo, push it, then run `shipone connect vercel`, `shipone connect render` and `shipone deploy`. Open the frontend and check that it can call the API with no CORS errors. Push a change and run `shipone deploy` again: no new services should be created and both sides should show the new commit in `shipone status`.

## Later (not in v1)

1. More hosts: Railway and Fly.io for backends, Netlify for frontends. Each one implements `BackendHost` or `FrontendHost`.
2. Database provisioning (Neon or Supabase), with `DATABASE_URL` wired in automatically.
3. Rewriting hardcoded localhost URLs in code, not just flagging them.
4. Plain-language "why did my deploy fail" explanations from build logs.
6. Linked PR preview environments.
7. SaaS: GitHub login, synced preferences, a dashboard. The deploy logic stays the same; only storage moves.
