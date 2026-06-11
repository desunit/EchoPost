# PRD deviations and v1 scope notes

Deliberate deviations from the PRD, chosen to keep the build dependency-light and reliable on one VPS. None changes the product behavior described in the acceptance criteria.

| PRD says | Implementation | Why |
| --- | --- | --- |
| Drizzle ORM | better-sqlite3 + raw SQL repositories | The PRD specifies exact SQL schemas; prepared statements against them are simpler, faster, and dependency-free. Migrations are plain `.sql` files. |
| unified / remark / rehype | marked + sanitize-html | Same rendering features (GFM, tables, code fences), one dependency instead of a tree. Sanitization is identical in effect. |
| Tailwind CSS | hand-written `styles.css` (~300 lines) | No build step; the server runs `tsx` directly. Swap in Tailwind later if the UI grows. |
| Argon2id password hashing | scrypt (node:crypto) | Avoids a native build dependency; scrypt is a memory-hard KDF available in the standard library. Hashes are versioned (`scrypt$salt$hash`) so Argon2id can be added behind the same interface. |
| TOTP for admin | password + sessions + rate limiting only | Single-author v1; the AuthService is structured to add TOTP without schema changes (store the secret in `settings`). |
| HTMX progressive UI | plain HTML forms | Every admin action is a form POST; HTMX can be layered on without route changes. |
| Sharp thumbnails / responsive sizes | originals served with lazy loading + dimensions | Avoids the native sharp dependency. Image dimensions are parsed from file headers (pure JS) so layout doesn't shift. Add sharp later inside `MediaService`. |
| SMTP email provider | console / Resend / Postmark / webhook adapters | All HTTPS-API providers work dependency-free via fetch. SMTP needs nodemailer — add it as another `EmailProvider` if required. |
| S3 media driver | local driver implemented; S3 config reserved | v1 targets one VPS (PRD §18 "Mirror media locally"). The `MediaService` isolates storage so an S3 adapter slots in. |
| X user-context OAuth flow | bearer-token mode + encrypted token storage ready | Public metrics need only the bearer token. The OAuth callback route, token encryption, and private-metrics request fields are in place; the authorize-redirect dance remains to be wired when an X app with OAuth scopes exists. |
| Embeddings for related posts | FTS5 + tags only | Explicitly the PRD's own v1 recommendation (§18). `EmbeddingProvider` interface reserved in design. |
| AMA page | implemented, off by default, Anthropic **or** OpenAI provider | PRD §17 recommends delaying until the archive is large; enable in Settings once `LLM_PROVIDER` is `anthropic` or `openai` and the matching API key is set. OpenAI uses the chat-completions API (`OPENAI_MODEL`, default `gpt-5.4-nano`; `OPENAI_BASE_URL` override for proxies/compatible endpoints). |

## Other notes

- **Unique visitor estimation** uses a short-lived `daily_visitor_log`
  table (pruned after 3 days) rather than unbounded event storage —
  satisfies "raw daily aggregates" (PRD 5.8.4).
- **`autoPublishAfterMinutes`** is stored and editable but not yet acted
  on by a delayed job; auto-publish currently happens at import time when
  thresholds are met.
- **Bulk admin actions** (PRD 5.16.3) are available one-post-at-a-time in
  the UI and via jobs (`recalculate_related`, `x_metrics_refresh`,
  `verify_media`); multi-select UI is a follow-up.
- **Admin IP allowlist** (optional, defense-in-depth): when
  `ADMIN_IP_ALLOWLIST` is set (comma-separated exact IPs and/or CIDR ranges,
  IPv4/IPv6), a preHandler rejects any `/admin` request — including the login
  page — whose client IP is not in the list, before auth runs. The client IP
  comes from `req.ip`, which honors `X-Forwarded-For` via Fastify `trustProxy`,
  so it works behind a reverse proxy. Empty/unset → no restriction. Matcher in
  `lib/ip-allow.ts` (IPv4-mapped IPv6 like `::ffff:…` is matched as IPv4).
- **Historical backfill** (beyond the PRD's forward-only sync): the
  `x_backfill` job walks the timeline *backwards* via the X API `until_id`
  cursor, importing `X_BACKFILL_BATCH_SIZE` older posts per run (default
  100; the API enforces a 5-post page minimum, so smaller batches fetch a
  page and keep only the newest N). Progress is remembered on `x_account`
  (`backfill_oldest_x_post_id` / `backfill_oldest_at`), separate from the
  forward watermark `last_imported_x_post_id`, so each batch only fetches
  still-older posts and the existing `x_post_id`-unique constraint makes
  re-runs idempotent. `backfill_complete` is set when no older posts remain.
  Triggered from Admin → Review queue ("Sync N older posts") or the jobs
  panel. Snowflake ids are compared numerically (lengths differ across
  years, so lexicographic order is wrong). Backfilled posts are
  **auto-published** (bypassing the review queue and engagement thresholds),
  except `possibly_sensitive` ones, which still land as draft.
- **note_tweet truncation recovery**: the user-timeline endpoint
  inconsistently omits `note_tweet` for some long (>280 char) tweets,
  leaving `text` truncated. The importer detects truncated-looking tweets
  (no `note_tweet`, ≥250 chars) and re-fetches them via the tweets-lookup
  endpoint (which returns `note_tweet` reliably) before importing, for both
  forward sync and backfill. A rate-limit during enrichment reschedules the
  job rather than persisting truncated text.
- **Thread-continuation filtering**: only a self-reply to the author's *own*
  previous tweet (`in_reply_to_user_id === own`) is folded into the article;
  replies to other people's comments in the conversation are skipped. A
  continuation that quote-tweets the thread's own root (`quoted` id ===
  `conversation_id`) is a self-promo "requote" and is also skipped.
- **X-reference rendering**: references to X posts inside a post body are
  resolved at render time (`lib/x-embed.ts`, called from the post route so it
  stays cached). A quote of *another* account's tweet becomes the live X embed
  widget (`platform.twitter.com/widgets.js`, loaded only on pages that have
  one); a reference to one of the author's *own* tweets that also lives in the
  archive becomes an internal reference card (thumbnail + title + excerpt)
  linking to the local post. Resolving at render (not import) keeps cards fresh
  when a referenced post is retitled or imported later by backfill. The stored
  markdown keeps plain links as the source of truth. Per-section "View on X"
  footer links and non-X links are left untouched. Thread continuations are
  joined as paragraphs with no `<hr>` separator (the `<!-- x:ID -->` comment
  remains the canonical section boundary).
- **Quote-commentary minimum**: quotes don't embed the quoted tweet, so they
  are held to a dedicated, higher bar — `minimumQuoteCommentaryCount`
  (default 280, editable in Settings → Import rules), falling back to
  `minimumCharacterCount` when unset. Replaces the old `max(40, min/2)` rule,
  which was weaker than the general minimum and let thin reaction-quotes through.
- **LLM metadata** (optional): when `LLM_PROVIDER` is set (`openai` /
  `anthropic`), the importer asks the model for the title, SEO description,
  and tags in one call (`metadata/llm.ts`), preferring existing tags /
  controlled vocabulary. The deterministic heuristics in `metadata/generate.ts`
  remain the baseline and are used on any LLM failure or when no key is
  configured, so imports never block. Excerpts are always heuristic. The
  provider is injected by the jobs worker; tests construct the importer
  without it so imports stay offline and deterministic.
