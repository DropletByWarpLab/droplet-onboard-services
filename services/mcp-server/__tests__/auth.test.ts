import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { verifyJwt } from "../src/auth/jwt.js";

const SECRET = "test-secret";

// Helper — every test mints orchestrator-shaped access tokens. The
// `type: "access"` claim is required after WARP-103 reviewer follow-up
// (matches `apps/orchestrator/src/services/jwt.service.ts`).
// `expiresIn` is typed from `SignOptions`, not inferred as `string`: the
// library narrows it to `number | StringValue` (a `${number}${unit}` template
// union), and a bare `string` does not satisfy it. Inference gave `string`
// here and nothing caught it while `__tests__` was excluded from `tsc`.
function signAccess(
  payload: Record<string, unknown>,
  secret = SECRET,
  expiresIn: SignOptions["expiresIn"] = "5m",
): string {
  return jwt.sign({ type: "access", ...payload }, secret, { expiresIn });
}

describe("verifyJwt", () => {
  it("returns claims for a valid access token", () => {
    const token = signAccess({ sub: "u1", role: "admin" });
    const claims = verifyJwt(token, SECRET);
    expect(claims.sub).toBe("u1");
    expect(claims.role).toBe("admin");
  });

  it("throws on invalid signature", () => {
    const token = signAccess({ sub: "u1" }, "wrong-secret");
    expect(() => verifyJwt(token, SECRET)).toThrow();
  });

  it("throws on expired token", () => {
    const token = signAccess({ sub: "u1" }, SECRET, "-1s");
    expect(() => verifyJwt(token, SECRET)).toThrow();
  });

  it("throws on malformed (string) decoded payload", () => {
    // jsonwebtoken returns a string when the token has no JSON payload —
    // we treat that as malformed rather than letting it fall through with
    // an undefined sub/role and bypassing role checks.
    expect(() => verifyJwt("not-a-jwt", SECRET)).toThrow();
  });

  // WARP-103 reviewer follow-up: token-type confusion. The orchestrator
  // signs both access (15 min) and refresh (7 day) tokens with the same
  // secret. Without this guard, a refresh token would verify on the
  // mcp-server HTTP path and grant full RBAC for its 7-day lifetime.
  it("throws on a refresh token (type='refresh')", () => {
    const token = jwt.sign({ type: "refresh", sub: "u1", role: "admin" }, SECRET, { expiresIn: "7d" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/expected token type "access"/);
  });

  it("throws on a token with no type claim (defensive — orchestrator always sets it)", () => {
    const token = jwt.sign({ sub: "u1", role: "admin" }, SECRET, { expiresIn: "5m" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/expected token type "access"/);
  });

  it("throws on a token with a non-string type claim", () => {
    const token = jwt.sign({ type: 1, sub: "u1", role: "admin" }, SECRET, { expiresIn: "5m" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/expected token type "access"/);
  });

  // WARP-103 reviewer follow-up: empty sub. Matches orchestrator's
  // auth-middleware contract — a missing/empty subject would bind a
  // ToolContext with `userId: undefined`, which is the stdio-only shape.
  it("throws on a token with empty sub", () => {
    const token = signAccess({ sub: "", role: "admin" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/missing or empty sub/);
  });

  it("throws on a token with no sub claim", () => {
    const token = jwt.sign({ type: "access", role: "admin" }, SECRET, { expiresIn: "5m" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/missing or empty sub/);
  });

  it("normalizes role to undefined when missing", () => {
    const token = signAccess({ sub: "u2" });
    const claims = verifyJwt(token, SECRET);
    expect(claims.sub).toBe("u2");
    expect(claims.role).toBeUndefined();
  });

  // WARP-103 reviewer follow-up: an unknown role string must HARD-FAIL,
  // not silently downgrade to `undefined`. `undefined` is the
  // stdio-trusted-principal sentinel inside rbac.ts (paired with
  // `trustedPrincipal: true`); the HTTP path must never pretend an
  // unknown-role JWT is the trusted in-proc agent.
  it("throws on case-sensitive role mismatch (e.g. 'Admin')", () => {
    const token = signAccess({ sub: "u3", role: "Admin" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/unrecognized role/i);
  });

  it("throws on a non-canonical role string", () => {
    const token = signAccess({ sub: "u4", role: "stranger" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/unrecognized role/i);
  });

  it("throws on an empty-string role claim", () => {
    const token = signAccess({ sub: "u5", role: "" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/unrecognized role/i);
  });

  it("throws on a non-string role claim (e.g. number)", () => {
    const token = signAccess({ sub: "u6", role: 1 });
    expect(() => verifyJwt(token, SECRET)).toThrow(/unrecognized role/i);
  });

  it("normalizes role to undefined when explicitly null", () => {
    // null is treated like missing — orchestrator's older tokens may
    // ship `role: null` rather than omitting the key entirely.
    const token = signAccess({ sub: "u7", role: null });
    const claims = verifyJwt(token, SECRET);
    expect(claims.role).toBeUndefined();
  });

  it("accepts each canonical role", () => {
    for (const role of ["owner", "admin", "family", "guest"] as const) {
      const token = signAccess({ sub: `u-${role}`, role });
      const claims = verifyJwt(token, SECRET);
      expect(claims.role).toBe(role);
    }
  });
});
