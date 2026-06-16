/**
 * TOTP service — RFC 6238 second factor for the built-in directory.
 *
 * The service is the only place that talks to the `otplib` vetted library
 * and the only place that knows the TOTP secret in plaintext. It:
 *   - mints a fresh Base32 secret + the `otpauth://` enrollment URI,
 *   - encrypts/decrypts the secret at rest by delegating to the existing
 *     aes-256-gcm `encryption.service` (DEVICE_SECRET_KEY) — NO new key,
 *   - verifies a 6-digit code against a stored secret with a small
 *     time-window tolerance (±1 period) and constant-time comparison.
 *
 * These tests drive the real otplib + a test-installed encryption key so
 * the round-trip (mint → encrypt → decrypt → verify the live code) is
 * exercised end-to-end without touching env or a DB.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { generate as otplibGenerate } from "otplib";
import { __setEncryptionKeyForTest } from "./encryption.service.js";
import {
  TOTP_ISSUER,
  generateTotpEnrollment,
  encryptTotpSecret,
  decryptTotpSecret,
  verifyTotpCode,
} from "./totp.service.js";

// A known 32-byte key (base64) so encrypt/decrypt work without env setup.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
  __setEncryptionKeyForTest(TEST_KEY);
});

describe("totp.service — enrollment", () => {
  it("mints a Base32 secret and an otpauth:// URI carrying the issuer + label", () => {
    const { secret, otpauthUri } = generateTotpEnrollment("stefan@warp.test");

    // Base32 alphabet only (RFC 4648, no padding) — authenticator-app compatible.
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(16);

    expect(otpauthUri.startsWith("otpauth://totp/")).toBe(true);
    // Issuer + the user label are both present (URI-encoded) so the
    // authenticator app shows "Droplet (stefan@warp.test)".
    expect(otpauthUri).toContain(encodeURIComponent(TOTP_ISSUER));
    expect(otpauthUri).toContain(encodeURIComponent("stefan@warp.test"));
    // The secret travels in the query, never the path.
    expect(otpauthUri).toContain(`secret=${secret}`);
  });

  it("mints a different secret on every call (fresh randomness)", () => {
    const a = generateTotpEnrollment("a@x.test").secret;
    const b = generateTotpEnrollment("b@x.test").secret;
    expect(a).not.toEqual(b);
  });
});

describe("totp.service — encryption at rest", () => {
  it("round-trips a secret through encrypt → decrypt", () => {
    const { secret } = generateTotpEnrollment("stefan@warp.test");
    const blob = encryptTotpSecret(secret);

    // The stored blob must NOT be the plaintext secret (encrypted at rest).
    expect(blob).not.toContain(secret);
    expect(decryptTotpSecret(blob)).toBe(secret);
  });
});

describe("totp.service — verification", () => {
  it("accepts the current valid code for the secret", async () => {
    const { secret } = generateTotpEnrollment("stefan@warp.test");
    const code = await otplibGenerate({ secret });
    expect(await verifyTotpCode(secret, code)).toBe(true);
  });

  it("rejects a wrong 6-digit code", async () => {
    const { secret } = generateTotpEnrollment("stefan@warp.test");
    const valid = await otplibGenerate({ secret });
    // Flip the code to something guaranteed different but still 6 digits.
    const wrong = valid === "000000" ? "111111" : "000000";
    expect(await verifyTotpCode(secret, wrong)).toBe(false);
  });

  it("rejects malformed input (empty / non-numeric) without throwing", async () => {
    const { secret } = generateTotpEnrollment("stefan@warp.test");
    expect(await verifyTotpCode(secret, "")).toBe(false);
    expect(await verifyTotpCode(secret, "abcdef")).toBe(false);
    expect(await verifyTotpCode(secret, "12345")).toBe(false); // too short
  });

  it("rejects a code against a corrupt stored secret without throwing", async () => {
    // A foreign / non-Base32 secret must read as 'invalid code', not crash.
    expect(await verifyTotpCode("not a real secret!!", "123456")).toBe(false);
  });
});
