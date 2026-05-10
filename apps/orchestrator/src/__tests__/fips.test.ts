/**
 * WARP-229 — orchestrator FIPS integration tests.
 *
 * We mock `crypto.getFips()` and `crypto.createHash("md5")` to simulate
 * the production (FIPS-on) and degraded (FIPS-off / FIPS-loaded-but-not-
 * enforcing) paths without requiring a FIPS OpenSSL on the test runner.
 *
 * Covers:
 *   - Positive boot self-test path: provider loaded, MD5 rejected → ok
 *   - Negative path: MD5 succeeds → asserts the helper throws
 *   - HTTP probe at `/_/fips` returns 200 + `{fips:true,...}` on the
 *     FIPS-on path and 503 on the FIPS-off path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import {
  assertFipsAtBoot,
  FipsSelfTestError,
} from "@droplet/fips-selftest";
import { createFipsRouter } from "../routes/fips.js";

// Pin the FIPS-enforcing simulation: getFips()===1 AND MD5 throws.
function mockFipsEnforcing() {
  const getFipsSpy = vi.spyOn(crypto, "getFips").mockReturnValue(1 as any);
  const createHashSpy = vi
    .spyOn(crypto, "createHash")
    .mockImplementation((alg: string) => {
      if (alg === "md5") throw new Error("disabled for FIPS");
      // For everything else, use the real implementation.
      return (createHashSpy.getMockImplementation() &&
        Reflect.apply(crypto.createHash, crypto, [alg])) as any;
    });
  // Restore non-md5 algorithms by routing through the real createHash.
  createHashSpy.mockImplementation((alg: string) => {
    if (alg === "md5") throw new Error("disabled for FIPS");
    // @ts-expect-error — restoring real impl by un-spying internally would
    // be circular; use the underlying _Hash class via a fresh spy unwind.
    return createHashSpy.getMockImplementation && (createHashSpy as any)._original
      ? (createHashSpy as any)._original(alg)
      : (vi.fn() as any)();
  });
  return { getFipsSpy, createHashSpy };
}

// Simpler: replace createHash with a thin wrapper that only intercepts md5.
function installFipsMock() {
  const getFipsSpy = vi.spyOn(crypto, "getFips").mockReturnValue(1 as any);
  const realCreateHash = crypto.createHash.bind(crypto);
  const createHashSpy = vi
    .spyOn(crypto, "createHash")
    .mockImplementation((alg: any) => {
      if (alg === "md5") throw new Error("disabled for FIPS");
      return realCreateHash(alg);
    });
  return () => {
    getFipsSpy.mockRestore();
    createHashSpy.mockRestore();
  };
}

describe("orchestrator FIPS boot self-test", () => {
  it("positive path: assertFipsAtBoot returns success when FIPS is enforcing", () => {
    const restore = installFipsMock();
    try {
      const lines: string[] = [];
      const result = assertFipsAtBoot("orchestrator", { log: (l) => lines.push(l) });
      expect(result.fips).toBe(true);
      expect(result.service).toBe("orchestrator");
      expect(result.provider).toBe("OpenSSL 3 FIPS");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.event).toBe("fips_self_test");
    } finally {
      restore();
    }
  });

  it("negative path: MD5 succeeding makes the boot self-test throw", () => {
    // No mocks — dev runner has no FIPS, MD5 succeeds.
    const getFipsSpy = vi.spyOn(crypto, "getFips").mockReturnValue(1 as any);
    try {
      expect(() => assertFipsAtBoot("orchestrator", { log: () => {} })).toThrow(
        FipsSelfTestError,
      );
    } finally {
      getFipsSpy.mockRestore();
    }
  });
});

describe("orchestrator /_/fips HTTP endpoint", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(createFipsRouter("orchestrator"));
  });

  it("returns 200 + {fips:true} when FIPS is enforcing", async () => {
    const restore = installFipsMock();
    try {
      const res = await request(app).get("/_/fips");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        event: "fips_self_test",
        service: "orchestrator",
        fips: true,
        provider: "OpenSSL 3 FIPS",
      });
    } finally {
      restore();
    }
  });

  it("returns 503 + {fips:false} when FIPS is not enabled", async () => {
    const getFipsSpy = vi.spyOn(crypto, "getFips").mockReturnValue(0 as any);
    try {
      const res = await request(app).get("/_/fips");
      expect(res.status).toBe(503);
      expect(res.body.fips).toBe(false);
    } finally {
      getFipsSpy.mockRestore();
    }
  });

  it("returns 503 when FIPS is loaded but MD5 succeeds (not enforcing)", async () => {
    const getFipsSpy = vi.spyOn(crypto, "getFips").mockReturnValue(1 as any);
    try {
      // Don't mock createHash — MD5 will succeed on the dev runner.
      const res = await request(app).get("/_/fips");
      expect(res.status).toBe(503);
      expect(res.body.fips).toBe(false);
      expect(res.body.provider).toContain("not enforcing");
    } finally {
      getFipsSpy.mockRestore();
    }
  });
});
