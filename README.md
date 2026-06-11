# EchoPost

Personal content archive and X-to-blog mirror. Imports selected posts from an X account and publishes them as permanent, SEO-friendly blog pages alongside manually written content.

> X is the writing and distribution layer. The website is the permanent archive, SEO layer, and audience-capture layer.

**Stack:** Node.js 22+, TypeScript, Fastify, SQLite (WAL + FTS5), Eta templates, server-rendered HTML. Runs on one VPS.

## Quick start

```bash
npm install
cp .env.example .env        # fill in at least APP_ENCRYPTION_KEY, SESSION_SECRET, ADMIN_PASSWORD
npm run migrate
npm run seed                # optional: demo content
npm run dev                 # http://localhost:3000
```

Log in at `/admin/login` with `ADMIN_PASSWORD` (or run `npm run create-admin`).

## Connecting X

1. Set `X_BEARER_TOKEN` (and optionally `X_USERNAME`) in `.env`.
2. Open **Admin → Review queue**, enter the X username, click **Connect**.
3. Click **Sync now** (also runs automatically every 15 minutes).
4. Imported posts land in the review queue; publish, edit, or ignore each one.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server with reload |
| `npm start` | Production server |
| `npm run migrate` | Apply database migrations |
| `npm run seed` | Seed demo content (no-op if posts exist) |
| `npm run backup` | Snapshot the database and verify it |
| `npm run create-admin` | Set the admin password interactively |
| `npm test` | Run the test suite |
| `npm run typecheck` | TypeScript check |

## Documentation

- [docs/prd.md](docs/prd.md) — the full product requirements document
- [docs/architecture.md](docs/architecture.md) — modules, data flow, design decisions
- [docs/deployment.md](docs/deployment.md) — VPS setup, Docker, reverse proxy
- [docs/backup-restore.md](docs/backup-restore.md) — backup schedule and restore procedure
- [docs/prd-deviations.md](docs/prd-deviations.md) — where the implementation deviates from the PRD and why
