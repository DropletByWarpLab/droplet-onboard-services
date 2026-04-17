/**
 * WARP-80: tests for normalizeMac — the single source of truth for MAC
 * address canonicalization in the device-registry path. Every reconciler
 * and API-layer path must go through this function before touching Prisma
 * so the `NetworkDevice.mac` primary key stays consistent.
 *
 * Canonical form: uppercase hex bytes separated by colons, e.g. AA:BB:CC:DD:EE:FF.
 */

import { describe, it, expect } from "vitest";
import { normalizeMac } from "./mac.js";
import { DeviceRegistryError } from "../types/device-registry-error.js";

describe("normalizeMac", () => {
  it("passes canonical form through unchanged", () => {
    expect(normalizeMac("AA:BB:CC:DD:EE:FF")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("uppercases lowercase colon form", () => {
    expect(normalizeMac("aa:bb:cc:dd:ee:ff")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("converts dash separators to colons", () => {
    expect(normalizeMac("aa-bb-cc-dd-ee-ff")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("accepts no-separator hex", () => {
    expect(normalizeMac("aabbccddeeff")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("tolerates mixed separators (router UCI dumps are sometimes messy)", () => {
    expect(normalizeMac("aa:bb-cc.ddeeff")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("rejects wrong length with INVALID_MAC", () => {
    let caught: unknown;
    try {
      normalizeMac("AA:BB:CC:DD:EE");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DeviceRegistryError);
    expect((caught as DeviceRegistryError).code).toBe("INVALID_MAC");
  });

  it("rejects non-hex chars with INVALID_MAC", () => {
    let caught: unknown;
    try {
      normalizeMac("AA:BB:CC:DD:EE:GG");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DeviceRegistryError);
    expect((caught as DeviceRegistryError).code).toBe("INVALID_MAC");
  });

  it("rejects empty string", () => {
    expect(() => normalizeMac("")).toThrow(DeviceRegistryError);
  });
});
