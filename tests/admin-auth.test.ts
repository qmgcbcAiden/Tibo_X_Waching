import { describe, expect, it } from "vitest";
import {
  AdminSessions,
  createPasswordHash,
  LoginRateLimiter,
  verifyPassword
} from "../src/admin-auth.js";

describe("admin authentication primitives", () => {
  it("creates and verifies a scrypt password hash", () => {
    const password = "this-is-a-very-long-password";
    const hash = createPasswordHash(password);
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(verifyPassword(password, hash)).toBe(true);
    expect(verifyPassword(`${password}!`, hash)).toBe(false);
    expect(() => createPasswordHash("too-short")).toThrow(/20/);
  });

  it("expires memory sessions and validates the login window", () => {
    const sessions = new AdminSessions(1_000);
    const session = sessions.create(10_000);
    expect(sessions.get(session.token, 10_999)?.csrf).toBe(session.csrf);
    expect(sessions.get(session.token, 11_000)).toBeNull();

    const limiter = new LoginRateLimiter(2, 1_000);
    limiter.fail("ip-user", 10_000);
    limiter.fail("ip-user", 10_100);
    expect(limiter.canAttempt("ip-user", 10_200)).toBe(false);
    expect(limiter.canAttempt("ip-user", 11_101)).toBe(true);
  });
});
