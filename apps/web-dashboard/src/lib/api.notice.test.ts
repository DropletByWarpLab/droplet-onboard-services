/**
 * WARP-807 (K3) — UX review follow-up. `routerUnreachableNotice` classifies a
 * router-reachability failure and, when it is one, returns the actionable
 * notice broken into { prefix, destination } so each wizard surface can name
 * the *correct* place to finish later (Wi-Fi/DuckDNS → "Network"; WireGuard →
 * "Remote Access") and monospace just the destination name, mirroring the
 * LearnMoreCards. Non-reachability errors still return null so the caller falls
 * back to the real message.
 */
import { describe, it, expect } from "vitest";
import { RouterStatusError, routerUnreachableNotice } from "./api";

describe("routerUnreachableNotice (WARP-807, per-surface destination)", () => {
  it("returns the prefix + the supplied destination for an UNREACHABLE error", () => {
    const out = routerUnreachableNotice(
      new RouterStatusError("UNREACHABLE", "fetch failed", 503),
      "Network",
    );
    expect(out).not.toBeNull();
    expect(out!.destination).toBe("Network");
    expect(out!.prefix).toMatch(/router isn't reachable yet/i);
    // The prefix carries the connective; the destination is rendered separately
    // (monospaced) by the caller, so the destination must NOT be baked into it.
    expect(out!.prefix).not.toMatch(/Network/);
    // And we never point the customer at "Settings" (the dead-end the review flagged).
    expect(out!.prefix).not.toMatch(/Settings/i);
  });

  it("honors a different destination per surface (Remote Access)", () => {
    const out = routerUnreachableNotice(
      new RouterStatusError("UNREACHABLE", "fetch failed", 503),
      "Remote Access",
    );
    expect(out!.destination).toBe("Remote Access");
  });

  it.each(["UNREACHABLE", "TIMEOUT", "DISABLED"] as const)(
    "treats code %s as a reachability problem",
    (code) => {
      expect(
        routerUnreachableNotice(new RouterStatusError(code, "x"), "Network"),
      ).not.toBeNull();
    },
  );

  it("classifies a bare 503 status (any code) as reachability", () => {
    expect(
      routerUnreachableNotice(
        new RouterStatusError("UNKNOWN", "x", 503),
        "Network",
      ),
    ).not.toBeNull();
    // A plain object carrying a 503 status, too (defensive path).
    expect(
      routerUnreachableNotice({ status: 503 }, "Network"),
    ).not.toBeNull();
  });

  it("returns null for an ordinary (non-reachability) error", () => {
    expect(
      routerUnreachableNotice(new Error("Subdomain already in use"), "Network"),
    ).toBeNull();
    expect(
      routerUnreachableNotice(
        new RouterStatusError("AUTH", "unauthorized", 401),
        "Network",
      ),
    ).toBeNull();
  });
});
