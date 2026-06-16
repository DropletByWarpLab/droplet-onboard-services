/**
 * WARP-808 (review #5): the shared device-bridge connection-error classifier,
 * extracted from the verbatim copies in routes/storage.ts and
 * services/hostapd-bridge.service.ts. Both call sites import this one definition.
 */
import { describe, it, expect } from "vitest";
import { isBridgeConnectionError } from "./bridge-errors.js";

describe("isBridgeConnectionError", () => {
  it("matches an undici-style error whose cause.code is a connection code", () => {
    // This is exactly how a failed `fetch()` to an absent bridge surfaces.
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    expect(isBridgeConnectionError(err)).toBe(true);
  });

  it("matches when the code sits directly on the error (older paths)", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND bridge"), {
      code: "ENOTFOUND",
    });
    expect(isBridgeConnectionError(err)).toBe(true);
  });

  it.each(["EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"])(
    "recognizes %s as a connection failure",
    (code) => {
      expect(
        isBridgeConnectionError(Object.assign(new Error("x"), { cause: { code } })),
      ).toBe(true);
    },
  );

  it("does NOT match a reachable-bridge error (e.g. a timeout or HTTP error)", () => {
    expect(isBridgeConnectionError(new Error("The bridge returned 422"))).toBe(false);
    expect(
      isBridgeConnectionError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })),
    ).toBe(false);
  });

  it("does NOT match non-Error values", () => {
    expect(isBridgeConnectionError(undefined)).toBe(false);
    expect(isBridgeConnectionError("ECONNREFUSED")).toBe(false);
    expect(isBridgeConnectionError({ code: "ECONNREFUSED" })).toBe(false);
  });
});
