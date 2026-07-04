/**
 * WARP-237 — daily signed roots.
 *
 * Semantics pinned here:
 *   - canonical form: JSON, keys lexicographic, BigInts as decimal strings;
 *   - first-ever root covers min(id)..max(id with at < end of `date`);
 *   - subsequent roots are id-contiguous: firstRowId = prev.lastRowId + 1;
 *   - empty day → rowCount 0, lastRowId = prev.lastRowId,
 *     tailSignatureHash carried forward;
 *   - idempotent per date (unique `date`, second call is a no-op);
 *   - runDailyRootJob signs yesterday and catches up missed days.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalizeDailyRoot,
  dailyRootHash,
  signDailyRootForDate,
  runDailyRootJob,
} from "./audit-daily-root.service.js";
import { hashSignature } from "./audit-signing.service.js";

function makeFakes(rows: Array<{ id: bigint; at: Date; signature: string }>) {
  const roots: Array<Record<string, unknown>> = [];
  const prisma = {
    activityRow: {
      async findFirst(args: {
        where?: { at?: { lt?: Date } };
        orderBy: { id: "asc" | "desc" };
      }) {
        let pool = rows;
        const lt = args.where?.at?.lt;
        if (lt) pool = pool.filter((r) => r.at.getTime() < lt.getTime());
        if (pool.length === 0) return null;
        const sorted = [...pool].sort((a, b) => (a.id < b.id ? -1 : 1));
        return args.orderBy.id === "asc" ? sorted[0] : sorted[sorted.length - 1];
      },
      async count(args: { where: { id: { gte: bigint; lte: bigint } } }) {
        return rows.filter(
          (r) => r.id >= args.where.id.gte && r.id <= args.where.id.lte,
        ).length;
      },
      async findUnique(args: { where: { id: bigint } }) {
        return rows.find((r) => r.id === args.where.id) ?? null;
      },
    },
    activityDailyRoot: {
      async findFirst(args?: { orderBy?: { date: "desc" } }) {
        void args;
        if (roots.length === 0) return null;
        return [...roots].sort((a, b) =>
          String(a.date) < String(b.date) ? 1 : -1,
        )[0];
      },
      async findUnique(args: { where: { date: string } }) {
        return roots.find((r) => r.date === args.where.date) ?? null;
      },
      async create(args: { data: Record<string, unknown> }) {
        const row = { id: BigInt(roots.length + 1), ...args.data };
        roots.push(row);
        return row;
      },
    },
  };
  const signCalls: Uint8Array[] = [];
  const identity = {
    async signWithDeviceKey(payload: Uint8Array) {
      signCalls.push(payload);
      return {
        signature: new Uint8Array([1, 2, 3, 4]),
        algorithm: "ECDSA-P256-SHA256",
      };
    },
  };
  return { prisma: prisma as never, roots, identity, signCalls };
}

const D = (s: string) => new Date(s);

describe("canonicalizeDailyRoot", () => {
  it("emits lexicographically ordered keys and stable JSON", () => {
    const c = {
      date: "2026-07-05",
      firstRowId: "1",
      lastRowId: "3",
      prevRootHash: "",
      rowCount: 3,
      tailSignatureHash: "abc",
    };
    expect(canonicalizeDailyRoot(c)).toBe(
      '{"date":"2026-07-05","firstRowId":"1","lastRowId":"3","prevRootHash":"","rowCount":3,"tailSignatureHash":"abc"}',
    );
    expect(dailyRootHash(c)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("signDailyRootForDate", () => {
  it("first root covers min id .. max id before end of day and signs the canonical bytes", async () => {
    const { prisma, roots, identity, signCalls } = makeFakes([
      { id: 1n, at: D("2026-07-05T08:00:00Z"), signature: "sigA" },
      { id: 2n, at: D("2026-07-05T09:00:00Z"), signature: "sigB" },
      { id: 3n, at: D("2026-07-06T01:00:00Z"), signature: "sigC" }, // next day
    ]);
    const r = await signDailyRootForDate(prisma, identity, "2026-07-05");
    expect(r.created).toBe(true);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      date: "2026-07-05",
      firstRowId: 1n,
      lastRowId: 2n,
      rowCount: 2,
      prevRootHash: "",
      tailSignatureHash: hashSignature("sigB"),
      algorithm: "ECDSA-P256-SHA256",
    });
    expect(Buffer.from(signCalls[0]!).toString("utf8")).toBe(
      canonicalizeDailyRoot({
        date: "2026-07-05",
        firstRowId: "1",
        lastRowId: "2",
        prevRootHash: "",
        rowCount: 2,
        tailSignatureHash: hashSignature("sigB"),
      }),
    );
  });

  it("second root is id-contiguous and chains prevRootHash; empty day carries the tail forward", async () => {
    const { prisma, roots, identity } = makeFakes([
      { id: 1n, at: D("2026-07-05T08:00:00Z"), signature: "sigA" },
    ]);
    await signDailyRootForDate(prisma, identity, "2026-07-05");
    const emptyDay = await signDailyRootForDate(prisma, identity, "2026-07-06");
    expect(emptyDay.created).toBe(true);
    expect(roots[1]).toMatchObject({
      date: "2026-07-06",
      firstRowId: 2n, // prev.lastRowId + 1
      lastRowId: 1n, // firstRowId > lastRowId ⇒ attested-empty day
      rowCount: 0,
      tailSignatureHash: hashSignature("sigA"),
      prevRootHash: roots[0]!.rootHash,
    });
  });

  it("is idempotent per date", async () => {
    const { prisma, roots, identity } = makeFakes([
      { id: 1n, at: D("2026-07-05T08:00:00Z"), signature: "sigA" },
    ]);
    await signDailyRootForDate(prisma, identity, "2026-07-05");
    const again = await signDailyRootForDate(prisma, identity, "2026-07-05");
    expect(again.created).toBe(false);
    expect(roots).toHaveLength(1);
  });

  it("no rows and no prior root → no root (nothing to attest yet)", async () => {
    const { prisma, roots, identity } = makeFakes([]);
    const r = await signDailyRootForDate(prisma, identity, "2026-07-05");
    expect(r.created).toBe(false);
    expect(roots).toHaveLength(0);
  });
});

describe("runDailyRootJob", () => {
  it("signs yesterday and catches up missed days in order", async () => {
    const { prisma, roots, identity } = makeFakes([
      { id: 1n, at: D("2026-07-03T08:00:00Z"), signature: "sigA" },
      { id: 2n, at: D("2026-07-04T08:00:00Z"), signature: "sigB" },
    ]);
    await signDailyRootForDate(prisma, identity, "2026-07-03");
    // Now pretend the box was off on the 5th; job runs on the 6th.
    const res = await runDailyRootJob(prisma, identity, D("2026-07-06T03:35:00Z"));
    expect(res.signed).toEqual(["2026-07-04", "2026-07-05"]);
    expect(roots.map((r) => r.date)).toEqual([
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
  });
});
