/**
 * Recovery-code service — one-time backup codes for the TOTP second factor.
 *
 * Codes are shown to the user exactly once at generation; only their
 * argon2id hashes are persisted (reusing `password.service`). At login a
 * candidate code is matched against the user's UNUSED code hashes; the
 * matching hash is returned so the caller can mark that single row used.
 *
 * These tests run the real argon2id hashing (slow but correct) so the
 * generate → hash → match round-trip is exercised exactly as production.
 */
import { describe, it, expect, vi } from "vitest";
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  findMatchingRecoveryCodeHash,
  consumeRecoveryCode,
} from "./recovery.service.js";
import { hashPassword, verifyPassword } from "./password.service.js";

describe("recovery.service — generation", () => {
  it("produces RECOVERY_CODE_COUNT plaintext codes and an equal number of hashes", async () => {
    const { plaintext, hashes } = await generateRecoveryCodes();
    expect(plaintext).toHaveLength(RECOVERY_CODE_COUNT);
    expect(hashes).toHaveLength(RECOVERY_CODE_COUNT);
  });

  it("formats codes as readable grouped lowercase tokens, all distinct", async () => {
    const { plaintext } = await generateRecoveryCodes();
    for (const code of plaintext) {
      // e.g. "3f9a-b2c7" — two base32-ish groups separated by a hyphen.
      expect(code).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    }
    expect(new Set(plaintext).size).toBe(plaintext.length);
  });

  it("stores hashes, not plaintext — every hash is an argon2id PHC string", async () => {
    const { plaintext, hashes } = await generateRecoveryCodes();
    for (const h of hashes) {
      expect(h.startsWith("$argon2id$")).toBe(true);
      expect(plaintext).not.toContain(h);
    }
  });

  it("each emitted hash verifies against its own plaintext code", async () => {
    const { plaintext, hashes } = await generateRecoveryCodes();
    // The arrays are positionally aligned: hashes[i] is hash(plaintext[i]).
    for (let i = 0; i < plaintext.length; i++) {
      expect(await verifyPassword(hashes[i]!, plaintext[i]!)).toBe(true);
    }
  });
});

describe("recovery.service — matching at login", () => {
  it("returns the matching hash for a correct, unused code", async () => {
    const { plaintext, hashes } = await generateRecoveryCodes();
    const match = await findMatchingRecoveryCodeHash(plaintext[3]!, hashes);
    expect(match).toBe(hashes[3]);
  });

  it("is case-insensitive and tolerant of surrounding whitespace", async () => {
    const { plaintext, hashes } = await generateRecoveryCodes();
    const noisy = `  ${plaintext[0]!.toUpperCase()}  `;
    const match = await findMatchingRecoveryCodeHash(noisy, hashes);
    expect(match).toBe(hashes[0]);
  });

  it("returns null for a code that matches none of the stored hashes", async () => {
    const { hashes } = await generateRecoveryCodes();
    const match = await findMatchingRecoveryCodeHash("zzzz-zzzz", hashes);
    expect(match).toBeNull();
  });

  it("returns null (no crash) when the stored-hash list is empty", async () => {
    const match = await findMatchingRecoveryCodeHash("3f9a-b2c7", []);
    expect(match).toBeNull();
  });

  it("returns null for a malformed candidate without throwing", async () => {
    const { hashes } = await generateRecoveryCodes();
    expect(await findMatchingRecoveryCodeHash("", hashes)).toBeNull();
  });
});

// WARP-3193 ARCH-3 — the ONE consume path shared by /auth/login and
// /auth/recovery: match against UNUSED codes, then claim exactly that row
// under a `usedAt: null` guard so a concurrent replay loses.
describe("recovery.service — consumeRecoveryCode", () => {
  async function prismaWith(codes: string[]) {
    const rows = await Promise.all(
      codes.map(async (c, i) => ({
        id: `rc-${i}`,
        userId: "u1",
        codeHash: await hashPassword(c),
        usedAt: null as Date | null,
      })),
    );
    const prisma = {
      recoveryCode: {
        findMany: vi.fn(async ({ where }: any) =>
          rows.filter((r) => r.userId === where.userId && r.usedAt === null),
        ),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const r = rows.find((x) => x.id === where.id && x.usedAt === null);
          if (!r) return { count: 0 };
          r.usedAt = data.usedAt;
          return { count: 1 };
        }),
      },
    };
    return { prisma, rows };
  }

  it("consumes a matching code once and reports the remaining count", async () => {
    const { prisma, rows } = await prismaWith(["aaaa-bbbb", "cccc-dddd"]);
    const first = await consumeRecoveryCode(prisma as any, "u1", " AAAA-BBBB ");
    expect(first).toEqual({ consumed: true, remaining: 1 });
    expect(rows[0]!.usedAt).toBeInstanceOf(Date);
    // A replay of the same code matches nothing.
    expect(await consumeRecoveryCode(prisma as any, "u1", "aaaa-bbbb")).toEqual({ consumed: false });
  });

  it("rejects a non-matching code without writing", async () => {
    const { prisma } = await prismaWith(["aaaa-bbbb"]);
    expect(await consumeRecoveryCode(prisma as any, "u1", "zzzz-zzzz")).toEqual({ consumed: false });
    expect(prisma.recoveryCode.updateMany).not.toHaveBeenCalled();
  });

  it("loses the race when a concurrent consume already claimed the row (count 0)", async () => {
    const { prisma } = await prismaWith(["aaaa-bbbb"]);
    prisma.recoveryCode.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await consumeRecoveryCode(prisma as any, "u1", "aaaa-bbbb")).toEqual({ consumed: false });
    expect(prisma.recoveryCode.updateMany).toHaveBeenCalledWith({
      where: { id: "rc-0", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
  });
});
