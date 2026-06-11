# WordPress import

Imports an existing WordPress site into EchoPost as native `type: "blog"` posts —
both WordPress **posts and pages**, with slugs preserved, body HTML converted to
markdown, and inline + featured images mirrored locally. Everything is pulled via
the public WordPress REST API (no HTML scraping). Built as a sibling of the X
importer; reuses `PostsService`, `TagsService`, and `MediaService`.

## Usage

One-shot CLI, idempotent (safe to re-run — only new posts are imported):

```bash
# Uses WORDPRESS_URL from .env
npm run import-wordpress

# Or pass the site URL explicitly
npm run import-wordpress -- https://blog.example.com
```

## Configuration (`.env`)

| Var | Purpose |
| --- | --- |
| `WORDPRESS_URL` | Base URL of the WordPress site, e.g. `https://blog.example.com`. Its host is auto-added to the media allowlist so images can be mirrored. |
| `WORDPRESS_PER_PAGE` | Items fetched per WP REST API page (max 100, default 100). |
| `WORDPRESS_CONTENT_TYPES` | Which content types to import: `posts`, `pages`, or both (default `posts,pages`). |
| `MEDIA_EXTRA_ALLOWED_HOSTS` | Comma-separated extra hosts allowed for media mirroring — set this if images are served from a CDN host different from `WORDPRESS_URL`. |

## How it works

1. **Fetch** — reads the public WP REST API (`/wp-json/wp/v2/{posts,pages}?_embed`)
   page by page, oldest-first, following the `X-WP-TotalPages` header, for each
   configured content type. No auth, so only published/visible content is
   returned (exactly the archive to mirror). A disabled content type (404) is
   skipped silently.
2. **Map** — per post:
   - `title` ← `title.rendered` (tags stripped, HTML entities decoded)
   - `slug` ← WordPress `slug`, **preserved verbatim**
   - `type` = `blog`
   - `status` — a published WordPress **post** → `published`; a published
     WordPress **page** → `hidden` (reachable at its own URL but kept out of the
     homepage, archive, RSS, sitemap, tag pages and search — so About/Contact
     pages don't pollute the blog feed). Anything not published in WordPress
     (draft/pending/private/future) → `draft`.
   - `published_at` ← `date_gmt` (the `Z` suffix WP omits is appended)
   - `canonical_url` / `source_url` ← the WordPress permalink (`link`)
   - body ← `content.rendered` converted HTML → markdown (`turndown`)
   - tags ← embedded categories + tags (`Uncategorized` skipped)
3. **Images** — the featured image and every inline `<img>` are mirrored through
   `MediaService` (HTTPS-only, host allowlist, SSRF DNS check, SHA-256 dedupe).
   Body image URLs are rewritten to the local `/media/...` paths, because the
   site CSP only allows `<img>` from self + twimg — un-mirrored WordPress images
   would be blocked. The featured image becomes the post's `og_image`. A failed
   image mirror is logged and skipped; the body keeps the original URL and the
   post still imports.
4. **Embeds** — WordPress oEmbeds (which render as `<iframe>`) would otherwise be
   dropped by the HTML→markdown step. YouTube embeds are preserved as a
   privacy-friendly `youtube-nocookie.com` player (`iframe.yt-embed`, video title
   kept); any other iframe is turned into a plain `[Embedded content](url)` link
   so nothing is lost silently. Rendering this requires two allowances that are
   already in place: `sanitize-html` permits `<iframe>` only from YouTube hosts
   (`allowedIframeHostnames`), and the CSP `frame-src` lists the YouTube domains.

## Idempotency

A unique `wp_post_id` column (migration `003_wordpress.sql`, partial unique
index) records each post's WordPress id, mirroring the `x_post_id` pattern.
Re-runs skip posts already imported. Manual edits made in the admin after import
are **not** protected by a future re-run unless you re-import a *new* post — the
importer never updates existing posts, only inserts new ones.

## Tests

`tests/wordpress-import.test.ts` — fakes the client at the class boundary and
injects a fake `MediaService`, so the suite stays offline and deterministic
(same approach as `tests/import.test.ts`). Covers field mapping, HTML→markdown,
entity decoding, draft mapping, tag import, pagination, idempotency, image
mirroring + URL rewrite, and graceful handling of a failed image mirror.
