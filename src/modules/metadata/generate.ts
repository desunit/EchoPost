import { makeExcerpt } from "../../lib/markdown.js";

/**
 * Metadata generation for imported X posts (PRD 5.4). These deterministic,
 * heuristic implementations preserve the author's words rather than inventing
 * new ones, and are the always-available baseline. When an LLM is configured
 * (see metadata/llm.ts) the importer prefers its title/SEO description/tags
 * and falls back to these on any failure. Results are always editable.
 */

const STOP_WORDS = new Set(
  (
    "a an and are as at be but by for from has have how i if in into is it its just me my of on or our so " +
    "that the their then there these they this to was we what when which who will with you your not no can " +
    "do does did been being am were would could should them he she his her us out up down about over under " +
    "very really also more most some any all each other than too only now get got like one two new"
  ).split(" "),
);

function cleanText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@(\w+)/g, "$1")
    .replace(/#(\w+)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** First complete sentence/line, trimmed to <100 chars on a word boundary (PRD 5.4.1). */
export function generateTitle(postText: string): string {
  const clean = cleanText(postText);
  if (!clean) return "Untitled post";

  // prefer the first line, then the first sentence within it
  const firstLine = clean.split(/\n/)[0]!.trim();
  const sentenceMatch = firstLine.match(/^.+?[.!?](?:\s|$)/);
  let title = (sentenceMatch ? sentenceMatch[0] : firstLine).trim();
  title = title.replace(/[.\s]+$/, "");

  if (title.length > 100) {
    const cut = title.slice(0, 97);
    const lastSpace = cut.lastIndexOf(" ");
    title = `${cut.slice(0, lastSpace > 40 ? lastSpace : 97)}…`;
  }
  if (title.length < 8 && clean.length > title.length) {
    title = clean.length > 100 ? `${clean.slice(0, 97)}…` : clean;
  }
  return title || "Untitled post";
}

export function generateExcerpt(postText: string): string {
  return makeExcerpt(cleanText(postText));
}

export function generateSeoDescription(postText: string): string {
  return makeExcerpt(cleanText(postText), 160);
}

/**
 * Suggest 2–8 tags (PRD 5.4.3): prefer existing tags and the controlled
 * vocabulary; fall back to the most frequent meaningful words.
 */
export function generateTags(
  postText: string,
  options: { existingTags: string[]; vocabulary: string[] },
): string[] {
  const clean = cleanText(postText).toLowerCase();
  const words = clean.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
  const suggestions: string[] = [];

  // 1. known tags / vocabulary that literally appear in the text
  const known = [...new Set([...options.existingTags, ...options.vocabulary])];
  for (const tag of known) {
    if (suggestions.length >= 8) break;
    const needle = tag.toLowerCase();
    if (needle.length >= 2 && clean.includes(needle) && !suggestions.some((s) => s.toLowerCase() === needle)) {
      suggestions.push(tag);
    }
  }

  // 2. frequent meaningful words as fallback
  if (suggestions.length < 2) {
    const freq = new Map<string, number>();
    for (const w of words) {
      if (w.length < 4 || STOP_WORDS.has(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    for (const [word] of top) {
      if (suggestions.length >= 8) break;
      if (!suggestions.some((s) => s.toLowerCase() === word)) suggestions.push(word);
    }
  }

  return suggestions.slice(0, 8);
}
