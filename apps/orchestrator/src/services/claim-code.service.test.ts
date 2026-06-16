/**
 * Unit tests for the claim-code MINT/SEED service (WARP-632 / ADR-017).
 *
 * The verify half (consumeClaimCode) shipped in PR #373; this service is the
 * MINT half ADR-017 assigns to the orchestrator: it produces an unambiguous
 * DRPL-XXXX-XXXX code, seeds ONLY its hash via the existing
 * `setup-claim.service.seedClaimCode` (so the hash matches verify), holds the
 * plaintext in memory, and — crucially — maintains exactly ONE `available`
 * row while the box is unclaimed (no pile-up) without rotating on every tick
 * within a single process.
 *
 * Contract under test (spec §1, AC 1/5/6):
 *   - generateClaimCode() → DRPL-XXXX-XXXX from the no-0/O/1/I alphabet,
 *     crypto-random (two distinct calls differ).
 *   - isClaimed(prisma) → true iff a `consumed` row exists.
 *   - ensureClaimCode(prisma):
 *       * claimed → returns null (nothing to render);
 *       * unclaimed, empty → mints one code, deletes prior `available` rows,
 *         seeds the new hash, returns plaintext;
 *       * re-invoked within one process while unclaimed → SAME plaintext, no
 *         new row (idempotent, no rotation, no pile-up);
 *       * CLAIM_CODE env set → seeds THAT exact code instead of minting;
 *       * the seeded hash equals hashClaimCode(plaintext) so the existing
 *         verify path (consumeClaimCode) accepts the minted code.
 *   - getCurrentClaimCode() exposes the in-memory plaintext.
 *
 * Strategy mirrors setup-claim.service.test.ts: an in-memory `claimCode`
 * stand-in + a `$transaction` that runs the callback against the same store,
 * so deleteMany + create are observed as one unit. We unmock @prisma/client
 * so the generated runtime resolves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.unmock("@prisma/client");

import {
  generateClaimCode,
  isClaimed,
  ensureClaimCode,
  getCurrentClaimCode,
  _resetClaimCodeMemoForTests,
  CLAIM_CODE_ALPHABET,
} from "./claim-code.service.js";
import { hashClaimCode, consumeClaimCode, CLAIM_OUTCOME } from "./setup-claim.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type Row = {
  id: string;
  codeHash: string;
  state: "available" | "consumed";
  expiresAt: Date;
  usedAt: Date | null;
  attempts: number;
};

/**
 * In-memory `claimCode` store covering exactly the slice the mint service +
 * the verify service touch: count, findFirst, create, deleteMany, updateMany.
 * `$transaction(fn)` runs the callback against the same store so the
 * delete-prior + seed-new sequence is atomic.
 */
function createPrismaMock() {
  const rows: Row[] = [];

  const claimCode = {
    _rows: () => rows,
    _seed: (row: Partial<Row> & { codeHash: string }) => {
      const full: Row = {
        id: row.id ?? `cc-${rows.length + 1}`,
        codeHash: row.codeHash,
        state: row.state ?? "available",
        expiresAt: row.expiresAt ?? new Date(Date.now() + DAY_MS),
        usedAt: row.usedAt ?? null,
        attempts: row.attempts ?? 0,
      };
      rows.push(full);
      return full;
    },
    count: async ({ where }: { where?: { state?: string } } = {}) => {
      if (!where?.state) return rows.length;
      return rows.filter((r) => r.state === where.state).length;
    },
    findFirst: async ({ where }: { where: { codeHash?: string; state?: string } }) => {
      const found = rows.find(
        (r) =>
          (where.codeHash === undefined || r.codeHash === where.codeHash) &&
          (where.state === undefined || r.state === where.state),
      );
      return found ? { ...found } : null;
    },
    create: async ({ data }: { data: { codeHash: string; expiresAt: Date } }) => {
      const full: Row = {
        id: `cc-${rows.length + 1}`,
        codeHash: data.codeHash,
        state: "available",
        expiresAt: data.expiresAt,
        usedAt: null,
        attempts: 0,
      };
      rows.push(full);
      return { ...full };
    },
    deleteMany: async ({ where }: { where?: { state?: string } } = {}) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (where?.state === undefined || rows[i].state === where.state) {
          rows.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; state?: string; expiresAt?: { gt: Date } };
      data: Partial<Row>;
    }) => {
      let count = 0;
      for (const r of rows) {
        if (r.id !== where.id) continue;
        if (where.state !== undefined && r.state !== where.state) continue;
        if (where.expiresAt?.gt !== undefined && !(r.expiresAt > where.expiresAt.gt)) continue;
        Object.assign(r, data);
        count += 1;
      }
      return { count };
    },
  };

  return {
    claimCode,
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ claimCode }),
  };
}

describe("generateClaimCode (WARP-632)", () => {
  it("matches the DRPL-XXXX-XXXX shape from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateClaimCode();
      expect(code).toMatch(/^DRPL-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    }
  });

  it("excludes the ambiguous glyphs 0 O 1 I from the alphabet", () => {
    expect(CLAIM_CODE_ALPHABET).not.toMatch(/[01OI]/);
    // And the generated body (after stripping DRPL- prefix + dashes) too.
    const body = generateClaimCode().replace(/^DRPL-/, "").replace(/-/g, "");
    expect(body).not.toMatch(/[01OI]/);
  });

  it("is crypto-random: consecutive codes differ", () => {
    const a = generateClaimCode();
    const b = generateClaimCode();
    const c = generateClaimCode();
    // Vanishingly unlikely (8 chars from a 32-glyph alphabet) to collide.
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("isClaimed (WARP-632)", () => {
  beforeEach(() => {
    process.env.DEVICE_SECRET = "test-device-secret";
  });
  afterEach(() => {
    delete process.env.DEVICE_SECRET;
  });

  it("is false on an empty table", async () => {
    const prisma = createPrismaMock();
    expect(await isClaimed(prisma as never)).toBe(false);
  });

  it("is false when only an available row exists", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-AAAA-BBBB"), state: "available" });
    expect(await isClaimed(prisma as never)).toBe(false);
  });

  it("is true once a consumed row exists", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-AAAA-BBBB"), state: "consumed" });
    expect(await isClaimed(prisma as never)).toBe(true);
  });
});

describe("ensureClaimCode (WARP-632 / ADR-017)", () => {
  beforeEach(() => {
    process.env.DEVICE_SECRET = "test-device-secret";
    delete process.env.CLAIM_CODE;
    _resetClaimCodeMemoForTests();
  });
  afterEach(() => {
    delete process.env.DEVICE_SECRET;
    delete process.env.CLAIM_CODE;
    _resetClaimCodeMemoForTests();
  });

  it("mints exactly one code on a fresh/empty unclaimed box and returns the plaintext (AC1)", async () => {
    const prisma = createPrismaMock();

    const code = await ensureClaimCode(prisma as never);

    expect(code).toMatch(/^DRPL-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // Exactly one available row, seeded with the HASH of the plaintext.
    const available = prisma.claimCode._rows().filter((r) => r.state === "available");
    expect(available).toHaveLength(1);
    expect(available[0].codeHash).toBe(hashClaimCode(code!));
    // Not expired (far-future).
    expect(available[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    // In-memory plaintext exposed.
    expect(getCurrentClaimCode()).toBe(code);
  });

  it("does NOT pile up rows and does NOT rotate when re-invoked within one process (AC1)", async () => {
    const prisma = createPrismaMock();

    const first = await ensureClaimCode(prisma as never);
    const second = await ensureClaimCode(prisma as never);
    const third = await ensureClaimCode(prisma as never);

    // Same plaintext across calls — no rotation within the process.
    expect(second).toBe(first);
    expect(third).toBe(first);
    // Still exactly one available row — prior `available` rows were not piled up.
    expect(prisma.claimCode._rows().filter((r) => r.state === "available")).toHaveLength(1);
  });

  it("re-mints (deleting the stale available row) when the in-memory plaintext is lost — no pile-up (AC1)", async () => {
    const prisma = createPrismaMock();

    const first = await ensureClaimCode(prisma as never);
    expect(prisma.claimCode._rows()).toHaveLength(1);

    // Simulate a process restart: memo cleared, but the old `available` row
    // is still in the DB. Plaintext is gone (only the hash persisted), so we
    // can't show the old code → must re-mint AND delete the stale row.
    _resetClaimCodeMemoForTests();
    const second = await ensureClaimCode(prisma as never);

    expect(second).not.toBe(first);
    // Old available row deleted, new one seeded → still exactly one.
    expect(prisma.claimCode._rows().filter((r) => r.state === "available")).toHaveLength(1);
    expect(prisma.claimCode._rows().filter((r) => r.state === "available")[0].codeHash).toBe(
      hashClaimCode(second!),
    );
  });

  it("returns null and seeds nothing once the box is claimed (AC4)", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-OLDC-ODEE"), state: "consumed" });

    const code = await ensureClaimCode(prisma as never);

    expect(code).toBeNull();
    expect(getCurrentClaimCode()).toBeNull();
    // No new available row was created.
    expect(prisma.claimCode._rows().filter((r) => r.state === "available")).toHaveLength(0);
  });

  it("seeds the CLAIM_CODE env override verbatim instead of minting (AC5)", async () => {
    process.env.CLAIM_CODE = "DRPL-ENVX-SEED";
    const prisma = createPrismaMock();

    const code = await ensureClaimCode(prisma as never);

    expect(code).toBe("DRPL-ENVX-SEED");
    const available = prisma.claimCode._rows().filter((r) => r.state === "available");
    expect(available).toHaveLength(1);
    expect(available[0].codeHash).toBe(hashClaimCode("DRPL-ENVX-SEED"));
  });

  it("the minted code verifies via the existing consumeClaimCode path (AC3)", async () => {
    const prisma = createPrismaMock();

    const code = await ensureClaimCode(prisma as never);
    expect(code).toBeTruthy();

    // The customer reads the code off the lid and types it (possibly without
    // dashes / lowercased). The existing verify path must accept it.
    const result = await consumeClaimCode(prisma as never, code!.toLowerCase().replace(/-/g, ""));
    expect(result.outcome).toBe(CLAIM_OUTCOME.CLAIMED);
  });
});
