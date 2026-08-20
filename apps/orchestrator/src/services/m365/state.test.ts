/**
 * WARP-2115 / ADR-041 — the pure decisions behind a Microsoft 365 link.
 *
 * These are the parts that are easy to get quietly wrong and expensive to
 * debug on a customer's box, so they are pure functions with no I/O:
 *
 *   - classifyAuthFailure: does this Entra failure mean "ask the person to
 *     sign in again" (NEEDS_RECONNECT) or "something is misconfigured and
 *     signing in again will not help" (ERROR)? Getting this backwards either
 *     nags a customer to re-consent forever against a broken app registration,
 *     or buries a revoked grant in an error banner they cannot act on.
 *   - isPendingFlowExpired: an orchestrator restart drops the in-memory device
 *     -code flow. Without an expiry sweep the row sits PENDING_CONSENT forever
 *     and the person can never start a new sign-in.
 *   - redactAuthError: whatever we persist in `lastError` is rendered in the
 *     dashboard. It must never carry a token, a device code, or a bearer.
 */
import { describe, it, expect } from "vitest";

import {
  classifyAuthFailure,
  isPendingFlowExpired,
  redactAuthError,
  PENDING_FLOW_TTL_MS,
} from "./state.js";

describe("classifyAuthFailure", () => {
  it("treats a revoked or expired grant as NEEDS_RECONNECT, not an error", () => {
    // The single most common real-world case: an admin resets the person's
    // password, or the box sat powered off past the 90-day refresh window.
    // Entra answers invalid_grant. The person just needs to sign in again.
    for (const code of [
      "invalid_grant",
      "interaction_required",
      "consent_required",
      "login_required",
    ]) {
      expect(classifyAuthFailure({ errorCode: code })).toBe("NEEDS_RECONNECT");
    }
  });

  it("recognises the AADSTS codes for revoked tokens and lapsed refresh windows", () => {
    // MSAL frequently surfaces the specific reason only inside errorMessage.
    const revoked = {
      errorCode: "invalid_grant",
      errorMessage: "AADSTS50173: The provided grant has expired due to it being revoked.",
    };
    const lapsed = {
      errorCode: "",
      errorMessage: "AADSTS700082: The refresh token has expired due to inactivity.",
    };
    expect(classifyAuthFailure(revoked)).toBe("NEEDS_RECONNECT");
    expect(classifyAuthFailure(lapsed)).toBe("NEEDS_RECONNECT");
  });

  it("treats a rejected or unknown app registration as ERROR — reconnecting cannot fix it", () => {
    // These mean OUR configuration is wrong (or the tenant has not consented
    // to the app at all). Telling the customer to sign in again would loop.
    const cases = [
      { errorCode: "unauthorized_client" },
      { errorCode: "invalid_client" },
      { errorCode: "", errorMessage: "AADSTS700016: Application with identifier 'x' was not found" },
    ];
    for (const c of cases) expect(classifyAuthFailure(c)).toBe("ERROR");
  });

  it("treats a tenant that blocks device code flow as ERROR, so the UI can offer the fallback", () => {
    // Microsoft's own Conditional Access guidance recommends blocking device
    // code flow, so this is expected in hardened tenants — but it is NOT a
    // reconnect: the person must use the auth-code path instead.
    expect(
      classifyAuthFailure({
        errorCode: "invalid_grant",
        errorMessage: "AADSTS50199: device code flow is blocked by Conditional Access policy",
      }),
    ).toBe("ERROR");
  });

  it("defaults an unrecognised failure to ERROR rather than nagging the customer", () => {
    expect(classifyAuthFailure({ errorCode: "something_new" })).toBe("ERROR");
    expect(classifyAuthFailure({})).toBe("ERROR");
  });
});

describe("isPendingFlowExpired", () => {
  const now = new Date("2026-08-20T12:00:00Z");

  it("is expired once the recorded deadline has passed", () => {
    expect(isPendingFlowExpired(new Date("2026-08-20T11:59:59Z"), now)).toBe(true);
  });

  it("is not expired while the deadline is still ahead", () => {
    expect(isPendingFlowExpired(new Date("2026-08-20T12:00:01Z"), now)).toBe(false);
  });

  it("treats a missing deadline as expired so a half-written row cannot wedge", () => {
    // A PENDING_CONSENT row with no deadline would otherwise be unrecoverable:
    // never swept, and blocking every future connect attempt.
    expect(isPendingFlowExpired(null, now)).toBe(true);
  });

  it("uses a TTL at or under Microsoft's ~15 minute device-code lifetime", () => {
    expect(PENDING_FLOW_TTL_MS).toBeGreaterThan(0);
    expect(PENDING_FLOW_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});

describe("redactAuthError", () => {
  it("keeps the AADSTS identifier, which is what makes a failure diagnosable", () => {
    const out = redactAuthError({
      errorCode: "invalid_grant",
      errorMessage: "AADSTS50173: The provided grant has expired.",
    });
    expect(out).toContain("AADSTS50173");
  });

  it("never carries token, code or bearer material into a persisted field", () => {
    // lastError is rendered in the dashboard and lands in logs; a leaked
    // refresh token here would defeat the point of encrypting the cache.
    const out = redactAuthError({
      errorCode: "invalid_grant",
      errorMessage:
        "failed for refresh_token=0.AXoAlonger-secret-value and device_code=GAQABAAEAAAD--secret",
    });
    expect(out).not.toContain("0.AXoAlonger-secret-value");
    expect(out).not.toContain("GAQABAAEAAAD--secret");
  });

  it("bounds the length so a huge Entra payload cannot bloat the row", () => {
    const out = redactAuthError({ errorCode: "x", errorMessage: "y".repeat(5000) });
    expect(out.length).toBeLessThanOrEqual(500);
  });

  it("still returns something useful when Entra gives us nothing", () => {
    expect(redactAuthError({}).length).toBeGreaterThan(0);
  });
});
