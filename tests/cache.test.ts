import { afterEach, describe, expect, it, vi } from "vitest";
import { cache, MAX_ENTRIES } from "../src/lib/cache.js";

// Regression 2026-11-10: expired entries were removed only when the same key was read
// again, so one visit to each post kept every post page (each with a copy of the
// whole archive) in memory until the 259 MB heap ran out (exit 134).
describe("cache size", () => {
  afterEach(() => {
    cache.invalidate();
    vi.useRealTimers();
  });

  it("never holds more than MAX_ENTRIES", () => {
    for (let i = 0; i < MAX_ENTRIES * 3; i++) cache.set(`post:${i}`, i, 60_000);
    expect(cache.size()).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(cache.get(`post:${MAX_ENTRIES * 3 - 1}`)).toBe(MAX_ENTRIES * 3 - 1); // newest kept
    expect(cache.get("post:0")).toBeUndefined(); // oldest dropped
  });

  it("drops expired entries before live ones", () => {
    vi.useFakeTimers();
    cache.set("home:keep", "live", 10 * 60_000);
    for (let i = 0; i < MAX_ENTRIES - 1; i++) cache.set(`post:${i}`, i, 1_000);
    vi.advanceTimersByTime(2_000);
    cache.set("post:new", "x", 60_000);
    expect(cache.get("home:keep")).toBe("live");
    expect(cache.size()).toBe(2);
  });
});
