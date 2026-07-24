# Cloudflare CDN

`desunit.com` sits behind Cloudflare. This documents the Cache Rules deployed for
the EchoPost app at `/blog/*`, why each one is shaped the way it is, and how to
verify they are actually in effect.

The rules were validated live on 2026-07-24; every claim below was measured
against production rather than inferred from the dashboard.

## The one constraint that shapes everything: HTML is not cached

EchoPost records pageviews **server-side**, in the request handler
(`analytics.recordView`, `src/routes/public.ts:28`). Edge-caching HTML would mean
most requests never reach the origin, which silently zeroes out view counts,
"popular posts", and `/blog/stats`.

So HTML is deliberately left uncached (`cf-cache-status: DYNAMIC` on `/blog/` and
post pages). The in-memory TTL cache (`src/lib/cache.ts`) already fronts the
homepage and post pages, so origin work per request is a template render, not SQL.

Caching HTML at the edge is only viable after moving view recording to a
client-side beacon. That trade is not currently made: beacon counts run lower than
server-side ones because of ad blockers, and the origin is not under load.

## Deployed Cache Rules

Order matters — later matching rules override earlier ones for overlapping
settings, so the expressions are kept mutually exclusive.

| # | Name | Expression | Action |
| - | ---- | ---------- | ------ |
| 1 | Bypass — admin, health, one-shot links | `starts_with(http.request.uri.path, "/blog/admin") or starts_with(http.request.uri.path, "/health") or http.request.uri.path in {"/blog/subscribe/confirm" "/blog/unsubscribe"}` | Bypass cache |
| 2 | Media — immutable | `starts_with(http.request.uri.path, "/blog/media/")` | Eligible for cache · Edge TTL override · Browser TTL 1 year |
| 3 | Assets — long at edge, short in browsers | `starts_with(http.request.uri.path, "/blog/assets/")` | Eligible for cache · Edge TTL override 1 month · Browser TTL 2 hours |
| 4 | Feeds and sitemap — short | `http.request.uri.path in {"/blog/rss" "/blog/rss/x" "/blog/rss/blog" "/blog/sitemap.xml" "/blog/robots.txt"} or (starts_with(http.request.uri.path, "/blog/tag/") and ends_with(http.request.uri.path, "/rss"))` | Eligible for cache · Edge TTL override 1 hour · Browser TTL 2 hours |
| 5 | Search — bypass | `starts_with(http.request.uri.path, "/blog/search")` | Bypass cache |

Notes per rule:

- **1 — bypass.** The admin session cookie is scoped to `/admin` so HTML caching
  would not leak sessions anyway, but the CSRF-bearing forms and the
  confirm/unsubscribe tokens must never be served from cache.
- **2 — media.** Filenames are content-addressed SHA-256
  (`ab/<sha256>.png`, `src/modules/media/service.ts:177`), so a changed file is a
  changed URL. A 1-year browser TTL is safe here; there is no invalidation problem.
- **3 — assets.** `styles.css` and `theme.js` are **not** fingerprinted
  (`src/views/layout.eta:22-23`). Long edge TTL is fine because the edge can be
  purged; the browser TTL is deliberately short because browsers cannot. At 2 hours,
  a deploy that changes CSS leaves repeat visitors on stale CSS for up to 2 hours.
  Adding a `?v=<build hash>` to the asset URLs would remove that constraint and
  allow a 1-year browser TTL.
- **5 — search.** Unbounded query cardinality; caching it would fill the edge with
  single-hit entries.

### Regex is not available

The `matches` operator requires a Business or WAF Advanced plan. Rule 4's tag-feed
branch therefore uses `starts_with` + `ends_with` instead of
`^/blog/tag/[^/]+/rss$`. Coverage is identical — the route is `/tag/:slug/rss` and
slugs cannot contain a slash. The `wildcard` operator
(`http.request.uri.path wildcard "/blog/tag/*/rss"`) is an equally available
one-line alternative.

## Two gotchas that cost real debugging time

### Cache eligibility and Edge TTL are both required

Cloudflare's default cacheable-extension list covers `.css`, `.js`, `.png` and
similar, but **not `.xml`, `.txt`, or extensionless paths**. The feed and sitemap
routes are therefore not cacheable by default.

Worse, EchoPost sends **no `Cache-Control` header at all** on `/blog/rss`,
`/blog/sitemap.xml` and `/blog/robots.txt` (`src/routes/public.ts:143-155`). With
no origin header, the Edge TTL setting decides everything:

| Edge TTL option | Result when origin sends no `Cache-Control` |
| --------------- | ------------------------------------------- |
| Use cache-control if present, **bypass** if not | Never cached → `DYNAMIC` |
| Use cache-control if present, Cloudflare default TTL if not | Cached |
| **Ignore cache-control header and use this TTL** | Always cached ← what rules 2-4 use |

Rule 4 sat on `DYNAMIC` until its Edge TTL was switched to "Ignore cache-control
header and use this TTL". Setting *Cache eligibility → Eligible for cache* alone is
not enough.

The same asymmetry explains asset behaviour: `@fastify/static` is registered for
`/blog/assets/` **without** `maxAge` (`src/app.ts:122-126`), so the origin sends
`max-age=0`. On "respect origin", edge entries go stale on arrival and every
request becomes a `REVALIDATED` 304 round-trip to the VPS — bandwidth is saved but
request load is not. Media is registered *with* `maxAge: "30d"` (`src/app.ts:132`),
which is why it cached correctly even before the rules existed.

### Verify against the zone actually serving traffic

A full debugging cycle was spent on rules that were correctly configured and marked
Active but had been created on a **different zone**. The dashboard looks identical
either way.

The tell was the browser TTL: responses carried `max-age=14400` (4 hours), which is
neither the origin's value nor the rule's value — it is Cloudflare's **zone-level
default Browser Cache TTL**. That default only raises a *lower* origin TTL, which is
why media (`max-age=2592000`, 30 days) passed through untouched while assets
(`max-age=0`) were bumped to 4 hours.

**Rule of thumb: if `cache-control` on the response does not equal the number your
rule specifies, the rule is not being applied — regardless of what the dashboard
shows.** Other causes to check, in order: the rule is saved but not enabled; a
legacy Page Rule is shadowing it (Page Rules take precedence over Cache Rules); the
rules are on the wrong zone.

## Verifying

`cf-cache-status` on the second request is the signal. `MISS` → `HIT` is success;
`MISS` → `REVALIDATED` means the edge TTL is not being applied; `DYNAMIC` means the
response was never eligible for cache.

Append a random query string to force a cold cache key — the path still matches the
rules, since the query string is not part of `http.request.uri.path`:

```bash
B="cb$RANDOM$$"
check() { printf '\n== %s\n' "$1"; for i in 1 2; do
  curl -sSI "$1" | grep -iE 'cf-cache-status|cache-control|^age:'; echo ---; done; }

check "https://desunit.com/blog/assets/theme.js?$B"   # expect max-age=7200,  MISS -> HIT
check "https://desunit.com/blog/rss"                  # expect max-age=7200,  MISS -> HIT
check "https://desunit.com/blog/tag/ai/rss"           # rule 4's second branch
check "https://desunit.com/blog/"                     # expect DYNAMIC (by design)
```

To see what is actually deployed on a zone, rather than what the dashboard shows:

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq '.result.rules[] | {expression, enabled, action_parameters}'
```

Note that a bypass rule reports `DYNAMIC` rather than `BYPASS` on responses that
were never cacheable to begin with, so rules 1 and 5 cannot be confirmed from
response headers alone. The dashboard's per-rule match counter is the way to check
them.

## Other Cloudflare settings

Worth having on: **Tiered Cache**, **Brotli**, **HTTP/3**, **0-RTT**,
**Always Online**, **Early Hints** (helps, since `styles.css` is a render-blocking
`<link>` in the layout head), and **Crawler Hints** (complements the IndexNow ping —
see `docs/indexnow.md`).

Leave **Rocket Loader** off: it defers `theme.js`, which causes a theme flash on
load. **Auto Minify** is retired by Cloudflare and irrelevant here.

Query-string cache-key customisation is a paid-plan feature and is not needed while
HTML stays uncached. It would matter only if HTML caching were adopted, where
`?page=` and `?q=` must stay in the cache key while `utm_*` / `gclid` should be
stripped.

## Known gap: no purge on publish

Feeds and the sitemap carry a 1-hour edge TTL and a 2-hour browser TTL, so a newly
published post can take up to an hour to appear in `/blog/rss` and
`/blog/sitemap.xml`, plus up to 2 more hours for clients that already fetched them.

`invalidateContentCaches()` clears the in-process cache immediately, but Cloudflare
has no way to know a post went live. This works against the IndexNow ping
(`src/modules/seo/indexnow.ts`, wired in `src/modules/jobs/worker.ts`), which tells
search engines to crawl now while the edge may still be serving a sitemap that does
not list the new URL.

The fix — not yet implemented — is a Cloudflare purge-by-URL call on the same
publish hook that fires IndexNow, purging the feed and sitemap URLs. It needs
`CLOUDFLARE_ZONE_ID` and a scoped `CLOUDFLARE_API_TOKEN`.

A related subtlety for whoever implements it: on revalidation Cloudflare returns the
**stored** response headers alongside a `304`. A deploy that changes response headers
but not asset bytes will not propagate on its own — an asset was observed serving a
pre-GA4 CSP header for exactly this reason. Deploys that change headers need a purge
too.
