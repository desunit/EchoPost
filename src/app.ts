import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { Eta } from "eta";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config/index.js";
import { getDb, type DB } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { PostsService } from "./modules/posts/service.js";
import { TagsService } from "./modules/tags/service.js";
import { MediaService } from "./modules/media/service.js";
import { SettingsService } from "./modules/settings/service.js";
import { RelatedPostsService } from "./modules/related-posts/service.js";
import { SearchService } from "./modules/search/service.js";
import { AnalyticsService } from "./modules/analytics/service.js";
import { NewsletterService } from "./modules/newsletter/service.js";
import { RssService } from "./modules/rss/service.js";
import { SeoService } from "./modules/seo/service.js";
import { StatsService } from "./modules/stats/service.js";
import { ArchiveQaService } from "./modules/ama/service.js";
import { AuthService } from "./modules/auth/service.js";
import { JobWorker } from "./modules/jobs/worker.js";
import { XAccountService } from "./modules/x/account.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerHealthRoutes } from "./routes/health.js";
import { formatDate, formatDateShort, formatNumber } from "./lib/time.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export interface Services {
  db: DB;
  posts: PostsService;
  tags: TagsService;
  media: MediaService;
  settings: SettingsService;
  related: RelatedPostsService;
  search: SearchService;
  analytics: AnalyticsService;
  newsletter: NewsletterService;
  rss: RssService;
  seo: SeoService;
  stats: StatsService;
  ama: ArchiveQaService;
  auth: AuthService;
  worker: JobWorker;
  xAccount: XAccountService;
}

declare module "fastify" {
  interface FastifyInstance {
    services: Services;
    view(reply: FastifyReply, template: string, data?: Record<string, unknown>): FastifyReply;
  }
}

export async function buildApp(opts: { startWorker?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.isProduction ? "info" : "debug",
      transport: config.isProduction ? undefined : { target: "pino-pretty" },
    },
    trustProxy: config.trustProxy,
    disableRequestLogging: config.isProduction,
  });

  // Fail fast rather than silently falling back to ephemeral random secrets in
  // production: those reset every restart, invalidating all sessions and making
  // encrypted X OAuth tokens undecryptable.
  if (config.isProduction) {
    const missing = ["APP_ENCRYPTION_KEY", "SESSION_SECRET"].filter((k) => !process.env[k]?.trim());
    if (missing.length) {
      throw new Error(`Refusing to boot in production without: ${missing.join(", ")}`);
    }
  }

  const db = getDb();
  runMigrations(db);

  const auth = new AuthService(db);
  if (!auth.hasAdminPassword() && config.adminPassword) {
    if (config.adminPassword.length < 8) {
      app.log.warn("ADMIN_PASSWORD is shorter than 8 characters — set a stronger admin password");
    }
    auth.setAdminPassword(config.adminPassword);
    app.log.info("admin password initialized from ADMIN_PASSWORD");
  }

  const worker = new JobWorker(db, app.log as any);
  const services: Services = {
    db,
    posts: new PostsService(db),
    tags: new TagsService(db),
    media: new MediaService(db),
    settings: new SettingsService(db),
    related: new RelatedPostsService(db),
    search: new SearchService(db),
    analytics: new AnalyticsService(db),
    newsletter: new NewsletterService(db, app.log as any),
    rss: new RssService(db),
    seo: new SeoService(db),
    stats: new StatsService(db),
    ama: new ArchiveQaService(db),
    auth,
    worker,
    xAccount: new XAccountService(db),
  };
  app.decorate("services", services);

  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyFormbody);
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.media.maxDownloadBytes, files: 20 },
  });
  await app.register(fastifyStatic, {
    root: path.join(rootDir, "public"),
    prefix: `${config.basePath}/assets/`,
  });
  if (config.media.driver === "local") {
    await app.register(fastifyStatic, {
      root: config.media.storagePath,
      prefix: `${config.media.publicUrl}/`,
      decorateReply: false,
      maxAge: "30d",
    });
  }

  /* ---------- templating ---------- */
  const eta = new Eta({
    views: path.join(rootDir, "views"),
    cache: config.isProduction,
    autoEscape: true,
  });
  const siteSettings = () => services.settings.getSiteSettings();
  app.decorate("view", function (reply: FastifyReply, template: string, data: Record<string, unknown> = {}) {
    const html = eta.render(template, {
      site: {
        url: config.siteUrl,
        title: config.siteTitle,
        brand: config.siteBrand,
        description: config.siteDescription,
        xUsername: config.x.username,
        ...siteSettings(),
      },
      // URL prefix for all internal page/feed/admin links (empty at root).
      // Static assets (/assets, /media) are served at root and never prefixed.
      base: config.basePath,
      // Absolute origin+basePath, for canonical/OG URLs in templates.
      publicUrl: config.publicUrl,
      // Sitewide fallback social card when a page has no content image.
      defaultOgImage: `${config.publicUrl}/assets/favicon-192x192.jpg`,
      formatDate,
      formatDateShort,
      formatNumber,
      ...data,
    });
    return reply.type("text/html; charset=utf-8").send(html);
  });

  /* ---------- security headers + redirects ---------- */
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: https://pbs.twimg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' https://platform.twitter.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://platform.twitter.com; frame-ancestors 'self'",
    );

    // Trailing-slash normalization (301): WordPress permalinks end in "/", but
    // imported slugs are stored without one, so "/slug/" would 404. Redirect to
    // the canonical no-slash URL so old WP links and their SEO equity resolve.
    // The site root (basePath + "/") keeps its slash; assets/media are untouched.
    if (req.method === "GET") {
      const qIdx = req.url.indexOf("?");
      const path = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
      const query = qIdx === -1 ? "" : req.url.slice(qIdx);
      if (
        path.length > 1 &&
        path.endsWith("/") &&
        path !== `${config.basePath}/` &&
        !path.startsWith(`${config.basePath}/assets`) &&
        !path.startsWith(`${config.media.publicUrl}/`)
      ) {
        return reply.code(301).redirect(path.replace(/\/+$/, "") + query);
      }
    }

    // slug redirects (PRD 5.13.2) — only for plain GET page requests.
    // Redirects are stored as unprefixed slug paths (/old → /new); strip the
    // base path before lookup and re-add it on the way out.
    if (req.method === "GET" && !req.url.startsWith(`${config.basePath}/admin`) && !req.url.startsWith(`${config.basePath}/assets`)) {
      let pathOnly = req.url.split("?")[0]!;
      if (config.basePath && pathOnly.startsWith(config.basePath)) {
        pathOnly = pathOnly.slice(config.basePath.length) || "/";
      }
      const redirect = services.seo.findRedirect(pathOnly);
      if (redirect) {
        return reply.code(redirect.status_code).redirect(config.basePath + redirect.to_path);
      }
    }
  });

  // Health checks stay at root (infra), everything else mounts under basePath.
  registerHealthRoutes(app);
  await app.register(
    async (scope) => {
      registerPublicRoutes(scope);
      registerAdminRoutes(scope);
    },
    { prefix: config.basePath || undefined },
  );

  app.setNotFoundHandler((req, reply) => {
    reply.code(404);
    return app.view(reply, "message", {
      title: "Not found",
      heading: "404 — Page not found",
      message: "That page doesn't exist. It may have moved.",
    });
  });

  app.setErrorHandler((err: any, req, reply) => {
    req.log.error({ err }, "request failed");
    reply.code(err?.statusCode ?? 500);
    return app.view(reply, "message", {
      title: "Error",
      heading: "Something went wrong",
      message: config.isProduction ? "Please try again later." : String(err?.message ?? err),
    });
  });

  if (opts.startWorker !== false) {
    worker.start();
    app.addHook("onClose", async () => worker.stop());
  }

  return app;
}
