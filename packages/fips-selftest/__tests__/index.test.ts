import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import {
  assertFipsAtBoot,
  FIPS_PROVIDER_NAME,
  FipsSelfTestError,
  isFipsEnabled,
  md5ShouldFail,
  sha256ShouldWork,
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
    // Bind the real implementation BEFORE spying — calling crypto.createHash
    // inside the mock would recurse into the mock itself.
    const realCreateHash = crypto.createHash.bind(crypto);
    const spy = vi.spyOn(crypto, "createHash").mockImplementation(((alg: string) => {
      if (alg === "md5") throw new Error("disabled for FIPS");
      return realCreateHash(alg);
    }) as typeof crypto.createHash);
    expect(md5ShouldFail()).toBe("disabled for FIPS");
    spy.mockRestore();
  });

  it("returns null when MD5 unexpectedly works (FIPS NOT enforcing)", () => {
    // Default behavior of node on dev machines: MD5 works.
    expect(md5ShouldFail()).toBeNull();
  });
});

describe("sha256ShouldWork", () => {
  it("returns null when SHA-256 works (provider active)", () => {
    // Default behavior everywhere: an approved digest is available.
    expect(sha256ShouldWork()).toBeNull();
  });

  it("returns the error message when SHA-256 throws (provider dead)", () => {
    // WARP-1063: a failed provider activation under the fips=yes property
    // pin leaves NOTHING fetchable — even approved digests die.
    const spy = vi.spyOn(crypto, "createHash").mockImplementation(() => {
      throw new Error("unsupported");
    });
    expect(sha256ShouldWork()).toBe("unsupported");
    spy.mockRestore();
  });
});

describe("assertFipsAtBoot", () => {
  it("emits a structured log line on success", () => {
    const getFipsSpy = vi.spyOn(crypto, "getFips").mockReturnValue(1 as any);
    // Bind the real implementation BEFORE spying (see md5ShouldFail test) —
    // the WARP-1063 positive probe calls createHash("sha256") through the
    // mock, and a self-referencing mock would recurse.
    const realCreateHash = crypto.createHash.bind(crypto);
    const md5Spy = vi.spyOn(crypto, "createHash").mockImplementation(((alg: string) => {
      if (alg === "md5") throw new Error("disabled for FIPS");
      return realCreateHash(alg);
    }) as typeof crypto.createHash);

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

  it("throws when the approved digest is unavailable (provider did not activate)", () => {
    // WARP-1063: fips=yes pinned (getFips()==1) but the provider never
    // activated — EVERY digest is unfetchable, not just MD5. The self-test
    // must fail closed with the provider-not-active diagnosis instead of
    // reporting fips:true and letting TLS clients die later with
    // LIBRARY_HAS_NO_CIPHERS.
    const getFipsSpy = vi.spyOn(crypto, "getFips").mockReturnValue(1 as any);
    const hashSpy = vi.spyOn(crypto, "createHash").mockImplementation(() => {
      throw new Error("unsupported");
    });
    expect(() => assertFipsAtBoot("orchestrator", { log: () => {} })).toThrow(
      /approved digest SHA-256 unavailable/,
    );
    hashSpy.mockRestore();
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
