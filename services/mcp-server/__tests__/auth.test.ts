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

  it("normalizes role to undefined when not in the role enum", () => {
    const token = jwt.sign({ sub: "u3", role: "stranger" }, SECRET, { expiresIn: "5m" });
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
