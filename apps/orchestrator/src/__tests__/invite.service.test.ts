/**
 * Unit tests for invite token generation and constant-time comparison.
 * These are pure-function tests — no Prisma, no Express, no Nextcloud.
 */
import { describe, it, expect } from "vitest";
import {
  generateInviteToken,
  compareTokensConstantTime,
  isExpired,
  isUsed,
  isRevoked,
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
    acceptedAt: null,
    acceptedFrom: null,
    revokedAt: null,
    createdAt: new Date(),
  };

  it("isExpired: true when expiresAt is in the past", () => {
    expect(isExpired({ ...baseInvite, expiresAt: new Date(Date.now() - 1000) })).toBe(true);
  });

  it("isExpired: false when expiresAt is in the future", () => {
    expect(isExpired(baseInvite)).toBe(false);
  });

  it("isUsed: true iff acceptedAt is not null", () => {
    expect(isUsed(baseInvite)).toBe(false);
    expect(isUsed({ ...baseInvite, acceptedAt: new Date() })).toBe(true);
  });

  it("isRevoked: true iff revokedAt is not null", () => {
    expect(isRevoked(baseInvite)).toBe(false);
    expect(isRevoked({ ...baseInvite, revokedAt: new Date() })).toBe(true);
  });
});
