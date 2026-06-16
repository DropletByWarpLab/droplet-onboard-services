/**
 * Unit tests for the onboarding claim service (PR #373 /
 * docs/ONBOARDING_CLAIM.md + #371 handoff §2).
 *
 * The service owns claim-code verification: a single-use code (read off the
 * PyPortal lid display) binds a fresh appliance to its workspace. The security
 * contract under test:
 *   - codes are HASHED at rest — `hashClaimCode` never stores plaintext, and
 *     verification re-hashes + compares in constant time;
 *   - the consume is ATOMIC + SINGLE-USE — a conditional
 *     `updateMany WHERE state='available'` inside a `$transaction`; a second
 *     concurrent/sequential claim flips zero rows and is reported as
 *     already-claimed (the WARP-564 pairing-claim pattern);
 *   - the lifecycle is an EXPLICIT `state` column, never `usedAt IS NULL`
 *     (CLAUDE.md no-guessing rule);
 *   - a wrong code increments the per-code `attempts` counter and is reported
 *     invalid WITHOUT revealing the real code;
 *   - an expired code can't bind even if still `available`.
 *
 * MINTING / ROTATION is out of scope (PyPortal display-service, separate PR) —
 * codes here are SEEDED (hash inserted directly), only verified.
 *
 * Strategy: an in-memory stand-in for the `claimCode` model + `$transaction`,
 * mirroring `setup.service.test.ts`. We unmock @prisma/client so the real
 * generated `ClaimCodeState` enum object resolves at runtime.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.unmock("@prisma/client");

import {
  hashClaimCode,
  normalizeClaimCode,
  consumeClaimCode,
  CLAIM_OUTCOME,
} from "./setup-claim.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory `claimCode` store covering exactly the slice the service touches:
 * findFirst (by codeHash), updateMany (the atomic conditional consume),
 * update (attempts bump). `$transaction(fn)` runs the callback against the
 * same store so the conditional consume + audit write are observed atomically.
 */
function createPrismaMock() {
  type Row = {
    id: string;
    codeHash: string;
    state: "available" | "consumed";
    expiresAt: Date;
    usedAt: Date | null;
    attempts: number;
  };
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
    findFirst: async ({ where }: { where: { codeHash: string } }) => {
      const found = rows.find((r) => r.codeHash === where.codeHash);
      return found ? { ...found } : null;
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
        if (where.expiresAt?.gt !== undefined && !(r.expiresAt > where.expiresAt.gt))
          continue;
        Object.assign(r, data);
        count += 1;
      }
      return { count };
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { attempts?: { increment: number } };
    }) => {
      const r = rows.find((x) => x.id === where.id);
      if (!r) throw new Error("not found");
      if (data.attempts?.increment) r.attempts += data.attempts.increment;
      return { ...r };
    },
  };

  return {
    claimCode,
    // The service wraps the consume in $transaction; run the callback against
    // the same in-memory store so updateMany + audit write are one unit.
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({ claimCode }),
  };
}

describe("claim-code normalization + hashing (PR #373)", () => {
  beforeEach(() => {
    process.env.DEVICE_SECRET = "test-device-secret";
  });
  afterEach(() => {
    delete process.env.DEVICE_SECRET;
  });

  it("normalizes separators, whitespace, and case to a canonical form", () => {
    // The PyPortal renders "DRPL · 7K2Q · 9F4M"; the customer may type it with
    // or without the grouping. All must canonicalize identically.
    const canonical = normalizeClaimCode("DRPL · 7K2Q · 9F4M");
    expect(normalizeClaimCode("drpl 7k2q 9f4m")).toBe(canonical);
    expect(normalizeClaimCode("DRPL-7K2Q-9F4M")).toBe(canonical);
    expect(normalizeClaimCode("  DRPL7K2Q9F4M  ")).toBe(canonical);
  });

  it("hashes deterministically and never returns the plaintext", () => {
    const h = hashClaimCode("DRPL · 7K2Q · 9F4M");
    expect(h).not.toContain("7K2Q");
    expect(h).not.toContain("9F4M");
    // Deterministic over the normalized form (so a seeded hash matches at
    // verify time regardless of grouping).
    expect(h).toBe(hashClaimCode("drpl7k2q9f4m"));
    // HMAC-SHA256 hex digest.
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different codes", () => {
    expect(hashClaimCode("AAAA-BBBB")).not.toBe(hashClaimCode("AAAA-CCCC"));
  });
});

describe("consumeClaimCode — atomic, single-use, constant-time (PR #373)", () => {
  beforeEach(() => {
    process.env.DEVICE_SECRET = "test-device-secret";
  });
  afterEach(() => {
    delete process.env.DEVICE_SECRET;
  });

  it("binds once on the correct code and flips the explicit state column", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });

    const result = await consumeClaimCode(prisma as never, "DRPL · 7K2Q · 9F4M");

    expect(result.outcome).toBe(CLAIM_OUTCOME.CLAIMED);
    const row = prisma.claimCode._rows()[0];
    expect(row.state).toBe("consumed"); // explicit, not usedAt-derived
    expect(row.usedAt).toBeInstanceOf(Date); // audit timestamp written
  });

  it("is single-use: a second claim of the same code reports already-claimed", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });

    const first = await consumeClaimCode(prisma as never, "DRPL-7K2Q-9F4M");
    expect(first.outcome).toBe(CLAIM_OUTCOME.CLAIMED);

    const second = await consumeClaimCode(prisma as never, "DRPL-7K2Q-9F4M");
    expect(second.outcome).toBe(CLAIM_OUTCOME.ALREADY_CLAIMED);
    // Still exactly one consumed row — no double-bind.
    expect(prisma.claimCode._rows().filter((r) => r.state === "consumed")).toHaveLength(1);
  });

  it("under a race, only ONE concurrent claim wins; the loser is already-claimed", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });

    const [a, b] = await Promise.all([
      consumeClaimCode(prisma as never, "DRPL-7K2Q-9F4M"),
      consumeClaimCode(prisma as never, "DRPL-7K2Q-9F4M"),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(
      [CLAIM_OUTCOME.ALREADY_CLAIMED, CLAIM_OUTCOME.CLAIMED].sort(),
    );
    expect(prisma.claimCode._rows().filter((r) => r.state === "consumed")).toHaveLength(1);
  });

  it("reports invalid for a wrong code and never reveals the real one", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({ codeHash: hashClaimCode("DRPL-7K2Q-9F4M") });

    const result = await consumeClaimCode(prisma as never, "WRON-GGGG-GGGG");

    expect(result.outcome).toBe(CLAIM_OUTCOME.INVALID);
    // The real code stays available + unconsumed.
    const row = prisma.claimCode._rows()[0];
    expect(row.state).toBe("available");
    // The result carries no plaintext / hash of the real code.
    expect(JSON.stringify(result)).not.toContain("7K2Q");
  });

  it("does not bind an expired code even while state is still available", async () => {
    const prisma = createPrismaMock();
    prisma.claimCode._seed({
      codeHash: hashClaimCode("DRPL-7K2Q-9F4M"),
      state: "available",
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    const result = await consumeClaimCode(prisma as never, "DRPL-7K2Q-9F4M");

    expect(result.outcome).toBe(CLAIM_OUTCOME.INVALID);
    expect(prisma.claimCode._rows()[0].state).toBe("available");
  });
});
