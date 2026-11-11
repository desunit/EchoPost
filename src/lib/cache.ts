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

/**
 * Hard cap on entries. Without it, expired entries stayed until the SAME key was
 * read again, so a crawler that visited each post once kept every post page in
 * memory (2026-11: each also held a copy of the whole archive → heap OOM,
 * exit 134, desunit.com 502/503 bursts).
 */
export const MAX_ENTRIES = 500;

function sweepExpired(now: number): void {
  for (const [key, entry] of store) if (entry.expiresAt < now) store.delete(key);
}

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
    const now = Date.now();
    store.delete(key); // re-insert so Map order = insertion age
    if (store.size >= MAX_ENTRIES) sweepExpired(now);
    // still full: drop the oldest entries (Map iterates in insertion order)
    for (const k of store.keys()) {
      if (store.size < MAX_ENTRIES) break;
      store.delete(k);
    }
    store.set(key, { value, expiresAt: now + ttlMs });
  },

  size(): number {
    return store.size;
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
