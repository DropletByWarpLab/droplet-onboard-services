import { describe, it, expect, vi, beforeEach } from "vitest";

// Set JWT_SECRET before imports
process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests-only-not-production";

// ── Cache mock — backed by an in-memory Map so denylist tests work ──
const cacheStore = new Map<string, unknown>();
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => { cacheStore.set(key, value); }),
  cacheDel: vi.fn(async (key: string) => { cacheStore.delete(key); }),
}));

import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  denyRefreshToken,
  claimRefreshRotation,
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
