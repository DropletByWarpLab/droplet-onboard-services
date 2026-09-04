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

export type MoneyKind = "RECEIVABLE" | "PAYABLE";

export type MoneyDb = Pick<PrismaClient, "erpDocument">;

/** One ledger's own total. Never added to another's. */
export interface MoneyLedgerTotal {
  readonly connectionId: string;
  readonly provider: string;
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
  readonly kind: MoneyKind;
  readonly externalId: string;
  readonly externalSystem: string;
  readonly connectionId: string;
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
  readonly status: string | null;
  readonly isOverdue: boolean;
  readonly vendorUpdatedAt: string | null;
  readonly lastReadAt: string;
}

/** A row as Prisma returns it, narrowed to what this service reads. */
type DocumentRow = {
  id: string;
  kind: MoneyKind;
  externalId: string;
  externalSystem: string;
  connectionId: string;
  issuedAt: Date | null;
  dueAt: Date | null;
  counterpartyExternalId: string | null;
  counterpartyName: string | null;
  companyId: string | null;
  amount: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  currency: string | null;
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
  OR: [{ balance: null }, { balance: { not: 0 } }],
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
  kind: MoneyKind;
  connectionId: string;
  externalSystem: string;
  currency: string | null;
  _count: { _all: number };
  _sum: { balance: Prisma.Decimal | null };
}

function ledgerKey(group: LedgerGroup): string {
  return `${group.connectionId} ${group.currency ?? ""}`;
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
      : a.connectionId.localeCompare(b.connectionId),
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
    kind?: MoneyKind;
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

      const ofKind = (kind: MoneyKind) => (group: LedgerGroup) => group.kind === kind;
      return {
        receivable: sideFrom(open.filter(ofKind("RECEIVABLE")), overdue.filter(ofKind("RECEIVABLE"))),
        payable: sideFrom(open.filter(ofKind("PAYABLE")), overdue.filter(ofKind("PAYABLE"))),
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
    async documents({ kind, overdueOnly = false, limit = MONEY_PAGE_LIMIT, now }) {
      const rows = (await prisma.erpDocument.findMany({
        where: {
          ...(kind === undefined ? {} : { kind }),
          ...(overdueOnly ? overdueWhere(now) : OPEN),
        },
        orderBy: [{ dueAt: "asc" }, { externalId: "asc" }],
        take: Math.min(limit, MONEY_PAGE_LIMIT),
      })) as unknown as DocumentRow[];
      return rows.map((row) => toView(row, now));
    },
  };
}
