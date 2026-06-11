import { describe, expect, it, beforeEach } from "vitest";
import { AnalyticsService, isBot, referrerDomain } from "../src/modules/analytics/service.js";
import { PostsService } from "../src/modules/posts/service.js";
import { visitorHash } from "../src/lib/crypto.js";
import { testDb } from "./helpers.js";
import type { DB } from "../src/db/index.js";

let db: DB;
let analytics: AnalyticsService;
let postId: string;

const CHROME_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

beforeEach(() => {
  db = testDb();
  analytics = new AnalyticsService(db);
  postId = new PostsService(db).create({ title: "T", type: "blog", status: "published" }).id;
});

describe("bot detection", () => {
  it("flags crawlers and tools", () => {
    expect(isBot("Googlebot/2.1 (+http://www.google.com/bot.html)")).toBe(true);
    expect(isBot("GPTBot/1.0")).toBe(true);
    expect(isBot("curl/8.0")).toBe(true);
    expect(isBot(undefined)).toBe(true);
  });

  it("passes real browsers", () => {
    expect(isBot(CHROME_UA)).toBe(false);
  });
});

describe("referrer parsing", () => {
  it("extracts external domains and drops own host", () => {
    expect(referrerDomain("https://news.ycombinator.com/item?id=1", "example.com")).toBe("news.ycombinator.com");
    expect(referrerDomain("https://www.example.com/page", "example.com")).toBeNull();
    expect(referrerDomain("not a url", "example.com")).toBeNull();
  });
});

describe("view recording", () => {
  const view = (ip: string, ua = CHROME_UA) =>
    analytics.recordView({ postId, ip, userAgent: ua, referrer: "https://x.com/foo", ownHost: "example.com" });

  it("separates human and bot views without storing raw IPs", () => {
    view("203.0.113.5");
    view("203.0.113.5", "Googlebot/2.1");
    const row = db.prepare("SELECT * FROM post_daily_views WHERE post_id = ?").get(postId) as any;
    expect(row.human_views).toBe(1);
    expect(row.bot_views).toBe(1);
    const logged = db.prepare("SELECT visitor_hash FROM daily_visitor_log").all() as any[];
    for (const l of logged) expect(l.visitor_hash).not.toContain("203.0.113");
  });

  it("estimates unique visitors per day", () => {
    view("203.0.113.5");
    view("203.0.113.5"); // same visitor again
    view("198.51.100.7"); // different /24
    const row = db.prepare("SELECT * FROM post_daily_views WHERE post_id = ?").get(postId) as any;
    expect(row.human_views).toBe(3);
    expect(row.unique_visitors).toBe(2);
  });

  it("aggregates referrers", () => {
    view("203.0.113.5");
    const ref = db.prepare("SELECT * FROM referrer_daily_stats").get() as any;
    expect(ref.referrer_domain).toBe("x.com");
    expect(ref.view_count).toBe(1);
  });

  it("rotates the visitor hash daily", () => {
    const h1 = visitorHash("203.0.113.5", CHROME_UA, "2026-06-10");
    const h2 = visitorHash("203.0.113.5", CHROME_UA, "2026-06-11");
    expect(h1).not.toBe(h2);
  });

  it("prunes the visitor log", () => {
    db.prepare("INSERT INTO daily_visitor_log (view_date, visitor_hash, post_id) VALUES ('2020-01-01', 'x', '')").run();
    expect(analytics.pruneVisitorLog(3)).toBe(1);
  });
});
