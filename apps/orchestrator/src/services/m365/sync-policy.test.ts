/**
 * WARP-2118 / ADR-041 — the pure decisions inside the Graph sync engine.
 *
 * The box has no inbound path, so Graph change-notification subscriptions
 * (which need a public HTTPS endpoint) are unavailable and delta-query polling
 * is the sync mechanism by design. That makes these four decisions the whole
 * engine, and all of them are cheap to get wrong in ways that only show up on
 * a customer's box weeks later:
 *
 *   - classifySyncFailure: is this a wobble, a dead delta token, a dead grant,
 *     or something genuinely broken? Each needs a different recovery.
 *   - parseRetryAfter / computeBackoffMs: throttled requests STILL COUNT
 *     against Microsoft's budget, so ignoring Retry-After makes throttling
 *     worse rather than better.
 *   - extractDeltaLinks: the deltaLink must be stored WHOLE and opaque — it
 *     encodes $select and other state, and rebuilding it silently changes what
 *     the next sync asks for.
 */
import { describe, it, expect } from "vitest";

import {
  classifySyncFailure,
  computeBackoffMs,
  parseRetryAfter,
  extractDeltaLinks,
  graphUserAgent,
  MAX_BACKOFF_MS,
} from "./sync-policy.js";

describe("classifySyncFailure", () => {
  it("treats 410 Gone as RESYNC_REQUIRED — the delta token is dead", () => {
    // Graph answers 410 when a delta token can no longer be honoured. It is a
    // normal state transition (re-enumerate from scratch), not an error.
    expect(classifySyncFailure({ statusCode: 410 })).toBe("RESYNC_REQUIRED");
  });

  it("recognises the Outlook and Drive resync codes by name", () => {
    // Outlook evicts old delta tokens from an internal cache with no fixed
    // lifetime, so this is expected on any long-lived connection.
    expect(classifySyncFailure({ code: "syncStateNotFound" })).toBe("RESYNC_REQUIRED");
    expect(classifySyncFailure({ code: "resyncRequired" })).toBe("RESYNC_REQUIRED");
    // Drive distinguishes two resync flavours; both mean re-enumerate.
    expect(classifySyncFailure({ code: "resyncChangesApplyDifferences" })).toBe(
      "RESYNC_REQUIRED",
    );
    expect(classifySyncFailure({ code: "resyncChangesUploadDifferences" })).toBe(
      "RESYNC_REQUIRED",
    );
  });

  it("treats 429 and 5xx as TRANSIENT", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifySyncFailure({ statusCode: status })).toBe("TRANSIENT");
    }
  });

  it("treats network-level failures as TRANSIENT", () => {
    for (const code of ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"]) {
      expect(classifySyncFailure({ code })).toBe("TRANSIENT");
    }
  });

  it("treats 401/403 as AUTH so the connection — not the cursor — is repaired", () => {
    // A dead grant is a property of the CONNECTION. Marking the cursor failed
    // would leave every other cursor retrying against the same dead token.
    expect(classifySyncFailure({ statusCode: 401 })).toBe("AUTH");
    expect(classifySyncFailure({ statusCode: 403 })).toBe("AUTH");
  });

  it("defaults to FATAL so a genuinely broken request stops rather than hammering", () => {
    expect(classifySyncFailure({ statusCode: 400 })).toBe("FATAL");
    expect(classifySyncFailure({})).toBe("FATAL");
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
  });

  it("reads an HTTP-date relative to now", () => {
    const now = new Date("2026-08-21T12:00:00Z");
    expect(parseRetryAfter("Fri, 21 Aug 2026 12:00:30 GMT", now)).toBe(30_000);
  });

  it("never returns a negative wait for a date already past", () => {
    const now = new Date("2026-08-21T12:00:00Z");
    expect(parseRetryAfter("Fri, 21 Aug 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("returns null for a missing or unparseable header", () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("soon-ish")).toBeNull();
  });
});

describe("computeBackoffMs", () => {
  it("obeys Retry-After exactly when Microsoft sends one", () => {
    // Not a suggestion: throttled requests still count against the budget, so
    // retrying early actively makes throttling worse.
    expect(computeBackoffMs(1, 90_000)).toBe(90_000);
    expect(computeBackoffMs(7, 90_000)).toBe(90_000);
  });

  it("grows with consecutive failures when there is no Retry-After", () => {
    const first = computeBackoffMs(1, null, () => 0.5);
    const later = computeBackoffMs(4, null, () => 0.5);
    expect(later).toBeGreaterThan(first);
  });

  it("caps the wait so a cursor cannot back off effectively forever", () => {
    expect(computeBackoffMs(50, null, () => 1)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });

  it("applies jitter so many cursors do not retry in lockstep", () => {
    // Every workload for every user waking at the same instant is how a box
    // turns one throttle into a stampede.
    const low = computeBackoffMs(3, null, () => 0);
    const high = computeBackoffMs(3, null, () => 1);
    expect(high).toBeGreaterThan(low);
  });

  it("never returns a negative or zero wait", () => {
    expect(computeBackoffMs(1, null, () => 0)).toBeGreaterThan(0);
  });
});

describe("extractDeltaLinks", () => {
  it("returns the deltaLink WHOLE when a page is the last one", () => {
    // Stored opaquely on purpose: the link encodes $select and other state,
    // and rebuilding it silently changes what the next sync asks for.
    const link = "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=abc&$select=id";
    expect(extractDeltaLinks({ "@odata.deltaLink": link })).toEqual({
      deltaLink: link,
      nextLink: null,
    });
  });

  it("returns the nextLink while a page run is still in progress", () => {
    const next = "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=xyz";
    expect(extractDeltaLinks({ "@odata.nextLink": next })).toEqual({
      deltaLink: null,
      nextLink: next,
    });
  });

  it("returns neither when the response carries no links", () => {
    expect(extractDeltaLinks({})).toEqual({ deltaLink: null, nextLink: null });
  });
});

describe("graphUserAgent", () => {
  it("uses the ISV format Microsoft asks integrators to send", () => {
    // Also what makes a support escalation tractable when a tenant is
    // throttling us and nobody can tell which app is responsible.
    expect(graphUserAgent("1.2.3")).toBe("ISV|WarpLab|Droplet/1.2.3");
  });
});
