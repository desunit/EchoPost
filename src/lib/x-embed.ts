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

  // Quote-tweet: append a card for the quoted post unless the body already links it
  // (e.g. the t.co URL survived stripping and was rendered as a card above).
  let withQuote = out;
  if (opts.quotedTweetId) {
    const card = opts.lookup(opts.quotedTweetId);
    if (card && !out.includes(`"${config.basePath}/${card.slug}"`)) {
      withQuote = out + cardHtml(card);
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
