/**
 * Development seed: a few posts across types, tags, metric snapshots, and
 * fake analytics so every page has something to render.
 */
import { getDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { PostsService } from "../modules/posts/service.js";
import { TagsService } from "../modules/tags/service.js";
import { RelatedPostsService } from "../modules/related-posts/service.js";
import { nowIso, daysAgoIso, daysAgoDate } from "../lib/time.js";

const db = getDb();
runMigrations(db);

if ((db.prepare("SELECT COUNT(*) AS c FROM posts").get() as any).c > 0) {
  console.log("Database already has posts — skipping seed.");
  process.exit(0);
}

const posts = new PostsService(db);
const tags = new TagsService(db);
const related = new RelatedPostsService(db);

const samples = [
  {
    title: "Everyone can now build apps with AI, so distribution is the real challenge",
    type: "x_post" as const,
    daysAgo: 5,
    xPostId: "1900000000000000001",
    body: "Everyone can now build apps with AI.\n\nThe hard part isn't shipping anymore — it's getting anyone to care. Distribution is the new moat.\n\nOwn your audience: an email list, a blog, a community. Platforms change their algorithms; your archive doesn't.",
    tags: ["AI", "Startups", "Distribution"],
    metrics: { impressions: 7_556_438, likes: 5_527, reposts: 336 },
    pinned: true,
  },
  {
    title: "Why I mirror my X posts to my own blog",
    type: "blog" as const,
    daysAgo: 30,
    body: "X is the writing and distribution layer.\n\nThe website is the permanent archive, the SEO layer, and the audience-capture layer.\n\n## Why bother\n\n- Posts on X stop being discoverable within days\n- Google can't index what an algorithm buried\n- An owned archive compounds for years",
    tags: ["Blogging", "SEO", "Indie Hacking"],
  },
  {
    title: "Notes from building a one-VPS publishing stack",
    type: "long_form" as const,
    daysAgo: 90,
    body: "SQLite, one Node.js process, a reverse proxy. That's the whole stack.\n\nNo Redis, no Kubernetes, no managed databases. WAL mode handles the concurrency a personal site will ever see, and `VACUUM INTO` gives you single-file backups.",
    tags: ["SQLite", "Node.js", "Infrastructure"],
    metrics: { impressions: 250_000, likes: 1_200, reposts: 80 },
    xPostId: "1900000000000000002",
  },
  {
    title: "Talk: owning your content in the platform era",
    type: "presentation" as const,
    daysAgo: 200,
    body: "Slides and notes from my talk about content ownership, archives, and why every creator should keep a copy of everything they publish.",
    tags: ["Content", "Talks"],
  },
  {
    title: "Podcast: the compounding value of old posts",
    type: "podcast" as const,
    daysAgo: 400,
    body: "We discuss why a five-year-old post can outperform anything you wrote this week — if it has a permanent URL and internal links pointing at it.",
    tags: ["Content", "SEO"],
  },
];

for (const sample of samples) {
  const publishedAt = daysAgoIso(sample.daysAgo);
  const post = posts.create({
    title: sample.title,
    type: sample.type,
    status: "published",
    publishedAt,
    markdownBody: sample.body,
    pinned: sample.pinned ?? false,
    xPostId: sample.xPostId ?? null,
    sourceUrl: sample.xPostId ? `https://x.com/example/status/${sample.xPostId}` : null,
    importedAt: sample.xPostId ? publishedAt : null,
  });
  tags.setPostTags(post.id, sample.tags);
  posts.syncSearchIndex(posts.getById(post.id)!);

  if (sample.metrics) {
    // two snapshots so 30-day growth has data
    db.prepare(
      `INSERT INTO x_metric_snapshots (post_id, impression_count, like_count, repost_count, reply_count, quote_count, collected_at)
       VALUES (?, ?, ?, ?, 0, 0, ?)`,
    ).run(post.id, Math.floor(sample.metrics.impressions * 0.7), Math.floor(sample.metrics.likes * 0.7), sample.metrics.reposts, daysAgoIso(35));
    db.prepare(
      `INSERT INTO x_metric_snapshots (post_id, impression_count, like_count, repost_count, reply_count, quote_count, collected_at)
       VALUES (?, ?, ?, ?, 0, 0, ?)`,
    ).run(post.id, sample.metrics.impressions, sample.metrics.likes, sample.metrics.reposts, nowIso());
  }

  // fake daily views for the last two weeks
  for (let d = 0; d < 14; d++) {
    const views = Math.floor(Math.random() * 40) + 2;
    db.prepare(
      `INSERT INTO post_daily_views (post_id, view_date, human_views, bot_views, unique_visitors)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(post.id, daysAgoDate(d), views, Math.floor(views / 4), Math.floor(views * 0.8));
    db.prepare(
      `INSERT INTO site_daily_views (view_date, human_views, bot_views, unique_visitors)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(view_date) DO UPDATE SET human_views = human_views + excluded.human_views`,
    ).run(daysAgoDate(d), views, Math.floor(views / 4), Math.floor(views * 0.8));
  }
}

// topic groups for the stats squares
db.prepare("UPDATE tags SET category_group = 'Business and tech' WHERE slug IN ('ai', 'startups', 'sqlite', 'node-js', 'infrastructure')").run();

related.recalculateAll();
console.log(`Seeded ${samples.length} posts.`);
