import { describe, expect, it } from "vitest";
import { verifyTurnstile, type FetchLike } from "../src/lib/turnstile.js";

function fakeFetch(status: number, body: unknown, seen?: Array<string>): FetchLike {
  return async (_url, init) => {
    seen?.push(String(init.body));
    return { ok: status === 200, json: async () => body };
  };
}

describe("verifyTurnstile", () => {
  it("accepts a token Cloudflare accepts, and sends secret, token and IP", async () => {
    const seen: string[] = [];
    expect(await verifyTurnstile("sec", "tok", "1.2.3.4", fakeFetch(200, { success: true }, seen))).toBe(true);
    expect(seen[0]).toContain("secret=sec");
    expect(seen[0]).toContain("response=tok");
    expect(seen[0]).toContain("remoteip=1.2.3.4");
  });

  it("fails closed: no token, rejected token, HTTP error, network error", async () => {
    expect(await verifyTurnstile("sec", undefined, undefined, fakeFetch(200, { success: true }))).toBe(false);
    expect(await verifyTurnstile("sec", "", undefined, fakeFetch(200, { success: true }))).toBe(false);
    expect(await verifyTurnstile("sec", "tok", undefined, fakeFetch(200, { success: false }))).toBe(false);
    expect(await verifyTurnstile("sec", "tok", undefined, fakeFetch(500, {}))).toBe(false);
    const broken: FetchLike = async () => {
      throw new Error("offline");
    };
    expect(await verifyTurnstile("sec", "tok", undefined, broken)).toBe(false);
  });
});
