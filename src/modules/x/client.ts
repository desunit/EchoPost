import { config } from "../../config/index.js";

/** Raw X API v2 shapes (subset we consume). */
export interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  conversation_id?: string;
  author_id?: string;
  lang?: string;
  possibly_sensitive?: boolean;
  in_reply_to_user_id?: string;
  attachments?: { media_keys?: string[] };
  referenced_tweets?: Array<{ type: "retweeted" | "quoted" | "replied_to"; id: string }>;
  public_metrics?: {
    impression_count?: number;
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
    bookmark_count?: number;
  };
  non_public_metrics?: {
    url_link_clicks?: number;
    user_profile_clicks?: number;
    engagements?: number;
  };
  entities?: { urls?: Array<{ url: string; expanded_url?: string; display_url?: string }> };
  // Tweets over 280 chars ("note tweets") are truncated in `text`; the full
  // content lives here, with its own entity offsets.
  note_tweet?: {
    text: string;
    entities?: { urls?: Array<{ url: string; expanded_url?: string; display_url?: string }> };
  };
}

export interface XMedia {
  media_key: string;
  type: "photo" | "video" | "animated_gif";
  url?: string;
  preview_image_url?: string;
  width?: number;
  height?: number;
  alt_text?: string;
  duration_ms?: number;
  // For type=video|animated_gif: the playable renditions. Pick the highest
  // bit_rate video/mp4 to mirror the actual clip (animated_gif has one, no bit_rate).
  variants?: Array<{ bit_rate?: number; content_type: string; url: string }>;
}

export interface XUser {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
}

export interface TimelineResponse {
  tweets: XTweet[];
  media: Map<string, XMedia>;
  newestId?: string;
  oldestId?: string;
  nextToken?: string;
  raw: unknown;
}

export class XRateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`X API rate limited; retry after ${retryAfterSeconds}s`);
  }
}

export class XAuthError extends Error {}

const TWEET_FIELDS =
  "created_at,public_metrics,entities,referenced_tweets,conversation_id,lang,possibly_sensitive,author_id,attachments,in_reply_to_user_id,note_tweet";
const MEDIA_FIELDS = "url,preview_image_url,width,height,alt_text,type,duration_ms,variants";

/**
 * Minimal X API v2 client. Uses bearer-token auth for public data; a
 * user-context access token can be passed for private metrics.
 */
export class XClient {
  constructor(private bearerToken: string = config.x.bearerToken) {}

  private async request(pathname: string, params: Record<string, string>, accessToken?: string): Promise<any> {
    const token = accessToken ?? this.bearerToken;
    if (!token) throw new XAuthError("No X API token configured");
    const url = new URL(`${config.x.apiBase}${pathname}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 429) {
      const reset = Number(res.headers.get("x-rate-limit-reset") ?? 0);
      const retryAfter = reset > 0 ? Math.max(15, reset - Math.floor(Date.now() / 1000)) : 900;
      throw new XRateLimitError(retryAfter);
    }
    if (res.status === 401 || res.status === 403) {
      throw new XAuthError(`X API auth failed (${res.status}): ${await res.text()}`);
    }
    if (!res.ok) {
      throw new Error(`X API error ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  async getUserByUsername(username: string): Promise<XUser> {
    const data = await this.request(`/users/by/username/${encodeURIComponent(username)}`, {
      "user.fields": "profile_image_url",
    });
    if (!data.data) throw new Error(`X user not found: ${username}`);
    return data.data as XUser;
  }

  /** User timeline since a known post ID, with media expansions (PRD 5.2.3). */
  async getUserTimeline(userId: string, sinceId?: string, maxResults = 100): Promise<TimelineResponse> {
    const params: Record<string, string> = {
      max_results: String(Math.min(100, Math.max(5, maxResults))),
      "tweet.fields": TWEET_FIELDS,
      "media.fields": MEDIA_FIELDS,
      expansions: "attachments.media_keys",
    };
    if (sinceId) params.since_id = sinceId;

    const data = await this.request(`/users/${userId}/tweets`, params);
    const media = new Map<string, XMedia>();
    for (const m of data.includes?.media ?? []) media.set(m.media_key, m as XMedia);
    return {
      tweets: (data.data ?? []) as XTweet[],
      media,
      newestId: data.meta?.newest_id,
      oldestId: data.meta?.oldest_id,
      nextToken: data.meta?.next_token,
      raw: data,
    };
  }

  /**
   * Older slice of the user timeline for historical backfill (PRD deviation):
   * `until_id` returns only tweets older than that id (exclusive), newest-first,
   * so repeated calls walking the oldest id backwards page through the archive.
   * A `pagination_token` may be passed to continue a previous backfill page.
   */
  async getUserTimelineOlder(
    userId: string,
    untilId?: string,
    maxResults = 100,
    paginationToken?: string,
  ): Promise<TimelineResponse> {
    const params: Record<string, string> = {
      max_results: String(Math.min(100, Math.max(5, maxResults))),
      "tweet.fields": TWEET_FIELDS,
      "media.fields": MEDIA_FIELDS,
      expansions: "attachments.media_keys",
    };
    if (untilId) params.until_id = untilId;
    if (paginationToken) params.pagination_token = paginationToken;

    const data = await this.request(`/users/${userId}/tweets`, params);
    const media = new Map<string, XMedia>();
    for (const m of data.includes?.media ?? []) media.set(m.media_key, m as XMedia);
    return {
      tweets: (data.data ?? []) as XTweet[],
      media,
      newestId: data.meta?.newest_id,
      oldestId: data.meta?.oldest_id,
      nextToken: data.meta?.next_token,
      raw: data,
    };
  }

  /** Batch lookup (up to 100 IDs) used by metrics refresh and thread fetch. */
  async getTweets(ids: string[], accessToken?: string): Promise<TimelineResponse> {
    if (ids.length === 0) return { tweets: [], media: new Map(), raw: null };
    const fields = accessToken ? `${TWEET_FIELDS},non_public_metrics` : TWEET_FIELDS;
    const data = await this.request(
      "/tweets",
      {
        ids: ids.slice(0, 100).join(","),
        "tweet.fields": fields,
        "media.fields": MEDIA_FIELDS,
        expansions: "attachments.media_keys",
      },
      accessToken,
    );
    const media = new Map<string, XMedia>();
    for (const m of data.includes?.media ?? []) media.set(m.media_key, m as XMedia);
    const missing: string[] = (data.errors ?? [])
      .filter((e: any) => e.title === "Not Found Error")
      .map((e: any) => e.value);
    return { tweets: (data.data ?? []) as XTweet[], media, raw: { ...data, missingIds: missing } };
  }

  /** Search the author's own thread continuations within a conversation. */
  async getConversationPosts(conversationId: string, authorId: string): Promise<TimelineResponse> {
    const data = await this.request("/tweets/search/recent", {
      query: `conversation_id:${conversationId} from:${authorId}`,
      max_results: "100",
      "tweet.fields": TWEET_FIELDS,
      "media.fields": MEDIA_FIELDS,
      expansions: "attachments.media_keys",
    });
    const media = new Map<string, XMedia>();
    for (const m of data.includes?.media ?? []) media.set(m.media_key, m as XMedia);
    return { tweets: (data.data ?? []) as XTweet[], media, raw: data };
  }
}
