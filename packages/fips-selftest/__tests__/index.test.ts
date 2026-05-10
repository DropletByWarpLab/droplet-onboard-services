import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import {
  assertFipsAtBoot,
  FIPS_PROVIDER_NAME,
  FipsSelfTestError,
  isFipsEnabled,
  md5ShouldFail,
} from "../src/index.js";

// These tests pin the *contract* of the helper without requiring an
// actual FIPS-enabled OpenSSL on the test runner (developer laptops,
// GitHub Ubuntu runners don't have FIPS enabled by default). They mock
// `crypto.getFips` and `crypto.createHash` to simulate both the
// FIPS-on path and every failure mode.

describe("isFipsEnabled", () => {
  it("returns true when crypto.getFips() === 1", () => {
    const spy = vi.spyOn(crypto, "getFips").mockReturnValue(1 as any);
    expect(isFipsEnabled()).toBe(true);
    spy.mockRestore();
  });

  it("returns false when crypto.getFips() === 0", () => {
    const spy = vi.spyOn(crypto, "getFips").mockReturnValue(0 as any);
    expect(isFipsEnabled()).toBe(false);
    spy.mockRestore();
  });

  it("returns false when crypto.getFips throws", () => {
    const spy = vi.spyOn(crypto, "getFips").mockImplementation(() => {
      throw new Error("not supported");
    });
    expect(isFipsEnabled()).toBe(false);
    spy.mockRestore();
  });
});

describe("md5ShouldFail", () => {
  it("returns the error message when MD5 throws (FIPS enforcing)", () => {
    const spy = vi.spyOn(crypto, "createHash").mockImplementation((alg: string) => {
      if (alg === "md5") throw new Error("disabled for FIPS");
      return crypto.createHash("sha256");
    });
    expect(md5ShouldFail()).toBe("disabled for FIPS");
    spy.mockRestore();
  });

  it("returns null when MD5 unexpectedly works (FIPS NOT enforcing)", () => {
    // Default behavior of node on dev machines: MD5 works.
    expect(md5ShouldFail()).toBeNull();
  });
});

describe("assertFipsAtBoot", () => {
  it("emits a structured log line on success", () => {
    const getFipsSpy = vi.spyOn(crypto, "getFips").mockReturnValue(1 as any);
    const md5Spy = vi.spyOn(crypto, "createHash").mockImplementation((alg: string) => {
      if (alg === "md5") throw new Error("disabled for FIPS");
      return crypto.createHash("sha256");
    });

    const lines: string[] = [];
    const result = assertFipsAtBoot("orchestrator", { log: (l) => lines.push(l) });

    expect(result).toEqual({
      event: "fips_self_test",
      service: "orchestrator",
      fips: true,
      provider: FIPS_PROVIDER_NAME,
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe("fips_self_test");
    expect(parsed.service).toBe("orchestrator");
    expect(parsed.fips).toBe(true);
    expect(parsed.provider).toBe(FIPS_PROVIDER_NAME);

    getFipsSpy.mockRestore();
    md5Spy.mockRestore();
  });

  it("throws when getFips() is false", () => {
    const spy = vi.spyOn(crypto, "getFips").mockReturnValue(0 as any);
    expect(() => assertFipsAtBoot("orchestrator", { log: () => {} })).toThrow(
      FipsSelfTestError,
    );
    spy.mockRestore();
  });

  it("throws when MD5 unexpectedly succeeds (FIPS not enforcing)", () => {
    const getFipsSpy = vi.spyOn(crypto, "getFips").mockReturnValue(1 as any);
    // Don't mock createHash — MD5 will succeed on a non-FIPS dev runner.
    expect(() => assertFipsAtBoot("orchestrator", { log: () => {} })).toThrow(
      /FIPS provider is loaded but not enforcing/,
    );
    getFipsSpy.mockRestore();
  });

  it("requires a service name", () => {
    expect(() => assertFipsAtBoot("", { log: () => {} })).toThrow(FipsSelfTestError);
  });

  it("includes service name in the failure message", () => {
    const spy = vi.spyOn(crypto, "getFips").mockReturnValue(0 as any);
    try {
      assertFipsAtBoot("mcp-server", { log: () => {} });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as FipsSelfTestError).service).toBe("mcp-server");
      expect((err as Error).message).toContain("mcp-server");
    }
    spy.mockRestore();
  });
});
