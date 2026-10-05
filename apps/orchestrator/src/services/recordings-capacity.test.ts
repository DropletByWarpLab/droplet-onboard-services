/**
 * WARP-3514 / ADR-070 — the data helpers every reader of the recordings
 * allocation shares: the effective capacity the near-full check measures
 * against, and the one place a `StorageAllocation` row (BIGINT) becomes the
 * plain-number `AllocationRecord` the maths works in.
 *
 * Prisma is a hand-rolled fake (same style as backup-health.service.test.ts):
 * the assertions are on the QUERY the helpers issue and on what they do with
 * the rows, including the "should never happen" case of several RECORDINGS rows.
 */
import { describe, expect, it, vi } from "vitest";
import {
  effectiveCapacityBytes,
  getRecordingsReservedBytes,
  loadRecordingsAllocation,
  loadRecordingsAllocations,
  recordingsUsageByFsUuid,
  selectSubjectAllocation,
  toAllocationRecord,
  type StorageAllocationRow,
} from "./recordings-capacity.js";
import { GIB } from "./recordings-sizing.js";

const g = (gib: number): number => gib * GIB;

function row(over: Partial<StorageAllocationRow> = {}): StorageAllocationRow {
  return {
    id: "alloc-1",
    fsUuid: "1111-aaaa",
    mode: "AUTO_RESERVED",
    reservedBytes: BigInt(g(200)),
    status: "ACTIVE",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-02T00:00:00.000Z"),
    ...over,
  };
}

function fakePrisma(rows: StorageAllocationRow[]) {
  // A real findMany filters on `where.role`; every row here is a RECORDINGS row,
  // so the fake returns them all and the tests assert on the QUERY separately.
  const findMany = vi.fn(async (_args?: unknown) => rows.map((r) => ({ ...r, role: "RECORDINGS" as const })));
  return { prisma: { storageAllocation: { findMany } } as never, findMany };
}

describe("effectiveCapacityBytes — min(reserved, volume total)", () => {
  type Reserved = number | bigint | null | undefined;
  it.each<[string, Reserved, number | null, number | null]>([
    ["reserved smaller than the volume", g(100), g(1000), g(100)],
    ["reserved larger than the volume (the quota is not live yet, or the drive shrank)", g(2000), g(1000), g(1000)],
    ["reserved equal to the volume", g(100), g(100), g(100)],
    ["no reservation (null) → the volume", null, g(1000), g(1000)],
    ["no reservation (undefined) → the volume", undefined, g(1000), g(1000)],
    ["a zero reservation is 'none' → the volume", 0, g(1000), g(1000)],
    ["a negative reservation is 'none' → the volume", -5, g(1000), g(1000)],
    ["no volume figure → the reservation", g(100), null, g(100)],
    ["neither → unknown (null), never 0", null, null, null],
    ["neither (undefined) → unknown", undefined, null, null],
    ["a zero reservation and no volume → unknown", 0, null, null],
    ["a BIGINT reservation (straight from the DB column)", BigInt(g(100)), g(1000), g(100)],
    ["a zero BIGINT reservation is 'none'", BigInt(0), g(1000), g(1000)],
    ["a NaN reservation is 'none' (never poisons the comparison)", Number.NaN, g(1000), g(1000)],
    ["a zero-size volume is 'unknown' → the reservation", g(100), 0, g(100)],
    ["a NaN volume figure is 'unknown' → the reservation", g(100), Number.NaN, g(100)],
  ])("%s", (_name, reserved, volumeTotal, expected) => {
    expect(effectiveCapacityBytes(reserved, volumeTotal)).toBe(expected);
  });
});

describe("toAllocationRecord", () => {
  it("converts the BIGINT to a plain number and drops the DB-only role column", () => {
    const r = toAllocationRecord({ ...row({ reservedBytes: BigInt(g(200)) }), role: "RECORDINGS" } as StorageAllocationRow);
    expect(r).toEqual({
      id: "alloc-1",
      fsUuid: "1111-aaaa",
      mode: "AUTO_RESERVED",
      reservedBytes: g(200),
      status: "ACTIVE",
      migrationFailures: 0,
      lastFailureAt: null,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedAt: new Date("2026-10-02T00:00:00.000Z"),
    });
    expect(typeof r.reservedBytes).toBe("number");
  });

  it("accepts an already-numeric reservation", () => {
    expect(toAllocationRecord(row({ reservedBytes: g(50) })).reservedBytes).toBe(g(50));
  });

  it("carries a multi-terabyte value exactly (far inside Number.MAX_SAFE_INTEGER)", () => {
    const tb = 18_000_000_000_000; // 18 TB
    expect(toAllocationRecord(row({ reservedBytes: BigInt(tb) })).reservedBytes).toBe(tb);
  });

  it("keeps FULL mode and every status", () => {
    expect(toAllocationRecord(row({ mode: "FULL", status: "MISSING" }))).toMatchObject({ mode: "FULL", status: "MISSING" });
  });
});

describe("loadRecordingsAllocation", () => {
  it("no row → null", async () => {
    const { prisma } = fakePrisma([]);
    await expect(loadRecordingsAllocation(prisma)).resolves.toBeNull();
  });

  it("reads only RECORDINGS rows", async () => {
    const { prisma, findMany } = fakePrisma([row()]);
    await loadRecordingsAllocation(prisma);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { role: "RECORDINGS" } }));
  });

  it("the single row comes back as a plain-number record", async () => {
    const { prisma } = fakePrisma([row({ reservedBytes: BigInt(g(120)) })]);
    await expect(loadRecordingsAllocation(prisma)).resolves.toMatchObject({
      fsUuid: "1111-aaaa",
      reservedBytes: g(120),
      status: "ACTIVE",
    });
  });

  describe("if several RECORDINGS rows exist (they should not): ACTIVE first, then the newest updatedAt", () => {
    const oldActive = row({ id: "old-active", fsUuid: "aaaa-0001", status: "ACTIVE", updatedAt: new Date("2026-10-01T00:00:00Z") });
    const newActive = row({ id: "new-active", fsUuid: "bbbb-0002", status: "ACTIVE", updatedAt: new Date("2026-10-02T00:00:00Z") });
    const newPending = row({ id: "new-pending", fsUuid: "cccc-0003", status: "PENDING", updatedAt: new Date("2026-10-03T00:00:00Z") });
    const olderDegraded = row({ id: "older-degraded", fsUuid: "dddd-0004", status: "DEGRADED", updatedAt: new Date("2026-09-30T00:00:00Z") });

    it("an ACTIVE row beats a newer non-ACTIVE one", async () => {
      const { prisma } = fakePrisma([newPending, oldActive]);
      expect((await loadRecordingsAllocation(prisma))?.id).toBe("old-active");
    });

    it("among several ACTIVE rows the newest wins", async () => {
      const { prisma } = fakePrisma([oldActive, newActive, newPending]);
      expect((await loadRecordingsAllocation(prisma))?.id).toBe("new-active");
    });

    it("with no ACTIVE row the newest wins", async () => {
      const { prisma } = fakePrisma([olderDegraded, newPending]);
      expect((await loadRecordingsAllocation(prisma))?.id).toBe("new-pending");
    });

    it("an exact tie is broken by createdAt (newer first), then by id, whatever order the DB returned", async () => {
      const t = new Date("2026-10-02T00:00:00Z");
      const a = row({ id: "row-a", fsUuid: "aaaa-0001", updatedAt: t, createdAt: new Date("2026-09-01T00:00:00Z") });
      const b = row({ id: "row-b", fsUuid: "bbbb-0002", updatedAt: t, createdAt: new Date("2026-09-02T00:00:00Z") });
      const c = row({ id: "row-c", fsUuid: "cccc-0003", updatedAt: t, createdAt: new Date("2026-09-02T00:00:00Z") });
      for (const order of [[a, b, c], [c, b, a], [b, c, a]]) {
        const { prisma } = fakePrisma(order);
        expect((await loadRecordingsAllocation(prisma))?.id).toBe("row-b");
      }
    });
  });
});

describe("getRecordingsReservedBytes", () => {
  it("null when there is no allocation", async () => {
    const { prisma } = fakePrisma([]);
    await expect(getRecordingsReservedBytes(prisma)).resolves.toBeNull();
  });

  it("the reserved size as a number when there is one — any status", async () => {
    for (const status of ["PENDING", "MIGRATING", "ACTIVE", "DEGRADED", "MISSING"] as const) {
      const { prisma } = fakePrisma([row({ status, reservedBytes: BigInt(g(75)) })]);
      await expect(getRecordingsReservedBytes(prisma)).resolves.toBe(g(75));
    }
  });
});

describe("recordingsUsageByFsUuid — the `usage` field of GET /storage/drives", () => {
  it("empty when nothing is allocated", async () => {
    const { prisma } = fakePrisma([]);
    expect((await recordingsUsageByFsUuid(prisma)).size).toBe(0);
  });

  it("maps the allocated filesystem to role 'recordings' and its reservation", async () => {
    const { prisma, findMany } = fakePrisma([row({ fsUuid: "1111-aaaa", reservedBytes: BigInt(g(200)) })]);
    const usage = await recordingsUsageByFsUuid(prisma);
    expect(usage).toEqual(new Map([["1111-aaaa", { role: "recordings", reservedBytes: g(200) }]]));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { role: "RECORDINGS" } }));
  });

  it("every RECORDINGS row is reported (the map reflects the DB; a drive that is not allocated is simply absent)", async () => {
    const { prisma } = fakePrisma([
      row({ id: "a", fsUuid: "aaaa-0001", reservedBytes: BigInt(g(10)) }),
      row({ id: "b", fsUuid: "bbbb-0002", reservedBytes: BigInt(g(20)) }),
    ]);
    const usage = await recordingsUsageByFsUuid(prisma);
    expect([...usage.keys()].sort()).toEqual(["aaaa-0001", "bbbb-0002"]);
    expect(usage.get("bbbb-0002")).toEqual({ role: "recordings", reservedBytes: g(20) });
    expect(usage.get("not-allocated")).toBeUndefined();
  });
});

describe("recordingsUsageByFsUuid — only a drive that HOSTS recordings is `recordings`", () => {
  it.each([
    ["ACTIVE", true],
    ["MIGRATING", true],
    ["DEGRADED", true],
    ["PENDING", false],
    ["MISSING", false],
  ] as const)("a %s row → recordings: %s", async (status, hosting) => {
    const { prisma } = fakePrisma([row({ status })]);
    expect((await recordingsUsageByFsUuid(prisma)).has("1111-aaaa")).toBe(hosting);
  });

  it("during a drive switch both drives are recordings (the old one still records until the flip)", async () => {
    const { prisma } = fakePrisma([
      row({ id: "old", fsUuid: "aaaa-0001", status: "ACTIVE" }),
      row({ id: "new", fsUuid: "bbbb-0002", status: "MIGRATING" }),
    ]);
    expect([...(await recordingsUsageByFsUuid(prisma)).keys()].sort()).toEqual(["aaaa-0001", "bbbb-0002"]);
  });
});

describe("loadRecordingsAllocations + selectSubjectAllocation — a drive switch has two rows", () => {
  const rec = (over: Partial<StorageAllocationRow>) => toAllocationRecord(row(over));
  const live = rec({ id: "old", fsUuid: "aaaa-0001", status: "ACTIVE" });
  const target = rec({ id: "new", fsUuid: "bbbb-0002", status: "PENDING" });

  it("loads every RECORDINGS row as a plain-number record, ACTIVE first", async () => {
    const { prisma } = fakePrisma([row({ id: "new", fsUuid: "bbbb-0002", status: "PENDING" }), row({ id: "old", fsUuid: "aaaa-0001" })]);
    const all = await loadRecordingsAllocations(prisma);
    expect(all.map((r) => r.id)).toEqual(["old", "new"]);
    expect(typeof all[0]?.reservedBytes).toBe("number");
  });

  it("no rows → null", () => {
    expect(selectSubjectAllocation([], "aaaa-0001")).toBeNull();
  });

  it("one row → that row, whatever the host says", () => {
    expect(selectSubjectAllocation([live], "aaaa-0001")).toBe(live);
    expect(selectSubjectAllocation([live], null)).toBe(live);
    expect(selectSubjectAllocation([target], null)).toBe(target);
  });

  it.each(["PENDING", "MIGRATING", "DEGRADED", "MISSING"] as const)(
    "while a switch is in flight the %s TARGET is the subject, not the row Frigate records onto",
    (status) => {
      const t = rec({ id: "new", fsUuid: "bbbb-0002", status });
      expect(selectSubjectAllocation([live, t], "aaaa-0001")).toBe(t);
    },
  );

  it("without a host answer a non-active row is still the subject of a two-row state", () => {
    expect(selectSubjectAllocation([live, target], null)).toBe(target);
  });

  it("two rows and the host records on the NEW drive (the flip happened, the old row is not deleted yet): the live ACTIVE row wins", () => {
    const flipped = rec({ id: "new", fsUuid: "bbbb-0002", status: "ACTIVE" });
    const stale = rec({ id: "old", fsUuid: "aaaa-0001", status: "ACTIVE" });
    expect(selectSubjectAllocation([stale, flipped], "bbbb-0002")).toBe(flipped);
  });

  it("the only row is not live (host on the OS volume): it is still the subject", () => {
    expect(selectSubjectAllocation([live], "zzzz-9999")).toBe(live);
  });
});
