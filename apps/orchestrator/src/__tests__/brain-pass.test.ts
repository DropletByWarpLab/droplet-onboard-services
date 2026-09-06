/**
 * WARP-2749 / WARP-2754 (ADR-051) — the pass runner, the cursor, and the
 * detectors' arithmetic.
 *
 * The cases that matter most here are the ones that decide whether an operator
 * keeps the feature switched on:
 *
 *   staleness  — a resolved problem must LEAVE the list by itself. Without
 *                this, /brief accumulates paid invoices and becomes a list
 *                nobody reads.
 *   isolation  — one broken detector must not silence the others, and the
 *                operator must be told WHICH one broke.
 *   cursor     — a bare-timestamp watermark skips rows that share a
 *                millisecond, forever, invisibly (the WARP-2743 shape).
 *   money      — Decimal -> minor units without a float round-trip, and
 *                impact/currency all-or-nothing.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runDetectorPass,
  DETECTOR_PASS_KEY,
} from "../services/brain/brain-pass.service";
import { encodeCursor, decodeCursor, parseDigests } from "../services/brain/brain-corpus.service";
import { decimalToMinor, overdueReceivables, overduePayables } from "../services/brain/detectors/money-overdue";
import { dealsSlipping } from "../services/brain/detectors/deals-slipping";
import type { Detector } from "../services/brain/detectors/types";

vi.mock("../middleware/space", () => ({
  readableDepartmentIdsFor: vi.fn(async () => new Set<string>()),
}));
vi.mock("../services/file-search.service", () => ({
  decryptChunkRows: vi.fn(async (_p: unknown, rows: unknown[]) => rows),
}));

const SRC = [{ sourceKind: "erp_document", sourceId: "d1", quote: "q" }];

function passPrisma(over: Record<string, unknown> = {}) {
  return {
    brainPass: {
      upsert: vi.fn(async () => ({ enabled: true, cursor: null })),
      update: vi.fn(async () => ({})),
    },
    brainFinding: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ id: "f1" })),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    ...over,
  } as never;
}

function detector(key: string, results: unknown[]): Detector {
  return {
    key,
    description: "test",
    run: vi.fn(async () => results as never),
  } as Detector;
}

describe("runDetectorPass — staleness sweep (WARP-2749)", () => {
  it("marks a finding stale once its detector stops returning it", async () => {
    // The invoice was paid. Nobody should have to dismiss it by hand.
    const updateMany = vi.fn(async (_a: { data: { status: string } }) => ({ count: 1 }));
    const prisma = passPrisma({
      brainFinding: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => ({ id: "f1" })),
        // One open finding for invoice "gone", which the detector no longer
        // returns.
        findMany: vi.fn(async () => [
          { id: "old", dedupeKey: "money.overdue-receivable:finding:-:gone" },
        ]),
        updateMany,
      },
    });

    const out = await runDetectorPass(prisma, {
      detectors: [detector("money.overdue-receivable", [])],
    });

    expect(updateMany).toHaveBeenCalledOnce();
    expect(updateMany.mock.calls[0]![0]).toMatchObject({ data: { status: "stale" } });
    expect(out.staled).toBe(1);
  });

  it("does NOT stale a finding the detector still returns", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = passPrisma({
      brainFinding: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => ({ id: "f1" })),
        findMany: vi.fn(async () => [
          { id: "still", dedupeKey: "d:finding:-:inv-1" },
        ]),
        updateMany,
      },
    });

    await runDetectorPass(prisma, {
      detectors: [
        detector("d", [
          {
            subjectKey: "inv-1",
            kind: "loss",
            title: "t",
            rationale: "r",
            evidence: { sources: SRC },
          },
        ]),
      ],
    });

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("recovers a subject key that itself contains the separator", async () => {
    // dedupeKey is `${detector}:finding:-:${subject}`; a naive [3] index would
    // truncate a subject containing ":" and stale a live finding.
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = passPrisma({
      brainFinding: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => ({ id: "f1" })),
        findMany: vi.fn(async () => [
          { id: "x", dedupeKey: "d:finding:-:urn:inv:1" },
        ]),
        updateMany,
      },
    });

    await runDetectorPass(prisma, {
      detectors: [
        detector("d", [
          {
            subjectKey: "urn:inv:1",
            kind: "loss",
            title: "t",
            rationale: "r",
            evidence: { sources: SRC },
          },
        ]),
      ],
    });

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("sweeps only new/acknowledged — never a human's dismissal or action", async () => {
    const findMany = vi.fn(async (_a: { where: { status: { in: string[] } } }) => []);
    const prisma = passPrisma({
      brainFinding: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => ({ id: "f1" })),
        findMany,
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    });

    await runDetectorPass(prisma, { detectors: [detector("d", [])] });

    const where = findMany.mock.calls[0]![0].where;
    expect(where.status.in).toEqual(["new", "acknowledged"]);
    expect(where.status.in).not.toContain("dismissed");
    expect(where.status.in).not.toContain("actioned");
  });
});

describe("runDetectorPass — isolation and state (WARP-2749)", () => {
  it("one broken detector does not stop the others, and is named", async () => {
    const bad: Detector = {
      key: "bad",
      description: "x",
      run: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as Detector;
    const good = detector("good", [
      { subjectKey: "s", kind: "loss", title: "t", rationale: "r", evidence: { sources: SRC } },
    ]);
    const prisma = passPrisma();

    const out = await runDetectorPass(prisma, { detectors: [bad, good] });

    expect(out.written).toBe(1);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("bad");
    expect(out.errors[0]).toContain("boom");
  });

  it("a partial run does NOT advance lastSucceededAt", async () => {
    // Otherwise a freshness check reads "succeeded an hour ago" for a pass
    // that has been failing all week.
    const update = vi.fn(async (_a: { data: Record<string, unknown> }) => ({}));
    const prisma = passPrisma({
      brainPass: { upsert: vi.fn(async () => ({ enabled: true, cursor: null })), update },
    });
    const bad: Detector = {
      key: "bad",
      description: "x",
      run: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as Detector;

    await runDetectorPass(prisma, { detectors: [bad] });

    const data = update.mock.calls[0]![0].data;
    expect(data).not.toHaveProperty("lastSucceededAt");
    expect(data.lastError).toContain("bad");
  });

  it("a clean run clears a previous error", async () => {
    const update = vi.fn(async (_a: { data: Record<string, unknown> }) => ({}));
    const prisma = passPrisma({
      brainPass: { upsert: vi.fn(async () => ({ enabled: true, cursor: null })), update },
    });

    await runDetectorPass(prisma, { detectors: [detector("d", [])] });

    const data = update.mock.calls[0]![0].data;
    expect(data.lastError).toBeNull();
    expect(data).toHaveProperty("lastSucceededAt");
  });

  it("a disabled pass runs nothing at all", async () => {
    const run = vi.fn(async () => []);
    const prisma = passPrisma({
      brainPass: {
        upsert: vi.fn(async () => ({ enabled: false, cursor: null })),
        update: vi.fn(async () => ({})),
      },
    });

    const out = await runDetectorPass(prisma, {
      detectors: [{ key: "d", description: "x", run } as Detector],
    });

    expect(out.ran).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("corpus cursor (WARP-2749)", () => {
  it("round-trips the full composite key", () => {
    const d = new Date("2026-09-05T12:00:00.000Z");
    const c = encodeCursor(d, "alice", "Docs/lease.pdf");
    expect(decodeCursor(c)).toEqual({
      updatedAt: d,
      userId: "alice",
      path: "Docs/lease.pdf",
    });
  });

  it("survives a path containing the separator", () => {
    // A bare split() would truncate here and silently resume from the wrong
    // document, skipping everything between.
    const d = new Date("2026-09-05T12:00:00.000Z");
    const c = encodeCursor(d, "alice", "Docs/a|b/lease.pdf");
    expect(decodeCursor(c)!.path).toBe("Docs/a|b/lease.pdf");
  });

  it("rejects a malformed cursor rather than resuming from a guess", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-a-date|u|p")).toBeNull();
    expect(decodeCursor("2026-09-05T12:00:00.000Z")).toBeNull(); // no separator at all
    // ONE separator — an older `updatedAt|id` cursor, or a truncated one.
    // Accepting it would resume with an empty path and silently re-digest
    // everything at that timestamp; a full restart is the honest answer.
    expect(decodeCursor("2026-09-05T12:00:00.000Z|alice")).toBeNull();
  });
});

describe("parseDigests (WARP-2749)", () => {
  const ok = '{"digests":[{"kind":"obligation","title":"t","body":"b","quote":"q"}]}';

  it("parses a clean object", () => {
    expect(parseDigests(ok)).toHaveLength(1);
  });

  it("parses through a ```json fence", () => {
    expect(parseDigests("```json\n" + ok + "\n```")).toHaveLength(1);
  });

  it("parses through leading prose", () => {
    expect(parseDigests("Sure! Here you go:\n" + ok)).toHaveLength(1);
  });

  it("DROPS a digest with no quote — provenance is not optional", () => {
    expect(
      parseDigests('{"digests":[{"kind":"obligation","title":"t","body":"b"}]}'),
    ).toHaveLength(0);
  });

  it("DROPS a digest whose kind is not in the enum", () => {
    expect(
      parseDigests('{"digests":[{"kind":"vibes","title":"t","body":"b","quote":"q"}]}'),
    ).toHaveLength(0);
  });

  it("returns nothing for unparseable output rather than throwing", () => {
    expect(parseDigests("I could not read that document.")).toEqual([]);
    expect(parseDigests("")).toEqual([]);
  });
});

describe("decimalToMinor (WARP-2754)", () => {
  it("converts without a float round-trip", () => {
    expect(decimalToMinor("1234.565")).toBe(123457n); // half-up, not 123456
    expect(decimalToMinor("10")).toBe(1000n);
    expect(decimalToMinor("0.005")).toBe(1n);
    expect(decimalToMinor("0.004")).toBe(0n);
  });

  it("handles negatives symmetrically", () => {
    expect(decimalToMinor("-10.50")).toBe(-1050n);
  });

  it("returns null for absent or non-numeric input", () => {
    expect(decimalToMinor(null)).toBeNull();
    expect(decimalToMinor(undefined)).toBeNull();
    expect(decimalToMinor("abc")).toBeNull();
  });
});

describe("money detectors (WARP-2754)", () => {
  const now = new Date("2026-09-05T00:00:00.000Z");
  const due = new Date("2026-06-01T00:00:00.000Z"); // ~96 days earlier

  function erpPrisma(rows: unknown[]) {
    return { erpDocument: { findMany: vi.fn(async () => rows) } } as never;
  }

  const base = {
    id: "doc-1",
    balance: "500.00",
    currency: "USD",
    dueAt: due,
    status: "open",
    counterpartyName: "Acme Ltd",
    externalSystem: "quickbooks",
  };

  it("reports an overdue receivable as a loss, with impact", async () => {
    const out = await overdueReceivables.run(erpPrisma([base]), now);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("loss");
    expect(out[0]!.impactMinor).toBe(50000n);
    expect(out[0]!.currency).toBe("USD");
    expect(out[0]!.subjectKey).toBe("doc-1");
    expect(out[0]!.evidence.sources).toHaveLength(1);
  });

  it("reports an overdue PAYABLE as a risk, not a loss", async () => {
    // Money the business owes is not money it lost. Filing it as `loss` would
    // inflate the /brief total with the business's own obligations.
    const out = await overduePayables.run(erpPrisma([base]), now);
    expect(out[0]!.kind).toBe("risk");
  });

  it("skips a settled document whatever its balance says", async () => {
    // money.service.ts records that a paid document is never reaped, so a
    // stale row can keep a balance forever.
    for (const status of ["paid", "PAID", " Void ", "refunded"]) {
      const out = await overdueReceivables.run(erpPrisma([{ ...base, status }]), now);
      expect(out).toHaveLength(0);
    }
  });

  it("skips a zero or negative balance", async () => {
    expect(await overdueReceivables.run(erpPrisma([{ ...base, balance: "0" }]), now)).toHaveLength(0);
    expect(await overdueReceivables.run(erpPrisma([{ ...base, balance: "-5" }]), now)).toHaveLength(0);
  });

  it("skips sub-threshold noise", async () => {
    expect(
      await overdueReceivables.run(erpPrisma([{ ...base, balance: "0.50" }]), now),
    ).toHaveLength(0);
  });

  it("reports WITHOUT a number when the vendor sent no currency", async () => {
    // impact and currency are all-or-nothing; a guessed currency is worse than
    // no amount.
    const out = await overdueReceivables.run(erpPrisma([{ ...base, currency: null }]), now);
    expect(out).toHaveLength(1);
    expect(out[0]!.impactMinor).toBeNull();
    expect(out[0]!.currency).toBeNull();
  });

  it("caps confidence at 95 however old the debt is", async () => {
    const ancient = new Date("2020-01-01T00:00:00.000Z");
    const out = await overdueReceivables.run(erpPrisma([{ ...base, dueAt: ancient }]), now);
    expect(out[0]!.confidence).toBeLessThanOrEqual(95);
  });
});

describe("dealsSlipping (WARP-2754)", () => {
  const now = new Date("2026-09-05T00:00:00.000Z");
  const slipped = new Date("2026-07-01T00:00:00.000Z");

  function dealPrisma(rows: unknown[]) {
    return { crmDeal: { findMany: vi.fn(async () => rows) } } as never;
  }

  const deal = {
    id: "deal-1",
    title: "Acme renewal",
    amountMinor: 4000000n,
    currency: "USD",
    expectedCloseOn: slipped,
    company: { name: "Acme Ltd" },
    stage: { name: "Proposal", kind: "OPEN" },
  };

  it("reports a slipped deal as a RISK, not a loss", async () => {
    // The forecast slipped; the money did not leave. Filing it as a loss would
    // double-count it against invoices that actually went unpaid.
    const out = await dealsSlipping.run(dealPrisma([deal]), now);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("risk");
    expect(out[0]!.impactMinor).toBe(4000000n);
  });

  it("ignores a deal sitting in a terminal stage", async () => {
    for (const kind of ["WON", "LOST"]) {
      const out = await dealsSlipping.run(
        dealPrisma([{ ...deal, stage: { name: "Closed", kind } }]),
        now,
      );
      expect(out).toHaveLength(0);
    }
  });

  it("reports without a number when the deal has no currency", async () => {
    const out = await dealsSlipping.run(dealPrisma([{ ...deal, currency: null }]), now);
    expect(out[0]!.impactMinor).toBeNull();
    expect(out[0]!.currency).toBeNull();
  });
});
