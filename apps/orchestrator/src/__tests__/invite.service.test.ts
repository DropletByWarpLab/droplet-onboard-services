/**
 * Unit tests for invite token generation and constant-time comparison.
 * These are pure-function tests — no Prisma, no Express, no Nextcloud.
 */
import { describe, it, expect, vi } from "vitest";
import {
  generateInviteToken,
  compareTokensConstantTime,
  isExpired,
  isUsed,
  isRevoked,
  expireOverdueInvites,
} from "../services/invite.service.js";

describe("invite.service — token generation", () => {
  it("produces URL-safe base64 tokens of length >= 40", () => {
    const t = generateInviteToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("does not include base64 padding", () => {
    const t = generateInviteToken();
    expect(t).not.toContain("=");
  });

  it("returns a different token on every call (statistically)", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) tokens.add(generateInviteToken());
    expect(tokens.size).toBe(100);
  });
});

describe("invite.service — constant-time comparison", () => {
  it("returns true when both inputs match", () => {
    const t = generateInviteToken();
    expect(compareTokensConstantTime(t, t)).toBe(true);
  });

  it("returns false when both inputs are equal length but different", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b); // sanity
    expect(a.length).toBe(b.length);
    expect(compareTokensConstantTime(a, b)).toBe(false);
  });

  it("returns false when inputs are different lengths (no throw)", () => {
    expect(compareTokensConstantTime("short", generateInviteToken())).toBe(false);
    expect(compareTokensConstantTime(generateInviteToken(), "short")).toBe(false);
    expect(compareTokensConstantTime("", "anything")).toBe(false);
  });

  it("returns false when given empty strings", () => {
    expect(compareTokensConstantTime("", "")).toBe(false);
  });
});

describe("invite.service — state predicates", () => {
  const baseInvite = {
    id: "inv-1",
    token: "abc",
    username: "alice",
    displayName: null,
    email: null,
    role: "user",
    createdBy: "admin",
    expiresAt: new Date(Date.now() + 60_000),
    status: "pending" as const,
    acceptedAt: null,
    acceptedFrom: null,
    revokedAt: null,
    createdAt: new Date(),
  };

  it("isExpired: true when a pending invite is past expiresAt (real-time deadline)", () => {
    expect(isExpired({ ...baseInvite, expiresAt: new Date(Date.now() - 1000) })).toBe(true);
  });

  it("isExpired: false when expiresAt is in the future", () => {
    expect(isExpired(baseInvite)).toBe(false);
  });

  // WARP-3193 QUAL-3: the lifecycle is the explicit status column, never the
  // absence of a timestamp.
  it("isExpired: true when the daily sweep stamped status=expired", () => {
    expect(isExpired({ ...baseInvite, status: "expired" })).toBe(true);
  });

  it("isUsed: true iff status is accepted", () => {
    expect(isUsed(baseInvite)).toBe(false);
    expect(isUsed({ ...baseInvite, status: "accepted" })).toBe(true);
  });

  it("isRevoked: true iff status is revoked", () => {
    expect(isRevoked(baseInvite)).toBe(false);
    expect(isRevoked({ ...baseInvite, status: "revoked" })).toBe(true);
  });
});

describe("WARP-3193 QUAL-3 — expireOverdueInvites (daily sweep)", () => {
  it("stamps status=expired on pending invites past expiresAt, and only those", async () => {
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const now = new Date("2026-09-26T03:00:00Z");
    const n = await expireOverdueInvites({ userInvite: { updateMany } } as never, now);
    expect(n).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { status: "pending", expiresAt: { lt: now } },
      data: { status: "expired" },
    });
  });
});
