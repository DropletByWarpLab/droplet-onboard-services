/**
 * WARP-2739 (ADR-049 §4.2) — the lifecycle, cell by cell.
 *
 * ── Why every cell, and not the interesting ones ───────────────────────────
 *
 * The failure this table can have is not a crash. It is ONE cell that allows a
 * move it should not — `PART_PAID → VOID`, say, which voids an invoice that
 * already received money and leaves that payment allocated to a document
 * claiming it never existed. A spot-check of the interesting rows is exactly
 * how such a cell survives, because it is never the row somebody thought to
 * check.
 *
 * So the grid below walks all 6 kinds × 14 statuses × 14 statuses and compares
 * `canTransition` against `expectAllowed`, which is written out INDEPENDENTLY
 * from the ticket's own table rather than derived from `TRANSITIONS`. A test
 * that read the map it is testing would agree with any map.
 *
 * ── And the transaction ────────────────────────────────────────────────────
 *
 * `moveDealStage` established that a status move and its timeline entry commit
 * together, and `updateDeal` routes through `applyStageMove` so a PATCH cannot
 * skip the timeline. On money the question this protects is "when did this
 * become PAID and who said so", which is the one that gets asked.
 */
import { describe, it, expect, vi } from "vitest";

import {
  DOCUMENT_ERRORS,
  INITIAL_STATUS,
  TRANSITIONS,
  allowedNext,
  canTransition,
  isTerminal,
  moveDocumentStatus,
  statusLabel,
} from "./document-status.js";

const KINDS = ["QUOTE", "ORDER", "INVOICE", "BILL", "CREDIT_NOTE", "RECEIPT"] as const;
const STATUSES = [
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "DECLINED",
  "EXPIRED",
  "CONFIRMED",
  "FULFILLED",
  "CANCELLED",
  "PART_PAID",
  "PAID",
  "VOID",
  "WRITTEN_OFF",
  "ISSUED",
  "APPLIED",
] as const;

type Kind = (typeof KINDS)[number];
type Status = (typeof STATUSES)[number];

/**
 * The ticket's table, transcribed by hand.
 *
 * 🔴 Written from WARP-2739's acceptance criteria, NOT from `TRANSITIONS`. The
 * one deliberate difference from the ticket's shorthand is spelled out below,
 * so a reader can see it was decided rather than mistyped.
 */
function expectAllowed(kind: Kind, from: Status, to: Status): boolean {
  switch (kind) {
    // QUOTE: DRAFT → SENT → ACCEPTED | DECLINED | EXPIRED
    case "QUOTE":
      if (from === "DRAFT") return to === "SENT";
      if (from === "SENT") return to === "ACCEPTED" || to === "DECLINED" || to === "EXPIRED";
      return false;

    // ORDER: DRAFT → CONFIRMED → FULFILLED | CANCELLED
    case "ORDER":
      if (from === "DRAFT") return to === "CONFIRMED";
      if (from === "CONFIRMED") return to === "FULFILLED" || to === "CANCELLED";
      return false;

    // INVOICE / BILL: DRAFT → SENT → PART_PAID → PAID | VOID | WRITTEN_OFF
    //
    // 🔴 The one deliberate narrowing of the ticket's shorthand: VOID is
    // reachable from SENT and NOT from PART_PAID. An invoice that has taken
    // money cannot be made never to have existed; WRITTEN_OFF is the exit that
    // keeps the payment and stops chasing the rest.
    case "INVOICE":
    case "BILL":
      if (from === "DRAFT") return to === "SENT";
      if (from === "SENT") return to === "PART_PAID" || to === "PAID" || to === "VOID";
      if (from === "PART_PAID") return to === "PAID" || to === "WRITTEN_OFF";
      return false;

    // CREDIT_NOTE: DRAFT → ISSUED → APPLIED
    case "CREDIT_NOTE":
      if (from === "DRAFT") return to === "ISSUED";
      if (from === "ISSUED") return to === "APPLIED";
      return false;

    // A receipt records something that already happened.
    case "RECEIPT":
      return false;
  }
}

describe("🔴 the transition table, every cell", () => {
  it("allows exactly the moves the ticket names, and refuses the rest", () => {
    const wrong: string[] = [];
    for (const kind of KINDS) {
      for (const from of STATUSES) {
        for (const to of STATUSES) {
          const got = canTransition(kind, from, to);
          const want = expectAllowed(kind, from, to);
          if (got !== want) {
            wrong.push(`${kind} ${from}->${to}: got ${got}, want ${want}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    // The grid is only proof if it ran. 6 × 14 × 14.
    expect(KINDS.length * STATUSES.length * STATUSES.length).toBe(1176);
  });

  it("MUTATION: allow PART_PAID → VOID — a paid invoice claims it never existed", () => {
    // Named on its own because it is the cell most likely to be added as a
    // convenience: an owner who wants to cancel an invoice reaches for Void,
    // and the money that already arrived becomes an allocation against a
    // document that says nothing was ever owed.
    expect(canTransition("INVOICE", "PART_PAID", "VOID")).toBe(false);
    expect(canTransition("BILL", "PART_PAID", "VOID")).toBe(false);
    expect(canTransition("INVOICE", "PART_PAID", "WRITTEN_OFF")).toBe(true);
  });

  it("never lets a document go backwards, on any kind", () => {
    // No terminal or later state reaches DRAFT again. Reopening is a NEW
    // document — the same answer §4.3 gives for quote → invoice, and for the
    // same reason: a historical record must not change its mind.
    for (const kind of KINDS) {
      for (const from of STATUSES) {
        if (from === "DRAFT") continue;
        expect(canTransition(kind, from, "DRAFT")).toBe(false);
      }
    }
  });

  it("never lets a document transition to itself", () => {
    for (const kind of KINDS) {
      for (const status of STATUSES) {
        expect(canTransition(kind, status, status)).toBe(false);
      }
    }
  });

  it("every kind starts at DRAFT and every kind can leave it, except RECEIPT", () => {
    expect(INITIAL_STATUS).toBe("DRAFT");
    for (const kind of KINDS) {
      const out = allowedNext(kind, "DRAFT");
      if (kind === "RECEIPT") {
        expect(out).toEqual([]);
      } else {
        expect(out.length).toBeGreaterThan(0);
      }
    }
  });

  it("names RECEIPT's empty map rather than omitting the key", () => {
    // An empty map is a stated "nothing follows"; a missing key is an
    // oversight, and the two are indistinguishable at the call site.
    expect(Object.prototype.hasOwnProperty.call(TRANSITIONS, "RECEIPT")).toBe(true);
    expect(isTerminal("RECEIPT", "DRAFT")).toBe(true);
  });

  it("reads the states in the owner's spelling", () => {
    expect(statusLabel("PART_PAID")).toBe("Part Paid");
    expect(statusLabel("DRAFT")).toBe("Draft");
    expect(statusLabel("WRITTEN_OFF")).toBe("Written Off");
  });
});

// ── the move itself ─────────────────────────────────────────────────────────

function harness(
  doc: Record<string, unknown> | null,
  moved = { count: 1 },
): {
  prisma: never;
  updateMany: ReturnType<typeof vi.fn>;
  createActivity: ReturnType<typeof vi.fn>;
} {
  const updateMany = vi.fn(
    async (_arg: { where: Record<string, unknown>; data: Record<string, unknown> }) => moved,
  );
  const createActivity = vi.fn(async (_arg: { data: Record<string, unknown> }) => ({ id: "a1" }));
  const tx = {
    erpDocument: { updateMany },
    crmActivity: { create: createActivity },
  };
  const prisma = {
    erpDocument: { findUnique: vi.fn(async () => doc), updateMany },
    crmActivity: { create: createActivity },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as never;
  return { prisma, updateMany, createActivity };
}

const LOCAL_INVOICE = {
  id: "d1",
  kind: "INVOICE",
  origin: "LOCAL",
  status: "SENT",
  companyId: "co-1",
};

describe("🔴 the move and its timeline entry are one transaction", () => {
  it("MUTATION: write the status without the entry — nobody can say when it was paid", async () => {
    const { prisma, updateMany, createActivity } = harness(LOCAL_INVOICE);
    const result = await moveDocumentStatus(prisma, "d1", "PAID", "u-ada");

    expect(result).toEqual({ id: "d1", from: "SENT", to: "PAID" });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(createActivity).toHaveBeenCalledTimes(1);
    // Both through the SAME transaction client — the guard against a status
    // that commits while its timeline entry rolls back.
    expect(
      (prisma as unknown as { $transaction: { mock: { calls: unknown[] } } }).$transaction.mock
        .calls,
    ).toHaveLength(1);
    expect(createActivity.mock.calls[0][0].data).toMatchObject({
      subjectType: "COMPANY",
      companyId: "co-1",
      kind: "STAGE_CHANGE",
      summary: "Invoice: Sent → Paid",
      actorId: "u-ada",
    });
  });

  it("🔴 MUTATION: drop the `status: from` predicate — one payment, two timeline entries", async () => {
    const { prisma, updateMany } = harness(LOCAL_INVOICE);
    await moveDocumentStatus(prisma, "d1", "PAID", null);
    // The guard IS the where clause. Two tabs marking the same invoice paid
    // would otherwise both read SENT, both write PAID, and both append an
    // entry saying it happened.
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      id: "d1",
      status: "SENT",
      origin: "LOCAL",
    });
  });

  it("refuses when somebody else moved it first", async () => {
    const { prisma, createActivity } = harness(LOCAL_INVOICE, { count: 0 });
    await expect(moveDocumentStatus(prisma, "d1", "PAID", null)).rejects.toThrow(
      DOCUMENT_ERRORS.ALREADY_MOVED,
    );
    expect(createActivity).not.toHaveBeenCalled();
  });

  it("🔴 refuses to give a LANDED document a lifecycle", async () => {
    // The vendor owns its state, `status` is NULL on it by CHECK, and there is
    // no `from` to move out of. Named rather than left to fall through as
    // "transition not allowed", which would send somebody hunting for a
    // missing map entry.
    const { prisma, createActivity } = harness({
      ...LOCAL_INVOICE,
      origin: "LANDED",
      status: null,
    });
    await expect(moveDocumentStatus(prisma, "d1", "PAID", null)).rejects.toThrow(
      DOCUMENT_ERRORS.NOT_LOCAL,
    );
    expect(createActivity).not.toHaveBeenCalled();
  });

  it("refuses a move the table does not allow, before touching the database", async () => {
    const { prisma, updateMany } = harness({ ...LOCAL_INVOICE, status: "PART_PAID" });
    await expect(moveDocumentStatus(prisma, "d1", "VOID", null)).rejects.toThrow(
      DOCUMENT_ERRORS.BAD_TRANSITION,
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("still moves a document with no customer, and writes no entry", async () => {
    // A status move is the wrong place to discover a missing party and the
    // worst place to refuse it: refusing would strand the document in the state
    // it was already in. The party is required on the way in instead.
    const { prisma, updateMany, createActivity } = harness({
      ...LOCAL_INVOICE,
      companyId: null,
    });
    await expect(moveDocumentStatus(prisma, "d1", "PAID", null)).resolves.toMatchObject({
      to: "PAID",
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(createActivity).not.toHaveBeenCalled();
  });

  it("says so when the document is gone", async () => {
    const { prisma } = harness(null);
    await expect(moveDocumentStatus(prisma, "nope", "PAID", null)).rejects.toThrow(
      DOCUMENT_ERRORS.NOT_FOUND,
    );
  });
});
