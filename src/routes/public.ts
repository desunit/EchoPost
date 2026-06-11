import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config/index.js";
import { cache } from "../lib/cache.js";
import { visitorHash } from "../lib/crypto.js";
import { SORT_MODES, FILTER_MODES, type SortMode, type FilterMode } from "../modules/types.js";
import { embedXReferences, quotedTweetId, quotedTweetUrl } from "../lib/x-embed.js";

// Brand suffix used in page <title> tags. Prefers the X handle ("@desunit Blog")
// and falls back to the configured site title.
const brand = config.x.username ? `@${config.x.username} Blog` : config.siteTitle;

function ownHost(): string {
  try {
    return new URL(config.siteUrl).hostname;
  } catch {
    return "localhost";
  }
}

/** Absolute URL for a media public_url (already absolute under the S3 driver). */
function absoluteMediaUrl(publicUrl: string): string {
  return /^https?:\/\//.test(publicUrl) ? publicUrl : config.siteUrl + publicUrl;
}

function track(app: FastifyInstance, req: FastifyRequest, postId: string | null): void {
  try {
    app.services.analytics.recordView({
      postId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      referrer: req.headers.referer,
      ownHost: ownHost(),
    });
  } catch (err) {
    req.log.warn({ err }, "analytics tracking failed");
  }
}

/** Groups archive items into [{year, posts}] newest year first. */
function groupByYear<T extends { published_at: string | null }>(posts: T[]): Array<{ year: number; posts: T[] }> {
  const groups = new Map<number, T[]>();
  for (const p of posts) {
    const year = p.published_at ? new Date(p.published_at).getUTCFullYear() : 0;
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year)!.push(p);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, items]) => ({ year, posts: items }));
}

export function registerPublicRoutes(app: FastifyInstance): void {
  const s = app.services;

  /* ---------- homepage (PRD 4.2) ---------- */
  app.get("/", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const sort = (SORT_MODES.some((m) => m.key === query.sort) ? query.sort : "latest") as SortMode;
    const filter = (FILTER_MODES.some((m) => m.key === query.filter) ? query.filter : "all") as FilterMode;

    const data = cache.getOrCompute(`home:${sort}:${filter}`, 60_000, () => {
      const posts = s.posts.listArchive({ sort, filter });
      const pinned = posts.filter((p) => p.pinned === 1);
      const totals = s.posts.totalArchiveViews();
      return {
        pinned,
        groups: sort === "latest" || sort === "oldest" ? groupByYear(posts) : [{ year: 0, posts }],
        grouped: sort === "latest" || sort === "oldest",
        totals,
        count: posts.length,
      };
    });

    track(app, req, null);
    return app.view(reply, "home", {
      title: brand,
      sort,
      filter,
      sortModes: SORT_MODES,
      filterModes: FILTER_MODES,
      ...data,
    });
  });

  /* ---------- tags ---------- */
  app.get("/tags", async (req, reply) => {
    const tags = cache.getOrCompute("tags", 5 * 60_000, () => s.tags.listWithCounts());
    return app.view(reply, "tags", { title: `Tags — ${brand}`, tags });
  });

  app.get("/tag/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const tag = s.tags.getBySlug(slug);
    if (!tag) {
      // tag aliases keep renamed tags reachable
      const aliased = s.db
        .prepare("SELECT t.slug FROM tags t JOIN tag_aliases a ON a.tag_id = t.id WHERE a.alias = ?")
        .get(slug) as { slug: string } | undefined;
      if (aliased) return reply.code(301).redirect(`${config.basePath}/tag/${aliased.slug}`);
      return reply.callNotFound();
    }
    const posts = s.tags.postsForTag(tag.id);
    return app.view(reply, "tag", {
      title: `${tag.name} — ${brand}`,
      tag,
      posts,
      groups: groupByYear(posts),
    });
  });

  app.get("/tag/:slug/rss", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const tag = s.tags.getBySlug(slug);
    if (!tag) return reply.callNotFound();
    return reply
      .type("application/rss+xml; charset=utf-8")
      .send(s.rss.build({ tagSlug: slug, title: `${tag.name} — ${brand}` }));
  });

  /* ---------- stats (PRD 5.11) ---------- */
  app.get("/stats", async (req, reply) => {
    const stats = s.stats.build();
    track(app, req, null);
    return app.view(reply, "stats", { title: `Stats — ${brand}`, stats });
  });

  /* ---------- feeds + SEO ---------- */
  app.get("/rss", async (_req, reply) =>
    reply.type("application/rss+xml; charset=utf-8").send(s.rss.build()),
  );
  app.get("/rss/x", async (_req, reply) =>
    reply.type("application/rss+xml; charset=utf-8").send(s.rss.build({ type: "x_post", title: `X posts — ${brand}` })),
  );
  app.get("/rss/blog", async (_req, reply) =>
    reply.type("application/rss+xml; charset=utf-8").send(s.rss.build({ type: "blog", title: `Blog — ${brand}` })),
  );
  app.get("/sitemap.xml", async (_req, reply) =>
    reply.type("application/xml; charset=utf-8").send(s.seo.sitemap()),
  );
  app.get("/robots.txt", async (_req, reply) => reply.type("text/plain").send(s.seo.robotsTxt()));

  /* ---------- search (PRD 5.14) ---------- */
  app.get("/search", async (req, reply) => {
    const { q = "", sort = "relevance" } = req.query as Record<string, string>;
    const results = q
      ? s.search.search(q, ["relevance", "latest", "most_viewed", "x_views", "blog_views"].includes(sort) ? (sort as any) : "relevance")
      : [];
    return app.view(reply, "search", { title: `Search — ${brand}`, q, sort, results });
  });

  /* ---------- newsletter (PRD 5.9) ---------- */
  app.post("/subscribe", async (req, reply) => {
    const body = req.body as Record<string, string>;
    const result = await s.newsletter.subscribe(body.email ?? "", body.source ?? "homepage");
    return app.view(reply, "message", {
      title: "Newsletter",
      heading: result.ok ? "Almost there" : "Subscription failed",
      message: result.message,
    });
  });

  app.get("/subscribe/confirm", async (req, reply) => {
    const { token = "" } = req.query as Record<string, string>;
    const subscriber = await s.newsletter.confirm(token);
    return app.view(reply, "message", {
      title: "Newsletter",
      heading: subscriber ? "Subscription confirmed" : "Invalid or expired link",
      message: subscriber
        ? "Welcome aboard — you'll get new posts by email."
        : "This confirmation link is not valid. Try subscribing again.",
    });
  });

  app.get("/unsubscribe", async (req, reply) => {
    const { token = "" } = req.query as Record<string, string>;
    const ok = s.newsletter.unsubscribe(token);
    return app.view(reply, "message", {
      title: "Newsletter",
      heading: ok ? "Unsubscribed" : "Invalid link",
      message: ok ? "You won't receive further emails." : "This unsubscribe link is not valid.",
    });
  });

  /* ---------- AMA (PRD 5.15) ---------- */
  app.get("/ama", async (req, reply) => {
    if (!s.ama.isEnabled()) return reply.callNotFound();
    return app.view(reply, "ama", { title: `Ask my archive — ${brand}`, answer: null, question: "", sources: [] });
  });

  app.post("/ama", async (req, reply) => {
    if (!s.ama.isEnabled()) return reply.callNotFound();
    const body = req.body as Record<string, string>;
    const question = (body.question ?? "").trim();
    if (!question) return reply.redirect(`${config.basePath}/ama`);

    const key = visitorHash(req.ip, req.headers["user-agent"] ?? "", new Date().toISOString().slice(0, 10));
    if (!s.ama.checkRateLimit(key)) {
      return app.view(reply, "ama", {
        title: `Ask my archive — ${brand}`,
        question,
        answer: "Rate limit reached — please try again in an hour.",
        sources: [],
      });
    }
    const result = await s.ama.ask(question);
    s.auth.audit("ama_question", { length: question.length });
    return app.view(reply, "ama", {
      title: `Ask my archive — ${brand}`,
      question,
      answer: result.answer,
      sources: result.sources,
    });
  });

  /* ---------- post page (PRD 5.6) — keep last: catch-all slug ---------- */
  app.get("/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const post = s.posts.getBySlug(slug);
    if (!post) return reply.callNotFound();
    // hidden/archived stay reachable by direct URL per PRD; drafts/review do not
    if (!["published", "hidden", "archived"].includes(post.status)) return reply.callNotFound();

    track(app, req, post.id);

    const data = cache.getOrCompute(`post:${post.id}`, 60_000, () => {
      const tags = s.tags.forPost(post.id);
      const media = s.media.forPost(post.id);
      const related = s.related.forPost(post.id);
      const { prev, next } = s.posts.adjacent(post);
      const metrics = s.posts.latestMetrics(post.id);
      const blogViews = s.posts.blogViews(post.id);
      const totals = s.posts.totalArchiveViews();
      const archiveGroups = groupByYear(s.posts.listArchive({ sort: "latest" }));
      // Resolve X references: own-account quotes → internal cards, others → widgets.
      const account = s.xAccount.get();
      const { html: bodyHtml, hasWidget: hasXWidget } = embedXReferences(post.html_body ?? "", {
        ownUserId: account.x_user_id ?? "",
        ownUsername: account.username ?? "",
        quotedTweetId: quotedTweetId(post.x_raw_json),
        quotedTweetUrl: quotedTweetUrl(post.x_raw_json),
        lookup: (tweetId) => {
          const ref = s.posts.getByXPostId(tweetId);
          if (!ref || ref.id === post.id) return null; // not ours / self-reference
          const img = s.media.forPost(ref.id).find((m) => m.mime_type?.startsWith("image/"));
          return { slug: ref.slug, title: ref.title, excerpt: ref.excerpt ?? "", thumbnailUrl: img?.public_url };
        },
      });
      // og:image: the post's chosen image, else the first available image —
      // including a video's poster thumbnail — so every post with a picture
      // (photo or video) shares one as its social card.
      const ogMedia =
        media.find((m) => m.id === post.og_image_media_id && m.mime_type?.startsWith("image/")) ??
        media.find((m) => m.mime_type?.startsWith("image/"));
      const ogImage = ogMedia ? absoluteMediaUrl(ogMedia.public_url) : undefined;

      return {
        tags, media, related, prev, next, metrics, blogViews, totals, archiveGroups, bodyHtml, hasXWidget,
        ogImage, ogType: "article", metaDescription: post.seo_description || post.excerpt || undefined,
      };
    });

    return app.view(reply, "post", {
      title: post.seo_title || `${post.title} — ${brand}`,
      post,
      jsonLd: s.seo.jsonLd(post, s.settings.getSiteSettings().authorName),
      canonicalUrl: post.canonical_url || `${config.publicUrl}/${post.slug}`,
      ...data,
    });
  });
}
