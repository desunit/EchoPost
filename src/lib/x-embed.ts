import { escapeHtml } from "./markdown.js";

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
    `<a class="x-ref-card" href="/${escapeHtml(card.slug)}">${thumb}` +
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

  return { html: out, hasWidget };
}
