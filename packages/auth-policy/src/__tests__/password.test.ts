import { describe, it, expect } from "vitest";
import { validatePassword, PASSWORD_RULES, PASSWORD_MIN, PASSWORD_MAX } from "../password.js";

describe("validatePassword", () => {
  it("rejects an 11-char password (below the 12 minimum)", () => {
    // 'Aa1!Aa1!Aa1' = 11 chars, 4 classes — fails ONLY on length.
    const r = validatePassword("Aa1!Aa1!Aa1");
    expect(r.ok).toBe(false);
    expect(r.failed).toContain("length");
    expect(r.failed).not.toContain("classes");
  });

  it("accepts a 12-char password with 3 classes", () => {
    // 'Abcdefghijk1' = 12 chars: lower+upper+digit = 3 classes.
    const r = validatePassword("Abcdefghijk1");
    expect(r.ok).toBe(true);
    expect(r.failed).toEqual([]);
  });

  it("rejects a long password with only 2 classes", () => {
    // 'abcdefghijklmnop1' = 17 chars: lower+digit = 2 classes.
    const r = validatePassword("abcdefghijklmnop1");
    expect(r.ok).toBe(false);
    expect(r.failed).toContain("classes");
    expect(r.failed).not.toContain("length");
  });

  it("rejects a password over the 128 maximum", () => {
    const r = validatePassword("Aa1!".repeat(33)); // 132 chars
    expect(r.failed).toContain("length");
  });

  it("exposes rules for UI rendering with stable ids", () => {
    expect(PASSWORD_RULES.map((x) => x.id)).toEqual(["length", "classes"]);
    expect(PASSWORD_MIN).toBe(12);
    expect(PASSWORD_MAX).toBe(128);
  });
});
