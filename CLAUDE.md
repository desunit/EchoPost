# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

EchoPost: a personal content archive that mirrors X (Twitter) posts to permanent SEO-friendly blog pages. Single Node.js process, server-rendered HTML, SQLite as the only datastore. Built to run on one VPS. The full spec lives in `docs/prd.md`; deviations from it are documented in `docs/prd-deviations.md`.

## Commands

```bash
npm run dev          # dev server with reload (tsx watch), http://localhost:3000
npm test             # vitest run (all tests)
npx vitest run tests/import.test.ts          # single test file
npx vitest run -t "combines thread"          # single test by name
npm run typecheck    # tsc --noEmit
npm run migrate      # apply SQL migrations
npm run seed         # demo content (no-op if posts exist)
npm run backup       # VACUUM INTO snapshot + verification
```

There is no build step: `tsx` runs TypeScript directly in dev, prod, and Docker. The project is ESM — relative imports must use the `.js` suffix (`import { x } from "./foo.js"`).

To boot locally the app needs `ADMIN_PASSWORD` set (or `npm run create-admin`); other secrets fall back to ephemeral random values in dev. Copy `.env.example` to `.env`.

## Architecture

### Service container pattern

`src/app.ts` constructs every service once and exposes them as `app.services` (Fastify decoration). Routes (`src/routes/public.ts`, `admin.ts`, `health.ts`) are plain functions receiving the app. Services live in `src/modules/<name>/service.ts`, each taking the `better-sqlite3` `DB` handle in its constructor. **No ORM** — raw SQL with prepared statements; the schema is in `src/db/migrations/*.sql` (plain SQL files run in filename order by `src/db/migrate.ts`; migrations auto-run on boot).

### Cross-cutting invariants

- **FTS index**: `post_search` (FTS5) is synced manually, not by triggers. Any code path that changes a post's title/body/tags/status must call `posts.syncSearchIndex(post)` — only published posts are indexed. Related-post scoring and `/search` both depend on it.
- **Cache invalidation**: an in-memory TTL cache (`src/lib/cache.ts`) fronts the homepage, post pages, RSS, sitemap, stats. Content mutations must call `invalidateContentCaches()` (PostsService/TagsService already do).
- **Metric snapshots are append-only**: `x_metric_snapshots` is never updated in place. All "30-day growth" sorts work by subtracting the snapshot nearest 30 days ago from the latest — don't "fix" this into a single-row upsert.
- **Slug changes on published posts create 301 redirects** (`redirects` table, checked in an `onRequest` hook). `PostsService.update` handles this; preserve it when touching slug logic.
- **Manual edits survive sync**: `preserve_manual_title` / `preserve_manual_body` flags on posts gate what the X importer may overwrite. The admin post-update route sets them automatically when an imported post is edited.
- **Privacy**: analytics never stores raw IPs — only `SHA256(ip_prefix|ua|date|secret)`. `daily_visitor_log` is the one per-visitor table and is pruned after 3 days; everything else is daily aggregates.

### X import pipeline (`src/modules/x/`)

`XImportService.runImport()` is the heart: fetch timeline since `last_imported_x_post_id` → apply `ImportRules` (from the `settings` table; defaults in `settings/service.ts`, **default minimum is 100 chars after URL stripping** — test fixtures must clear it) → thread continuations append to their root post (matched by `x_conversation_id`) instead of creating new posts → media mirrored through `MediaService` (HTTPS-only, twimg host allowlist, SSRF DNS check, SHA-256 dedupe) → heuristic metadata from `modules/metadata/generate.ts` → status `review` (or auto-publish per rules; `possibly_sensitive` always lands as `draft`). Idempotency comes from the unique `x_post_id` column.

### WordPress import (`src/modules/wordpress/`)

One-shot CLI (`npm run import-wordpress`, optional URL arg) that mirrors a WordPress site into native `type: "blog"` posts. `WordPressImportService.runImport()` pages through the public WP REST API oldest-first for each configured content type (`config.wordpress.contentTypes`, default both `posts` and `pages`), preserves each WP slug verbatim, converts `content.rendered` HTML → markdown (`turndown`, via `htmlToMarkdown` in `lib/markdown.ts`), and imports embedded categories/tags. Status mapping: a published WP post → `published`; a published WP page → `hidden` (live at its URL but excluded from homepage/archive/RSS/sitemap/search, so pages stay out of the feed); not-published WP content → `draft`. Featured + inline images are mirrored through `MediaService` and the body is rewritten to local `/media/...` URLs (the CSP blocks off-site `<img>`). Idempotency is the unique `wp_post_id` column (migration `003`), mirroring `x_post_id`. The WP host must be in the media allowlist — `config` auto-adds it from `WORDPRESS_URL` (plus `MEDIA_EXTRA_ALLOWED_HOSTS` for CDNs). Full notes in `docs/wordpress-import.md`.

### Jobs (`src/modules/jobs/`)

SQLite-backed queue (`jobs` table) drained by an in-process worker polling every 5s; node-cron entries only *enqueue* (with `dedupe: true`). Handlers are registered in `worker.ts`. Failures retry with exponential backoff to `max_attempts`, then go `dead` (visible in Admin → Jobs). `XRateLimitError` carries the API reset time and reschedules instead of backing off. Because the worker runs inside the web process, only one instance may run.

### Auth and admin

Single-author: scrypt password hash stored in `settings`, opaque session tokens stored hashed in `sessions`, cookie scoped to `/admin` with SameSite=Strict. A `preHandler` hook in `routes/admin.ts` guards all `/admin` URLs and enforces a per-session CSRF token (`_csrf` hidden field) on every non-GET. New admin forms must include `<input type="hidden" name="_csrf" value="<%= it.csrf %>">`.

### Templates

Eta templates in `src/views/`, rendered via `app.view(reply, "template", data)` which injects `site` (settings), `formatDate`, `formatNumber`. Layout via `<% layout("layout") %>`; partials via `<%~ include("partials/x", { ...it, extra }) %>` — spread `it` so helpers propagate. Autoescape is on; `<%~ %>` outputs raw HTML (only for already-sanitized content like `post.html_body`).

## Testing

Tests use real in-memory SQLite via `tests/helpers.ts` (`testDb()` runs all migrations) — no mocking of the database. The X client is faked at the class boundary (see `tests/import.test.ts`). `NewsletterService` accepts an injected `EmailProvider` for capturing sent mail; the confirmation token is extracted from the email text.
