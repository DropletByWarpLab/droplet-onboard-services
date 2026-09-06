/**
 * WARP-2739 (ADR-049 §4.2) — where a LOCAL money document is in its life, and
 * the only place that answer is allowed to change.
 *
 * ── One column, one map, not five enums ────────────────────────────────────
 *
 * A quote, an order, an invoice, a bill and a credit note have five different
 * lifecycles. Modelling that as five enums means five things to keep in sync
 * and a `switch` in every read path — and the first read path that forgets a
 * case shows a blank status rather than failing. One `status` column plus a
 * per-kind allowed-transition table keeps the vocabulary in a single place
 * where a test can walk every cell of it, including the refusals.
 *
 * ── The transition and its timeline entry are ONE transaction ──────────────
 *
 * 🔴 This is not a new rule for this table. `moveDealStage` established it and
 * `updateDeal` routes stage changes through `applyStageMove` precisely so that
 * a PATCH cannot change a stage without leaving a timeline entry. A document
 * whose status moved with no record of the move is a document nobody can
 * explain later — and on money, "when did this become PAID and who said so" is
 * the question that gets asked.
 *
 * `money-status-single-writer.guard.test.ts` asserts that nothing else in the
 * tree writes `status` on an `ErpDocument`.
 *
 * ── The move is a GUARDED update, not a read-then-write ────────────────────
 *
 * `updateMany({ where: { id, status: from } })` with `count === 1` required.
 * Two tabs marking the same invoice PAID would otherwise both read SENT, both
 * write PAID, and both append a timeline entry saying it happened — one event
 * recorded twice, which on a payment is the shape of a double-credit bug.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { ErpDocumentKind, ErpDocumentStatus } from "@prisma/client";

export const DOCUMENT_ERRORS = {
  NOT_FOUND: "document_not_found",
  /** A LANDED row. The vendor owns its state; the box has no lifecycle for it. */
  NOT_LOCAL: "document_is_landed",
  /** The move is not in this kind's map. */
  BAD_TRANSITION: "document_transition_not_allowed",
  /** Somebody else moved it first. */
  ALREADY_MOVED: "document_already_moved",
  /** A local document with no party — refused on the way in, not discovered. */
  NEEDS_PARTY: "document_needs_a_customer",
} as const;

/**
 * Every kind starts as a DRAFT.
 *
 * Uniform on purpose: a quote that could be created already SENT would let a
 * caller skip the one transition that has a side effect, and "created straight
 * into its terminal state" is how an audit trail ends up with a beginning
 * nobody wrote.
 */
export const INITIAL_STATUS: ErpDocumentStatus = "DRAFT";

/**
 * The allowed moves, per kind. Read as: from → the states it may reach.
 *
 * A state absent from the map is TERMINAL — there is nothing after PAID, and a
 * document that reached DECLINED does not go back to SENT. Reopening is a new
 * document, which is the same answer §4.3 gives for quote → invoice: a
 * historical record must not change because somebody changed their mind later.
 */
export const TRANSITIONS: Readonly<
  Record<ErpDocumentKind, Readonly<Partial<Record<ErpDocumentStatus, readonly ErpDocumentStatus[]>>>>
> = {
  QUOTE: {
    DRAFT: ["SENT"],
    SENT: ["ACCEPTED", "DECLINED", "EXPIRED"],
  },
  ORDER: {
    DRAFT: ["CONFIRMED"],
    CONFIRMED: ["FULFILLED", "CANCELLED"],
  },
  INVOICE: {
    DRAFT: ["SENT"],
    SENT: ["PART_PAID", "PAID", "VOID"],
    // 🔴 PART_PAID → VOID is absent, and WRITTEN_OFF is the way out instead.
    // Voiding a part-paid invoice would leave a received payment allocated to
    // a document that says it never existed. Writing it off keeps the money
    // that arrived and stops chasing the rest — which is what a business
    // actually does, and what the payment table (a later slice) will need.
    PART_PAID: ["PAID", "WRITTEN_OFF"],
  },
  // Same shape, direction reversed: a BILL is what the business owes.
  BILL: {
    DRAFT: ["SENT"],
    SENT: ["PART_PAID", "PAID", "VOID"],
    PART_PAID: ["PAID", "WRITTEN_OFF"],
  },
  CREDIT_NOTE: {
    DRAFT: ["ISSUED"],
    ISSUED: ["APPLIED"],
  },
  // A receipt records something that already happened. It has no life after
  // being written, which is why its map is empty rather than absent — an empty
  // map is a stated "nothing follows", a missing key is an oversight.
  RECEIPT: {},
};

export function allowedNext(
  kind: ErpDocumentKind,
  from: ErpDocumentStatus,
): readonly ErpDocumentStatus[] {
  return TRANSITIONS[kind][from] ?? [];
}

export function canTransition(
  kind: ErpDocumentKind,
  from: ErpDocumentStatus,
  to: ErpDocumentStatus,
): boolean {
  return allowedNext(kind, from).includes(to);
}

export function isTerminal(kind: ErpDocumentKind, status: ErpDocumentStatus): boolean {
  return allowedNext(kind, status).length === 0;
}

/** Title case for the timeline line. The owner reads "Draft → Sent", never
 *  `PART_PAID`. */
export function statusLabel(status: ErpDocumentStatus): string {
  return status
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

const KIND_LABEL: Record<ErpDocumentKind, string> = {
  QUOTE: "Quote",
  ORDER: "Order",
  INVOICE: "Invoice",
  BILL: "Bill",
  CREDIT_NOTE: "Credit note",
  RECEIPT: "Receipt",
};

export interface MoveResult {
  readonly id: string;
  readonly from: ErpDocumentStatus;
  readonly to: ErpDocumentStatus;
}

/**
 * Move a local document to its next state, and record that it happened.
 *
 * Every refusal is a named error rather than a silent no-op: a caller that
 * asked for PAID and got back a document that is still SENT would show the
 * owner a success and an unchanged row.
 */
export async function moveDocumentStatus(
  prisma: PrismaClient,
  documentId: string,
  to: ErpDocumentStatus,
  actorId: string | null,
): Promise<MoveResult> {
  const doc = await prisma.erpDocument.findUnique({
    where: { id: documentId },
    select: { id: true, kind: true, origin: true, status: true, companyId: true },
  });
  if (!doc) throw new Error(DOCUMENT_ERRORS.NOT_FOUND);

  // 🔴 A LANDED row has `status IS NULL` by CHECK, so this is not merely a
  // policy: there is no `from` to move out of. Saying so by name beats letting
  // the null fall through and produce "transition not allowed", which would
  // send somebody looking for a missing map entry.
  if (doc.origin !== "LOCAL" || doc.status === null) {
    throw new Error(DOCUMENT_ERRORS.NOT_LOCAL);
  }

  const from = doc.status;
  if (!canTransition(doc.kind, from, to)) throw new Error(DOCUMENT_ERRORS.BAD_TRANSITION);

  return prisma.$transaction(async (tx) => {
    const moved = await tx.erpDocument.updateMany({
      // The `status: from` predicate is the concurrency guard. Losing this race
      // must produce a refusal, not a second identical timeline entry.
      where: { id: documentId, status: from, origin: "LOCAL" },
      data: { status: to },
    });
    if (moved.count !== 1) throw new Error(DOCUMENT_ERRORS.ALREADY_MOVED);

    await writeTimelineEntry(tx, doc.companyId, doc.kind, from, to, actorId);
    return { id: documentId, from, to };
  });
}

/**
 * The timeline half.
 *
 * Hangs off the COMPANY, because that is where a person looks for "what has
 * happened with this customer" and `CrmActivity` has no document subject
 * column. `STAGE_CHANGE` rather than a new kind: it IS a stage change, and
 * `notifyStatus` reaches `not_needed` on its first sweep because only a
 * STAGE_CHANGE whose destination stage has kind WON or LOST is ever notified —
 * these carry no `toStageId` at all, so they drain rather than accumulate.
 *
 * A document with no company writes no entry rather than failing. The party is
 * required on the way in and enforced there; a status move is the wrong place
 * to discover its absence and the worst place to refuse it, because refusing
 * would strand the document in whatever state it was already in.
 */
async function writeTimelineEntry(
  tx: Prisma.TransactionClient,
  companyId: string | null,
  kind: ErpDocumentKind,
  from: ErpDocumentStatus,
  to: ErpDocumentStatus,
  actorId: string | null,
): Promise<void> {
  if (!companyId) return;
  await tx.crmActivity.create({
    data: {
      subjectType: "COMPANY",
      companyId,
      kind: "STAGE_CHANGE",
      summary: `${KIND_LABEL[kind]}: ${statusLabel(from)} → ${statusLabel(to)}`,
      actorId,
    },
  });
}
