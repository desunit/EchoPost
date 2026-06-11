# PRD: Personal Content Archive and X-to-Blog Mirror

**Working name:** EchoPost
**Version:** 1.0
**Primary implementation:** Node.js + TypeScript + SQLite
**Reference product:** Levels.io-style personal blog and X mirror
**Audience:** solo founder, small internal engineering team, AI coding agent

---

# 1. Product Summary

Build a lightweight personal publishing platform that automatically imports selected posts from an X account and publishes them as permanent, SEO-friendly blog pages.

The platform must support:

* traditional manually written blog posts;
* mirrored X posts;
* long-form articles;
* presentations;
* podcasts;
* pinned posts;
* tags and topic pages;
* RSS;
* newsletter subscription;
* local blog view tracking;
* X metrics synchronization;
* related-post recommendations;
* chronological archive pages;
* public statistics;
* an optional AI-powered “ask my archive” page;
* a minimal private admin panel.

The system should feel closer to an owned personal knowledge base than a traditional CMS.

The core principle:

> X is the writing and distribution layer.
> The website is the permanent archive, SEO layer, and audience-capture layer.

---

# 2. Goals

## 2.1 Primary goals

1. Convert useful X posts into permanent, indexable webpages.
2. Preserve content independently of X.
3. Retain original images and metadata locally.
4. Show social engagement metrics next to imported posts.
5. Make old content discoverable through tags, related posts, RSS, internal navigation, and search engines.
6. Capture email subscribers from both the homepage and individual post pages.
7. Minimize ongoing publishing effort.
8. Keep infrastructure simple enough to run on one VPS.

## 2.2 Secondary goals

1. Identify which ideas perform well on X and which perform well through organic web traffic.
2. Create a reusable personal knowledge base for future AI search.
3. Support importing older content in bulk.
4. Support manual editing without breaking synchronization.
5. Allow gradual extension into a reusable open-source publishing engine.

## 2.3 Non-goals for v1

1. Multi-author publication workflows.
2. Complex editorial permissions.
3. A full Medium-style rich-text editor.
4. Social-network functionality such as comments, follows, or likes.
5. Real-time analytics comparable to Google Analytics.
6. Full email campaign automation.
7. Replicating private internal functionality that is not visible from the reference site.

---

# 3. Target User

## 3.1 Primary user

A founder or creator who:

* publishes regularly on X;
* wants an owned archive;
* prefers low-maintenance infrastructure;
* wants to compound the value of old posts;
* does not want to manually convert every X post into a blog article.

## 3.2 Reader personas

### Social visitor

Arrives from X after reading a post and may subscribe to email.

### Search visitor

Finds an old post through Google or an AI search tool.

### Returning reader

Browses the archive, tags, popular posts, and related posts.

### Author

Reviews imports, edits titles, controls publication, and monitors traffic.

---

# 4. User Experience Overview

## 4.1 Public routes

| Route          | Purpose                          |
| -------------- | -------------------------------- |
| `/`            | Main archive homepage            |
| `/:slug`       | Individual public post           |
| `/tags`        | All tags with post counts        |
| `/tag/:slug`   | Posts for a tag                  |
| `/stats`       | Public archive statistics        |
| `/rss`         | RSS feed                         |
| `/sitemap.xml` | XML sitemap                      |
| `/robots.txt`  | Search-engine rules              |
| `/ama`         | Optional AI archive Q&A          |
| `/subscribe`   | Newsletter subscription endpoint |
| `/unsubscribe` | Newsletter unsubscribe endpoint  |
| `/admin/*`     | Private admin panel              |

## 4.2 Homepage layout

The homepage must contain:

1. Sort controls.
2. Filter controls.
3. Pinned posts section.
4. Newsletter signup.
5. Chronological archive grouped by year.
6. Footer navigation.
7. Total archive view count.

### Sort modes

| Key              | Label          | Behavior                                            |
| ---------------- | -------------- | --------------------------------------------------- |
| `latest`         | Latest         | Newest published posts first                        |
| `oldest`         | Oldest         | Oldest published posts first                        |
| `x_views`        | Views          | Highest current X impressions first                 |
| `blog_views`     | Blog views     | Highest internal page views first                   |
| `x_views_30d`    | Views 30d      | Highest X impression growth during previous 30 days |
| `blog_views_30d` | Blog views 30d | Highest internal page views during previous 30 days |

### Content filters

| Key            | Label         |
| -------------- | ------------- |
| `all`          | All           |
| `blog`         | Blog          |
| `x_post`       | X posts       |
| `long_form`    | Long form     |
| `presentation` | Presentations |
| `podcast`      | Podcasts      |

### Archive item rendering

Each archive list item should show:

* publication date;
* thumbnail indicator or image;
* title;
* content-type marker;
* X marker for mirrored posts;
* optional featured marker;
* internal link to post page.

---

# 5. Functional Requirements

# 5.1 Content Model

The system must support the following content types:

```ts
type ContentType =
  | "x_post"
  | "blog"
  | "long_form"
  | "presentation"
  | "podcast"
  | "link"
  | "ama";
```

Every public content item must support:

* unique ID;
* title;
* slug;
* publication date;
* content type;
* status;
* excerpt;
* body;
* HTML body;
* source URL;
* canonical URL;
* optional X post ID;
* optional external URL;
* optional thumbnail;
* tags;
* attached media;
* SEO metadata;
* featured flag;
* pinned flag;
* related posts;
* chronological previous and next post;
* internal view metrics;
* external metrics;
* audit timestamps.

## 5.1.1 Publishing states

```ts
type PublicationStatus =
  | "imported"
  | "draft"
  | "review"
  | "published"
  | "hidden"
  | "archived";
```

Rules:

* Imported X posts enter `review` by default.
* Posts may auto-publish when they match configurable rules.
* `hidden` posts stay stored but are excluded from public pages and feeds.
* `archived` posts remain accessible if their direct URL is known but are excluded from the homepage unless configured otherwise.

---

# 5.2 X Integration

## 5.2.1 Authentication

Support two authentication modes:

### Bearer-token mode

Used to retrieve public data.

### User-context OAuth mode

Used when the connected account owner authorizes access to additional private metrics.

Store tokens encrypted at rest.

Environment variables:

```env
X_CLIENT_ID=
X_CLIENT_SECRET=
X_BEARER_TOKEN=
X_REDIRECT_URI=
APP_ENCRYPTION_KEY=
```

## 5.2.2 X account configuration

The admin panel must allow the author to connect one X account.

Store:

* X user ID;
* username;
* display name;
* profile image;
* connection status;
* token expiration;
* last successful synchronization timestamp;
* last imported X post ID;
* last metrics refresh timestamp.

## 5.2.3 Import pipeline

Use the X user-timeline endpoint to request posts authored by the connected account.

The importer must:

1. Request new posts since the latest known X post ID.
2. Exclude reposts by default.
3. Exclude replies by default.
4. Detect quote posts.
5. Retrieve media expansions.
6. Retrieve public engagement metrics.
7. Normalize X data into internal records.
8. Download attached images locally or into object storage.
9. Preserve original X URLs.
10. Save the original JSON response for debugging.
11. Generate a proposed title, slug, tags, excerpt, and SEO description.
12. Add the item to a review queue or auto-publish based on rules.
13. Rebuild related-post recommendations.
14. Refresh sitemap and RSS cache.

## 5.2.4 Import rules

Default rules:

| Post type                                       | Default behavior                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| Original post with complete standalone text     | Import                                                                |
| Thread root                                     | Import and combine thread                                             |
| Thread continuation                             | Attach to root                                                        |
| Reply                                           | Ignore                                                                |
| Repost                                          | Ignore                                                                |
| Quote post with substantial original commentary | Import                                                                |
| Quote post with almost no original commentary   | Ignore                                                                |
| Post marked sensitive                           | Import as draft only                                                  |
| Deleted X post                                  | Mark source as unavailable; do not automatically delete local archive |

Admin-configurable thresholds:

```ts
interface ImportRules {
  minimumCharacterCount: number;
  minimumXViewsForAutoPublish?: number;
  minimumLikesForAutoPublish?: number;
  importReplies: boolean;
  importReposts: boolean;
  importQuotes: boolean;
  combineThreads: boolean;
  autoPublishStandalonePosts: boolean;
  autoPublishAfterMinutes: number;
  blockedKeywords: string[];
  allowedLanguages: string[];
}
```

## 5.2.5 Thread handling

When a post belongs to a thread:

1. Detect the root post.
2. Fetch connected posts authored by the same account.
3. Preserve the original order.
4. Create one article page for the root.
5. Render each thread item as a separate section.
6. Attach media to the appropriate section.
7. Preserve links to original X items.
8. Update the article when new thread items appear.

## 5.2.6 Metrics synchronization

Synchronize the following public metrics:

```ts
interface XPublicMetrics {
  impressionCount: number;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  quoteCount: number;
  bookmarkCount?: number;
}
```

Optionally synchronize private metrics for recent posts:

```ts
interface XPrivateMetrics {
  urlLinkClicks?: number;
  profileClicks?: number;
  engagements?: number;
}
```

Metrics refresh strategy:

| Post age       | Refresh interval |
| -------------- | ---------------- |
| Under 24 hours | Every 15 minutes |
| 1–7 days       | Every hour       |
| 8–30 days      | Every 6 hours    |
| 31–180 days    | Daily            |
| Over 180 days  | Weekly           |

Store every metrics observation rather than overwriting the previous value. This enables charts and 30-day growth calculations.

## 5.2.7 X API resilience

The integration must support:

* rate-limit detection;
* exponential backoff;
* retry queue;
* dead-letter logging;
* sync status visibility;
* manual retry;
* token-expiration handling;
* partial-response handling;
* media-download retry;
* idempotent imports.

---

# 5.3 Manual Publishing

The admin panel must allow manual creation and editing of content.

## 5.3.1 Editor fields

* title;
* slug;
* content type;
* publication date;
* excerpt;
* Markdown body;
* rendered HTML preview;
* tags;
* featured image;
* attached media;
* source URL;
* canonical URL;
* SEO title;
* SEO description;
* Open Graph image;
* pinned flag;
* featured flag;
* status;
* related-post overrides.

## 5.3.2 Markdown rendering

Use Markdown as the canonical editable content format.

Support:

* headings;
* paragraphs;
* bold and italics;
* links;
* images;
* videos;
* blockquotes;
* code fences;
* lists;
* embedded X links;
* tables;
* horizontal separators.

Sanitize generated HTML before rendering.

---

# 5.4 Title and Metadata Generation

Imported X posts often lack titles. Generate proposed metadata automatically.

## 5.4.1 Title generation

Generate a readable headline based on the post text.

Requirements:

* preserve the author’s tone;
* avoid generic clickbait;
* keep titles under 100 characters when possible;
* describe the actual idea;
* avoid hallucinated claims;
* permit manual editing;
* preserve edited titles during future X synchronizations.

## 5.4.2 Slug generation

Rules:

1. Convert title to lowercase.
2. Transliterate where appropriate.
3. Replace spaces and punctuation with hyphens.
4. Remove repeated hyphens.
5. Enforce uniqueness.
6. Preserve slug permanently after publication unless manually changed.
7. Create HTTP 301 redirects after slug changes.

Example:

```text
Everyone can now build apps with AI, so distribution is the real challenge
```

becomes:

```text
everyone-can-build-apps-with-ai-distribution-is-the-real-challenge
```

## 5.4.3 Tag generation

Generate 2–8 suggested tags using:

* configured controlled vocabulary;
* keyword extraction;
* optional AI classification;
* existing tag reuse;
* manual review.

Avoid creating near-duplicate tags such as:

* `AI`
* `Artificial Intelligence`
* `artificial-intelligence`
* `A.I.`

Use tag aliases and canonical tags.

---

# 5.5 Media Storage

All attached media must be copied away from X-controlled URLs.

## 5.5.1 Supported media types

* image;
* animated GIF;
* video thumbnail;
* video metadata;
* audio;
* document attachment;
* Open Graph preview image.

## 5.5.2 Storage adapters

Support two adapters:

### Local filesystem

Default for a single VPS.

```env
MEDIA_STORAGE_DRIVER=local
MEDIA_STORAGE_PATH=./data/media
MEDIA_PUBLIC_URL=/media
```

### S3-compatible storage

Optional for production portability.

```env
MEDIA_STORAGE_DRIVER=s3
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_PUBLIC_URL=
```

## 5.5.3 Media-processing requirements

* preserve original file;
* compute SHA-256 checksum;
* deduplicate identical media;
* extract width and height;
* generate thumbnails;
* generate responsive sizes;
* preserve alt text;
* strip unsafe metadata if configured;
* prevent remote hotlinking;
* use lazy loading;
* store source URL for provenance.

---

# 5.6 Post Page

Each post page must render:

1. Back-to-archive link.
2. H1 title.
3. Publication date.
4. X metrics when available.
5. Blog view count if enabled.
6. Tags.
7. Main content.
8. Attached media.
9. Link to the original X post.
10. Author call-to-action section.
11. Newsletter signup.
12. Related posts.
13. Previous and next chronological posts.
14. Full year-grouped archive below the article, configurable.
15. Footer links.
16. Total archive view count.

## 5.6.1 X metric display

Example format:

```text
9 December, 2024 · 7,556,438 views · 5,527 likes · 336 reposts
```

Clicking an X metric should link to the original X post.

## 5.6.2 Source attribution

For imported X posts, show:

```text
Originally posted on X
```

with a link to the source post.

## 5.6.3 Author CTA

Configurable author footer:

```text
P.S. I'm on X too if you'd like to follow more of my stories.
See a list of my projects or contact me.
```

The admin panel must allow editing this block globally.

---

# 5.7 Related Posts

Each published post must show five related posts.

## 5.7.1 Related-post algorithm

Use a hybrid score:

```text
related_score =
  0.45 × tag_similarity
+ 0.25 × text_similarity
+ 0.10 × content_type_similarity
+ 0.10 × recency_diversity
+ 0.10 × popularity_score
```

Do not show:

* the current post;
* hidden posts;
* drafts;
* duplicate pages;
* more than two posts from the same week unless the archive is small.

## 5.7.2 SQLite implementation

Use SQLite FTS5 for text similarity in v1.

FTS index fields:

* title;
* excerpt;
* normalized body;
* tag names.

Example virtual table:

```sql
CREATE VIRTUAL TABLE post_search USING fts5(
  post_id UNINDEXED,
  title,
  excerpt,
  body,
  tags
);
```

## 5.7.3 Optional embedding enhancement

Support an optional embeddings adapter later.

```ts
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}
```

Embeddings may be stored as JSON or binary blobs. For a small archive, cosine similarity may be calculated in application code.

## 5.7.4 Manual overrides

Admin controls:

* pin a related post;
* block a related post;
* recalculate suggestions;
* preview related posts before publication.

---

# 5.8 Internal Blog Analytics

The application must track its own blog traffic independently of X.

## 5.8.1 Metrics

Track:

* page views;
* unique visitor estimate;
* views by post;
* views by day;
* views during previous 30 days;
* referrer domain;
* campaign UTM values;
* browser category;
* country code if obtained through reverse proxy headers;
* bot status;
* first visit timestamp;
* last visit timestamp.

## 5.8.2 Privacy-first visitor identification

Create a daily rotating anonymous visitor hash:

```text
SHA256(ip_prefix + user_agent + date + server_secret)
```

Do not store raw IP addresses by default.

## 5.8.3 Bot filtering

Exclude common crawlers from human-view counters but log them separately.

Examples:

* Googlebot;
* Bingbot;
* social preview crawlers;
* AI crawlers;
* RSS readers;
* uptime monitors.

## 5.8.4 View aggregation

Maintain raw daily aggregates rather than unbounded event logs.

Store:

* total views;
* daily human views;
* daily bot views;
* estimated daily unique visitors;
* referrer counts;
* UTM counts.

This keeps SQLite compact.

---

# 5.9 Newsletter Subscription

Support a newsletter signup form on:

* homepage;
* every post page;
* optional footer;
* optional dedicated subscription page.

## 5.9.1 Subscription flow

1. Reader enters email.
2. Validate syntax.
3. Normalize email.
4. Store pending subscriber.
5. Send double-opt-in email.
6. Reader clicks confirmation link.
7. Mark subscriber active.
8. Send welcome email.
9. Support one-click unsubscribe.

## 5.9.2 Subscriber states

```ts
type SubscriberStatus =
  | "pending"
  | "active"
  | "unsubscribed"
  | "bounced"
  | "complained";
```

## 5.9.3 Email provider adapter

```ts
interface EmailProvider {
  sendTransactionalEmail(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<void>;
}
```

Initial providers:

* SMTP;
* Resend;
* Postmark;
* Amazon SES.

## 5.9.4 Optional external newsletter integration

Support webhook forwarding to an external provider such as Buttondown, ConvertKit, Beehiiv, or Mailchimp.

---

# 5.10 Tags

## 5.10.1 Tags directory

Route:

```text
/tags
```

Render:

* total number of tags;
* tag list;
* count of published posts for each tag;
* links to tag-specific pages.

## 5.10.2 Tag page

Route:

```text
/tag/:slug
```

Render:

* tag name;
* post count;
* posts sorted by date;
* optional tag description;
* optional related tags;
* RSS link for tag.

## 5.10.3 Tag management

Admin functionality:

* create tag;
* rename tag;
* merge tags;
* add alias;
* delete unused tag;
* bulk-tag posts;
* recalculate auto-tags.

---

# 5.11 Statistics Page

Route:

```text
/stats
```

## 5.11.1 Top-level statistics

Render:

* total published posts;
* total words;
* total X views;
* total blog views;
* total combined views;
* total tags;
* first-publication year.

## 5.11.2 Topics section

Render top tags with counts.

## 5.11.3 Most-viewed section

Render:

* most-viewed posts by X impressions;
* most-viewed posts by blog views;
* highest X-growth posts during previous 30 days;
* highest blog-traffic posts during previous 30 days.

## 5.11.4 Most-used words

Generate a word cloud or ranked text list.

Exclude:

* stop words;
* URLs;
* punctuation;
* Markdown syntax;
* configurable ignored terms.

## 5.11.5 Post history visualization

Display one square per post.

Axes:

* horizontal: publication timeline;
* group or color: topic category.

Support topic groups:

* Business and tech;
* Travel and countries;
* Music and arts;
* Politics;
* Society;
* Health and life;
* Philosophy;
* Other.

Each square should link to the post.

---

# 5.12 RSS

Route:

```text
/rss
```

Requirements:

* valid RSS 2.0 or Atom feed;
* latest 50 posts;
* title;
* link;
* GUID;
* publication date;
* author;
* excerpt;
* full rendered content if configured;
* media attachments;
* content type;
* canonical URL;
* source X URL where relevant.

Optional feeds:

```text
/rss/x
/rss/blog
/tag/:slug/rss
```

---

# 5.13 SEO

Every published page must have:

* stable URL;
* canonical link;
* title tag;
* meta description;
* Open Graph metadata;
* Twitter/X card metadata;
* JSON-LD Article schema;
* sitemap entry;
* RSS entry;
* semantic headings;
* responsive images;
* alt text;
* internal links;
* clean HTML output.

## 5.13.1 Sitemap

Generate:

```text
/sitemap.xml
```

Include:

* published posts;
* tag pages;
* stats page;
* homepage;
* optional AMA page.

Exclude:

* drafts;
* hidden posts;
* admin routes;
* subscription confirmation pages.

## 5.13.2 Redirects

Support:

* old slug to new slug;
* imported legacy URL to current URL;
* HTTP 301 redirects;
* redirect audit history.

---

# 5.14 Optional Archive Search

Route:

```text
/search?q=
```

Use SQLite FTS5.

Search:

* title;
* body;
* tags;
* excerpt;
* source URL.

Sort by:

* relevance;
* latest;
* most viewed;
* X views;
* blog views.

---

# 5.15 Optional AI “Ask My Archive”

Route:

```text
/ama
```

Purpose:

Allow readers to ask questions about published posts.

## 5.15.1 Flow

1. User submits a question.
2. Search archive using FTS5.
3. Retrieve top relevant post fragments.
4. Optionally rerank results with embeddings.
5. Send context and question to configured LLM.
6. Return a concise answer.
7. Include links to source posts.
8. Log anonymous query analytics.
9. Add rate limiting.

## 5.15.2 Provider interface

```ts
interface LlmProvider {
  answer(input: {
    question: string;
    context: Array<{
      postId: string;
      title: string;
      url: string;
      text: string;
    }>;
  }): Promise<{
    answer: string;
    citations: Array<{
      postId: string;
      url: string;
    }>;
  }>;
}
```

## 5.15.3 Safety controls

* only answer from indexed archive content;
* show source links;
* state when the archive lacks enough information;
* block prompt injection in archived content;
* rate-limit by visitor hash;
* cap context and answer size;
* log token usage;
* allow the author to disable the feature.

---

# 5.16 Admin Panel

Route prefix:

```text
/admin
```

Authentication options:

* password + session cookie;
* magic link;
* GitHub OAuth;
* Google OAuth.

For a single-author installation, password + TOTP is sufficient.

## 5.16.1 Admin dashboard

Show:

* pending review count;
* posts imported today;
* X sync status;
* metrics sync status;
* failed jobs;
* new subscriber count;
* blog views today;
* top blog posts this week;
* top X posts this week;
* storage usage.

## 5.16.2 Content review queue

Each imported X post shows:

* original post text;
* media preview;
* proposed title;
* proposed slug;
* proposed tags;
* X metrics;
* source URL;
* publication controls;
* ignore button;
* publish button;
* edit button;
* combine-with-thread button.

## 5.16.3 Bulk actions

Support:

* publish selected;
* hide selected;
* regenerate titles;
* regenerate tags;
* resync X metrics;
* recalculate related posts;
* export selected posts;
* re-download missing media.

## 5.16.4 Settings

Sections:

* general site settings;
* author profile;
* X integration;
* import rules;
* newsletter;
* email provider;
* SEO;
* analytics;
* AI provider;
* media storage;
* jobs;
* backup;
* theme;
* custom HTML footer;
* social links.

---

# 6. Database Design

Use SQLite with WAL mode enabled.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

Use migrations.

Recommended ORM:

* Drizzle ORM, or
* Prisma with SQLite support.

Drizzle is preferred for a lightweight deployment.

## 6.1 Core tables

### `posts`

```sql
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  excerpt TEXT,
  markdown_body TEXT,
  html_body TEXT,
  normalized_text TEXT,
  language TEXT,
  published_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  canonical_url TEXT,
  external_url TEXT,
  x_post_id TEXT UNIQUE,
  x_conversation_id TEXT,
  x_author_id TEXT,
  x_raw_json TEXT,
  preserve_manual_title INTEGER NOT NULL DEFAULT 0,
  preserve_manual_body INTEGER NOT NULL DEFAULT 0,
  seo_title TEXT,
  seo_description TEXT,
  og_image_media_id TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  imported_at TEXT,
  deleted_at TEXT
);
```

### `media`

```sql
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  storage_path TEXT NOT NULL,
  public_url TEXT NOT NULL,
  checksum_sha256 TEXT,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
```

### `tags`

```sql
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  category_group TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### `post_tags`

```sql
CREATE TABLE post_tags (
  post_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  confidence REAL,
  PRIMARY KEY (post_id, tag_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
```

### `tag_aliases`

```sql
CREATE TABLE tag_aliases (
  alias TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
```

### `x_metric_snapshots`

```sql
CREATE TABLE x_metric_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  impression_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  repost_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  quote_count INTEGER NOT NULL DEFAULT 0,
  bookmark_count INTEGER NOT NULL DEFAULT 0,
  url_link_clicks INTEGER,
  profile_clicks INTEGER,
  engagements INTEGER,
  collected_at TEXT NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
```

### `post_daily_views`

```sql
CREATE TABLE post_daily_views (
  post_id TEXT NOT NULL,
  view_date TEXT NOT NULL,
  human_views INTEGER NOT NULL DEFAULT 0,
  bot_views INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, view_date),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
```

### `site_daily_views`

```sql
CREATE TABLE site_daily_views (
  view_date TEXT PRIMARY KEY,
  human_views INTEGER NOT NULL DEFAULT 0,
  bot_views INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0
);
```

### `referrer_daily_stats`

```sql
CREATE TABLE referrer_daily_stats (
  post_id TEXT NOT NULL,
  view_date TEXT NOT NULL,
  referrer_domain TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, view_date, referrer_domain),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
```

### `related_posts`

```sql
CREATE TABLE related_posts (
  post_id TEXT NOT NULL,
  related_post_id TEXT NOT NULL,
  score REAL NOT NULL,
  source TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, related_post_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (related_post_id) REFERENCES posts(id) ON DELETE CASCADE
);
```

### `subscribers`

```sql
CREATE TABLE subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  confirmation_token_hash TEXT,
  unsubscribe_token_hash TEXT,
  subscribed_at TEXT,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### `redirects`

```sql
CREATE TABLE redirects (
  from_path TEXT PRIMARY KEY,
  to_path TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 301,
  created_at TEXT NOT NULL
);
```

### `jobs`

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TEXT NOT NULL,
  locked_at TEXT,
  locked_by TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### `settings`

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### `audit_log`

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
```

---

# 7. Application Architecture

## 7.1 Recommended stack

| Layer          | Technology                    |
| -------------- | ----------------------------- |
| Runtime        | Node.js 22+                   |
| Language       | TypeScript                    |
| HTTP framework | Fastify                       |
| Templates      | Eta or Nunjucks               |
| Progressive UI | HTMX                          |
| Styling        | Tailwind CSS                  |
| Database       | SQLite                        |
| ORM            | Drizzle ORM                   |
| Search         | SQLite FTS5                   |
| Validation     | Zod                           |
| Markdown       | unified / remark / rehype     |
| Sanitization   | sanitize-html                 |
| Authentication | secure cookie sessions + TOTP |
| Scheduler      | node-cron                     |
| Job queue      | SQLite-backed worker          |
| Image handling | Sharp                         |
| Tests          | Vitest + Playwright           |
| Logging        | Pino                          |
| Deployment     | Docker Compose or systemd     |
| Reverse proxy  | Caddy or Nginx                |

## 7.2 Why server-rendered HTML

Use server-side rendering rather than a heavy SPA because:

* posts should load fast;
* SEO matters;
* the archive is mostly read-only;
* SQLite and one VPS are sufficient;
* deployment remains simple;
* HTMX is enough for filters, admin actions, and subscription forms.

## 7.3 Services

```text
src/
  app.ts
  server.ts

  config/
  db/
    schema.ts
    migrations/
    repositories/

  modules/
    posts/
    tags/
    x/
    media/
    analytics/
    newsletter/
    related-posts/
    rss/
    seo/
    stats/
    search/
    ama/
    admin/
    jobs/
    auth/

  views/
  public/
  scripts/
```

## 7.4 Internal modules

### `XImportService`

Imports posts and media.

### `XMetricsSyncService`

Refreshes X metrics and writes snapshots.

### `MediaMirrorService`

Downloads, validates, deduplicates, resizes, and stores media.

### `RelatedPostsService`

Computes recommendations.

### `AnalyticsService`

Tracks internal blog views.

### `NewsletterService`

Handles subscribe, confirmation, and unsubscribe workflows.

### `StatsService`

Builds public statistics.

### `SeoService`

Builds metadata, sitemap, and canonical URLs.

### `ArchiveQaService`

Optional retrieval-augmented AI answers.

### `JobWorker`

Runs queued tasks with retries and idempotency.

---

# 8. Scheduled Jobs

| Job                        | Frequency                 |
| -------------------------- | ------------------------- |
| Import new X posts         | Every 15 minutes          |
| Refresh fresh-post metrics | Every 15 minutes          |
| Refresh older-post metrics | Hourly and daily tiers    |
| Recalculate related posts  | After publish and nightly |
| Rebuild RSS                | After publish             |
| Rebuild sitemap            | After publish             |
| Aggregate analytics        | Hourly                    |
| Generate stats cache       | Hourly                    |
| Verify missing media       | Daily                     |
| Backup SQLite database     | Daily                     |
| Clean expired sessions     | Daily                     |
| Clean old job records      | Weekly                    |

---

# 9. API Endpoints

## 9.1 Public

```text
GET  /
GET  /:slug
GET  /tags
GET  /tag/:slug
GET  /stats
GET  /rss
GET  /sitemap.xml
GET  /robots.txt
GET  /search?q=
GET  /ama
POST /ama
POST /subscribe
GET  /subscribe/confirm
GET  /unsubscribe
```

## 9.2 Admin

```text
GET    /admin
GET    /admin/posts
GET    /admin/posts/:id
POST   /admin/posts
PATCH  /admin/posts/:id
DELETE /admin/posts/:id

POST   /admin/posts/:id/publish
POST   /admin/posts/:id/hide
POST   /admin/posts/:id/recalculate-related
POST   /admin/posts/:id/resync-x
POST   /admin/posts/:id/redownload-media

GET    /admin/imports
POST   /admin/imports/sync
POST   /admin/imports/:id/approve
POST   /admin/imports/:id/ignore

GET    /admin/tags
POST   /admin/tags
PATCH  /admin/tags/:id
POST   /admin/tags/:id/merge

GET    /admin/settings
PATCH  /admin/settings

GET    /admin/jobs
POST   /admin/jobs/:id/retry

GET    /admin/analytics
GET    /admin/subscribers
```

---

# 10. Caching

SQLite remains the source of truth.

Use in-memory caching for:

* homepage archive;
* tag list;
* RSS output;
* sitemap;
* stats page;
* post related-links block;
* total view counters.

Cache invalidation events:

* post publication;
* post update;
* tag change;
* metrics refresh;
* analytics aggregation;
* related-post recalculation.

Optional later extension:

* Redis cache;
* CDN caching;
* static-page export.

---

# 11. Security Requirements

## 11.1 Admin security

* HTTPS only;
* secure cookies;
* HTTP-only cookies;
* SameSite strict;
* CSRF protection;
* TOTP support;
* login rate limits;
* password hashing with Argon2id;
* session expiration;
* audit logs;
* IP-based suspicious-login logging.

## 11.2 Content security

* sanitize HTML;
* validate file MIME types;
* cap upload sizes;
* prevent path traversal;
* prevent SSRF when downloading media;
* allowlist remote media hosts;
* protect against malicious SVG;
* escape template output;
* configure Content Security Policy.

## 11.3 Token security

* encrypt X OAuth tokens;
* encrypt email-provider credentials;
* never log secrets;
* permit token revocation;
* expose last sync status without exposing credentials.

---

# 12. Performance Requirements

Target deployment: one small VPS.

## 12.1 Expected scale

* up to 10,000 posts;
* up to 100 tags per post;
* up to 100 million aggregated internal views;
* up to 1 million monthly page views;
* up to 50,000 subscribers;
* up to 1 million X metrics snapshots.

## 12.2 Response targets

| Page                 | p95 target                            |
| -------------------- | ------------------------------------- |
| Cached homepage      | Under 150 ms server time              |
| Cached post page     | Under 100 ms server time              |
| Tag page             | Under 200 ms                          |
| Stats page           | Under 300 ms                          |
| Search               | Under 300 ms                          |
| Subscription request | Under 500 ms excluding email delivery |
| Admin list           | Under 500 ms                          |

## 12.3 SQLite practices

* enable WAL mode;
* use prepared statements;
* add indexes;
* use transactions for multi-step writes;
* avoid storing unbounded analytics events;
* batch metrics inserts;
* vacuum periodically;
* back up daily;
* test restore process.

---

# 13. Backup and Restore

## 13.1 Backup scope

Back up:

* SQLite database;
* local media folder;
* environment-variable template;
* optional encrypted credential bundle;
* application version;
* migration version.

## 13.2 Backup schedule

* daily database snapshot;
* weekly full media backup;
* retain 14 daily backups;
* retain 8 weekly backups;
* optional remote encrypted backup to S3-compatible storage.

## 13.3 Restore verification

Run a monthly automated restore test into a temporary folder and verify:

* database opens;
* migrations match;
* homepage renders;
* random post media exists;
* RSS generates;
* subscriber count matches.

---

# 14. Observability

## 14.1 Logs

Log:

* request ID;
* route;
* response status;
* response duration;
* X API requests;
* X sync failures;
* media download failures;
* email delivery failures;
* background-job retries;
* admin actions;
* database errors.

## 14.2 Health endpoints

```text
GET /health
GET /health/db
GET /health/jobs
```

## 14.3 Alerts

Alert on:

* failed X synchronization for more than 24 hours;
* repeated X authentication failure;
* failed database backup;
* missing media spike;
* email-provider failure;
* queue backlog;
* disk usage above 80%.

---

# 15. Acceptance Criteria

## 15.1 X import

* A new standalone X post appears in the review queue after synchronization.
* Replies and reposts are ignored by default.
* Attached images are downloaded locally.
* Original X URL is preserved.
* Public X metrics are stored.
* Re-running the same import does not create duplicates.
* Thread posts are combined correctly.
* Manual title edits survive future synchronization.

## 15.2 Public archive

* Homepage supports all required sort modes.
* Homepage supports all required filters.
* Pinned posts render above the archive.
* Archive groups posts by year.
* Mirrored X posts are visually marked.
* Post pages render tags, media, metrics, source attribution, newsletter signup, related posts, and previous/next links.

## 15.3 Related posts

* Every published post has up to five related posts.
* Current post never appears in its own suggestions.
* Hidden and draft posts never appear publicly.
* Suggestions recalculate after tag or content changes.
* Admin can override suggestions.

## 15.4 Analytics

* Blog views increment without storing raw IP addresses.
* Bot traffic is separated.
* Daily counts are available.
* Homepage sort by blog views works.
* Previous-30-day blog-view sorting works.

## 15.5 Stats

* Stats page displays total posts.
* Stats page displays total word count.
* Stats page displays X views and blog views.
* Stats page displays top tags.
* Stats page displays most-viewed posts.
* Stats page displays most-used words.
* Stats page displays one visual box per post.

## 15.6 Newsletter

* Subscriber enters email.
* Double-opt-in confirmation works.
* Unsubscribe works.
* Duplicate subscription is handled gracefully.
* Subscriber status is recorded.
* Newsletter form works on homepage and post pages.

## 15.7 SEO

* Published posts appear in sitemap.
* Drafts do not appear in sitemap.
* RSS validates.
* Every post has canonical URL.
* Every post has Open Graph tags.
* Old slugs redirect after changes.

---

# 16. Delivery Plan

## Phase 1: Core archive

Build:

* database schema;
* migrations;
* homepage;
* manual post publishing;
* tags;
* post pages;
* media storage;
* RSS;
* sitemap;
* basic admin authentication.

Outcome:

A functional personal blog with Levels.io-style archive navigation.

## Phase 2: X mirror

Build:

* X OAuth;
* X import;
* media mirroring;
* review queue;
* generated titles;
* generated tags;
* metrics synchronization;
* thread handling;
* source attribution.

Outcome:

Useful X posts become owned webpages.

## Phase 3: Discovery and analytics

Build:

* related posts;
* internal analytics;
* sort by blog traffic;
* sort by X traffic;
* 30-day growth sorting;
* stats page;
* word-frequency analysis;
* archive visualization.

Outcome:

Old content becomes discoverable and measurable.

## Phase 4: Newsletter

Build:

* signup forms;
* double-opt-in;
* unsubscribe;
* email-provider adapter;
* external-newsletter webhook integration.

Outcome:

Social and SEO traffic converts into an owned audience.

## Phase 5: AI archive Q&A

Build:

* FTS retrieval;
* optional embeddings;
* LLM provider adapter;
* citations;
* rate limits;
* AMA interface.

Outcome:

Readers can query the archive conversationally.

---

# 17. Suggested v1 Scope

For the first production release, implement:

1. Manual posts.
2. X OAuth and import.
3. Exclude replies and reposts.
4. Copy X images locally.
5. Import metrics snapshots.
6. Homepage filters and sort controls.
7. Pinned posts.
8. Post pages.
9. Tags.
10. Related posts using tags + SQLite FTS5.
11. RSS.
12. Sitemap.
13. Privacy-first blog views.
14. Stats page.
15. Newsletter integration through an external provider.
16. Basic admin panel.
17. Daily SQLite backup.

Delay the AI AMA until the archive contains enough posts to make it valuable.

---

# 18. Recommended Implementation Decisions

## Keep SQLite

SQLite is appropriate because this is a content archive with mostly reads and low write contention.

## Use a SQLite-backed job queue

Do not add Redis initially. A personal publishing system does not need additional infrastructure unless traffic or queue volume grows substantially.

## Mirror media locally

Do not depend on X media URLs remaining stable forever.

## Store metric snapshots

Do not overwrite X metrics. Historical snapshots make 30-day sorting and performance analysis possible.

## Require approval initially

Do not publish every X post automatically from day one. Use a review queue until import rules are proven reliable.

## Use generated metadata as suggestions

AI-generated titles and tags should remain editable. Preserve manual edits across future syncs.

## Build related posts without a vector database

SQLite FTS5 plus tags is sufficient for v1. Add embeddings only when the archive becomes large enough to justify the extra complexity.

---

# 19. Future Extensions

Possible later additions:

* static-page export;
* multilingual posts;
* Mastodon, Bluesky, LinkedIn, Threads, and YouTube ingestion;
* automatic repost recommendations;
* “best old posts to resurface” dashboard;
* scheduled newsletter digest;
* content-performance charts;
* Google Search Console import;
* AI-generated content clusters;
* AI-generated long-form expansions from selected X posts;
* public API;
* open-source multi-tenant mode;
* Webmention support;
* comments through external providers;
* import from legacy WordPress, Markdown, and RSS archives;
* Git-based content export;
* automatic broken-link checker;
* author project directory;
* podcast transcript import;
* presentation embed support.

---

# 20. Definition of Done

The product is complete when:

1. A newly published standalone X post can be imported without manual copying.
2. Attached images are preserved locally.
3. The imported post appears on a permanent SEO-friendly webpage.
4. The page shows X metrics, tags, source attribution, newsletter signup, related posts, and previous/next navigation.
5. The homepage can sort and filter the full archive.
6. Internal blog views are measured independently from X impressions.
7. The tags page, stats page, RSS feed, and sitemap work.
8. The system runs reliably on one VPS using Node.js, TypeScript, and SQLite.
9. Daily backup and restore procedures are documented and tested.
10. The admin can review, publish, hide, edit, and resynchronize imported content without editing the database manually.
