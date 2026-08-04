/**
 * WARP-1673 — routerErrorFromResponse classification, focused on the new 502
 * contract: the routing service reserves 502 for "the router rejected the
 * routing service's own rpcd credentials" (body code ROUTER_AUTH), which must
 * surface as RouterError AUTH so the dashboard renders the actionable
 * "Credentials rejected" copy instead of "Router offline".
 */
import { describe, expect, it } from "vitest";

import { RouterError, routerErrorFromResponse } from "./router-error.js";

function response(status: number, headers?: Record<string, string>): Response {
  // Response() forbids 1xx/204-style bodies but a null body is fine for all
  // the statuses under test.
  return new Response(null, { status, headers });
}

describe("routerErrorFromResponse", () => {
  it("maps 401 and 403 to AUTH (orchestrator↔routing bearer failures)", () => {
    for (const status of [401, 403]) {
      const err = routerErrorFromResponse(response(status), "Router summary");
      expect(err).toBeInstanceOf(RouterError);
      expect(err.code).toBe("AUTH");
      expect(err.status).toBe(status);
    }
  });

  it("maps 502 to AUTH (routing↔router credential rejection, WARP-1673)", () => {
    const err = routerErrorFromResponse(response(502), "Router summary");
    expect(err.code).toBe("AUTH");
    expect(err.status).toBe(502);
  });

  it("classifies 502 as AUTH even when an operation id is present", () => {
    // An auth-refused write never changed anything on the router, so it must
    // not be reported as a rollback — order of the branches matters.
    const err = routerErrorFromResponse(
      response(502, { "X-Operation-Id": "op-123" }),
      "Set SSID",
    );
    expect(err.code).toBe("AUTH");
  });

  it("keeps 5xx + X-Operation-Id as ROLLED_BACK for non-502 statuses", () => {
    const err = routerErrorFromResponse(
      response(500, { "X-Operation-Id": "op-123" }),
      "Set SSID",
    );
    expect(err.code).toBe("ROLLED_BACK");
  });

  it("keeps plain 5xx as UNREACHABLE", () => {
    const err = routerErrorFromResponse(response(503), "Router summary");
    expect(err.code).toBe("UNREACHABLE");
  });

  it("keeps other 4xx as UNKNOWN with the status preserved", () => {
    // The 409 SCAN_UNSUPPORTED rethrow in openwrt.client.ts relies on this.
    const err = routerErrorFromResponse(response(409), "Wireless scan");
    expect(err.code).toBe("UNKNOWN");
    expect(err.status).toBe(409);
  });
});
