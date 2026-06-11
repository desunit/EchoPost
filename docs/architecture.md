# Architecture

Single Node.js process. Fastify serves server-rendered HTML (Eta templates); a SQLite database in WAL mode is the only datastore; an in-process worker executes queued jobs scheduled by node-cron.

## Directory layout

```
src/
  app.ts                 Fastify wiring: services, templating, hooks, error handling
  server.ts              Entry point
  config/                Environment configuration
  db/                    Connection, migration runner, SQL migrations
  lib/                   slugify, markdown (marked + sanitize-html), crypto, cache, image-size
  modules/
    posts/               Content model, archive queries (all sort modes), slug redirects, FTS sync
    tags/                Tags, aliases, merge, counts
    media/               SSRF-safe remote mirroring, checksum dedupe, local storage
    x/                   API client, account (encrypted tokens), import pipeline, metrics sync
    metadata/            Heuristic title/excerpt/tag generation for imports
    related-posts/       Hybrid scoring (tags 0.45 / text 0.25 / type 0.1 / recency 0.1 / popularity 0.1)
    analytics/           Privacy-first views: daily aggregates, bot split, visitor hash
    newsletter/          Double opt-in, provider adapters (console/Resend/Postmark/webhook)
    rss/ seo/ stats/     Feeds, sitemap/robots/JSON-LD/redirects, public stats
    search/              FTS5 archive search + AMA retrieval
    ama/                 Optional LLM Q&A over the archive (off by default)
    jobs/                SQLite-backed queue + worker + cron schedules
    auth/                Sessions, scrypt password, CSRF, login rate limit, audit log
    settings/            JSON settings store (site settings, import rules)
  routes/                public.ts, admin.ts, health.ts
  views/                 Eta templates (public + admin)
  public/                styles.css, theme.js (light/dark toggle, localStorage)
  scripts/               migrate, seed, backup, create-admin
```

## Key flows

### X import (every 15 min)
`x_import` job → timeline since last known post ID → per-tweet rules
(replies/reposts skipped, quotes need substantial commentary, min length,
language/keyword filters) → thread continuations appended to their root
article → media mirrored locally (host allowlist, size cap, SHA-256 dedupe)
→ heuristic title/slug/tags/excerpt → status `review` (or auto-publish per
rules; sensitive posts always `draft`) → metrics snapshot stored.
Idempotent via the unique `x_post_id` column.

### Metrics sync (every 15 min, tiered)
Posts are due per age tier (<24h: 15 min … >180d: weekly). Batched lookups
of up to 100 IDs; every observation appended to `x_metric_snapshots`, never
overwritten — 30-day growth sorting subtracts the snapshot nearest to 30
days ago from the latest. Posts missing from the API response are flagged
`x_source_unavailable`, never deleted.

### Analytics
Every public page view records `SHA256(ip_prefix|user_agent|date|secret)`.
Raw IPs are never stored. Bot UAs are counted separately. Aggregates live
in `post_daily_views` / `site_daily_views` / `referrer_daily_stats`; the
short-lived `daily_visitor_log` feeds unique-visitor estimates and is
pruned after 3 days, keeping the database bounded.

### Related posts
Recalculated after publish and nightly. FTS5 bm25 provides text
similarity; tag overlap is Jaccard. Admin can pin (always first) or block
(never shown, survives recalculation). Max two suggestions from the same
week unless the archive is small.

### Jobs
`jobs` table claimed transactionally by the in-process worker (poll every
5 s). Failures retry with exponential backoff up to `max_attempts`, then
dead-letter (visible in Admin → Jobs with manual retry). X rate limits
(429) reschedule using the API reset header. Stale `running` jobs are
released on boot.

## Caching

In-memory TTL cache keyed by prefix (`home:*`, `post:*`, `rss:*`,
`sitemap`, `stats`, `tags`). Any content mutation calls
`invalidateContentCaches()`. SQLite remains the source of truth; a restart
loses nothing but warm caches.

## Security

- Admin: scrypt password hash, opaque session token (stored hashed),
  HttpOnly + SameSite=Strict cookie scoped to `/admin`, per-session CSRF
  token on every mutating form, login rate limit, audit log.
- Content: markdown rendered then sanitized (sanitize-html allowlist);
  CSP, nosniff, frame and referrer headers on every response.
- Media: HTTPS-only, host allowlist (twimg), DNS resolution checked
  against private ranges (SSRF), 30 MB cap, MIME allowlist, content-hash
  file names (no path traversal).
- X OAuth tokens encrypted at rest with AES-256-GCM under
  `APP_ENCRYPTION_KEY`.
