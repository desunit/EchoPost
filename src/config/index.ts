import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseAllowlist } from "../lib/ip-allow.js";

// Load .env if present (Node 22+). Real environment variables always win,
// so this is a no-op in production where vars are injected by the platform.
const envFile = path.resolve(process.cwd(), process.env.ENV_FILE || ".env");
if (typeof process.loadEnvFile === "function" && fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// Strip a dotenv-style inline comment (whitespace + `#` to end of line). Neither
// Node's process.loadEnvFile nor Docker Compose's env_file parser removes these,
// so a line like `MEDIA_STORAGE_DRIVER=local # local | s3` otherwise yields the
// literal value "local # local | s3". A `#` without leading whitespace (e.g. a
// URL fragment or a `#`-bearing secret) is preserved.
export function stripInlineComment(value: string): string {
  return value.replace(/\s+#.*$/, "");
}

function env(key: string, fallback = ""): string {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return stripInlineComment(raw).trim() || fallback;
}

function intEnv(key: string, fallback: number): number {
  const v = Number.parseInt(env(key), 10);
  return Number.isFinite(v) ? v : fallback;
}

function listEnv(key: string): string[] {
  return env(key).split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse the reverse-proxy trust setting that decides how `req.ip` is derived
 * from `X-Forwarded-For`.
 *
 * SECURITY: `true` trusts the *entire* client-supplied XFF chain, so anyone can
 * forge `req.ip` and defeat the admin IP allowlist and the login rate limiter.
 * Prefer the number of trusted proxy hops in front of the app:
 *   - ""        → 1   (default: a single reverse proxy, e.g. nginx/Caddy)
 *   - "0"/"false" → false (app exposed directly — use the socket peer IP)
 *   - "2"       → trust 2 hops
 *   - "true"    → trust all hops (unsafe unless the proxy rewrites XFF)
 *   - "10.0.0.0/8,192.168.0.0/16" → trust these proxy addresses/CIDRs
 */
export function parseTrustProxy(raw: string): boolean | number | string[] {
  const v = raw.trim();
  if (v === "") return 1;
  const lower = v.toLowerCase();
  if (lower === "false" || v === "0") return false;
  if (lower === "true") return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function hostOf(url: string): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

// Normalize an optional URL path prefix: "" / "/" → "", "blog" / "/blog/" → "/blog".
// When set, the whole app (pages, feeds, admin) is mounted under this path.
function normalizeBasePath(raw: string): string {
  const p = raw.trim().replace(/\/+$/, "");
  if (!p || p === "/") return "";
  return p.startsWith("/") ? p : `/${p}`;
}

const root = process.cwd();
const siteUrl = env("SITE_URL", "http://localhost:3000").replace(/\/$/, "");
const basePath = normalizeBasePath(env("BASE_PATH"));

// Branding. Three knobs, decoupled so each can be set independently:
//   - siteBrand: the homepage <h1> (and homepage <title>) — e.g. "Sergey Bogdanov"
//   - pageTitleBrand: the brand token in inner page <title> tags ("Tags — <brand>")
// siteTitleEnv is the raw SITE_TITLE (empty when unset) so we can tell "set" apart
// from the "EchoPost" default.
const siteTitleEnv = env("SITE_TITLE");
const siteTitle = siteTitleEnv || "EchoPost";
const xUsername = env("X_USERNAME");
// Precedence: explicit SITE_BRAND, then SITE_TITLE, then the auto-derived
// "@<handle> Blog", then the "EchoPost" default. SITE_TITLE intentionally beats
// the X-handle derivation so setting it alone changes the brand everywhere.
const siteBrand = env("SITE_BRAND") || siteTitleEnv || (xUsername ? `@${xUsername} Blog` : "EchoPost");
// Inner pages use SITE_TITLE when explicitly set, else fall back to the brand.
const pageTitleBrand = siteTitleEnv || siteBrand;

const wordpressUrl = env("WORDPRESS_URL").replace(/\/$/, "");
// The WordPress site host plus any CDN/upload hosts must be allowlisted before
// MediaService will mirror their images (SSRF guard). Derived from WORDPRESS_URL
// automatically; add CDN/other hosts via MEDIA_EXTRA_ALLOWED_HOSTS.
const wordpressMediaHosts = [hostOf(wordpressUrl), ...listEnv("MEDIA_EXTRA_ALLOWED_HOSTS")].filter(
  (h): h is string => !!h,
);

// Outbound links to these hosts (and their subdomains) stay "follow" — own
// properties we want to pass SEO equity to. Every other off-site link in
// rendered content gets rel="nofollow". The site's own host is always included;
// add the rest (your apps) via LINK_FOLLOW_HOSTS.
const followLinkHosts = [hostOf(siteUrl), ...listEnv("LINK_FOLLOW_HOSTS")]
  .filter((h): h is string => !!h)
  .map((h) => h.toLowerCase());

export const config = {
  env: env("NODE_ENV", "development"),
  isProduction: env("NODE_ENV") === "production",
  port: intEnv("PORT", 3000),
  host: env("HOST", "0.0.0.0"),
  // How much of X-Forwarded-For to trust when computing req.ip. See parseTrustProxy.
  trustProxy: parseTrustProxy(env("TRUSTED_PROXY")),
  siteUrl,
  // URL path the app is mounted under (e.g. "/blog"); "" means root.
  basePath,
  // Absolute base for all public links: origin + basePath. Use this (not siteUrl)
  // for canonical URLs, feeds, sitemap, and JSON-LD.
  publicUrl: siteUrl + basePath,
  // Link rel policy for rendered content: hosts that stay "follow".
  links: { followHosts: followLinkHosts },
  siteTitle,
  siteDescription: env("SITE_DESCRIPTION", "Personal content archive and X mirror"),
  // Homepage <h1> / <title>. Defaults to "@<handle> Blog" (or SITE_TITLE when no X
  // handle is set); set SITE_BRAND to override with a name like "Sergey Bogdanov".
  siteBrand,
  // Brand token in inner page <title> tags ("Tags — <brand>"). Prefers SITE_TITLE
  // when set, else falls back to siteBrand.
  pageTitleBrand,

  databasePath: path.resolve(root, env("DATABASE_PATH", "./data/echopost.db")),

  // Secrets fall back to ephemeral random values in dev so the app boots,
  // but sessions and visitor hashes then reset on every restart.
  encryptionKey: env("APP_ENCRYPTION_KEY") || randomBytes(32).toString("hex"),
  sessionSecret: env("SESSION_SECRET") || randomBytes(32).toString("hex"),
  adminPassword: env("ADMIN_PASSWORD"),
  // Optional IP allowlist for the admin area (exact IPs / CIDR, comma-separated).
  // Empty = no restriction. Honors X-Forwarded-For via Fastify trustProxy.
  adminIpAllowlist: parseAllowlist(env("ADMIN_IP_ALLOWLIST")),

  x: {
    clientId: env("X_CLIENT_ID"),
    clientSecret: env("X_CLIENT_SECRET"),
    bearerToken: env("X_BEARER_TOKEN"),
    redirectUri: env("X_REDIRECT_URI"),
    username: xUsername,
    apiBase: env("X_API_BASE", "https://api.x.com/2"),
    // How many older posts each historical backfill batch imports.
    backfillBatchSize: intEnv("X_BACKFILL_BATCH_SIZE", 100),
  },

  indexNow: {
    // Ownership key served at `${publicUrl}/<key>.txt`. Optional: when unset a
    // key is generated once and persisted in the settings table, so it stays
    // stable across restarts.
    key: env("INDEXNOW_KEY"),
    // Pings are on in production by default. INDEXNOW_ENABLED=true/false
    // overrides (true to test against a fake endpoint locally, false to opt out).
    enabled: env("INDEXNOW_ENABLED", env("NODE_ENV") === "production" ? "true" : "false") === "true",
    // The api.indexnow.org endpoint shares submissions with all participating
    // engines (Bing, Yandex, Seznam, Naver, …) — one ping covers them all.
    endpoint: env("INDEXNOW_ENDPOINT", "https://api.indexnow.org/indexnow"),
  },

  wordpress: {
    // Base URL of the WordPress site to import from, e.g. https://blog.example.com.
    url: wordpressUrl,
    // Posts fetched per WP REST API page (max 100).
    perPage: Math.min(intEnv("WORDPRESS_PER_PAGE", 100), 100),
    // Which content types to import: WordPress "posts" and/or "pages".
    contentTypes: (listEnv("WORDPRESS_CONTENT_TYPES").length
      ? listEnv("WORDPRESS_CONTENT_TYPES")
      : ["posts", "pages"]
    ).filter((t): t is "posts" | "pages" => t === "posts" || t === "pages"),
  },

  media: {
    driver: env("MEDIA_STORAGE_DRIVER", "local") as "local" | "s3",
    storagePath: path.resolve(root, env("MEDIA_STORAGE_PATH", "./data/media")),
    // Served under the base path so sub-path deployments (e.g. /blog) resolve
    // media through the same reverse-proxy route as pages.
    publicUrl: basePath + env("MEDIA_PUBLIC_URL", "/media"),
    // 100 MB: large enough for mirrored X videos (the highest-bitrate MP4 variant).
    maxDownloadBytes: intEnv("MEDIA_MAX_DOWNLOAD_BYTES", 100 * 1024 * 1024),
    allowedHosts: ["pbs.twimg.com", "video.twimg.com", "abs.twimg.com", ...wordpressMediaHosts],
    s3: {
      endpoint: env("S3_ENDPOINT"),
      bucket: env("S3_BUCKET"),
      accessKey: env("S3_ACCESS_KEY"),
      secretKey: env("S3_SECRET_KEY"),
      publicUrl: env("S3_PUBLIC_URL"),
    },
  },

  email: {
    provider: env("EMAIL_PROVIDER", "console") as "console" | "resend" | "postmark" | "smtp" | "webhook",
    from: env("EMAIL_FROM", "newsletter@example.com"),
    resendApiKey: env("RESEND_API_KEY"),
    postmarkToken: env("POSTMARK_API_TOKEN"),
    webhookUrl: env("NEWSLETTER_WEBHOOK_URL"),
    // SMTP, including AWS SES SMTP (host email-smtp.<region>.amazonaws.com).
    // secure=true uses the TLS-wrapper port (465/2465); secure=false uses
    // STARTTLS (25/587/2587). SES always requires TLS.
    smtp: {
      host: env("SMTP_HOST"),
      port: intEnv("SMTP_PORT", 587),
      user: env("SMTP_USER"),
      pass: env("SMTP_PASS"),
      secure: env("SMTP_SECURE") === "true",
    },
  },

  llm: {
    provider: env("LLM_PROVIDER"),
    anthropicApiKey: env("ANTHROPIC_API_KEY"),
    openaiApiKey: env("OPENAI_API_KEY"),
    openaiModel: env("OPENAI_MODEL", "gpt-5.4-nano"),
    openaiBaseUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, ""),
  },

  backupPath: path.resolve(root, env("BACKUP_PATH", "./backups")),
};
