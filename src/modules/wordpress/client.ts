import { config } from "../../config/index.js";

/** A WordPress content type exposed under `/wp/v2/<type>` — posts and pages. */
export type WpContentType = "posts" | "pages";

/** Shape of a single item from the WordPress REST API (`/wp/v2/{posts,pages}?_embed`). */
export interface WpPost {
  id: number;
  date_gmt: string; // "2023-01-15T10:00:00" (no zone suffix — UTC)
  modified_gmt: string;
  slug: string;
  status: string; // "publish" | "draft" | "pending" | "future" | "private" | ...
  link: string; // canonical permalink
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  featured_media: number;
  _embedded?: {
    "wp:featuredmedia"?: Array<{ source_url?: string; alt_text?: string; mime_type?: string }>;
    "wp:term"?: Array<Array<{ name: string; taxonomy: string }>>; // pages have none
  };
}

/** One page of REST results plus the total page count from the response header. */
export interface WpFetchResult {
  items: WpPost[];
  totalPages: number;
}

/**
 * Minimal read-only client for the public WordPress REST API. No auth: only
 * published/visible content is returned, which is exactly the archive we mirror.
 */
export class WordPressClient {
  constructor(
    private baseUrl: string = config.wordpress.url,
    private perPage: number = config.wordpress.perPage,
  ) {}

  /** Fetch one page of a content type oldest-first, with embedded media + terms. */
  async getContentPage(type: WpContentType, page: number): Promise<WpFetchResult> {
    if (!this.baseUrl) throw new Error("WORDPRESS_URL is not configured");
    const url =
      `${this.baseUrl}/wp-json/wp/v2/${type}` +
      `?per_page=${this.perPage}&page=${page}&_embed=1&orderby=date&order=asc`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    // WP returns 400 (rest_post_invalid_page_number) when paging past the end.
    if (res.status === 400 && page > 1) return { items: [], totalPages: page - 1 };
    // A site with the content type disabled returns 404 — treat as "nothing here".
    if (res.status === 404) return { items: [], totalPages: 0 };
    if (!res.ok) throw new Error(`WordPress API ${res.status} for ${url}`);
    const items = (await res.json()) as WpPost[];
    const totalPages = Number(res.headers.get("x-wp-totalpages") ?? "1") || 1;
    return { items, totalPages };
  }
}
