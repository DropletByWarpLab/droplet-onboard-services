/**
 * WARP-808 (review #5): the shared device-bridge connection-error classifier,
 * extracted from the verbatim copies in routes/storage.ts and
 * services/hostapd-bridge.service.ts. Both call sites import this one definition.
 */
import { afterEach, describe, it, expect } from "vitest";
import {
  bridgeAdminToken,
  bridgeAuthToken,
  isBridgeConnectionError,
} from "./bridge-errors.js";

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

// WARP-3595: destructive bridge routes use SERVICE_TOKEN_BRIDGE; everything else
// keeps the panel token, so a box mid-update still reads from the bridge.
describe("bridge tokens", () => {
  const keys = ["BRIDGE_AUTH_TOKEN", "SERVICE_TOKEN_DISPLAY", "SERVICE_TOKEN_BRIDGE", "DEVICE_SECRET_KEY"];
  afterEach(() => {
    for (const k of keys) delete process.env[k];
  });

  it("bridgeAdminToken prefers SERVICE_TOKEN_BRIDGE and never the panel token when it is set", () => {
    process.env.SERVICE_TOKEN_DISPLAY = "panel";
    process.env.SERVICE_TOKEN_BRIDGE = " admin ";
    expect(bridgeAdminToken()).toBe("admin");
    expect(bridgeAuthToken()).toBe("panel");
  });

  it("bridgeAdminToken falls back to the panel token on a box without the new key", () => {
    process.env.SERVICE_TOKEN_DISPLAY = "panel";
    expect(bridgeAdminToken()).toBe("panel");
  });

  it("neither helper ever returns the master key", () => {
    process.env.DEVICE_SECRET_KEY = "master";
    expect(bridgeAdminToken()).toBe("");
    expect(bridgeAuthToken()).toBe("");
  });
});
