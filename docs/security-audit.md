# Security Audit — admin access & secret exposure

Date: 2026-06-12. Scope: can an unauthenticated attacker (a) read environment/secrets or
(b) reach admin methods. Method: source review of routes, auth, crypto, config, media,
markdown, search, and templates.

## Remediation status (2026-06-12)

- **Finding 1 — FIXED.** `trustProxy` is now configurable via `TRUSTED_PROXY` and defaults to
  `1` (one reverse proxy) instead of `true`; `req.ip` is no longer attacker-controllable in the
  documented topology. `src/config/index.ts:parseTrustProxy`, `src/app.ts`.
- **Finding 2 — FIXED.** Boot now warns on a `<8`-char `ADMIN_PASSWORD` and refuses to start in
  production without `APP_ENCRYPTION_KEY`/`SESSION_SECRET`. `src/app.ts`.
- **Finding 3 — FIXED.** Changing the admin password now requires the current password and a
  ≥8-char new password; rejection re-renders with an error and changes nothing.
  `src/routes/admin.ts`, `src/modules/auth/service.ts:verifyCurrentPassword`, `settings.eta`.
- **Finding 5 — FIXED.** `/subscribe` is rate-limited per IP (5/hour).
  `src/modules/newsletter/service.ts:checkRateLimit`, `src/routes/public.ts`.
- **Finding 6 — FIXED.** Covered by the production secret guard in Finding 2.
- **Finding 4 — ACCEPTED (not changed).** `customFooterHtml`/`authorCtaHtml` remain raw by
  design (author-only "custom HTML" feature); the CSP blocks inline scripts. Revisit if these
  ever become non-author-editable.

Original findings below for reference.

## Bottom line

- **Reading env/secrets over the web: no direct path found.** Secrets are never reflected
  into responses or templates, OAuth tokens are AES-256-GCM encrypted at rest, error bodies
  are generic in production, and all SQL is parameterized.
- **Reaching admin methods: no direct bypass.** Every `/admin` URL is behind a session +
  per-session CSRF check. The realistic path is **brute-forcing the admin password**, and
  that is made materially easier by Finding 1 (rate-limit bypass) plus Finding 2 (no env
  password-strength check). Finding 1 also **defeats `ADMIN_IP_ALLOWLIST`** entirely.

---

## Finding 1 — HIGH — `X-Forwarded-For` spoofing defeats the IP allowlist and login rate limit

`src/app.ts:66` sets `trustProxy: true`. With "trust all", Fastify derives `req.ip` from the
**left-most** (client-supplied) entry of `X-Forwarded-For`. That value is attacker-controlled —
even behind a standard nginx (`$proxy_add_x_forwarded_for` *appends*, so the client's forged
left-most value survives).

`req.ip` is the input to two security controls, both of which become bypassable:

- **Admin IP allowlist** (`src/routes/admin.ts:32-38` → `ipAllowed(req.ip, …)`): send
  `X-Forwarded-For: <any-allowlisted-ip>` and the 403 gate passes. The allowlist provides no
  protection.
- **Login brute-force throttle** (`src/modules/auth/service.ts:45-55`, keyed by `req.ip`):
  rotate the forged IP per request for **unlimited** password guesses. scrypt slows each guess
  but does not stop an offline-paced online attack against a weak password.

Secondary abuse via the same root cause: AMA per-visitor rate limit (`src/routes/public.ts:196`,
keyed off `req.ip`) → LLM cost abuse; analytics visitor hashing → poisoning.

**Fix:** set `trustProxy` to the actual hop count / proxy CIDR, not `true`. Behind one proxy use
`trustProxy: 1` (or the proxy IP). Then `req.ip` is the address your proxy appended, not arbitrary
client input. Make it configurable (`TRUSTED_PROXY_HOPS`) and document that the app must not be
exposed directly when an allowlist is relied upon.

## Finding 2 — MEDIUM — `ADMIN_PASSWORD` from env has no strength check; `NODE_ENV` not enforced

- `src/scripts/create-admin.ts` enforces ≥8 chars, but the env bootstrap
  (`src/app.ts:74-77` → `auth.setAdminPassword(config.adminPassword)`) applies **no** length or
  complexity check. A weak `ADMIN_PASSWORD` plus Finding 1 = practical admin takeover.
- `config.isProduction` is `NODE_ENV === "production"` (`src/config/index.ts:75`). If a prod
  deploy forgets to set it: session cookies lose `secure` (`src/routes/admin.ts:13`), and the
  error handler returns raw `err.message` (`src/app.ts:189-197`) — minor info leak and a
  cookie-over-HTTP risk.

**Fix:** validate `ADMIN_PASSWORD` length on boot (reject/warn if short); fail fast or warn loudly
if `NODE_ENV !== "production"` on a non-localhost bind.

## Finding 3 — LOW — Admin password change doesn't re-verify the current password

`src/routes/admin.ts:468-471`: a valid session can set a new password with no current-password
re-entry. Turns any session compromise into permanent account takeover. Require the current
password for `new_admin_password`.

## Finding 4 — LOW — Unsanitized admin-controlled HTML rendered raw

`customFooterHtml` / `authorCtaHtml` are output with `<%~` (`src/views/layout.eta:48`,
`src/views/post.eta:81`) and saved without sanitization (`src/routes/admin.ts:439-446`).
Author-only (self-XSS), and the CSP (`script-src 'self' https://platform.twitter.com`, no
`unsafe-inline`) blocks inline `<script>`. Low risk; consider running them through `sanitize()`.

## Finding 5 — LOW — Public POST endpoints have no rate limiting

`/subscribe` (`src/routes/public.ts:152`) and other public POSTs are unthrottled. Enables
confirmation-email spam / joe-jobbing (one email per address, double-opt-in limits blast radius)
and general resource abuse. Add a lightweight per-IP limiter (after Finding 1 is fixed so the key
is trustworthy).

## Finding 6 — INFO — Secret fallbacks are ephemeral in production

`APP_ENCRYPTION_KEY` / `SESSION_SECRET` fall back to random bytes when unset
(`src/config/index.ts:93-94`). Fine in dev; in prod (if unset) every restart invalidates all
sessions and makes encrypted X OAuth tokens undecryptable. Availability, not disclosure. Consider
refusing to boot in production without these set.

---

## Verified-good (no action needed)

- Passwords: scrypt (N=16384) + `timingSafeEqual` (`src/lib/crypto.ts`).
- Sessions: opaque 32-byte token stored only as SHA-256 hash, TTL-checked, `httpOnly`,
  `SameSite=Strict`, path-scoped to `/admin`.
- CSRF: per-session token enforced on every non-GET admin route, incl. streamed multipart upload.
- SQL: parameterized throughout; the two dynamically-built `WHERE` clauses
  (`rss/service.ts:39`, `stats/service.ts:143`) use only constant fragments with bound params.
- Search FTS5: user input stripped to `\p{L}\p{N}\s`, quoted, `ORDER BY` from a fixed map — no
  FTS/SQL injection.
- Rendered post bodies sanitized via `sanitize-html`; `embedXReferences` escapes all
  user-derived values and runs on already-sanitized HTML.
- Media mirroring SSRF guards: HTTPS-only, host allowlist, IP-literal block, DNS→private-address
  block, `redirect: "error"`, size cap, MIME allowlist, content-addressed path with traversal check.
- JSON-LD escapes `<` → `<` (no `</script>` breakout).
- No `process.env` / secret values reflected into any route or template.
- Security headers + CSP set on every response; `frame-ancestors 'self'`.
