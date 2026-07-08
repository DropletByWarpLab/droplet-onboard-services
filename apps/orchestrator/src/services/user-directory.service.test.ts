import { describe, it, expect, beforeEach } from "vitest";
import {
  emailWriteData,
  readUserEmail,
  findUserByEmail,
  normalizeEmail,
} from "./user-directory.service.js";
import {
  __setColumnCryptoKeyForTest,
  isEncryptedColumn,
  emailLookupHash,
} from "./column-crypto.service.js";

function fakePrisma(rows: Array<Record<string, unknown>>) {
  return {
    user: {
      findUnique: async ({ where }: any) =>
        rows.find((r) => r.emailLookupHash === where.emailLookupHash) ?? null,
      findFirst: async ({ where }: any) =>
        rows.find(
          (r) =>
            r.email === where.email &&
            (where.emailLookupHash === undefined || r.emailLookupHash === where.emailLookupHash),
        ) ?? null,
    },
  } as any;
}

describe("user-directory.service", () => {
  beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 5).toString("base64")));

  it("normalizeEmail trims + lowercases (matches the blind-index normalization)", () => {
    expect(normalizeEmail("  Romain@Example.COM ")).toBe("romain@example.com");
  });

  it("emailWriteData stores a dcv1 blob + deterministic blind index, round-trips", () => {
    const data = emailWriteData("Romain@Example.com");
    expect(isEncryptedColumn(data.email)).toBe(true);
    expect(data.emailLookupHash).toBe(emailLookupHash("romain@example.com"));
    expect(readUserEmail(data.email)).toBe("romain@example.com");
    // GCM is non-deterministic — two writes must not produce equal ciphertext
    // (that's WHY uniqueness lives on the hash, not the ciphertext).
    expect(emailWriteData("romain@example.com").email).not.toBe(data.email);
  });

  it("readUserEmail passes through pre-backfill plaintext and null", () => {
    expect(readUserEmail("legacy@example.com")).toBe("legacy@example.com");
    expect(readUserEmail(null)).toBeNull();
  });

  it("findUserByEmail resolves via the blind index first", async () => {
    const data = emailWriteData("hit@example.com");
    const prisma = fakePrisma([{ id: "u1", ...data }]);
    const found = await findUserByEmail(prisma, "  HIT@example.com ");
    expect(found?.id).toBe("u1");
  });

  it("findUserByEmail falls back to a legacy plaintext row (pre-backfill)", async () => {
    const prisma = fakePrisma([
      { id: "u2", email: "legacy@example.com", emailLookupHash: null },
    ]);
    const found = await findUserByEmail(prisma, "legacy@example.com");
    expect(found?.id).toBe("u2");
  });

  it("findUserByEmail returns null on a miss", async () => {
    const prisma = fakePrisma([]);
    expect(await findUserByEmail(prisma, "nobody@example.com")).toBeNull();
  });
});
