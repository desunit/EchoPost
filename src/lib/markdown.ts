import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";
import { config } from "../config/index.js";

marked.setOptions({ gfm: true, breaks: false });

/**
 * `rel` for an anchor: off-site links get "nofollow" (plus noopener/noreferrer)
 * so SEO equity isn't passed to third parties; internal links and our own
 * properties (config.links.followHosts) stay "follow" with just noopener.
 */
function relForLink(href: string | undefined): string {
  if (!href) return "noopener";
  let hostname: string;
  try {
    const u = new URL(href); // absolute URLs only; relative/anchor URLs throw
    if (u.protocol !== "http:" && u.protocol !== "https:") return "noopener"; // mailto:, tel:, …
    hostname = u.hostname.toLowerCase();
  } catch {
    return "noopener"; // relative path or #anchor → internal
  }
  const follow = config.links.followHosts.some((d) => hostname === d || hostname.endsWith("." + d));
  return follow ? "noopener" : "nofollow noopener noreferrer";
}

// HTML → Markdown for imported sources (e.g. WordPress content.rendered).
// Markdown stays the canonical body so the admin editor and the existing
// render/sanitize pipeline behave identically to natively authored posts.
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});
// Drop chrome WordPress commonly wraps content in but that carries no prose.
turndown.remove(["script", "style", "noscript"]);

/** Extract an 11-char YouTube video id from any common YouTube URL form. */
export function youTubeId(url: string): string | null {
  const m = url.match(
    /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|shorts\/|watch\?(?:[^&]*&)*v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  );
  return m ? m[1]! : null;
}

// Preserve embeds across HTML → markdown. turndown drops <iframe> by default,
// which silently loses WordPress oEmbeds (e.g. YouTube videos). Keep YouTube as a
// privacy-friendly nocookie player; turn any other iframe into a plain link so
// nothing vanishes without a trace.
turndown.addRule("iframeEmbed", {
  filter: "iframe",
  replacement: (_content, node: any) => {
    const src = node.getAttribute("src") || "";
    const id = youTubeId(src);
    if (id) {
      const title = escapeHtml(node.getAttribute("title") || "YouTube video");
      return `\n\n<iframe class="yt-embed" src="https://www.youtube-nocookie.com/embed/${id}" title="${title}" loading="lazy" allowfullscreen></iframe>\n\n`;
    }
    return src ? `\n\n[Embedded content](${src})\n\n` : "";
  },
});

// WordPress "content toggle" / accordion blocks (e.g. the Ultimate Blocks
// `ub-content-toggle-accordion`) are JS-driven collapsibles that turndown would
// otherwise flatten to plain text. Convert each title→content pair into a native
// <details>/<summary> — collapsible with zero JS. The title-wrap opens the
// <details>; the matching content-wrap (its next sibling) closes it.
turndown.addRule("toggleTitle", {
  filter: (node: any) =>
    node.nodeName === "DIV" && /\bwp-block-ub-content-toggle-accordion-title-wrap\b/.test(node.className || ""),
  replacement: (_content, node: any) =>
    `\n\n<details><summary>${escapeHtml((node.textContent || "").trim())}</summary>\n\n`,
});
turndown.addRule("toggleContent", {
  filter: (node: any) =>
    node.nodeName === "DIV" && /\bwp-block-ub-content-toggle-accordion-content-wrap\b/.test(node.className || ""),
  replacement: (content) => `${content}\n\n</details>\n\n`,
});

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "ul", "ol", "li", "blockquote",
    "pre", "code", "em", "strong", "del", "hr", "br", "img", "table", "thead",
    "tbody", "tr", "th", "td", "figure", "figcaption", "video", "audio", "source", "span", "iframe",
    "details", "summary",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel", "target"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    video: ["src", "controls", "poster", "width", "height", "preload", "autoplay", "loop", "muted", "playsinline"],
    audio: ["src", "controls", "preload"],
    source: ["src", "type"],
    iframe: ["src", "title", "loading", "allowfullscreen", "width", "height", "class"],
    code: ["class"],
    span: ["class"],
    th: ["align"],
    td: ["align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  // Only YouTube's privacy domains may be framed; any other iframe src is dropped.
  allowedIframeHostnames: ["www.youtube-nocookie.com", "www.youtube.com"],
  allowIframeRelativeUrls: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: relForLink(attribs.href) },
    }),
    img: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, loading: "lazy" },
    }),
  },
};

export function renderMarkdown(markdown: string): string {
  const raw = marked.parse(markdown, { async: false });
  return sanitizeHtml(raw, SANITIZE_OPTIONS);
}

export function sanitize(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

/** Convert source HTML (e.g. a WordPress post body) to markdown. */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html ?? "").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™",
};

/** Decode HTML entities in a plain string (titles, excerpts). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** Strip tags and decode entities — for HTML fields used as plain text (titles, excerpts). */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Plain text for FTS indexing, excerpts, and word counts. */
export function markdownToText(markdown: string): string {
  const html = marked.parse(markdown, { async: false });
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function makeExcerpt(text: string, maxLength = 240): string {
  const clean = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > maxLength / 2 ? lastSpace : maxLength)}…`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
