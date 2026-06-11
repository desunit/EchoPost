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

function env(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

function intEnv(key: string, fallback: number): number {
  const v = Number.parseInt(env(key), 10);
  return Number.isFinite(v) ? v : fallback;
}

function listEnv(key: string): string[] {
  return env(key).split(",").map((s) => s.trim()).filter(Boolean);
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

const wordpressUrl = env("WORDPRESS_URL").replace(/\/$/, "");
// The WordPress site host plus any CDN/upload hosts must be allowlisted before
// MediaService will mirror their images (SSRF guard). Derived from WORDPRESS_URL
// automatically; add CDN/other hosts via MEDIA_EXTRA_ALLOWED_HOSTS.
const wordpressMediaHosts = [hostOf(wordpressUrl), ...listEnv("MEDIA_EXTRA_ALLOWED_HOSTS")].filter(
  (h): h is string => !!h,
);

export const config = {
  env: env("NODE_ENV", "development"),
  isProduction: env("NODE_ENV") === "production",
  port: intEnv("PORT", 3000),
  host: env("HOST", "0.0.0.0"),
  siteUrl,
  // URL path the app is mounted under (e.g. "/blog"); "" means root.
  basePath,
  // Absolute base for all public links: origin + basePath. Use this (not siteUrl)
  // for canonical URLs, feeds, sitemap, and JSON-LD.
  publicUrl: siteUrl + basePath,
  siteTitle: env("SITE_TITLE", "EchoPost"),
  siteDescription: env("SITE_DESCRIPTION", "Personal content archive and X mirror"),

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
    username: env("X_USERNAME"),
    apiBase: env("X_API_BASE", "https://api.x.com/2"),
    // How many older posts each historical backfill batch imports.
    backfillBatchSize: intEnv("X_BACKFILL_BATCH_SIZE", 100),
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
    maxDownloadBytes: intEnv("MEDIA_MAX_DOWNLOAD_BYTES", 30 * 1024 * 1024),
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
    provider: env("EMAIL_PROVIDER", "console") as "console" | "resend" | "postmark" | "webhook",
    from: env("EMAIL_FROM", "newsletter@example.com"),
    resendApiKey: env("RESEND_API_KEY"),
    postmarkToken: env("POSTMARK_API_TOKEN"),
    webhookUrl: env("NEWSLETTER_WEBHOOK_URL"),
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
