export type ContentType =
  | "x_post"
  | "blog"
  | "long_form"
  | "presentation"
  | "podcast"
  | "link"
  | "ama";

export type PublicationStatus =
  | "imported"
  | "draft"
  | "review"
  | "published"
  | "hidden"
  | "archived";

export type SubscriberStatus = "pending" | "active" | "unsubscribed" | "bounced" | "complained";

export const CONTENT_TYPES: ContentType[] = [
  "x_post", "blog", "long_form", "presentation", "podcast", "link", "ama",
];

export const PUBLICATION_STATUSES: PublicationStatus[] = [
  "imported", "draft", "review", "published", "hidden", "archived",
];

export interface PostRow {
  id: string;
  type: ContentType;
  status: PublicationStatus;
  title: string;
  slug: string;
  excerpt: string | null;
  markdown_body: string | null;
  html_body: string | null;
  normalized_text: string | null;
  language: string | null;
  published_at: string | null;
  pinned: number;
  featured: number;
  source_url: string | null;
  canonical_url: string | null;
  external_url: string | null;
  x_post_id: string | null;
  x_conversation_id: string | null;
  x_author_id: string | null;
  x_raw_json: string | null;
  x_source_unavailable: number;
  preserve_manual_title: number;
  preserve_manual_body: number;
  seo_title: string | null;
  seo_description: string | null;
  og_image_media_id: string | null;
  word_count: number;
  created_at: string;
  updated_at: string;
  imported_at: string | null;
  deleted_at: string | null;
}

export interface MediaRow {
  id: string;
  post_id: string;
  source_type: string;
  source_url: string | null;
  storage_path: string;
  public_url: string;
  checksum_sha256: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  alt_text: string | null;
  sort_order: number;
  created_at: string;
}

export interface TagRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category_group: string | null;
  created_at: string;
  updated_at: string;
}

export interface XPublicMetrics {
  impressionCount: number;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  quoteCount: number;
  bookmarkCount?: number;
}

export interface ImportRules {
  minimumCharacterCount: number;
  // Minimum original commentary (URL-stripped) a quote tweet must add to be
  // imported. Quotes don't embed the quoted post, so they need more standalone
  // substance than a normal post; falls back to minimumCharacterCount if unset.
  minimumQuoteCommentaryCount?: number;
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

export type SortMode = "latest" | "oldest" | "x_views" | "blog_views" | "x_views_30d" | "blog_views_30d";
export type FilterMode = "all" | "blog" | "x_post" | "long_form" | "presentation" | "podcast";

export const SORT_MODES: Array<{ key: SortMode; label: string }> = [
  { key: "latest", label: "Latest" },
  { key: "oldest", label: "Oldest" },
  { key: "x_views", label: "Views" },
  { key: "blog_views", label: "Blog views" },
  { key: "x_views_30d", label: "Views 30d" },
  { key: "blog_views_30d", label: "Blog views 30d" },
];

export const FILTER_MODES: Array<{ key: FilterMode; label: string }> = [
  { key: "all", label: "All" },
  { key: "blog", label: "Blog" },
  { key: "x_post", label: "X posts" },
  { key: "long_form", label: "Long form" },
  // Presentations / Podcasts are valid post types but hidden from the nav.
];
