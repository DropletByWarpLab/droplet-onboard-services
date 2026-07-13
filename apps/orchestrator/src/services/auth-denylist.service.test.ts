/**
 * WARP-490 — access-token denylist service.
 *
 * The service is a thin, best-effort wrapper over Redis (`cache.service`):
 *   • denylistUser writes `auth:denylist:user:<id>` with a caller-supplied TTL,
 *   • isUserDenied reports whether that key is present,
 *   • both fail SOFT — a Redis outage must not brick the caller (the access
 *     token self-expires regardless), so isUserDenied fails OPEN (false).
 *
 * cache.service is mocked so these are pure unit assertions on key shape,
 * TTL plumbing, and the presence→boolean mapping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const cacheGet = vi.fn();
const cacheSet = vi.fn();
vi.mock("./cache.service.js", () => ({
  cacheGet: (...a: unknown[]) => cacheGet(...a),
  cacheSet: (...a: unknown[]) => cacheSet(...a),
}));

import { denylistUser, isUserDenied } from "./auth-denylist.service.js";

const KEY = "auth:denylist:user:u-uuid-1";

beforeEach(() => {
  vi.clearAllMocks();
  cacheGet.mockResolvedValue(null);
  cacheSet.mockResolvedValue(undefined);
});

describe("denylistUser", () => {
  it("writes the canonical per-user key with the caller's TTL", async () => {
    await denylistUser("u-uuid-1", 900);
    expect(cacheSet).toHaveBeenCalledTimes(1);
    expect(cacheSet).toHaveBeenCalledWith(KEY, 1, 900);
  });

  it("keys strictly per user — a different id can't shadow another", async () => {
    await denylistUser("u-uuid-2", 900);
    expect(cacheSet).toHaveBeenCalledWith("auth:denylist:user:u-uuid-2", 1, 900);
  });

  it("does not throw when the Redis write rejects (best-effort)", async () => {
    // cache.service already swallows Redis errors, but stay defensive: even a
    // rejecting cacheSet must not blow up the caller (the delete already
    // committed; revocation is belt-and-suspenders).
    cacheSet.mockRejectedValueOnce(new Error("redis down"));
    await expect(denylistUser("u-uuid-1", 900)).resolves.toBeUndefined();
  });
});

describe("isUserDenied", () => {
  it("returns true when the key is present", async () => {
    cacheGet.mockResolvedValueOnce(1);
    expect(await isUserDenied("u-uuid-1")).toBe(true);
    expect(cacheGet).toHaveBeenCalledWith(KEY);
  });

  it("returns false when the key is absent", async () => {
    cacheGet.mockResolvedValueOnce(null);
    expect(await isUserDenied("u-uuid-1")).toBe(false);
  });

  it("fails OPEN (false) on a Redis miss/outage — cacheGet returns null", async () => {
    // cache.service.cacheGet returns null on any Redis error, so a live outage
    // is indistinguishable from "not listed" here: the request proceeds and
    // the token self-expires in ≤TTL. This is the deliberate availability
    // posture (see checkSession), which is why the denylist is defense-in-
    // depth rather than the sole revocation control.
    cacheGet.mockResolvedValueOnce(null);
    expect(await isUserDenied("u-uuid-1")).toBe(false);
  });
});
