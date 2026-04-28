import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { verifyJwt } from "../src/auth/jwt.js";

const SECRET = "test-secret";

describe("verifyJwt", () => {
  it("returns claims for a valid token", () => {
    const token = jwt.sign({ sub: "u1", role: "admin" }, SECRET, { expiresIn: "5m" });
    const claims = verifyJwt(token, SECRET);
    expect(claims.sub).toBe("u1");
    expect(claims.role).toBe("admin");
  });

  it("throws on invalid signature", () => {
    const token = jwt.sign({ sub: "u1" }, "wrong-secret");
    expect(() => verifyJwt(token, SECRET)).toThrow();
  });

  it("throws on expired token", () => {
    const token = jwt.sign({ sub: "u1" }, SECRET, { expiresIn: "-1s" });
    expect(() => verifyJwt(token, SECRET)).toThrow();
  });

  it("throws on malformed (string) decoded payload", () => {
    // jsonwebtoken returns a string when the token has no JSON payload —
    // we treat that as malformed rather than letting it fall through with
    // an undefined sub/role and bypassing role checks.
    expect(() => verifyJwt("not-a-jwt", SECRET)).toThrow();
  });

  it("normalizes role to undefined when missing", () => {
    const token = jwt.sign({ sub: "u2" }, SECRET, { expiresIn: "5m" });
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
    const token = jwt.sign({ sub: "u3", role: "Admin" }, SECRET, { expiresIn: "5m" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/unrecognized role/i);
  });

  it("throws on a non-canonical role string", () => {
    const token = jwt.sign({ sub: "u4", role: "stranger" }, SECRET, { expiresIn: "5m" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/unrecognized role/i);
  });

  it("throws on an empty-string role claim", () => {
    const token = jwt.sign({ sub: "u5", role: "" }, SECRET, { expiresIn: "5m" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/unrecognized role/i);
  });

  it("throws on a non-string role claim (e.g. number)", () => {
    const token = jwt.sign({ sub: "u6", role: 1 }, SECRET, { expiresIn: "5m" });
    expect(() => verifyJwt(token, SECRET)).toThrow(/unrecognized role/i);
  });

  it("normalizes role to undefined when explicitly null", () => {
    // null is treated like missing — orchestrator's older tokens may
    // ship `role: null` rather than omitting the key entirely.
    const token = jwt.sign({ sub: "u7", role: null }, SECRET, { expiresIn: "5m" });
    const claims = verifyJwt(token, SECRET);
    expect(claims.role).toBeUndefined();
  });

  it("accepts each canonical role", () => {
    for (const role of ["owner", "admin", "family", "guest"] as const) {
      const token = jwt.sign({ sub: `u-${role}`, role }, SECRET, { expiresIn: "5m" });
      const claims = verifyJwt(token, SECRET);
      expect(claims.role).toBe(role);
    }
  });
});
