import { describe, expect, it } from "vitest";
import { testDb } from "./helpers.js";
import { AuthService } from "../src/modules/auth/service.js";

describe("AuthService.verifyCurrentPassword", () => {
  it("returns false when no admin password is set", () => {
    const auth = new AuthService(testDb());
    expect(auth.verifyCurrentPassword("anything")).toBe(false);
  });

  it("verifies the stored password and rejects a wrong one", () => {
    const auth = new AuthService(testDb());
    auth.setAdminPassword("correct horse battery");
    expect(auth.verifyCurrentPassword("correct horse battery")).toBe(true);
    expect(auth.verifyCurrentPassword("wrong")).toBe(false);
    expect(auth.verifyCurrentPassword("")).toBe(false);
  });
});

describe("AuthService.login rate limiting", () => {
  it("blocks after the configured number of attempts for one IP", () => {
    const auth = new AuthService(testDb());
    const ip = "203.0.113.7";
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (auth.checkRateLimit(ip, 10, 60_000)) allowed++;
    expect(allowed).toBe(10);
    // A different IP has its own bucket.
    expect(auth.checkRateLimit("203.0.113.8", 10, 60_000)).toBe(true);
  });
});
