/**
 * WARP-1049 — shared temp-password generator. The setup wizard's "Create
 * local account" dialog auto-generates a temporary password the operator hands
 * to the new member (show-once + copy). Because the SAME @droplet/auth-policy
 * `validatePassword` gates every credential surface (client checklist + server
 * passwordZod), the generator MUST produce a value that always passes it —
 * otherwise the server 400s WEAK_PASSWORD on a value the UI presented as valid.
 *
 * Uses Web Crypto `getRandomValues` (available in the browser + Node ≥ 15),
 * NOT Math.random — a temp credential is a real secret.
 */
import { describe, it, expect } from "vitest";
import { generateTempPassword } from "../generate.js";
import { validatePassword, PASSWORD_MIN } from "../password.js";

describe("generateTempPassword", () => {
  it("always produces a password that passes validatePassword", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generateTempPassword();
      const r = validatePassword(pw);
      expect(r.ok, `failed for "${pw}": ${r.failed.join(",")}`).toBe(true);
    }
  });

  it("meets the length floor", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateTempPassword().length).toBeGreaterThanOrEqual(PASSWORD_MIN);
    }
  });

  it("includes all four character classes on every draw (so it can't miss the 3-class rule)", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generateTempPassword();
      expect(/[a-z]/.test(pw), pw).toBe(true);
      expect(/[A-Z]/.test(pw), pw).toBe(true);
      expect(/[0-9]/.test(pw), pw).toBe(true);
      expect(/[^a-zA-Z0-9]/.test(pw), pw).toBe(true);
    }
  });

  it("is non-deterministic (two consecutive draws differ)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generateTempPassword());
    // 50 independent high-entropy draws must not collide.
    expect(seen.size).toBe(50);
  });

  it("excludes visually ambiguous characters (0/O, 1/l/I) so a handed-off password is transcribable", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generateTempPassword();
      expect(/[0O1lI]/.test(pw), pw).toBe(false);
    }
  });
});
