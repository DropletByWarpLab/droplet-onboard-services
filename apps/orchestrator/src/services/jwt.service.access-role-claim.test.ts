/**
 * WARP-1582 — the `accessRoleId` claim on access tokens.
 *
 * The claim is THREE-STATE, and the distinction is the entire safety
 * property (see the trust argument in tool-access.service.ts):
 *
 *   undefined — claim ABSENT. Either a token minted before this shipped,
 *               or a mint site that did not supply it. Means "unknown";
 *               every consumer must fall back to the database.
 *   null      — claim PRESENT, and says this person holds no custom
 *               access role. The one value a consumer may act on.
 *   string    — claim PRESENT and names a role. Carried for observability
 *               and future use; it is never a grant source, because the
 *               grants themselves still have to be read.
 *
 * `null` and `undefined` collapse into each other under almost every
 * careless JS idiom (`?.`, `??`, `!x`, JSON round-trips that drop
 * undefined). These tests exist because that collapse is a fail-OPEN bug:
 * an absent claim read as "no custom role" silently drops the WARP-1529
 * per-role tool narrowing for every pre-deploy token.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("./cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheSetNx: vi.fn().mockResolvedValue(true),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheSetAdd: vi.fn().mockResolvedValue(undefined),
  cacheSetRemove: vi.fn().mockResolvedValue(undefined),
  cacheSetMembers: vi.fn().mockResolvedValue([]),
}));

import jwt from "jsonwebtoken";
import { signAccessToken, verifyAccessToken } from "./jwt.service.js";

const SECRET = "test-secret-32-bytes-long-aaaaaaaa";
const base = {
  id: "u-uuid-0001",
  username: "alice",
  displayName: "Alice",
  role: "family" as const,
  sid: "sid-1",
};

describe("WARP-1582 — accessRoleId claim, three-state", () => {
  it("carries a role id through sign → verify", () => {
    const token = signAccessToken({ ...base, accessRoleId: "ar-finance" });
    expect(verifyAccessToken(token)?.accessRoleId).toBe("ar-finance");
  });

  it("carries an EXPLICIT null — present, and distinguishable from absent", () => {
    const token = signAccessToken({ ...base, accessRoleId: null });
    const decoded = verifyAccessToken(token)!;
    expect(decoded).toHaveProperty("accessRoleId");
    expect(decoded.accessRoleId).toBeNull();
  });

  it("omits the claim entirely when the mint site supplies nothing", () => {
    // Partial rollout must be SAFE: a mint site this ticket did not reach
    // produces the old token shape, and the consumer falls back to the DB.
    const token = signAccessToken(base);
    const decoded = verifyAccessToken(token)!;
    expect(decoded).not.toHaveProperty("accessRoleId");
    expect(decoded.accessRoleId).toBeUndefined();
  });

  it("verifies a legacy token (minted before the claim existed) as ABSENT", () => {
    const legacy = jwt.sign(
      {
        sub: base.id,
        username: base.username,
        displayName: base.displayName,
        role: base.role,
        sid: base.sid,
        type: "access",
      },
      SECRET,
      { expiresIn: 900 },
    );
    expect(verifyAccessToken(legacy)).not.toHaveProperty("accessRoleId");
  });

  it("treats a MALFORMED claim as absent, not as null — fail-safe coercion", () => {
    // A number, an object, an array: anything that is neither a string nor
    // null must degrade to "unknown" (→ database read), never to the one
    // value that permits eliding the read.
    for (const bad of [42, { id: "x" }, ["ar-x"], true]) {
      const token = jwt.sign(
        {
          sub: base.id,
          username: base.username,
          displayName: base.displayName,
          role: base.role,
          accessRoleId: bad,
          type: "access",
        },
        SECRET,
        { expiresIn: 900 },
      );
      const decoded = verifyAccessToken(token)!;
      expect(decoded, `claim ${JSON.stringify(bad)} must decode as absent`).not.toHaveProperty(
        "accessRoleId",
      );
    }
  });

  it("keeps the claim alongside sid + lastMfaAt without disturbing either", () => {
    const token = signAccessToken({
      ...base,
      lastMfaAt: "2026-01-01T00:00:00.000Z",
      accessRoleId: "ar-ops",
    });
    const decoded = verifyAccessToken(token)!;
    expect(decoded.sid).toBe("sid-1");
    expect(decoded.lastMfaAt).toBe("2026-01-01T00:00:00.000Z");
    expect(decoded.accessRoleId).toBe("ar-ops");
  });
});
