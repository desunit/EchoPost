# Newsletter (double opt-in)

`POST /subscribe` stores a `pending` subscriber and sends ONE confirmation mail. The reader clicks
the link (`/subscribe/confirm`) → `active` + welcome mail. Code: `src/modules/newsletter/`,
route in `src/routes/public.ts`, form `src/views/partials/newsletter.eta`.

## Why the form is guarded (2026-11-12 complaint)

A form that mails any typed address is a spam cannon: a bot (or a joker) enters a stranger's
address, the stranger gets "Confirm your subscription…" from a site they never visited, and clicks
**Report spam**. On 2026-11-12 Yahoo sent such a complaint (`complaintFeedbackType: abuse`) for a
`homepage` sign-up. At that time 67 of 71 subscribers since 2026-06-11 had never confirmed (94 %),
so most sign-ups were not real readers. Complaints count against the **whole SES account**, which
every Songtive app shares (SES reviews an account above ~0.1 % complaints).

Guards, outside in:

| Guard | Where | Effect |
|---|---|---|
| Cloudflare Turnstile | `src/lib/turnstile.ts`, form widget, CSP (`challenges.cloudflare.com` in `script-src` + `frame-src`) | On when `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are both set. Missing/invalid token → 400, no mail. Fails closed if Cloudflare cannot be reached |
| Honeypot `website` field | form (off-screen) + route | A filled value → the normal "check your inbox" page, no mail, log line `newsletter: honeypot hit, no mail` |
| Per-IP rate limit | `NewsletterService.checkRateLimit` | 5 attempts / IP / hour |
| Resend cooldown | `RESEND_COOLDOWN_MS` (24 h) | A `pending` address gets at most one confirmation mail per day |

## Sender (production, desunit.com/blog)

| Setting | Value |
|---|---|
| `EMAIL_FROM` | `Sergey Bogdanov <newsletter@desunit.com>` — the site's own domain. Until 2026-11-13 it was `support@songtive.com`: a mail about "@desunit" from a songtive.com address looks like phishing |
| SES identity | `desunit.com` (Easy DKIM, 3 CNAMEs `*._domainkey.desunit.com` in Cloudflare, DNS-only). Complaint/bounce notifications → SNS `songtive-email-complaints` / `songtive-email-bounces` (they land in `complaints@songtive.com`) |
| `SES_CONFIGURATION_SET` | `echopost-newsletter` (reputation metrics on) — the newsletter's own bounce/complaint numbers in SES, apart from the app mail |
| Transport | SES SMTP, same SMTP user as before (`AWSSESSendingGroupDoNotRename`) |

desunit.com has no MX and SPF `v=spf1 -all`: SES uses its own MAIL FROM (amazonses.com), and DKIM
on desunit.com gives DMARC alignment. Replies to `newsletter@desunit.com` bounce — the mail asks for
no reply.

## Check

```sql
-- on beta: sqlite3 /root/server/echopost/data/echopost.db
SELECT substr(created_at,1,10) d, count(*), sum(confirmed_at IS NOT NULL) FROM subscribers GROUP BY d ORDER BY d DESC LIMIT 14;
```

Sign-ups with 0 confirmations after the guards = bots still pass; check Turnstile is on.
