# IndexNow integration

EchoPost notifies IndexNow-participating search engines (Bing, Yandex, Seznam,
Naver, …) the moment content goes live, instead of waiting for a sitemap
re-crawl. One POST to `api.indexnow.org` fans out to all participating engines.
Google does not use IndexNow — it still discovers via sitemap/crawl.

## How it works

- **Ownership key** — served at `${publicUrl}/<key>.txt` (registered as a real
  route, so it works under `BASE_PATH` sub-path deployments too). The key is
  auto-generated on first boot and persisted in the `settings` table
  (`indexnow_key`), so it survives restarts. Set `INDEXNOW_KEY` to pin your own
  (8–128 chars of `a-z A-Z 0-9 -`).
- **Pings** — `IndexNowService.submit(paths)` (`src/modules/seo/indexnow.ts`)
  enqueues an `indexnow_ping` job; the job worker POSTs
  `{host, key, keyLocation, urlList}` to `INDEXNOW_ENDPOINT` (default
  `https://api.indexnow.org/indexnow`). Failures retry with the queue's
  exponential backoff and land in Admin → Jobs when dead.

## When pings fire

| Event | Where |
|---|---|
| Admin creates a post as published | `POST /admin/posts` |
| Admin edits a published post (slug change also pings the old, now-301 URL) | `POST /admin/posts/:id` |
| Admin publish action / review-queue approve | `POST /admin/posts/:id/publish`, `/admin/imports/:id/approve` |
| X import auto-publishes a post, or extends a published thread | `x_import` / `x_backfill` jobs (collected in `ImportSummary.publishedPaths`) |

The WordPress importer intentionally does not ping — it's a one-shot historical
migration; the sitemap covers it.

## Bulk submission

`npm run indexnow-submit-all` pings every sitemap URL (homepage, /tags, /stats,
all published posts, tag pages) in one batch — run it once after enabling
IndexNow or after a bulk import. It pings directly (no job queue) and ignores
`INDEXNOW_ENABLED` (running it is explicit intent), but refuses a localhost
`SITE_URL`. Run it on the server so it uses the production DB and env.

## Configuration

```bash
INDEXNOW_ENABLED=   # default: on in production, off elsewhere; true/false to override
INDEXNOW_KEY=       # optional: pin the key; otherwise auto-generated + persisted
INDEXNOW_ENDPOINT=  # default https://api.indexnow.org/indexnow (override in tests)
```

In development pings are disabled by default (localhost URLs are useless to
engines); `submit()` is then a no-op, so call sites don't need guards.

## Verifying

```bash
curl https://your-site/<key>.txt          # should echo the key
sqlite3 data/echopost.db "SELECT value_json FROM settings WHERE key='indexnow_key'"
sqlite3 data/echopost.db "SELECT type,status,last_error FROM jobs WHERE type='indexnow_ping' ORDER BY created_at DESC LIMIT 5"
```

Bing Webmaster Tools → IndexNow shows received submissions within a day.
