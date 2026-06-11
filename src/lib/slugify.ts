/**
 * Slug rules (PRD 5.4.2): lowercase, transliterate, hyphenate separators,
 * collapse repeated hyphens. Uniqueness is enforced by the caller against the DB.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    // strip combining diacritics left over from NFKD
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/, "");
  return slug || "post";
}

export function uniqueSlug(base: string, exists: (slug: string) => boolean): string {
  let slug = slugify(base);
  if (!exists(slug)) return slug;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${slug}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  return `${slug}-${Date.now()}`;
}
