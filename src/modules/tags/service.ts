import type { DB } from "../../db/index.js";
import { newId } from "../../lib/ids.js";
import { nowIso } from "../../lib/time.js";
import { slugify, uniqueSlug } from "../../lib/slugify.js";
import { invalidateContentCaches } from "../../lib/cache.js";
import type { TagRow } from "../types.js";

export interface TagWithCount extends TagRow {
  post_count: number;
}

export class TagsService {
  constructor(private db: DB) {}

  /**
   * Resolve a tag name to an existing tag (by slug or alias) or create it.
   * Keeps the vocabulary canonical (PRD 5.4.3): "AI", "ai", "A.I." all map
   * to one tag once an alias exists.
   */
  ensure(name: string): TagRow {
    const trimmed = name.trim();
    const slug = slugify(trimmed);

    const aliased = this.db
      .prepare("SELECT t.* FROM tags t JOIN tag_aliases a ON a.tag_id = t.id WHERE a.alias = ?")
      .get(slug) as TagRow | undefined;
    if (aliased) return aliased;

    const existing = this.db.prepare("SELECT * FROM tags WHERE slug = ?").get(slug) as TagRow | undefined;
    if (existing) return existing;

    const now = nowIso();
    const id = newId();
    this.db
      .prepare("INSERT INTO tags (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, trimmed, slug, now, now);
    return this.getById(id)!;
  }

  getById(id: string): TagRow | undefined {
    return this.db.prepare("SELECT * FROM tags WHERE id = ?").get(id) as TagRow | undefined;
  }

  getBySlug(slug: string): TagRow | undefined {
    return this.db.prepare("SELECT * FROM tags WHERE slug = ?").get(slug) as TagRow | undefined;
  }

  attach(postId: string, tagId: string, source = "manual", confidence?: number): void {
    this.db
      .prepare(
        `INSERT INTO post_tags (post_id, tag_id, source, confidence) VALUES (?, ?, ?, ?)
         ON CONFLICT(post_id, tag_id) DO NOTHING`,
      )
      .run(postId, tagId, source, confidence ?? null);
  }

  detach(postId: string, tagId: string): void {
    this.db.prepare("DELETE FROM post_tags WHERE post_id = ? AND tag_id = ?").run(postId, tagId);
  }

  /** Replace a post's tags from a comma-separated or array input. */
  setPostTags(postId: string, names: string[], source = "manual"): TagRow[] {
    this.db.prepare("DELETE FROM post_tags WHERE post_id = ?").run(postId);
    const tags: TagRow[] = [];
    for (const name of names.map((n) => n.trim()).filter(Boolean)) {
      const tag = this.ensure(name);
      if (!tags.some((t) => t.id === tag.id)) {
        this.attach(postId, tag.id, source);
        tags.push(tag);
      }
    }
    invalidateContentCaches();
    return tags;
  }

  forPost(postId: string): TagRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM tags t JOIN post_tags pt ON pt.tag_id = t.id
         WHERE pt.post_id = ? ORDER BY t.name`,
      )
      .all(postId) as TagRow[];
  }

  /** Tags with published-post counts (PRD 5.10.1). */
  listWithCounts(includeEmpty = false): TagWithCount[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, COUNT(p.id) AS post_count
         FROM tags t
         LEFT JOIN post_tags pt ON pt.tag_id = t.id
         LEFT JOIN posts p ON p.id = pt.post_id AND p.status = 'published' AND p.deleted_at IS NULL
         GROUP BY t.id
         ORDER BY post_count DESC, t.name`,
      )
      .all() as TagWithCount[];
    return includeEmpty ? rows : rows.filter((r) => r.post_count > 0);
  }

  rename(tagId: string, newName: string): TagRow {
    const tag = this.getById(tagId);
    if (!tag) throw new Error("Tag not found");
    const newSlug = uniqueSlug(newName, (s) => {
      const found = this.db.prepare("SELECT id FROM tags WHERE slug = ?").get(s) as { id: string } | undefined;
      return !!found && found.id !== tagId;
    });
    // keep the old slug reachable as an alias
    this.addAlias(tagId, tag.slug);
    this.db.prepare("UPDATE tags SET name = ?, slug = ?, updated_at = ? WHERE id = ?")
      .run(newName.trim(), newSlug, nowIso(), tagId);
    invalidateContentCaches();
    return this.getById(tagId)!;
  }

  addAlias(tagId: string, alias: string): void {
    this.db
      .prepare("INSERT INTO tag_aliases (alias, tag_id) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET tag_id = excluded.tag_id")
      .run(slugify(alias), tagId);
  }

  /** Merge source tag into target: posts move over, source slug becomes an alias. */
  merge(sourceTagId: string, targetTagId: string): void {
    if (sourceTagId === targetTagId) return;
    const source = this.getById(sourceTagId);
    const target = this.getById(targetTagId);
    if (!source || !target) throw new Error("Tag not found");

    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO post_tags (post_id, tag_id, source, confidence)
           SELECT post_id, ?, source, confidence FROM post_tags WHERE tag_id = ?
           ON CONFLICT(post_id, tag_id) DO NOTHING`,
        )
        .run(targetTagId, sourceTagId);
      this.db.prepare("UPDATE tag_aliases SET tag_id = ? WHERE tag_id = ?").run(targetTagId, sourceTagId);
      this.db.prepare("DELETE FROM tags WHERE id = ?").run(sourceTagId);
      this.addAlias(targetTagId, source.slug);
    });
    run();
    invalidateContentCaches();
  }

  delete(tagId: string): void {
    this.db.prepare("DELETE FROM tags WHERE id = ?").run(tagId);
    invalidateContentCaches();
  }

  postsForTag(tagId: string): Array<{ id: string; title: string; slug: string; published_at: string | null; type: string }> {
    return this.db
      .prepare(
        `SELECT p.id, p.title, p.slug, p.published_at, p.type
         FROM posts p JOIN post_tags pt ON pt.post_id = p.id
         WHERE pt.tag_id = ? AND p.status = 'published' AND p.deleted_at IS NULL
         ORDER BY p.published_at DESC`,
      )
      .all(tagId) as any;
  }
}
