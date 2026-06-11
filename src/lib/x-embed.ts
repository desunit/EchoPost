import { escapeHtml } from "./markdown.js";
import { config } from "../config/index.js";

/**
 * Render-time embedding of X-post references inside a post body.
 *
 * Quotes/links to *other* accounts' tweets become the live X (Twitter) embed
 * widget. References to the *author's own* tweets that also live in this archive
 * become an internal reference card (thumbnail + title + excerpt) linking to the
 * local post. Resolution happens at render — not at import — so cards stay in
 * sync when a referenced post is retitled or imported later (e.g. via backfill).
 *
 * Operates on already-sanitized HTML and only injects HTML we build ourselves
 * (user-supplied fields are escaped), so it runs after sanitize, not before.
 */

const X_STATUS = /^https?:\/\/(?:twitter\.com|x\.com)\/([^/?#]+)\/status\/(\d+)/i;
const ANCHOR = /<a\b[^>]*?\bhref="([^"]+)"[^>]*?>(.*?)<\/a>/gis;

export interface XRefCard {
  slug: string;
  title: string;
  excerpt: string;
  thumbnailUrl?: string | null;
}

export interface EmbedOptions {
  ownUserId: string;
  ownUsername: string;
  /** Resolve a tweet id to a local archive post, or null if not ours / not stored. */
  lookup: (tweetId: string) => XRefCard | null;
  /**
   * Quoted-tweet id from the post's `referenced_tweets`. X quote-tweets carry the
   * quoted status as a (often URL-stripped) reference rather than a body link, so
   * it never reaches the anchor pass. When it resolves to one of our archived
   * posts, render it as a trailing quote card — matching X's quote-tweet layout.
   */
  quotedTweetId?: string | null;
  /**
   * Canonical URL of the quoted status (from the raw JSON's `entities.urls`).
   * When the quoted tweet is *not* one of our archived posts, we append the live
   * X widget pointing here instead — otherwise an external quote-tweet whose t.co
   * link was stripped at import would render nothing.
   */
  quotedTweetUrl?: string | null;
}

function widgetHtml(href: string): string {
  return `<blockquote class="twitter-tweet" data-dnt="true"><a href="${escapeHtml(href)}"></a></blockquote>`;
}

function cardHtml(card: XRefCard): string {
  const excerpt = card.excerpt.length > 160 ? `${card.excerpt.slice(0, 159).trimEnd()}…` : card.excerpt;
  const thumb = card.thumbnailUrl
    ? `<img class="x-ref-card__thumb" src="${escapeHtml(card.thumbnailUrl)}" alt="" loading="lazy">`
    : "";
  return (
    `<a class="x-ref-card" href="${config.basePath}/${escapeHtml(card.slug)}">${thumb}` +
    `<span class="x-ref-card__body">` +
    `<span class="x-ref-card__title">${escapeHtml(card.title)}</span>` +
    (excerpt ? `<span class="x-ref-card__excerpt">${escapeHtml(excerpt)}</span>` : "") +
    `<span class="x-ref-card__source">View post</span>` +
    `</span></a>`
  );
}

export function embedXReferences(html: string, opts: EmbedOptions): { html: string; hasWidget: boolean } {
  let hasWidget = false;
  const ownUser = (opts.ownUsername || "").toLowerCase();

  const out = html.replace(ANCHOR, (full: string, href: string, inner: string) => {
    const m = X_STATUS.exec(href);
    if (!m) return full; // not an X status link → leave untouched
    const text = inner.replace(/<[^>]+>/g, "").trim();
    if (text === "View on X") return full; // per-section footer nav link, not a quote

    const user = m[1] ?? "";
    const tweetId = m[2] ?? "";
    const isOwn = user === opts.ownUserId || user.toLowerCase() === ownUser;

    if (isOwn) {
      const card = opts.lookup(tweetId);
      return card ? cardHtml(card) : full; // own post not in archive (or self-ref) → keep link
    }
    hasWidget = true;
    return widgetHtml(href);
  });

  // Quote-tweet: append a trailing embed for the quoted status. Own archived post
  // → internal card; anyone else → live X widget. Skip when the body already links
  // it (e.g. the t.co URL survived stripping and was rendered above).
  let withQuote = out;
  if (opts.quotedTweetId) {
    const card = opts.lookup(opts.quotedTweetId);
    if (card) {
      if (!out.includes(`"${config.basePath}/${card.slug}"`)) {
        withQuote = out + cardHtml(card);
      }
    } else if (opts.quotedTweetUrl && !out.includes(`href="${escapeHtml(opts.quotedTweetUrl)}"`)) {
      withQuote = out + widgetHtml(opts.quotedTweetUrl);
      hasWidget = true;
    }
  }

  return { html: withQuote, hasWidget };
}

/**
 * Extract the quoted-tweet id from a post's raw X JSON (`referenced_tweets`),
 * or null when the post isn't a quote-tweet / has no raw JSON.
 */
export function quotedTweetId(rawJson: string | null | undefined): string | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as { referenced_tweets?: { type: string; id: string }[] };
    const quoted = parsed.referenced_tweets?.find((r) => r.type === "quoted");
    return quoted?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Canonical URL of a post's quoted status, for the live X widget fallback. Prefers
 * the `entities.urls` expanded URL that points at the quoted id (keeps the original
 * author handle); falls back to a handle-less `x.com/i/status/<id>` permalink.
 * Returns null when the post isn't a quote-tweet / has no raw JSON.
 */
export function quotedTweetUrl(rawJson: string | null | undefined): string | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as {
      referenced_tweets?: { type: string; id: string }[];
      entities?: { urls?: { expanded_url?: string }[] };
    };
    const quoted = parsed.referenced_tweets?.find((r) => r.type === "quoted");
    if (!quoted) return null;
    const match = parsed.entities?.urls?.find((u) => {
      const m = u.expanded_url ? X_STATUS.exec(u.expanded_url) : null;
      return !!m && m[2] === quoted.id;
    });
    return match?.expanded_url ?? `https://x.com/i/status/${quoted.id}`;
  } catch {
    return null;
  }
}
