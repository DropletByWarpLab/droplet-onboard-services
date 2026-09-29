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
import { describe, it, expect, beforeEach, vi } from "vitest";
import { generate as otplibGenerate } from "otplib";
import { __setEncryptionKeyForTest } from "./encryption.service.js";
import {
  TOTP_ISSUER,
  generateTotpEnrollment,
  encryptTotpSecret,
  decryptTotpSecret,
  acceptTotpCode,
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
  // WARP-3193 SEC-AUTH-10: verification is reachable only through
  // acceptTotpCode now; a fresh row (nothing accepted yet) isolates it.
  async function verifyTotpCode(secret: string, code: string): Promise<boolean> {
    const prisma = { totpCredential: { updateMany: vi.fn(async () => ({ count: 1 })) } };
    const cred = { userId: "u1", secretEnc: encryptTotpSecret(secret), lastAcceptedStep: 0 };
    return acceptTotpCode(prisma as any, cred, code);
  }

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

// WARP-3193 SEC-AUTH-10 — a TOTP code is accepted at most once. The accepted
// RFC 6238 time step is persisted in `lastAcceptedStep` and claimed through
// ONE conditional update (`lastAcceptedStep < step`), so a replay — or two
// concurrent requests presenting the same code — finds count 0.
describe("totp.service — acceptTotpCode (replay protection)", () => {
  function store(row: { userId: string; secretEnc: string; lastAcceptedStep: number }) {
    return {
      row,
      prisma: {
        totpCredential: {
          updateMany: vi.fn(async ({ where, data }: any) => {
            const ok =
              where.userId === row.userId &&
              where.secretEnc === row.secretEnc &&
              row.lastAcceptedStep < where.lastAcceptedStep.lt;
            if (!ok) return { count: 0 };
            row.lastAcceptedStep = data.lastAcceptedStep;
            return { count: 1 };
          }),
        },
      },
    };
  }

  it("accepts a live code once, stores its step, and refuses the replay", async () => {
    const { secret } = generateTotpEnrollment("stefan@warp.test");
    const { row, prisma } = store({ userId: "u1", secretEnc: encryptTotpSecret(secret), lastAcceptedStep: 0 });
    const code = await otplibGenerate({ secret });

    expect(await acceptTotpCode(prisma as any, row, code)).toBe(true);
    const nowStep = Math.floor(Date.now() / 1000 / 30);
    expect(nowStep - row.lastAcceptedStep).toBeLessThanOrEqual(1);
    expect(nowStep - row.lastAcceptedStep).toBeGreaterThanOrEqual(0);
    expect(prisma.totpCredential.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", secretEnc: row.secretEnc, lastAcceptedStep: { lt: row.lastAcceptedStep } },
      data: { lastAcceptedStep: row.lastAcceptedStep },
    });

    // Same code again → its step is not after the stored one → refused.
    expect(await acceptTotpCode(prisma as any, { ...row }, code)).toBe(false);
  });

  it("two concurrent presentations of the same code → exactly one wins the conditional update", async () => {
    const { secret } = generateTotpEnrollment("stefan@warp.test");
    const { row, prisma } = store({ userId: "u1", secretEnc: encryptTotpSecret(secret), lastAcceptedStep: 0 });
    const code = await otplibGenerate({ secret });
    // Both read the same stale snapshot (lastAcceptedStep 0).
    const snapshot = { ...row };
    const results = await Promise.all([
      acceptTotpCode(prisma as any, snapshot, code),
      acceptTotpCode(prisma as any, snapshot, code),
    ]);
    expect(results.sort()).toEqual([false, true]);
  });

  it("refuses a wrong code without writing", async () => {
    const { secret } = generateTotpEnrollment("stefan@warp.test");
    const { row, prisma } = store({ userId: "u1", secretEnc: encryptTotpSecret(secret), lastAcceptedStep: 0 });
    const valid = await otplibGenerate({ secret });
    expect(await acceptTotpCode(prisma as any, row, valid === "000000" ? "111111" : "000000")).toBe(false);
    expect(prisma.totpCredential.updateMany).not.toHaveBeenCalled();
  });
});
