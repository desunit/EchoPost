# EchoPost

Personal content archive and X-to-blog mirror. Imports selected posts from an X account and publishes them as permanent, SEO-friendly blog pages alongside manually written content.

> X is the writing and distribution layer. The website is the permanent archive, SEO layer, and audience-capture layer.

**Stack:** Node.js 22+, TypeScript, Fastify, SQLite (WAL + FTS5), Eta templates, server-rendered HTML. Runs on one VPS.

**Live demo:** EchoPost runs in production on the author's own site — see it in action at **[desunit.com/blog](https://desunit.com/blog/)**.

## Why this exists

The pattern is borrowed from [levels.io](https://levels.io): mirror what you publish on X to a permanent, self-owned website. EchoPost packages that idea into a tool anyone can run.

X is where you write and reach people — and with X Articles you can write long-form there too. The problem isn't the writing; it's that everything you publish on X stays locked inside a platform you don't control:

- **Search engines can't reach it.** X gates posts behind login walls and limits crawlers, so your writing rarely shows up in Google and is invisible to anyone not already on the platform. A post gets its attention in the first 24 hours, then effectively disappears.
- **The platform owns the rules.** Algorithms change, reach is throttled, accounts get restricted, links rot — your audience and your archive exist at someone else's discretion.

EchoPost mirrors that content to a site you **fully control**: a permanent, SEO-friendly HTML page for every post, under your own domain and database.

```
idea → X post → automatic archive → searchable page → newsletter subscriber → future customer
```

That turns a 24-hour post into a lasting asset. The website becomes:

- **Discoverable** — indexed by Google, navigable through tags, related posts, full-text search, RSS, and a sitemap, and served as plain HTML that AI tools can read, quote, and cite (a timeline is none of these).
- **An owned audience** — every post carries a newsletter form, converting algorithm-dependent followers into email subscribers you can reach directly.
- **Compounding** — related-post links form topic clusters, so each new post strengthens the whole archive and even short posts become long-tail landing pages.
- **Yours** — the durable URL belongs to you, and every page links back to the original X post, so you keep the engagement without trusting the platform to keep your work alive.

(EchoPost can also import an existing WordPress blog — see [`docs/wordpress-import.md`](docs/wordpress-import.md) — so prior writing lives under the same owned roof.)

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
3. Click **Sync now** (also runs automatically once a day).
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

## Author

Built by **Sergey Bogdanov** ([@desunit](https://x.com/desunit)) — software engineer and founder of [Songtive](https://songtive.com), where he builds apps and SaaS products.

EchoPost powers his personal archive, live at **[desunit.com/blog](https://desunit.com/blog/)**, where every page is an X post or article mirrored by this project. More about him on the [About page](https://desunit.com/blog/about).

- X: [@desunit](https://x.com/desunit)
- GitHub: [@desunit](https://github.com/desunit)
- Blog: [desunit.com/blog](https://desunit.com/blog/)
