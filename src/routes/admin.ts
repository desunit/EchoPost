import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config/index.js";
import { invalidateContentCaches } from "../lib/cache.js";
import { ipAllowed } from "../lib/ip-allow.js";
import { DEFAULT_IMPORT_RULES } from "../modules/settings/service.js";
import { CONTENT_TYPES, PUBLICATION_STATUSES, type ContentType, type PublicationStatus } from "../modules/types.js";

const SESSION_COOKIE = "echopost_session";

function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "strict" as const,
    path: `${config.basePath}/admin`,
    maxAge: 7 * 86_400,
  };
}

export function registerAdminRoutes(app: FastifyInstance): void {
  const s = app.services;
  const bp = config.basePath;
  // All /admin URLs carry the base prefix in req.url and in redirects/cookies.
  const adminBase = `${bp}/admin`;

  const session = (req: FastifyRequest) => s.auth.getSession(req.cookies[SESSION_COOKIE]);

  /* ---------- IP allowlist (optional, covers all of /admin incl. login) ---------- */

  // Registered first so it runs before auth/CSRF. req.ip honors X-Forwarded-For
  // (Fastify trustProxy). Unset allowlist → no restriction.
  app.addHook("preHandler", async (req, reply) => {
    if (config.adminIpAllowlist.length === 0) return;
    if (!req.url.startsWith(adminBase)) return;
    if (ipAllowed(req.ip, config.adminIpAllowlist)) return;
    app.log.warn({ ip: req.ip, url: req.url }, "admin access blocked: IP not in allowlist");
    return reply.code(403).type("text/plain").send("Forbidden");
  });

  /* ---------- login / logout (no auth required) ---------- */

  app.get("/admin/login", async (req, reply) => {
    if (session(req)) return reply.redirect(bp + "/admin");
    return app.view(reply, "admin/login", {
      title: "Admin login",
      error: null,
      needsSetup: !s.auth.hasAdminPassword(),
    });
  });

  app.post("/admin/login", async (req, reply) => {
    const body = req.body as Record<string, string>;
    if (!s.auth.checkRateLimit(req.ip)) {
      reply.code(429);
      return app.view(reply, "admin/login", { title: "Admin login", error: "Too many attempts. Try again later.", needsSetup: false });
    }
    const token = s.auth.login(body.password ?? "", req.ip, req.headers["user-agent"]);
    if (!token) {
      reply.code(401);
      return app.view(reply, "admin/login", { title: "Admin login", error: "Wrong password.", needsSetup: !s.auth.hasAdminPassword() });
    }
    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    return reply.redirect(bp + "/admin");
  });

  app.post("/admin/logout", async (req, reply) => {
    s.auth.logout(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: adminBase });
    return reply.redirect(bp + "/admin/login");
  });

  /* ---------- auth + CSRF guard for everything else under /admin ---------- */

  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith(adminBase)) return;
    if (req.url === `${adminBase}/login`) return;
    const sess = session(req);
    if (!sess) {
      return reply.redirect(`${adminBase}/login`);
    }
    (req as any).adminSession = sess;
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Multipart bodies aren't parsed into req.body; those routes validate the
      // _csrf field themselves while streaming the parts (see media upload).
      const isMultipart = (req.headers["content-type"] ?? "").startsWith("multipart/form-data");
      const body = (req.body ?? {}) as Record<string, string>;
      if (req.url !== `${adminBase}/logout` && !isMultipart && body._csrf !== sess.csrf_token) {
        reply.code(403);
        throw new Error("Invalid CSRF token");
      }
    }
  });

  const csrf = (req: FastifyRequest) => ((req as any).adminSession?.csrf_token ?? "") as string;

  const adminView = (req: FastifyRequest, reply: FastifyReply, template: string, data: Record<string, unknown>) =>
    app.view(reply, template, { admin: true, csrf: csrf(req), ...data });

  /* ---------- dashboard (PRD 5.16.1) ---------- */

  app.get("/admin", async (req, reply) => {
    const statusCounts = s.posts.countByStatus();
    const account = s.xAccount.get();
    const jobCounts = s.worker.queue.counts();
    const today = new Date().toISOString().slice(0, 10);
    const importedToday = (
      s.db.prepare("SELECT COUNT(*) AS c FROM posts WHERE imported_at >= ?").get(`${today}T00:00:00`) as any
    ).c;
    const storage = s.media.storageUsage();

    return adminView(req, reply, "admin/dashboard", {
      title: "Admin",
      statusCounts,
      account,
      jobCounts,
      importedToday,
      pendingReview: (statusCounts.review ?? 0) + (statusCounts.imported ?? 0),
      newSubscribers: s.newsletter.newToday(),
      subscriberCounts: s.newsletter.counts(),
      viewsToday: s.analytics.viewsToday(),
      topBlogPosts: s.analytics.topPostsByBlogViews(7, 5),
      storage,
    });
  });

  /* ---------- posts CRUD ---------- */

  app.get("/admin/posts", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const posts = s.posts.listAdmin({
      status: (q.status as PublicationStatus) || "all",
      type: (q.type as ContentType) || "all",
      q: q.q,
      limit: 200,
    });
    return adminView(req, reply, "admin/posts", {
      title: "Posts",
      posts,
      statuses: PUBLICATION_STATUSES,
      types: CONTENT_TYPES,
      currentStatus: q.status ?? "all",
      currentType: q.type ?? "all",
      q: q.q ?? "",
    });
  });

  app.get("/admin/posts/new", async (req, reply) => {
    return adminView(req, reply, "admin/post-edit", {
      title: "New post",
      post: null,
      postTags: [],
      media: [],
      related: [],
      statuses: PUBLICATION_STATUSES,
      types: CONTENT_TYPES,
    });
  });

  function postInputFromBody(body: Record<string, string>) {
    return {
      title: body.title?.trim() || "Untitled",
      slug: body.slug?.trim() || undefined,
      type: (CONTENT_TYPES.includes(body.type as ContentType) ? body.type : "blog") as ContentType,
      status: (PUBLICATION_STATUSES.includes(body.status as PublicationStatus) ? body.status : "draft") as PublicationStatus,
      publishedAt: body.published_at?.trim() || undefined,
      excerpt: body.excerpt?.trim() || null,
      markdownBody: body.markdown_body ?? "",
      sourceUrl: body.source_url?.trim() || null,
      canonicalUrl: body.canonical_url?.trim() || null,
      externalUrl: body.external_url?.trim() || null,
      seoTitle: body.seo_title?.trim() || null,
      seoDescription: body.seo_description?.trim() || null,
      pinned: body.pinned === "on",
      featured: body.featured === "on",
      preserveManualTitle: body.preserve_manual_title === "on",
      preserveManualBody: body.preserve_manual_body === "on",
    };
  }

  app.post("/admin/posts", async (req, reply) => {
    const body = req.body as Record<string, string>;
    const post = s.posts.create(postInputFromBody(body));
    s.tags.setPostTags(post.id, (body.tags ?? "").split(","));
    s.posts.syncSearchIndex(s.posts.getById(post.id)!);
    if (post.status === "published") s.related.recalculateForPost(post.id);
    s.auth.audit("post_create", { title: post.title }, "post", post.id);
    return reply.redirect(bp + `/admin/posts/${post.id}`);
  });

  app.get("/admin/posts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const post = s.posts.getById(id);
    if (!post) return reply.callNotFound();
    return adminView(req, reply, "admin/post-edit", {
      title: `Edit: ${post.title}`,
      post,
      postTags: s.tags.forPost(id),
      media: s.media.forPost(id),
      related: s.related.forPost(id),
      statuses: PUBLICATION_STATUSES,
      types: CONTENT_TYPES,
    });
  });

  app.post("/admin/posts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, string>;
    const input = postInputFromBody(body);
    // manual edits to imported posts are preserved across future syncs (PRD 5.4.1)
    const existing = s.posts.getById(id);
    if (existing?.x_post_id) {
      if (input.title !== existing.title) input.preserveManualTitle = true;
      if ((input.markdownBody ?? "") !== (existing.markdown_body ?? "")) input.preserveManualBody = true;
    }
    const post = s.posts.update(id, input);
    s.tags.setPostTags(id, (body.tags ?? "").split(","));
    s.posts.syncSearchIndex(s.posts.getById(id)!);
    if (post.status === "published") s.related.recalculateForPost(id);
    s.auth.audit("post_update", { title: post.title }, "post", id);
    return reply.redirect(bp + `/admin/posts/${id}`);
  });

  app.post("/admin/posts/:id/delete", async (req, reply) => {
    const { id } = req.params as { id: string };
    s.posts.softDelete(id);
    s.auth.audit("post_delete", {}, "post", id);
    return reply.redirect(bp + "/admin/posts");
  });

  // Upload one or more images to an existing post. Multipart, so CSRF is checked
  // here (the global preHandler skips multipart). The _csrf field must precede
  // the file inputs in the form so it is validated before any bytes are stored.
  app.post("/admin/posts/:id/media", async (req, reply) => {
    const { id } = req.params as { id: string };
    const post = s.posts.getById(id);
    if (!post) return reply.callNotFound();
    const sess = (req as any).adminSession;
    let csrfOk = false;
    let stored = 0;
    for await (const part of req.parts()) {
      if (part.type === "field" && part.fieldname === "_csrf") {
        csrfOk = part.value === sess.csrf_token;
        if (!csrfOk) {
          reply.code(403);
          throw new Error("Invalid CSRF token");
        }
      } else if (part.type === "file") {
        if (!csrfOk) {
          reply.code(403);
          throw new Error("Invalid CSRF token");
        }
        const buf = await part.toBuffer();
        if (part.file.truncated) {
          reply.code(413);
          throw new Error("Upload exceeds size limit");
        }
        if (buf.length === 0) continue;
        try {
          s.media.storeUpload({ postId: id, buffer: buf, mime: part.mimetype, fileName: part.filename });
          stored++;
        } catch {
          // skip unsupported types; other valid files in the batch still upload
        }
      }
    }
    s.auth.audit("media_upload", { count: stored }, "post", id);
    return reply.redirect(bp + `/admin/posts/${id}`);
  });

  app.post("/admin/posts/:id/media/:mediaId/delete", async (req, reply) => {
    const { id, mediaId } = req.params as { id: string; mediaId: string };
    s.media.removeUpload(mediaId);
    s.auth.audit("media_delete", {}, "post", id);
    return reply.redirect(bp + `/admin/posts/${id}`);
  });

  for (const [action, status] of [
    ["publish", "published"],
    ["hide", "hidden"],
  ] as const) {
    app.post(`/admin/posts/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      s.posts.setStatus(id, status);
      if (status === "published") s.related.recalculateForPost(id);
      s.auth.audit(`post_${action}`, {}, "post", id);
      return reply.redirect((req.headers.referer as string) ?? `${adminBase}/posts`);
    });
  }

  app.post("/admin/posts/:id/recalculate-related", async (req, reply) => {
    const { id } = req.params as { id: string };
    s.related.recalculateForPost(id);
    return reply.redirect(bp + `/admin/posts/${id}`);
  });

  app.post("/admin/posts/:id/resync-x", async (req, reply) => {
    const { id } = req.params as { id: string };
    s.worker.queue.enqueue("x_metrics_refresh", { limit: 100 }, { dedupe: true });
    return reply.redirect(bp + `/admin/posts/${id}`);
  });

  app.post("/admin/posts/:id/redownload-media", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Re-fetch this post's tweet(s) from X and re-mirror their media (picks up
    // media changed upstream or never captured). The daily verify_media job, by
    // contrast, only restores files missing on disk.
    s.worker.queue.enqueue("x_post_media_refetch", { postId: id });
    s.auth.audit("post_media_refetch", {}, "post", id);
    return reply.redirect(bp + `/admin/posts/${id}`);
  });

  /* ---------- import review queue (PRD 5.16.2) ---------- */

  app.get("/admin/imports", async (req, reply) => {
    const pending = s.db
      .prepare(
        `SELECT p.*, (SELECT GROUP_CONCAT(t.name, ', ') FROM tags t
          JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = p.id) AS tag_names
         FROM posts p
         WHERE p.status IN ('review', 'imported') AND p.deleted_at IS NULL
         ORDER BY p.imported_at DESC LIMIT 100`,
      )
      .all() as any[];
    const account = s.xAccount.get();
    return adminView(req, reply, "admin/imports", {
      title: "Review queue",
      pending: pending.map((p) => ({ ...p, metrics: s.posts.latestMetrics(p.id), media: s.media.forPost(p.id) })),
      account,
      backfillBatchSize: config.x.backfillBatchSize,
    });
  });

  app.post("/admin/imports/sync", async (req, reply) => {
    s.worker.queue.enqueue("x_import", {}, { dedupe: true });
    return reply.redirect(bp + "/admin/imports");
  });

  app.post("/admin/imports/backfill", async (req, reply) => {
    s.worker.queue.enqueue("x_backfill", { batchSize: config.x.backfillBatchSize }, { dedupe: true });
    return reply.redirect(bp + "/admin/imports");
  });

  app.post("/admin/imports/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    s.posts.setStatus(id, "published");
    s.related.recalculateForPost(id);
    s.auth.audit("import_approve", {}, "post", id);
    return reply.redirect(bp + "/admin/imports");
  });

  app.post("/admin/imports/:id/ignore", async (req, reply) => {
    const { id } = req.params as { id: string };
    s.posts.setStatus(id, "hidden");
    s.auth.audit("import_ignore", {}, "post", id);
    return reply.redirect(bp + "/admin/imports");
  });

  /* ---------- X account ---------- */

  app.post("/admin/x/connect", async (req, reply) => {
    const body = req.body as Record<string, string>;
    const username = (body.username ?? config.x.username).replace(/^@/, "").trim();
    if (!username) return reply.redirect(bp + "/admin/imports");
    try {
      const { XClient } = await import("../modules/x/client.js");
      const user = await new XClient().getUserByUsername(username);
      s.xAccount.setProfile({
        xUserId: user.id,
        username: user.username,
        displayName: user.name,
        profileImageUrl: user.profile_image_url,
      });
      s.auth.audit("x_connect", { username });
    } catch (err: any) {
      s.xAccount.recordError(err.message);
    }
    return reply.redirect(bp + "/admin/imports");
  });

  /* ---------- tags (PRD 5.10.3) ---------- */

  app.get("/admin/tags", async (req, reply) => {
    return adminView(req, reply, "admin/tags", {
      title: "Tags",
      tags: s.tags.listWithCounts(true),
    });
  });

  app.post("/admin/tags", async (req, reply) => {
    const body = req.body as Record<string, string>;
    if (body.name?.trim()) s.tags.ensure(body.name);
    return reply.redirect(bp + "/admin/tags");
  });

  app.post("/admin/tags/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, string>;
    if (body.name?.trim()) s.tags.rename(id, body.name);
    if (body.category_group !== undefined) {
      s.db.prepare("UPDATE tags SET category_group = ? WHERE id = ?").run(body.category_group || null, id);
    }
    if (body.alias?.trim()) s.tags.addAlias(id, body.alias);
    return reply.redirect(bp + "/admin/tags");
  });

  app.post("/admin/tags/:id/merge", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, string>;
    const target = s.tags.getBySlug((body.target ?? "").trim());
    if (target) {
      s.tags.merge(id, target.id);
      s.auth.audit("tag_merge", { into: target.slug }, "tag", id);
    }
    return reply.redirect(bp + "/admin/tags");
  });

  app.post("/admin/tags/:id/delete", async (req, reply) => {
    const { id } = req.params as { id: string };
    s.tags.delete(id);
    return reply.redirect(bp + "/admin/tags");
  });

  /* ---------- settings (PRD 5.16.4) ---------- */

  app.get("/admin/settings", async (req, reply) => {
    return adminView(req, reply, "admin/settings", {
      title: "Settings",
      siteSettings: s.settings.getSiteSettings(),
      importRules: s.settings.getImportRules(),
      account: s.xAccount.get(),
    });
  });

  app.post("/admin/settings", async (req, reply) => {
    const body = req.body as Record<string, string>;
    const current = s.settings.getSiteSettings();
    s.settings.setSiteSettings({
      ...current,
      authorName: body.author_name?.trim() || current.authorName,
      authorXUrl: body.author_x_url?.trim() ?? current.authorXUrl,
      authorCtaHtml: body.author_cta_html ?? current.authorCtaHtml,
      showBlogViewCounts: body.show_blog_view_counts === "on",
      showArchiveOnPostPages: body.show_archive_on_post_pages === "on",
      amaEnabled: body.ama_enabled === "on",
      rssIncludeFullContent: body.rss_full_content === "on",
      customFooterHtml: body.custom_footer_html ?? current.customFooterHtml,
      controlledTagVocabulary: (body.tag_vocabulary ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      statsIgnoredWords: (body.stats_ignored_words ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    });

    const rules = s.settings.getImportRules();
    s.settings.setImportRules({
      ...rules,
      minimumCharacterCount: Number(body.min_chars) || DEFAULT_IMPORT_RULES.minimumCharacterCount,
      minimumQuoteCommentaryCount: Number(body.min_quote_chars) || DEFAULT_IMPORT_RULES.minimumQuoteCommentaryCount,
      minimumXViewsForAutoPublish: body.min_x_views ? Number(body.min_x_views) : undefined,
      minimumLikesForAutoPublish: body.min_likes ? Number(body.min_likes) : undefined,
      importReplies: body.import_replies === "on",
      importReposts: body.import_reposts === "on",
      importQuotes: body.import_quotes === "on",
      combineThreads: body.combine_threads === "on",
      autoPublishStandalonePosts: body.auto_publish === "on",
      autoPublishAfterMinutes: Number(body.auto_publish_after_minutes) || 0,
      blockedKeywords: (body.blocked_keywords ?? "").split(",").map((k) => k.trim()).filter(Boolean),
      allowedLanguages: (body.allowed_languages ?? "").split(",").map((k) => k.trim()).filter(Boolean),
    });

    if (body.new_admin_password?.trim()) {
      s.auth.setAdminPassword(body.new_admin_password.trim());
      s.auth.audit("admin_password_changed");
    }

    invalidateContentCaches();
    s.auth.audit("settings_update");
    return reply.redirect(bp + "/admin/settings");
  });

  /* ---------- jobs ---------- */

  app.get("/admin/jobs", async (req, reply) => {
    return adminView(req, reply, "admin/jobs", {
      title: "Jobs",
      jobs: s.worker.queue.list(100),
      counts: s.worker.queue.counts(),
    });
  });

  app.post("/admin/jobs/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    s.worker.queue.retryNow(id);
    return reply.redirect(bp + "/admin/jobs");
  });

  app.post("/admin/jobs/enqueue", async (req, reply) => {
    const body = req.body as Record<string, string>;
    const allowed = ["x_import", "x_backfill", "x_metrics_refresh", "recalculate_related", "backup_database", "verify_media"];
    if (allowed.includes(body.type ?? "")) {
      s.worker.queue.enqueue(body.type!, {}, { dedupe: true });
    }
    return reply.redirect(bp + "/admin/jobs");
  });

  /* ---------- subscribers + analytics ---------- */

  app.get("/admin/subscribers", async (req, reply) => {
    return adminView(req, reply, "admin/subscribers", {
      title: "Subscribers",
      subscribers: s.newsletter.list(),
      counts: s.newsletter.counts(),
    });
  });

  app.get("/admin/analytics", async (req, reply) => {
    return adminView(req, reply, "admin/analytics", {
      title: "Analytics",
      daily: s.analytics.dailySeries(30),
      topPosts: s.analytics.topPostsByBlogViews(30, 20),
      topReferrers: s.analytics.topReferrers(30, 20),
      totals: s.analytics.siteTotals(),
    });
  });
}
