-- EchoPost initial schema (PRD §6) plus auth/X-account/operational tables.

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
  x_source_unavailable INTEGER NOT NULL DEFAULT 0,
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

CREATE INDEX idx_posts_status_published ON posts(status, published_at DESC);
CREATE INDEX idx_posts_type ON posts(type);
CREATE INDEX idx_posts_conversation ON posts(x_conversation_id);

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

CREATE INDEX idx_media_post ON media(post_id);
CREATE INDEX idx_media_checksum ON media(checksum_sha256);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  category_group TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE post_tags (
  post_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  confidence REAL,
  PRIMARY KEY (post_id, tag_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX idx_post_tags_tag ON post_tags(tag_id);

CREATE TABLE tag_aliases (
  alias TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

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

CREATE INDEX idx_x_metrics_post_time ON x_metric_snapshots(post_id, collected_at DESC);

CREATE TABLE post_daily_views (
  post_id TEXT NOT NULL,
  view_date TEXT NOT NULL,
  human_views INTEGER NOT NULL DEFAULT 0,
  bot_views INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, view_date),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX idx_post_daily_views_date ON post_daily_views(view_date);

CREATE TABLE site_daily_views (
  view_date TEXT PRIMARY KEY,
  human_views INTEGER NOT NULL DEFAULT 0,
  bot_views INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE referrer_daily_stats (
  post_id TEXT NOT NULL,
  view_date TEXT NOT NULL,
  referrer_domain TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, view_date, referrer_domain),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- Short-lived per-visitor log used only to estimate daily uniques; pruned daily.
CREATE TABLE daily_visitor_log (
  view_date TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  post_id TEXT,
  PRIMARY KEY (view_date, visitor_hash, post_id)
);

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

CREATE TABLE redirects (
  from_path TEXT PRIMARY KEY,
  to_path TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 301,
  created_at TEXT NOT NULL
);

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

CREATE INDEX idx_jobs_status_run_after ON jobs(status, run_after);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

-- Admin sessions (PRD §5.16 / §11.1)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip_prefix TEXT,
  user_agent TEXT
);

-- Connected X account (PRD 5.2.2). Tokens are AES-256-GCM encrypted.
CREATE TABLE x_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  x_user_id TEXT,
  username TEXT,
  display_name TEXT,
  profile_image_url TEXT,
  connection_status TEXT NOT NULL DEFAULT 'disconnected',
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TEXT,
  last_sync_at TEXT,
  last_imported_x_post_id TEXT,
  last_metrics_refresh_at TEXT,
  last_error TEXT,
  updated_at TEXT
);

INSERT INTO x_account (id, connection_status) VALUES (1, 'disconnected');

-- Full-text search (PRD 5.7.2). Kept in sync from PostsService.
CREATE VIRTUAL TABLE post_search USING fts5(
  post_id UNINDEXED,
  title,
  excerpt,
  body,
  tags
);
