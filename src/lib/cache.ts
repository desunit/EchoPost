/**
 * In-memory TTL cache (PRD §10). SQLite stays the source of truth; this only
 * caches rendered fragments and expensive aggregates. Invalidation is by
 * key-prefix so e.g. invalidate("home") clears every homepage variant.
 */
interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export const cache = {
  get<T>(key: string): T | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value as T;
  },

  set(key: string, value: unknown, ttlMs = 60_000): void {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
  },

  getOrCompute<T>(key: string, ttlMs: number, compute: () => T): T {
    const hit = cache.get<T>(key);
    if (hit !== undefined) return hit;
    const value = compute();
    cache.set(key, value, ttlMs);
    return value;
  },

  invalidate(...prefixes: string[]): void {
    if (prefixes.length === 0) {
      store.clear();
      return;
    }
    for (const key of store.keys()) {
      if (prefixes.some((p) => key === p || key.startsWith(`${p}:`))) store.delete(key);
    }
  },
};

/** Clears caches affected by content changes (publish, update, tag change…). */
export function invalidateContentCaches(): void {
  cache.invalidate("home", "post", "tags", "tag", "rss", "sitemap", "stats", "totals", "search");
}
