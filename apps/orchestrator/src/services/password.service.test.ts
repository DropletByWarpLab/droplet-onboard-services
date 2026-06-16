/**
 * ADR-013 — built-in argon2id directory.
 *
 * The directory is the auth source of truth. This service is the
 * vetted-library boundary for password hashing + verification. Contract
 * locked here:
 *
 *   1. `hashPassword` returns an argon2id PHC string ($argon2id$...),
 *      never bcrypt, never plaintext.
 *   2. `verifyPassword` is true for the right password, false for the
 *      wrong one, false for a malformed/foreign hash (never throws on a
 *      bad stored value — a corrupt row must read as "auth failed", not
 *      crash the login route).
 *   3. `verifyDummyPassword` exists so the login route can spend
 *      comparable CPU on the unknown-email branch — anti-enumeration.
 *      It always returns false and never throws.
 *   4. The tuned params are argon2id with memoryCost / timeCost /
 *      parallelism at or above the OWASP floor, and are introspectable
 *      (PASSWORD_HASH_PARAMS) so the migration/ADR and tests stay in
 *      sync with what actually runs.
 *
 * NEVER log hashes or passwords — asserted indirectly: this service
 * takes no logger and exposes no stringification of secrets.
 */
import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
  PASSWORD_HASH_PARAMS,
} from "./password.service.js";

describe("ADR-013 password.service — argon2id directory", () => {
  it("hashes to an argon2id PHC string (never bcrypt, never plaintext)", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$/);
    // Defense against an accidental algo swap: bcrypt hashes start with $2.
    expect(hash).not.toMatch(/^\$2[aby]?\$/);
    // The plaintext must not survive into the stored value.
    expect(hash).not.toContain("correct horse battery staple");
  });

  it("produces a unique salt per call (two hashes of the same password differ)", async () => {
    const a = await hashPassword("same-password-here");
    const b = await hashPassword("same-password-here");
    expect(a).not.toBe(b);
  });

  it("verifies the correct password", async () => {
    const hash = await hashPassword("hunter22hunter22");
    await expect(verifyPassword(hash, "hunter22hunter22")).resolves.toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("hunter22hunter22");
    await expect(verifyPassword(hash, "not-the-password")).resolves.toBe(false);
  });

  it("returns false (does not throw) on a malformed/foreign stored hash", async () => {
    // A corrupt or bcrypt-era row must read as "auth failed", never crash
    // the login route. This is the constant-time-verify safety contract.
    await expect(verifyPassword("not-a-real-hash", "whatever")).resolves.toBe(
      false,
    );
    await expect(
      verifyPassword("$2b$10$abcdefghijklmnopqrstuv", "whatever"),
    ).resolves.toBe(false);
    await expect(verifyPassword("", "whatever")).resolves.toBe(false);
  });

  it("verifyDummyPassword always returns false and never throws (anti-enumeration)", async () => {
    await expect(verifyDummyPassword("anything")).resolves.toBe(false);
    await expect(verifyDummyPassword("")).resolves.toBe(false);
  });

  it("exposes tuned argon2id params at or above the OWASP floor", () => {
    expect(PASSWORD_HASH_PARAMS.type).toBe("argon2id");
    // OWASP Password Storage Cheat Sheet (argon2id): m>=19456 KiB (19 MiB),
    // t>=2, p>=1. We pin at or above that.
    expect(PASSWORD_HASH_PARAMS.memoryCost).toBeGreaterThanOrEqual(19456);
    expect(PASSWORD_HASH_PARAMS.timeCost).toBeGreaterThanOrEqual(2);
    expect(PASSWORD_HASH_PARAMS.parallelism).toBeGreaterThanOrEqual(1);
  });
});
