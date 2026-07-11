/**
 * WARP-1202/WARP-1203 — PairingCode lifecycle sweep + retention purge.
 *
 * Pins the two sweep steps:
 *   1. WARP-1202 transition write: overdue `active` rows are stamped with the
 *      explicit `expired` status (idempotent — a re-run walks zero rows).
 *   2. WARP-1203 retention purge: terminal rows (claimed/expired/revoked)
 *      created before the retention cutoff are deleted, keyed on the explicit
 *      status; active and recent-terminal rows survive. Deletes are batched +
 *      capped per run (same discipline as pruneExpiredLoginStates).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface CodeRow {
  id: string;
  code: string;
  userId: string;
  status: "active" | "claimed" | "expired" | "revoked";
  claimedBy: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Minimal recursive evaluator for the Prisma `where` shapes the sweep emits:
 * `{ status: "active" | { in } }`, `{ <dateCol>: { lt | gt } }`, and
 * `{ id: { in } }`. Mirrors sso-login-state.service.test's in-memory sim.
 */
function rowMatches(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond !== null && typeof cond === "object") {
      const c = cond as any;
      const v = row[key];
      if ("in" in c && !c.in.includes(v)) return false;
      if ("lt" in c && !(v !== null && v < c.lt)) return false;
      if ("gt" in c && !(v !== null && v > c.gt)) return false;
    } else if (row[key] !== cond) {
      return false;
    }
  }
  return true;
}

function createPrismaMock(seed: CodeRow[] = []) {
  let rows: CodeRow[] = [...seed];
  const self: any = {};
  self.pairingCode = {
    updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
      let count = 0;
      for (const r of rows) {
        if (!rowMatches(r, where)) continue;
        Object.assign(r, data);
        count++;
      }
      return { count };
    }),
    findMany: vi.fn(async ({ where, orderBy, take, select }: any) => {
      let matched = rows.filter((r) => rowMatches(r, where));
      if (orderBy?.createdAt === "asc") {
        matched = [...matched].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        );
      }
      if (typeof take === "number") matched = matched.slice(0, take);
      return matched.map((r) => (select?.id ? { id: r.id } : r));
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = rows.length;
      rows = rows.filter((r) => !rowMatches(r, where));
      return { count: before - rows.length };
    }),
  };
  self._rows = () => rows;
  return self;
}

import {
  sweepPairingCodes,
  PAIRING_CODE_RETENTION_DAYS,
} from "./pairing-code-purge.service.js";

const DAY = 86_400_000;
const MINUTE = 60_000;

function seedRow(id: string, over: Partial<CodeRow> = {}): CodeRow {
  const createdAt = over.createdAt ?? new Date();
  return {
    id,
    code: `CODE${id}`,
    userId: "owner-1",
    status: "active",
    claimedBy: null,
    // Mirrors the route's 10-minute TTL relative to creation.
    expiresAt: new Date(createdAt.getTime() + 10 * MINUTE),
    createdAt,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sweepPairingCodes — WARP-1202 active→expired transition", () => {
  it("stamps overdue active rows `expired` and leaves unexpired active rows alone", async () => {
    const now = new Date();
    const prisma = createPrismaMock([
      // Past its deadline, never claimed → flip to explicit `expired`.
      seedRow("overdue", { createdAt: new Date(now.getTime() - 30 * MINUTE) }),
      // Fresh, still claimable → untouched.
      seedRow("fresh", { createdAt: now }),
      // Already claimed → transition never touches non-active rows.
      seedRow("claimed", {
        status: "claimed",
        claimedBy: "dc-1",
        createdAt: new Date(now.getTime() - 30 * MINUTE),
      }),
    ]);

    const result = await sweepPairingCodes(prisma, { now });

    expect(result.expired).toBe(1);
    const byId = new Map(prisma._rows().map((r: CodeRow) => [r.id, r]));
    expect((byId.get("overdue") as CodeRow).status).toBe("expired");
    expect((byId.get("fresh") as CodeRow).status).toBe("active");
    expect((byId.get("claimed") as CodeRow).status).toBe("claimed");
    // The transition is keyed on the explicit status + the expiresAt deadline.
    expect(prisma.pairingCode.updateMany).toHaveBeenCalledWith({
      where: { status: "active", expiresAt: { lt: now } },
      data: { status: "expired" },
    });
  });

  it("is idempotent — a second run in the same instant flips zero rows", async () => {
    const now = new Date();
    const prisma = createPrismaMock([
      seedRow("overdue", { createdAt: new Date(now.getTime() - 30 * MINUTE) }),
    ]);

    const first = await sweepPairingCodes(prisma, { now });
    const second = await sweepPairingCodes(prisma, { now });

    expect(first.expired).toBe(1);
    expect(second.expired).toBe(0);
  });
});

describe("sweepPairingCodes — WARP-1203 retention purge", () => {
  it("purges claimed/expired/revoked rows past retention; keeps recent terminal and active rows", async () => {
    const now = new Date();
    const old = new Date(
      now.getTime() - (PAIRING_CODE_RETENTION_DAYS + 1) * DAY,
    );
    const recent = new Date(now.getTime() - 1 * DAY);
    const prisma = createPrismaMock([
      seedRow("old-claimed", { status: "claimed", claimedBy: "dc-1", createdAt: old }),
      seedRow("old-expired", { status: "expired", createdAt: old }),
      seedRow("old-revoked", { status: "revoked", createdAt: old }),
      // Terminal but inside the retention window → kept for forensics.
      seedRow("recent-claimed", { status: "claimed", claimedBy: "dc-2", createdAt: recent }),
      seedRow("recent-expired", { status: "expired", createdAt: recent }),
      // Live code → never purged.
      seedRow("fresh-active", { createdAt: now }),
    ]);

    const result = await sweepPairingCodes(prisma, { now });

    expect(result.purged).toBe(3);
    expect(
      prisma
        ._rows()
        .map((r: CodeRow) => r.id)
        .sort(),
    ).toEqual(["fresh-active", "recent-claimed", "recent-expired"]);
  });

  it("purges an overdue active row past retention in the SAME run (flip precedes the purge selection)", async () => {
    const now = new Date();
    const old = new Date(
      now.getTime() - (PAIRING_CODE_RETENTION_DAYS + 1) * DAY,
    );
    // Was never claimed and never swept — still `active` in the column even
    // though its deadline passed long ago.
    const prisma = createPrismaMock([seedRow("stale-active", { createdAt: old })]);

    const result = await sweepPairingCodes(prisma, { now });

    expect(result.expired).toBe(1);
    expect(result.purged).toBe(1);
    expect(prisma._rows()).toHaveLength(0);
  });

  it("drains a backlog larger than one batch via bounded deletes", async () => {
    const now = new Date();
    const old = new Date(
      now.getTime() - (PAIRING_CODE_RETENTION_DAYS + 2) * DAY,
    );
    const rows = Array.from({ length: 25 }, (_, i) =>
      seedRow(`old-${i}`, {
        status: "expired",
        createdAt: new Date(old.getTime() + i * 1000),
      }),
    );
    const prisma = createPrismaMock(rows);

    const result = await sweepPairingCodes(prisma, { now, batchSize: 10 });

    expect(result.purged).toBe(25);
    expect(prisma._rows()).toHaveLength(0);
    // 25 rows / batch 10 → 3 bounded deletes (10 + 10 + 5), never one 25-row
    // statement that could scan the whole backlog inside the 60 s tx.
    expect(prisma.pairingCode.deleteMany).toHaveBeenCalledTimes(3);
    for (const call of prisma.pairingCode.deleteMany.mock.calls) {
      expect(call[0].where.id.in.length).toBeLessThanOrEqual(10);
    }
  });

  it("caps total rows per run so a years-deep first-run backlog can't wedge the 60 s transaction", async () => {
    const now = new Date();
    const old = new Date(
      now.getTime() - (PAIRING_CODE_RETENTION_DAYS + 2) * DAY,
    );
    const rows = Array.from({ length: 100 }, (_, i) =>
      seedRow(`old-${i}`, {
        status: "claimed",
        claimedBy: `dc-${i}`,
        createdAt: new Date(old.getTime() + i * 1000),
      }),
    );
    const prisma = createPrismaMock(rows);

    const result = await sweepPairingCodes(prisma, {
      now,
      batchSize: 10,
      maxRowsPerRun: 30,
    });

    expect(result.purged).toBe(30);
    // 70 rows remain for subsequent nightly runs → the backlog drains safely.
    expect(prisma._rows()).toHaveLength(70);
    expect(prisma.pairingCode.deleteMany).toHaveBeenCalledTimes(3);
  });

  it("no-ops on an empty table", async () => {
    const prisma = createPrismaMock([]);
    const result = await sweepPairingCodes(prisma);
    expect(result).toEqual({ expired: 0, purged: 0 });
    expect(prisma.pairingCode.deleteMany).not.toHaveBeenCalled();
  });
});
