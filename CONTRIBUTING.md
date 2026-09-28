# Contributing to ShipOne

Thanks for helping! This guide gets you from clone to passing tests in a few minutes.

## Setup

```bash
git clone https://github.com/DebasisCode/shipone.git
cd shipone
npm install
```

You need **Node.js 22+** (`cat .nvmrc` for the exact version) and **git**.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the CLI from source (`tsx src/cli.ts`) |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Re-run tests on change |
| `npm run typecheck` | `tsc --noEmit` over the whole project |
| `npm run build` | Compile `src/` → `dist/` |
| `npm run smoke` | Manual end-to-end smoke run |

## How the code is organized

```
src/
  cli.ts          command definitions, menu, error handling
  commands/       one module per command (deploy, connect, config, project)
  core/           detection, env planning, git, checks, storage, UI helpers
  providers/      one module per hosting provider behind a common interface
```

Adding a **frontend or backend framework** = adding a detector in `src/core/detect.ts` (plus a test in `test/detect.test.ts`).
Adding a **hosting provider** = implement `FrontendHost`/`BackendHost` from `src/providers/types.ts` and register it in `src/providers/index.ts`.

## Testing your changes

- Run `npm test` before pushing — CI also runs typecheck, build, and a CLI smoke check on Linux **and** Windows.
- Tests use a fake in-memory cloud (`test/fakeCloud.ts`); no real provider calls happen in CI.
- For provider API changes, please include a case in `test/providers.test.ts`.

## Commit and PR style

- Small, focused PRs win. One feature or fix per PR.
- Write commit messages in the imperative: "add post-deploy URL check", not "added".
- If your change affects user-facing output, mention it in the PR description so the README can be updated in the same pass.

## Reporting bugs

Open an issue with:

1. Your OS and Node version (`node -v`)
2. The command you ran
3. The full terminal output (redact tokens!)
4. What you expected vs what happened

## A note on security

Please don't open public issues for vulnerabilities — see [SECURITY.md](./SECURITY.md).