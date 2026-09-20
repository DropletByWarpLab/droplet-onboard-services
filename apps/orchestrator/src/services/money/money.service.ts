/**
 * Money — what the business is owed and what it owes (WARP-2581).
 *
 * The read side of `ErpDocument`. Everything here exists to answer four
 * questions the product could not answer at all before: *how much am I owed*,
 * *by whom*, *what do I owe*, and *what is overdue*.
 *
 * ## Three rules this service will not break
 *
 * 🔴 **A total is per LEDGER, never across ledgers.** `invoice` and `bill` are
 * exempt from the money-needs-a-currency rule — a QuickBooks company file has
 * one home currency and its export carries no per-row currency column — so a
 * document's currency is usually NULL and means "this ledger's own". Adding two
 * ledgers produces a confident wrong number, and unknown behaves exactly like
 * mixed: the total is withheld. `ledgers[]` is therefore a list, and there is
 * deliberately no `total` field for a caller to reach for.
 *
 * 🔴 **`amount` and `balance` are different numbers, and every figure says
 * which.** An invoice part-paid still carries its original amount; summing
 * amounts where you meant balances overstates receivables. Receivable and
 * payable totals here are BALANCES, and the field is named for it.
 *
 * 🔴 **Money crosses this boundary as a STRING.** `Number()` rounds above 2^53,
 * which for a currency figure is a wrong number rather than an error. Postgres
 * holds `NUMERIC(20,6)`, Prisma hands back a `Decimal`, and this service calls
 * `.toString()` — it never converts to a JS number, not even for a comparison.
 *
 * ## What this does NOT do, and why it says so out loud
 *
 * A document the vendor stops serving — paid, voided, deleted upstream — is not
 * reaped. The tracks read OPEN documents only (`get_open_invoices`), so a
 * settled invoice simply stops appearing in the vendor's answer; nothing then
 * revisits the row this box already landed, and its last known balance stands.
 * Reaping needs the reconciliation sweep to land a full enumeration rather than
 * diff one in memory, which is its own change.
 *
 * The consequence is contained rather than hidden: every document and every
 * summary carries `lastReadAt`, and the surface may say WHEN IT LAST READ. It
 * may never say "up to date" — a claim that would be false for three separate
 * vendor reasons anyway (Xero's modification timestamp does not fire on a
 * due-date edit or a send-to-contact, HubSpot's search is eventually
 * consistent, and Stripe does not guarantee event order).
 */
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * WARP-2739 — RECEIVABLE and PAYABLE are a DIRECTION, and they stopped being
 * the `kind` column when `ErpDocumentKind` widened to six values.
 *
 * 🔴 They were never a kind. A quote and an invoice are both receivable; a
 * credit note is receivable and negative. Deriving direction from kind, in one
 * place, is what lets kinds be added without every read path learning about
 * them — and it is why the API's `?kind=receivable` words could stay exactly as
 * they were while the column underneath changed shape.
 */
export type MoneyDirection = "RECEIVABLE" | "PAYABLE";

/** Every document kind. Wider than what this surface reads — see below. */
export type MoneyDocumentKind =
  | "QUOTE"
  | "ORDER"
  | "INVOICE"
  | "BILL"
  | "CREDIT_NOTE"
  | "RECEIPT";

/**
 * 🔴 QUOTE AND ORDER ARE NOT MONEY OWED, and this surface must never show them.
 *
 * An unaccepted quote in "what you are owed" is the single most misleading
 * thing this page could say: it is a number the business has no claim to, added
 * to numbers it does. The exclusion is expressed as an allow-list rather than a
 * pair of `not` clauses so that a seventh kind added later is EXCLUDED until
 * somebody decides it belongs, rather than silently appearing in a total.
 */
const KINDS_BY_DIRECTION: Readonly<Record<MoneyDirection, readonly MoneyDocumentKind[]>> = {
  // A receipt records money that arrived and a credit note reduces what is
  // owed; both belong on the receivable side. A settled receipt carries a zero
  // balance and is excluded by `OPEN` anyway.
  RECEIVABLE: ["INVOICE", "CREDIT_NOTE", "RECEIPT"],
  PAYABLE: ["BILL"],
};

/** The kinds this surface reads at all. */
export const MONEY_KINDS: readonly MoneyDocumentKind[] = [
  ...KINDS_BY_DIRECTION.RECEIVABLE,
  ...KINDS_BY_DIRECTION.PAYABLE,
];

export function directionOf(kind: MoneyDocumentKind): MoneyDirection | null {
  if (KINDS_BY_DIRECTION.RECEIVABLE.includes(kind)) return "RECEIVABLE";
  if (KINDS_BY_DIRECTION.PAYABLE.includes(kind)) return "PAYABLE";
  return null;
}

export function kindsFor(direction: MoneyDirection): readonly MoneyDocumentKind[] {
  return KINDS_BY_DIRECTION[direction];
}

export type MoneyDb = Pick<PrismaClient, "erpDocument">;

/** One ledger's own total. Never added to another's. */
export interface MoneyLedgerTotal {
  /** WARP-2739 — NULL for the box's own documents. They are one book, with no
   *  connection behind them and no vendor to name. */
  readonly connectionId: string | null;
  readonly provider: string | null;
  /** The vendor's code when it names one; null means "this ledger's own". */
  readonly currency: string | null;
  /** Sum of BALANCES — what remains unpaid — as a decimal string. */
  readonly balance: string;
  readonly documentCount: number;
  /** Documents whose due date has passed. */
  readonly overdueCount: number;
  /** Sum of the balances of those overdue documents. */
  readonly overdueBalance: string;
}

export interface MoneySide {
  readonly documentCount: number;
  readonly overdueCount: number;
  /**
   * Per-ledger totals. A caller that wants "the number" must choose a ledger
   * or show them side by side; there is no cross-ledger sum to reach for.
   */
  readonly ledgers: readonly MoneyLedgerTotal[];
}

export interface MoneySummary {
  readonly receivable: MoneySide;
  readonly payable: MoneySide;
  /** The oldest and newest reads behind these numbers. Never "up to date". */
  readonly lastReadAt: string | null;
  readonly oldestReadAt: string | null;
}

export interface MoneyDocumentView {
  readonly id: string;
  /** What it IS. Six values since WARP-2739. */
  readonly kind: MoneyDocumentKind;
  /** Which way the money runs. Derived here so no client re-derives it. */
  readonly direction: MoneyDirection;
  /** WARP-2739 — LANDED or LOCAL. A caller may not infer it from a null
   *  `externalId`: that is the shape, not the fact. */
  readonly origin: "LANDED" | "LOCAL";
  /** NULL on a local document — nothing outside this box has ever seen it. */
  readonly externalId: string | null;
  readonly externalSystem: string | null;
  readonly connectionId: string | null;
  readonly issuedAt: string | null;
  readonly dueAt: string | null;
  readonly counterparty: {
    readonly externalId: string | null;
    readonly name: string | null;
    /** The landed customer, when this connection also landed them. */
    readonly companyId: string | null;
  };
  /** The document's original value. Decimal string, or null when unreadable. */
  readonly amount: string | null;
  /** What remains unpaid. NOT the same number as `amount`. */
  readonly balance: string | null;
  readonly currency: string | null;
  /** The VENDOR's own word, verbatim, on a landed row. Null on a local one. */
  readonly vendorStatus: string | null;
  /** The BOX's own lifecycle, on a local row. Null on a landed one. */
  readonly status: string | null;
  readonly isOverdue: boolean;
  readonly vendorUpdatedAt: string | null;
  readonly lastReadAt: string;
}

/** A row as Prisma returns it, narrowed to what this service reads. */
type DocumentRow = {
  id: string;
  kind: MoneyDocumentKind;
  origin: "LANDED" | "LOCAL";
  externalId: string | null;
  externalSystem: string | null;
  connectionId: string | null;
  issuedAt: Date | null;
  dueAt: Date | null;
  counterpartyExternalId: string | null;
  counterpartyName: string | null;
  companyId: string | null;
  amount: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  currency: string | null;
  vendorStatus: string | null;
  status: string | null;
  vendorUpdatedAt: Date | null;
  lastReadAt: Date;
};

/**
 * Decimal → string, without passing through a number.
 *
 * `Prisma.Decimal.toString()` is exact. `Number(decimal)` is not, and the
 * failure only shows up on the large or the awkward figures — which is to say,
 * on the ones somebody notices.
 */
function money(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString();
}

/**
 * Is this document still owed?
 *
 * A balance of zero is settled. A NULL balance is UNKNOWN, not zero — the
 * vendor sent something this box would not guess at — and unknown counts as
 * open, because dropping a document the business may still owe is the worse
 * of the two errors.
 *
 * 🔴 THIS PREDICATE LIVES IN SQL, not in a `.filter()`. It is the `where` the aggregates
 * below run under, so the count Postgres returns and the rows the table lists
 * can never drift apart.
 */
const OPEN: Prisma.ErpDocumentWhereInput = {
  // WARP-2739 — and only the kinds that ARE money owed. A quote is an offer,
  // an order is a commitment to deliver; neither is a claim on anybody's bank
  // account, and putting them in a receivables figure would overstate it by
  // exactly the value of the work that has not been agreed yet.
  kind: { in: [...MONEY_KINDS] },
  OR: [{ balance: null }, { balance: { not: 0 } }],
  // 🔴 WARP-2737 — nor is a document this box wrote and nobody has sent.
  //
  // The same argument as the kind allow-list above, one step further along.
  // `createLocalDocument` mints every filed document `origin: LOCAL, status:
  // DRAFT` with `balance = total`, so without this clause an invoice the owner
  // has only just been SHOWN — extracted from a PDF, applied on one click —
  // immediately joins "what you are owed", and joins the OVERDUE figure too
  // whenever the `dueAt` read off that PDF has already passed. A draft nobody
  // has sent is not a claim on anybody's bank account.
  //
  // Only LOCAL rows: a landed row carries `status = NULL` (the provenance
  // CHECK puts the vendor's word in `vendorStatus`), so this cannot narrow the
  // vendor-synced ledger by accident.
  NOT: { origin: "LOCAL", status: "DRAFT" },
};

/** Open, and past its due date. A document with no due date cannot be late. */
function overdueWhere(now: Date): Prisma.ErpDocumentWhereInput {
  return { ...OPEN, dueAt: { lt: now } };
}

function isOverdue(row: DocumentRow, now: Date): boolean {
  const open = row.balance === null || !row.balance.isZero();
  return row.dueAt !== null && row.dueAt.getTime() < now.getTime() && open;
}

function toView(row: DocumentRow, now: Date): MoneyDocumentView {
  return {
    id: row.id,
    kind: row.kind,
    // Non-null by construction: `OPEN` restricts every query here to the money
    // kinds, and `directionOf` answers for all of them. The fallback exists so
    // a seventh kind reaching this function is a visible RECEIVABLE rather than
    // a crash on a page about money — and the allow-list above keeps it from
    // getting here at all.
    direction: directionOf(row.kind) ?? "RECEIVABLE",
    origin: row.origin,
    externalId: row.externalId,
    externalSystem: row.externalSystem,
    connectionId: row.connectionId,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    dueAt: row.dueAt?.toISOString() ?? null,
    counterparty: {
      externalId: row.counterpartyExternalId,
      name: row.counterpartyName,
      companyId: row.companyId,
    },
    amount: money(row.amount),
    balance: money(row.balance),
    currency: row.currency,
    vendorStatus: row.vendorStatus,
    status: row.status,
    isOverdue: isOverdue(row, now),
    vendorUpdatedAt: row.vendorUpdatedAt?.toISOString() ?? null,
    lastReadAt: row.lastReadAt.toISOString(),
  };
}

/**
 * The columns one ledger's total is keyed by.
 *
 * Connection AND currency: a multi-currency ledger that DOES name its rows
 * must not have them added together either. `externalSystem` rides along
 * because it is denormalised from `connection.provider` on write and is
 * therefore constant within a connection — grouping by it adds no rows and
 * saves a join.
 */
const LEDGER_KEY = ["kind", "connectionId", "externalSystem", "currency"] as const;

/** One row of `GROUP BY kind, connectionId, externalSystem, currency`. */
interface LedgerGroup {
  kind: MoneyDocumentKind;
  connectionId: string | null;
  externalSystem: string | null;
  currency: string | null;
  _count: { _all: number };
  _sum: { balance: Prisma.Decimal | null };
}

function ledgerKey(group: LedgerGroup): string {
  // WARP-2739 — a LOCAL document has no connection, so every local row falls
  // into ONE ledger keyed by the empty string plus its currency. That is right:
  // the box's own documents are one book, and they are the only rows here whose
  // currency is reliably named.
  return `${group.connectionId ?? ""} ${group.currency ?? ""}`;
}

/**
 * A summed NUMERIC as a decimal string.
 *
 * `SUM()` over rows whose balance is entirely NULL is NULL, and that means
 * "nothing readable to add", which prints as `"0"` beside a non-zero count --
 * the same honest disagreement the per-row rule produces.
 */
function sum(value: Prisma.Decimal | null): string {
  return value === null ? "0" : value.toString();
}

function sideFrom(open: readonly LedgerGroup[], overdue: readonly LedgerGroup[]): MoneySide {
  const overdueByKey = new Map(overdue.map((group) => [ledgerKey(group), group]));

  const ledgers: MoneyLedgerTotal[] = open.map((group) => {
    const late = overdueByKey.get(ledgerKey(group));
    return {
      connectionId: group.connectionId,
      provider: group.externalSystem,
      currency: group.currency,
      // A document whose balance could not be read still COUNTS — it is money
      // somebody owes — but contributes nothing to the figure. The count and
      // the total disagreeing is the honest signal that one is unreadable.
      balance: sum(group._sum.balance),
      documentCount: group._count._all,
      overdueCount: late?._count._all ?? 0,
      overdueBalance: late === undefined ? "0" : sum(late._sum.balance),
    };
  });

  ledgers.sort((a, b) =>
    a.connectionId === b.connectionId
      ? (a.currency ?? "").localeCompare(b.currency ?? "")
      : (a.connectionId ?? "").localeCompare(b.connectionId ?? ""),
  );

  return {
    documentCount: ledgers.reduce((total, ledger) => total + ledger.documentCount, 0),
    overdueCount: ledgers.reduce((total, ledger) => total + ledger.overdueCount, 0),
    ledgers,
  };
}

export interface MoneyService {
  summary(now: Date): Promise<MoneySummary>;
  documents(args: {
    /** Which way the money runs. Absent = both. */
    direction?: MoneyDirection;
    overdueOnly?: boolean;
    limit?: number;
    now: Date;
  }): Promise<readonly MoneyDocumentView[]>;
}

/** How many documents one list request may return. */
export const MONEY_PAGE_LIMIT = 200;

export function createMoneyService(prisma: MoneyDb): MoneyService {
  return {
    /**
     * 🔴 THE ADDING HAPPENS IN POSTGRES, and that is not a micro-optimisation.
     *
     * This used to `findMany()` every landed document — unbounded — and sum
     * them in JS. `useMoney.ts` polls `/api/money` every five minutes per open
     * tab, so a practice with a few years of ledger paid for its whole
     * document table, over the wire and into the heap, on a timer. Three
     * bounded queries replace it: the open totals, the overdue totals, and the
     * read window. `NUMERIC` sums exactly in Postgres, so nothing is lost by
     * moving the arithmetic there — the exact-decimal string helpers this
     * service used to carry are gone with it.
     */
    async summary(now) {
      const [open, overdue, reads] = await Promise.all([
        prisma.erpDocument.groupBy({
          by: [...LEDGER_KEY],
          where: OPEN,
          _count: { _all: true },
          _sum: { balance: true },
        }) as unknown as Promise<LedgerGroup[]>,
        prisma.erpDocument.groupBy({
          by: [...LEDGER_KEY],
          where: overdueWhere(now),
          _count: { _all: true },
          _sum: { balance: true },
        }) as unknown as Promise<LedgerGroup[]>,
        // Deliberately unfiltered: the read window describes when the BOX last
        // spoke to the vendor, which a settled document evidences as well as
        // an open one.
        prisma.erpDocument.aggregate({
          _max: { lastReadAt: true },
          _min: { lastReadAt: true },
        }),
      ]);

      // 🔴 Grouped by KIND in SQL and folded into DIRECTIONS here. Grouping by
      // a direction is not possible — it is not a column — and computing it in
      // SQL would put the kind→direction table in two places, which is the one
      // way this could start disagreeing with itself.
      const facing = (d: MoneyDirection) => (g: LedgerGroup) => directionOf(g.kind) === d;
      return {
        receivable: sideFrom(open.filter(facing("RECEIVABLE")), overdue.filter(facing("RECEIVABLE"))),
        payable: sideFrom(open.filter(facing("PAYABLE")), overdue.filter(facing("PAYABLE"))),
        // Both ends, because one number cannot describe a box whose Xero
        // connection answered this morning and whose Stripe one has been
        // failing for a week.
        lastReadAt: reads._max.lastReadAt?.toISOString() ?? null,
        oldestReadAt: reads._min.lastReadAt?.toISOString() ?? null,
      };
    },

    /**
     * The page is taken in SQL — `where` + `take` — not sliced out of a full
     * table read. Settled documents are excluded by the same `OPEN` predicate
     * the summary counts under, so the ledger and the figure above it always
     * describe the same rows.
     */
    async documents({ direction, overdueOnly = false, limit = MONEY_PAGE_LIMIT, now }) {
      const rows = (await prisma.erpDocument.findMany({
        where: {
          ...(overdueOnly ? overdueWhere(now) : OPEN),
          // AFTER the spread, deliberately: `OPEN` already carries a `kind`
          // clause, and a narrowing that spread first would be overwritten by
          // it and silently return both directions.
          ...(direction === undefined ? {} : { kind: { in: [...kindsFor(direction)] } }),
        },
        orderBy: [{ dueAt: "asc" }, { externalId: "asc" }],
        take: Math.min(limit, MONEY_PAGE_LIMIT),
      })) as unknown as DocumentRow[];
      return rows.map((row) => toView(row, now));
    },
  };
}
