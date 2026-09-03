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

/** Exact decimal addition on strings, so a total never meets a float. */
function addDecimal(a: string, b: string): string {
  const scale = Math.max(fractionDigits(a), fractionDigits(b));
  const sum = toScaled(a, scale) + toScaled(b, scale);
  return fromScaled(sum, scale);
}

function fractionDigits(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

function toScaled(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const bare = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = bare.split(".");
  const digits = `${whole}${fraction.padEnd(scale, "0")}`;
  const scaled = BigInt(digits === "" ? "0" : digits);
  return negative ? -scaled : scaled;
}

function fromScaled(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Is this document still owed?
 *
 * A balance of zero is settled. A NULL balance is UNKNOWN, not zero — the
 * vendor sent something this box would not guess at — and unknown counts as
 * open, because dropping a document the business may still owe is the worse
 * of the two errors.
 */
function isOpen(row: DocumentRow): boolean {
  return row.balance === null || !row.balance.isZero();
}

function isOverdue(row: DocumentRow, now: Date): boolean {
  return row.dueAt !== null && row.dueAt.getTime() < now.getTime() && isOpen(row);
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

function summariseSide(rows: readonly DocumentRow[], now: Date): MoneySide {
  const open = rows.filter(isOpen);
  const byLedger = new Map<string, MoneyLedgerTotal>();

  for (const row of open) {
    // Keyed on connection AND currency: a multi-currency ledger that does name
    // its rows must not have them added together either.
    const key = `${row.connectionId} ${row.currency ?? ""}`;
    const current = byLedger.get(key) ?? {
      connectionId: row.connectionId,
      provider: row.externalSystem,
      currency: row.currency,
      balance: "0",
      documentCount: 0,
      overdueCount: 0,
      overdueBalance: "0",
    };
    const balance = money(row.balance);
    const overdue = isOverdue(row, now);
    byLedger.set(key, {
      ...current,
      // A document whose balance could not be read still COUNTS — it is money
      // somebody owes — but contributes nothing to the figure. The count and
      // the total disagreeing is the honest signal that one is unreadable.
      balance: balance === null ? current.balance : addDecimal(current.balance, balance),
      documentCount: current.documentCount + 1,
      overdueCount: current.overdueCount + (overdue ? 1 : 0),
      overdueBalance:
        overdue && balance !== null
          ? addDecimal(current.overdueBalance, balance)
          : current.overdueBalance,
    });
  }

  const ledgers = [...byLedger.values()].sort((a, b) =>
    a.connectionId === b.connectionId
      ? (a.currency ?? "").localeCompare(b.currency ?? "")
      : a.connectionId.localeCompare(b.connectionId),
  );

  return {
    documentCount: open.length,
    overdueCount: open.filter((row) => isOverdue(row, now)).length,
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
  async function allRows(kind?: MoneyKind): Promise<DocumentRow[]> {
    return (await prisma.erpDocument.findMany({
      where: kind === undefined ? {} : { kind },
      orderBy: [{ dueAt: "asc" }, { externalId: "asc" }],
    })) as unknown as DocumentRow[];
  }

  return {
    async summary(now) {
      const rows = await allRows();
      const reads = rows.map((row) => row.lastReadAt.getTime());
      return {
        receivable: summariseSide(
          rows.filter((row) => row.kind === "RECEIVABLE"),
          now,
        ),
        payable: summariseSide(
          rows.filter((row) => row.kind === "PAYABLE"),
          now,
        ),
        // Both ends, because one number cannot describe a box whose Xero
        // connection answered this morning and whose Stripe one has been
        // failing for a week.
        lastReadAt: reads.length === 0 ? null : new Date(Math.max(...reads)).toISOString(),
        oldestReadAt: reads.length === 0 ? null : new Date(Math.min(...reads)).toISOString(),
      };
    },

    async documents({ kind, overdueOnly = false, limit = MONEY_PAGE_LIMIT, now }) {
      const rows = await allRows(kind);
      const open = rows.filter(isOpen);
      const wanted = overdueOnly ? open.filter((row) => isOverdue(row, now)) : open;
      return wanted.slice(0, Math.min(limit, MONEY_PAGE_LIMIT)).map((row) => toView(row, now));
    },
  };
}
