# Security Policy

## Supported versions

Only the latest release on npm is supported with security fixes.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Use GitHub's private vulnerability reporting instead:
**https://github.com/DebasisCode/shipone/security/advisories/new**

Include what you found, how to reproduce it, and (if possible) a suggested fix. You'll get a response within a few days, and a fix or mitigation timeline once the report is confirmed.

## What matters most in ShipOne

- **Token storage** — provider tokens live in `~/.shipone/credentials.json` (written with mode `0600`). Anything that weakens those file permissions or leaks tokens to logs is critical.
- **Command injection** — ShipOne never runs arbitrary shell commands from provider API responses. If you find a path where remote data reaches `exec`/`spawn` with a shell, that's critical.
- **Env var handling** — values collected from the user or `.env` files must not end up in error messages, logs, or the repo.

## Safe harbor

We consider good-faith research and responsible disclosure of ShipOne's own code to be authorized work. Testing against third-party providers (Vercel, Netlify, Render, Railway) is governed by *their* policies, not ours — get their permission first.