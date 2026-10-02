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
  parseAppRegistration,
  redactAuthError,
  PENDING_FLOW_TTL_MS,
} from "./state.js";

const CLIENT = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const TENANT = "9a8b7c6d-5e4f-4321-8fed-cba987654321";

describe("parseAppRegistration (WARP-2705)", () => {
  it("accepts a client id and a tenant id copied from the app's Overview page", () => {
    expect(parseAppRegistration({ clientId: CLIENT, tenantId: TENANT })).toEqual({
      ok: true,
      app: { clientId: CLIENT, tenantId: TENANT },
    });
  });

  it("accepts a verified domain in place of the tenant GUID", () => {
    // Entra takes either as the authority's tenant segment.
    expect(parseAppRegistration({ clientId: CLIENT, tenantId: "practice.onmicrosoft.com" })).toEqual({
      ok: true,
      app: { clientId: CLIENT, tenantId: "practice.onmicrosoft.com" },
    });
  });

  it("normalises case and surrounding whitespace, the usual damage from a paste", () => {
    expect(
      parseAppRegistration({ clientId: ` ${CLIENT.toUpperCase()} `, tenantId: " Practice.COM\n" }),
    ).toEqual({ ok: true, app: { clientId: CLIENT, tenantId: "practice.com" } });
  });

  it("refuses the multitenant authorities — the whole point is the customer's own tenant", () => {
    // `/organizations` is exactly what WARP-2705 removes. Accepting it here
    // would put the fleet-pooled, publisher-gated shape back one paste away.
    // The DOMAIN shape alone would refuse these too (no dot); the explicit
    // check is what tells the owner WHY, instead of "that isn't a domain".
    for (const tenantId of ["common", "organizations", "consumers", "ORGANIZATIONS"]) {
      expect(parseAppRegistration({ clientId: CLIENT, tenantId })).toMatchObject({
        ok: false,
        field: "tenantId",
        reason: expect.stringMatching(/your organisation's own/i),
      });
    }
  });

  it("refuses anything that could reshape the authority URL", () => {
    // The tenant is interpolated into the sign-in URL's path. A value that is
    // not a GUID or a hostname must never reach it.
    for (const tenantId of ["../common", "a/b", "tenant?x=1", "x#y", "", "-bad-.com", "no-dot"]) {
      expect(parseAppRegistration({ clientId: CLIENT, tenantId })).toMatchObject({
        ok: false,
        field: "tenantId",
      });
    }
  });

  it("refuses a client id that is not a GUID", () => {
    for (const clientId of ["", "droplet", `${CLIENT}x`, "0f1e2d3c4b5a49688776a5b4c3d2e1f0"]) {
      expect(parseAppRegistration({ clientId, tenantId: TENANT })).toMatchObject({
        ok: false,
        field: "clientId",
      });
    }
  });

  it("refuses non-string input rather than coercing it", () => {
    expect(parseAppRegistration({ clientId: 42, tenantId: TENANT })).toMatchObject({ ok: false });
    expect(parseAppRegistration({ clientId: CLIENT, tenantId: null })).toMatchObject({ ok: false });
  });
});

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

  it("treats a mis-registered redirect or platform as ERROR, even when Entra calls it invalid_grant", () => {
    // WARP-2704. These are the ways a customer's app registration can be wrong
    // for the authorization-code path. Every one arrives at the token endpoint
    // looking like a grant problem, and every one fails identically however
    // many times the person signs in — so none of them may read as "reconnect".
    const cases = [
      "AADSTS50011: The redirect URI specified in the request does not match",
      "AADSTS7000218: The request body must contain client_assertion or client_secret",
      "AADSTS9002327: Tokens issued for the 'Single-Page Application' client-type may only be redeemed via cross-origin requests",
      "AADSTS50194: Application is not configured as a multi-tenant application",
      "AADSTS90094: The grant requires admin permission",
    ];
    for (const errorMessage of cases) {
      expect(classifyAuthFailure({ errorCode: "invalid_grant", errorMessage })).toBe("ERROR");
    }
  });

  it("defaults an unrecognised failure to ERROR rather than nagging the customer", () => {
    expect(classifyAuthFailure({ errorCode: "something_new" })).toBe("ERROR");
    expect(classifyAuthFailure({})).toBe("ERROR");
  });

  // --- review #1658 finding 2 --------------------------------------------
  it("classifies transport failures as TRANSIENT, so a WAN blip cannot downgrade a healthy box", () => {
    // ERROR is terminal by its own definition, and the sync engine skips rows
    // in it. If a thirty-second outage during a silent refresh landed there,
    // syncing would stop permanently and nothing would self-heal it.
    for (const code of [
      "network_error",
      "temporarily_unavailable",
      "request_timeout",
      "server_error",
      "ECONNRESET",
      "ENOTFOUND",
    ]) {
      expect(classifyAuthFailure({ errorCode: code })).toBe("TRANSIENT");
    }
  });

  it("treats 429 and 5xx as TRANSIENT, and 4xx client errors as not-transient", () => {
    expect(classifyAuthFailure({ statusCode: 429 })).toBe("TRANSIENT");
    expect(classifyAuthFailure({ statusCode: 503 })).toBe("TRANSIENT");
    expect(classifyAuthFailure({ statusCode: 500 })).toBe("TRANSIENT");
    expect(classifyAuthFailure({ statusCode: 400 })).toBe("ERROR");
  });

  // --- review #1658 finding 3 --------------------------------------------
  it("treats an abandoned sign-in as ABANDONED, not a failure", () => {
    // Closing the tab, letting the code lapse, or pressing Cancel are normal.
    // Recording them as ERROR would show an alarming, untrue banner.
    for (const code of [
      "authorization_declined",
      "access_denied",
      "expired_token",
      "device_code_expired",
      "user_cancelled",
    ]) {
      expect(classifyAuthFailure({ errorCode: code })).toBe("ABANDONED");
    }
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

  // --- review #1658 finding 1 --------------------------------------------
  it("removes a BARE JWT entirely, not just labels it", () => {
    // The original rule appended "=[redacted]" to the match and kept the token
    // verbatim, so an id_token echoed by Entra would have been persisted to
    // lastError, rendered in the dashboard, and returned in the error body.
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const out = redactAuthError({ errorCode: "invalid_grant", errorMessage: `failed with ${jwt}` });

    expect(out).not.toContain(jwt);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toContain("invalid_grant");
  });

  it("removes a bare opaque secret that carries no name or delimiter", () => {
    const secret = "0AXoAqwertyuiopasdfghjklzxcvbnm1234567890QWERTYUIOP";
    const out = redactAuthError({ errorMessage: `rejected ${secret}` });
    expect(out).not.toContain(secret);
  });

  it("keeps the credential's NAME while dropping its value", () => {
    // "which credential was involved" is diagnostic; the value never is.
    const out = redactAuthError({
      errorMessage: "refresh_token=0.AXoAsecretvalue was rejected",
    });
    expect(out).toContain("refresh_token");
    expect(out).not.toContain("0.AXoAsecretvalue");
  });

  it("keeps a plain Error's message instead of collapsing to 'no reason'", () => {
    // A DNS or Prisma failure has `message`, not `errorMessage`; losing it
    // left support with nothing to go on.
    const out = redactAuthError({ message: "getaddrinfo EAI_AGAIN login.example" } as never);
    expect(out).toContain("EAI_AGAIN");
  });
});
