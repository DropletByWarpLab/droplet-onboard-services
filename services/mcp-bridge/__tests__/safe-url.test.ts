/**
 * WARP-2398 — the ADR-043 §6 exact-host guard.
 *
 * Every host in this file is an RFC 2606 reserved name (`.example` /
 * `.test`), so no real destination is named and the egress gate's own
 * scope rules (tests are out of scope) are not being leaned on to hide one.
 */
import { describe, it, expect } from "vitest";
import {
  assertSafeMcpUrl,
  parseAllowedMcpHosts,
  UnsafeMcpUrlError,
} from "../src/safe-url.js";

const ALLOWED = parseAllowedMcpHosts("mcp.vendor.example");

describe("assertSafeMcpUrl", () => {
  it("accepts a registered https host and normalises it", () => {
    expect(assertSafeMcpUrl("https://mcp.vendor.example/v1/mcp/", ALLOWED)).toBe(
      "https://mcp.vendor.example/v1/mcp",
    );
  });

  it("refuses http — a Basic credential over http is the credential given away", () => {
    expect(() => assertSafeMcpUrl("http://mcp.vendor.example/v1/mcp", ALLOWED)).toThrow(
      /not https/,
    );
  });

  it("refuses userinfo in the URL", () => {
    expect(() =>
      assertSafeMcpUrl("https://evil@mcp.vendor.example/v1/mcp", ALLOWED),
    ).toThrow(/userinfo/);
  });

  it("refuses a suffix look-alike (exact match, never endsWith)", () => {
    expect(() =>
      assertSafeMcpUrl("https://mcp.vendor.example.evil.test/v1/mcp", ALLOWED),
    ).toThrow(UnsafeMcpUrlError);
  });

  it("refuses a host that merely contains the registered one", () => {
    expect(() =>
      assertSafeMcpUrl("https://notmcp.vendor.example/v1/mcp", ALLOWED),
    ).toThrow(UnsafeMcpUrlError);
  });

  it("refuses any port but 443, and accepts an explicit :443", () => {
    expect(() => assertSafeMcpUrl("https://mcp.vendor.example:8443/", ALLOWED)).toThrow(
      /port 8443/,
    );
    expect(assertSafeMcpUrl("https://mcp.vendor.example:443/v1/mcp", ALLOWED)).toBe(
      "https://mcp.vendor.example/v1/mcp",
    );
  });

  it("refuses a non-URL", () => {
    expect(() => assertSafeMcpUrl("mcp.vendor.example", ALLOWED)).toThrow(/not a URL/);
  });

  /**
   * The shipping state. `parseAllowedMcpHosts(undefined)` is empty, and empty
   * must deny — not "allow anything because nothing is configured", which is
   * the sovereignty-gate failure mode `off-lan-gate.service.ts` records
   * having shipped once already.
   */
  it("denies EVERY host when the allowed set is empty (the default)", () => {
    const empty = parseAllowedMcpHosts(undefined);
    expect(empty.size).toBe(0);
    expect(() => assertSafeMcpUrl("https://mcp.vendor.example/", empty)).toThrow(
      /no remote MCP host is registered/,
    );
  });

  it("parses a list tolerantly and lowercases it", () => {
    const set = parseAllowedMcpHosts(" MCP.Vendor.Example , other.test ,, ");
    expect([...set].sort()).toEqual(["mcp.vendor.example", "other.test"]);
  });
});
