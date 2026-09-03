/**
 * WARP-2353 — the 365-day token clock as an explicit status.
 *
 * Pure function, injected clock, no crypto and no token: the input is a
 * boolean and a date. That is itself the point — the credential seam is
 * ADR-042's and this module adds nothing to it.
 */
import { describe, it, expect } from "vitest";
import {
  ATLASSIAN_TOKEN_EXPIRY_UNKNOWN,
  ATLASSIAN_TOKEN_EXPIRY_WARNING_DAYS,
  ATLASSIAN_TOKEN_MAX_LIFETIME_DAYS,
  atlassianTokenExpiryStatus,
} from "./atlassian-token-expiry.js";

const NOW = new Date("2026-09-02T12:00:00Z");

function inDays(days: number): Date {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
}

function status(expiresAt: Date | null, hasToken = true) {
  return atlassianTokenExpiryStatus({ hasToken, expiresAt, now: NOW });
}

describe("the constants the guide and the code both quote", () => {
  it("records Atlassian's 365-day maximum lifetime", () => {
    expect(ATLASSIAN_TOKEN_MAX_LIFETIME_DAYS).toBe(365);
  });

  it("warns 30 days out", () => {
    expect(ATLASSIAN_TOKEN_EXPIRY_WARNING_DAYS).toBe(30);
  });
});

describe("a healthy connection", () => {
  it("is CONNECTED well outside the window", () => {
    const v = status(inDays(200));
    expect(v.status).toBe("CONNECTED");
    expect(v.daysRemaining).toBe(200);
  });

  it("is still CONNECTED one day outside the window", () => {
    expect(status(inDays(31)).status).toBe("CONNECTED");
  });
});

describe("the warning window", () => {
  it("is NEVER CONNECTED inside 30 days", () => {
    // The rule this test exists for: a connection 12 days from a hard stop is
    // not healthy, and rendering it green makes the outage the first signal.
    for (const days of [30, 29, 12, 1, 0]) {
      const v = status(inDays(days));
      expect(v.status, `${days} days out`).toBe("EXPIRING_SOON");
      expect(v.status).not.toBe("CONNECTED");
    }
  });

  it("says the token still works, so nobody disconnects it in a panic", () => {
    expect(status(inDays(10)).detail).toContain("still");
  });

  it("says there is no grace period — Atlassian offers none", () => {
    expect(status(inDays(10)).detail).toContain("no grace period");
  });

  it("floors partial days INTO the window rather than rounding out of it", () => {
    // 30 days and 14 hours: rounding would report 31 and keep it green.
    const almost = new Date(NOW.getTime() + (30 * 24 + 14) * 60 * 60 * 1000);
    expect(status(almost).daysRemaining).toBe(30);
    expect(status(almost).status).toBe("EXPIRING_SOON");
  });
});

describe("past expiry", () => {
  it("is EXPIRED, with a negative day count", () => {
    const v = status(inDays(-3));
    expect(v.status).toBe("EXPIRED");
    expect(v.daysRemaining).toBeLessThan(0);
    expect(v.detail).toContain("expired");
  });

  it("tells the customer only they can replace it", () => {
    expect(status(inDays(-1)).detail).toContain("created in Atlassian");
  });
});

describe("no guessing from absence", () => {
  it("gives a stored token with NO recorded expiry its own explicit status", () => {
    // Never CONNECTED (we cannot warn), never NOT_CONFIGURED (a token exists).
    const v = status(null);
    expect(v.status).toBe(ATLASSIAN_TOKEN_EXPIRY_UNKNOWN);
    expect(v.daysRemaining).toBeNull();
    expect(v.detail).toContain("no expiry date was recorded");
    expect(v.detail).toContain(String(ATLASSIAN_TOKEN_MAX_LIFETIME_DAYS));
  });

  it("distinguishes 'no token' from 'no expiry date'", () => {
    expect(status(null, false).status).toBe("NOT_CONFIGURED");
    expect(status(null, true).status).toBe(ATLASSIAN_TOKEN_EXPIRY_UNKNOWN);
  });

  it("reports NOT_CONFIGURED even when a stale expiry date is lying around", () => {
    // `hasToken` is the explicit column; the date is not allowed to imply one.
    expect(
      atlassianTokenExpiryStatus({ hasToken: false, expiresAt: inDays(90), now: NOW }).status,
    ).toBe("NOT_CONFIGURED");
  });

  it("returns null days rather than 0 when there is nothing to count", () => {
    // 0 would render as "expires today" on any surface that formats a number.
    expect(status(null).daysRemaining).toBeNull();
    expect(status(null, false).daysRemaining).toBeNull();
  });
});

describe("rule 19", () => {
  it("takes no token and can therefore leak none", () => {
    // The whole verdict is derived from a boolean and a date. There is no
    // parameter a credential could arrive through.
    const v = status(inDays(5));
    expect(JSON.stringify(v)).not.toMatch(/ATATT|Basic |token=/);
  });
});
