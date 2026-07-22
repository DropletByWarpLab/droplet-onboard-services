/**
 * WARP-247 — `sid` claim plumbing through the JWT sign/verify pair.
 *
 * The session id is the join key between a stateless JWT and its
 * server-side session record (sess:rec:{sid}). Both token types must
 * carry it losslessly; tokens signed WITHOUT one (legacy, pre-deploy)
 * must verify with `sid` undefined so the middleware can apply the
 * one-release grace path.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Neutralise the Redis-backed denylist so verifyRefreshToken resolves
// without a live Redis (mirrors auth.jwt-uuid.test.ts posture).
vi.mock("./cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheSetNx: vi.fn().mockResolvedValue(true),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheSetAdd: vi.fn().mockResolvedValue(undefined),
  cacheSetRemove: vi.fn().mockResolvedValue(undefined),
  cacheSetMembers: vi.fn().mockResolvedValue([]),
}));

import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "./jwt.service.js";

const user = {
  id: "u-uuid-0001",
  username: "alice",
  displayName: "Alice",
  role: "family" as const,
};

describe("WARP-247 — sid claim in access/refresh tokens", () => {
  it("carries sid through access-token sign → verify", () => {
    const token = signAccessToken({ ...user, sid: "sid-access-1" });
    const payload = verifyAccessToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.sid).toBe("sid-access-1");
  });

  it("carries sid through refresh-token sign → verify", async () => {
    const token = signRefreshToken({ ...user, sid: "sid-refresh-1" });
    const payload = await verifyRefreshToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.sid).toBe("sid-refresh-1");
  });

  it("verifies legacy tokens (no sid) with sid undefined — grace path", async () => {
    const access = verifyAccessToken(signAccessToken(user));
    expect(access).not.toBeNull();
    expect(access!.sid).toBeUndefined();

    const refresh = await verifyRefreshToken(signRefreshToken(user));
    expect(refresh).not.toBeNull();
    expect(refresh!.sid).toBeUndefined();
  });

  it("keeps sid alongside the lastMfaAt claim on access tokens", () => {
    const stamp = new Date().toISOString();
    const token = signAccessToken({ ...user, lastMfaAt: stamp, sid: "sid-mfa-1" });
    const payload = verifyAccessToken(token);
    expect(payload!.lastMfaAt).toBe(stamp);
    expect(payload!.sid).toBe("sid-mfa-1");
  });
});
