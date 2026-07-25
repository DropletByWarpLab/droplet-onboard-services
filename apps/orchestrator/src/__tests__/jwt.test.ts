import { describe, it, expect, vi, beforeEach } from "vitest";

// Set JWT_SECRET before imports
process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests-only-not-production";

// ── Cache mock — backed by an in-memory Map so denylist tests work ──
const cacheStore = new Map<string, unknown>();
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => { cacheStore.set(key, value); }),
  cacheDel: vi.fn(async (key: string) => { cacheStore.delete(key); }),
  // NX semantics: set only if absent. Mirrors the real Redis `SET … NX EX`
  // (true when the key was claimed, false when it already existed).
  cacheSetNx: vi.fn(async (key: string, value: unknown) => {
    if (cacheStore.has(key)) return false;
    cacheStore.set(key, value);
    return true;
  }),
}));

import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  denyRefreshToken,
  claimRefreshRotation,
  roleFromGroups,
  isRole,
  type Role,
} from "../services/jwt.service.js";

describe("JWT Service", () => {
  beforeEach(() => {
    cacheStore.clear();
    vi.clearAllMocks();
  });

  describe("signAccessToken / verifyAccessToken", () => {
    it("should sign and verify an access token", () => {
      const token = signAccessToken({
        id: "user-123",
        username: "alice",
        displayName: "Alice",
        role: "family",
      });

      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3); // JWT format

      const payload = verifyAccessToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe("user-123");
      expect(payload!.username).toBe("alice");
      expect(payload!.displayName).toBe("Alice");
      expect(payload!.role).toBe("family");
    });

    it("should return null for an invalid token", () => {
      const payload = verifyAccessToken("not.a.valid.jwt");
      expect(payload).toBeNull();
    });

    it("should return null for a tampered token", () => {
      const token = signAccessToken({
        id: "user-1",
        username: "bob",
        displayName: "Bob",
        role: "guest",
      });

      // Tamper with the payload
      const parts = token.split(".");
      parts[1] = Buffer.from('{"sub":"hacker","username":"hacker","role":"owner"}').toString("base64url");
      const tampered = parts.join(".");

      const payload = verifyAccessToken(tampered);
      expect(payload).toBeNull();
    });

    it("should encode role in the token", () => {
      const roles: Role[] = ["owner", "admin", "family", "guest"];
      for (const role of roles) {
        const token = signAccessToken({
          id: "u1",
          username: "test",
          displayName: "Test",
          role,
        });
        const payload = verifyAccessToken(token);
        expect(payload!.role).toBe(role);
      }
    });
  });

  describe("signRefreshToken / verifyRefreshToken", () => {
    it("should sign and verify a refresh token", async () => {
      const token = signRefreshToken({
        id: "user-456",
        username: "alice",
        displayName: "Alice",
        role: "family",
      });
      expect(token).toBeTruthy();

      const result = await verifyRefreshToken(token);
      expect(result).not.toBeNull();
      expect(result!.sub).toBe("user-456");
      expect(result!.username).toBe("alice");
      expect(result!.displayName).toBe("Alice");
      expect(result!.role).toBe("family");
    });

    it("should preserve role in the refresh token", async () => {
      const token = signRefreshToken({
        id: "admin-user",
        username: "admin-user",
        displayName: "Admin",
        role: "owner",
      });
      const result = await verifyRefreshToken(token);
      expect(result!.role).toBe("owner");
    });

    it("should return null for an invalid refresh token", async () => {
      const result = await verifyRefreshToken("garbage");
      expect(result).toBeNull();
    });

    it("should reject an access token used as a refresh token", async () => {
      const accessToken = signAccessToken({
        id: "u1",
        username: "test",
        displayName: "Test",
        role: "family",
      });
      // Access tokens carry type:"access" so they must be rejected here
      const result = await verifyRefreshToken(accessToken);
      expect(result).toBeNull();
    });

    it("should reject a refresh token used as an access token", () => {
      const refreshToken = signRefreshToken({
        id: "u1",
        username: "test",
        displayName: "Test",
        role: "family",
      });
      // Refresh tokens carry type:"refresh" so they must be rejected here
      const payload = verifyAccessToken(refreshToken);
      expect(payload).toBeNull();
    });
  });

  describe("denyRefreshToken", () => {
    it("should denylist a refresh token so it cannot be reused", async () => {
      const token = signRefreshToken({
        id: "user-789",
        username: "charlie",
        displayName: "Charlie",
        role: "family",
      });

      // Valid before denying
      const before = await verifyRefreshToken(token);
      expect(before).not.toBeNull();
      expect(before!.sub).toBe("user-789");

      // Denylist it
      await denyRefreshToken(token);

      // Should be rejected now
      const after = await verifyRefreshToken(token);
      expect(after).toBeNull();
    });

    it("should not denylist a forged token (no valid signature)", async () => {
      const forged = "forged.header.signature";
      // Should not throw, and should not add anything to the store
      await denyRefreshToken(forged);
      expect(cacheStore.size).toBe(0);
    });

    it("should not throw for an already-expired token", async () => {
      await expect(denyRefreshToken("expired.token.here")).resolves.not.toThrow();
    });
  });

  describe("isRole (WARP-1523 — canonical Role vocabulary guard)", () => {
    it("accepts every canonical role value", () => {
      for (const role of ["owner", "admin", "family", "guest", "service"]) {
        expect(isRole(role)).toBe(true);
      }
    });

    it("rejects non-role strings, non-strings, and prototype-chain keys", () => {
      expect(isRole("superuser")).toBe(false);
      expect(isRole("Owner")).toBe(false); // vocabulary is lowercase-exact
      expect(isRole("")).toBe(false);
      expect(isRole(undefined)).toBe(false);
      expect(isRole(null)).toBe(false);
      expect(isRole(3)).toBe(false);
      // Not an `in`-style check: object prototype keys must not pass.
      expect(isRole("constructor")).toBe(false);
      expect(isRole("toString")).toBe(false);
    });
  });

  describe("roleFromGroups (ADR-004 §4 mapping)", () => {
    // The mapping is the single source of truth for translating
    // Nextcloud groups → Role. AC #4 / ADR-004 §4 require:
    //   admin group → owner, staff group → admin, guest group → guest,
    //   no recognised group → family (least-privileged default).
    // Precedence is owner > admin > guest > default so a user in
    // overlapping groups always lands on the most-privileged tier.
    it("maps the admin group to owner", () => {
      expect(roleFromGroups(["admin"])).toBe("owner");
    });

    it("maps the staff group to admin", () => {
      expect(roleFromGroups(["staff"])).toBe("admin");
    });

    it("maps the guest group to guest", () => {
      expect(roleFromGroups(["guest"])).toBe("guest");
    });

    it("defaults to family when no recognised group is present", () => {
      expect(roleFromGroups([])).toBe("family");
      expect(roleFromGroups(["random-group"])).toBe("family");
    });

    it("gives admin group precedence over staff/guest/default", () => {
      expect(roleFromGroups(["admin", "staff", "guest"])).toBe("owner");
      expect(roleFromGroups(["staff", "admin"])).toBe("owner");
    });

    it("gives staff group precedence over guest/default", () => {
      expect(roleFromGroups(["staff", "guest"])).toBe("admin");
      expect(roleFromGroups(["other", "staff"])).toBe("admin");
    });

    it("gives guest group precedence over the default fallthrough", () => {
      expect(roleFromGroups(["guest", "users"])).toBe("guest");
    });
  });

  describe("claimRefreshRotation", () => {
    it("should let the first caller claim the rotation", async () => {
      const token = signRefreshToken({
        id: "u1",
        username: "alice",
        displayName: "Alice",
        role: "family",
      });
      const claimed = await claimRefreshRotation(token);
      expect(claimed).toBe(true);
    });

    it("should block a concurrent second caller", async () => {
      const token = signRefreshToken({
        id: "u1",
        username: "alice",
        displayName: "Alice",
        role: "family",
      });
      const first = await claimRefreshRotation(token);
      const second = await claimRefreshRotation(token);
      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it("should cause a claimed token to fail verifyRefreshToken (prevents reuse)", async () => {
      const token = signRefreshToken({
        id: "u1",
        username: "alice",
        displayName: "Alice",
        role: "family",
      });
      await claimRefreshRotation(token);
      // After the claim the token is in the denylist namespace, so verification fails
      const result = await verifyRefreshToken(token);
      expect(result).toBeNull();
    });
  });
});
