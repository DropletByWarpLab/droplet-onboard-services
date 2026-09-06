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
 *
 * ⚠ THIS HAS NO CALLER YET, AND THAT IS TRACKED RATHER THAN ACCIDENTAL —
 * WARP-2778. `createLocalDocument` below mints every filed document DRAFT and
 * nothing on the box can move it: the money surface is two GET routes. What is
 * missing is not a route, it is an access decision — `access-catalog.ts` says
 * Money is READ-ONLY, "there is no `act` level: there is no action", and
 * `FEATURE_GATED_MODULES` mounts only a view gate at the money prefix, so a
 * PATCH here would be a write endpoint on a module whose access model says
 * writes do not exist.
 *
 * Until that lands, an un-sent local DRAFT is excluded from the money
 * aggregates (`money.service.ts`'s `OPEN`), so a filed invoice cannot inflate
 * what an owner is told they are owed while they have no way to settle it.
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
 * Mint a LOCAL document — the box's own invoice, quote or credit note.
 *
 * ── Why the creator lives HERE and not at the call site ────────────────────
 *
 * 🔴 Two rules this repo already had collide head-on, and this function is
 * where they are reconciled rather than argued with.
 *
 *   - `ErpDocument_provenance` REQUIRES `status IS NOT NULL` on a LOCAL row.
 *     A local document without a lifecycle is unrepresentable.
 *   - `money-status-single-writer.guard.test.ts` fails ANY Prisma write
 *     against `erpDocument` whose `data` mentions `status`, outside this file.
 *
 * So a `CREATE_MONEY_DOC` apply branch physically cannot write the row itself.
 * That is not an obstacle the guard failed to anticipate — it is the guard
 * working: the file that owns the lifecycle owns the moment the lifecycle
 * BEGINS, and every document on this box starts in exactly one state.
 *
 * ── Takes a transaction client, deliberately ───────────────────────────────
 *
 * `applyProposal` already runs its writes and its back-pointer update in one
 * transaction. A creator that opened its own would commit an invoice that a
 * later rollback could not take back, and the proposal would then point at a
 * document nobody agreed to.
 */
export interface LocalDocumentInput {
  kind: ErpDocumentKind;
  /** 🔴 REQUIRED. See `NEEDS_PARTY` below. */
  companyId: string;
  /** The number the DOCUMENT carries, as printed on it. Never `externalId` —
   *  that column is the vendor's and is NULL on every local row by CHECK. */
  documentNumber?: string | null;
  currency: string;
  /** 🔴 DECIMAL STRINGS. Never a JS number: `Number()` rounds above 2^53 and
   *  the column is NUMERIC(20,6), so a rounded figure is a wrong invoice
   *  rather than an error anybody notices. Passed straight through to Prisma,
   *  which accepts a string for a Decimal field. */
  total: string;
  balance?: string | null;
  issuedAt?: Date | null;
  dueAt?: Date | null;
  counterpartyName?: string | null;
}

export async function createLocalDocument(
  tx: Prisma.TransactionClient,
  input: LocalDocumentInput,
): Promise<{ id: string; status: ErpDocumentStatus }> {
  // 🔴 The first caller `DOCUMENT_ERRORS.NEEDS_PARTY` has ever had, and the
  // reason it was declared before anything could throw it.
  //
  // The provenance CHECK deliberately does NOT carry `companyId IS NOT NULL`
  // on its LOCAL arm — under an `onDelete: SetNull` FK that constraint would
  // fire inside the statement that nulls it and make the customer
  // un-deletable. So the invariant has to be enforced by the only code that
  // creates these rows, which is this function.
  if (!input.companyId) throw new Error(DOCUMENT_ERRORS.NEEDS_PARTY);

  const doc = await tx.erpDocument.create({
    data: {
      origin: "LOCAL",
      kind: input.kind,
      // Every document starts as a DRAFT. Uniform across kinds so a caller
      // cannot mint one straight into a state that skips the transition with
      // the side effect.
      status: INITIAL_STATUS,
      companyId: input.companyId,
      documentNumber: input.documentNumber ?? null,
      currency: input.currency,
      amount: input.total,
      balance: input.balance ?? input.total,
      issuedAt: input.issuedAt ?? null,
      dueAt: input.dueAt ?? null,
      counterpartyName: input.counterpartyName ?? null,
      // 🔴 Stated, not defaulted. All four are NULL by the CHECK's LOCAL arm,
      // and writing them out is what makes a reader of this function able to
      // see that a local row borrows nothing from a vendor.
      connectionId: null,
      externalSystem: null,
      externalId: null,
      vendorStatus: null,
    },
    select: { id: true, status: true },
  });

  return { id: doc.id, status: doc.status ?? INITIAL_STATUS };
}

/**
 * Delete a LOCAL document that is still a draft.
 *
 * The reverse of `createLocalDocument`, and the only deletion this file
 * permits. Bounded to DRAFT on purpose: once a document has been SENT it has
 * left the building — somebody has it — and once it is PART_PAID money has
 * moved against it. Neither can be undone by removing the row, and a delete
 * that silently succeeded on those would destroy the record of both.
 *
 * ⚠ `ErpDocument` has no `isArchived`, so the delete-vs-archive rule the CRM
 * undo path follows has only one branch available here. That is stated rather
 * than worked around: an archive column for money documents is a decision
 * about how a business's books read, not a detail to add in a filing slice.
 */
export async function deleteDraftDocument(
  tx: Prisma.TransactionClient,
  documentId: string,
): Promise<boolean> {
  const removed = await tx.erpDocument.deleteMany({
    // Guarded on BOTH origin and status. A landed row is the vendor's and a
    // sent one is somebody else's; neither is ours to remove, and a bare
    // delete-by-id would take either.
    where: { id: documentId, origin: "LOCAL", status: INITIAL_STATUS },
  });
  return removed.count === 1;
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
