/**
 * Money at rest — where an `invoice` or `bill` read from a cloud ledger becomes
 * an `ErpDocument` (WARP-2581).
 *
 * The only money in the product before this was one number: an
 * accounts-receivable tile on `/reports`, read live from the practice's server
 * every time somebody looked at it. It could not say by whom, since when, or
 * what the business OWES — and it disappeared entirely whenever that server was
 * off, because nothing was kept.
 *
 * ## 🔴 Cloud accounting tracks only
 *
 * `isCloudErpProvider` is the gate, and it is not a formality. A LAN
 * practice-management track's receivables are a PATIENT LEDGER: who owes the
 * practice money is, in a dental context, a fact about a patient. PHI on this
 * box is read-through, per connector, behind the ERP router's own `canRead`
 * (ADR-044 §3), and `account` — the dataset that carries it — is named in
 * `NEVER_LANDED_ENTITIES` for that reason. A LAN track that one day declares
 * `invoice` must not sneak the same data in through this door.
 *
 * ## Why exact decimals and not minor units
 *
 * `CrmDeal` holds minor units because a deal's currency is always known, so its
 * exponent is known. A ledger document's is not. `invoice` and `bill` are named
 * in `SINGLE_CURRENCY_LEDGER_DATASETS` — deliberately exempt from the
 * money-needs-a-currency rule, because a QuickBooks company file has ONE home
 * currency and its export carries no per-row currency column to map. Computing
 * minor units would mean assuming an exponent, and assuming 2 is wrong by a
 * factor of 100 on a yen ledger, silently, in the direction that overstates.
 *
 * So the vendor's decimal is stored exactly, in `NUMERIC(20,6)`, and the
 * consequence is carried by the service: **a total may be computed per
 * connection, never across connections.** One ledger is one currency by
 * construction; two ledgers are not.
 */
import { isCloudErpProvider } from "../erp-provider.js";

import type { LandOutcome, LandingConnection, LandingDb } from "./land.js";

/** Datasets that become `ErpDocument` rows. */
export const MONEY_ENTITIES = ["invoice", "bill"] as const;

export function landsMoney(entity: string): boolean {
  return (MONEY_ENTITIES as readonly string[]).includes(entity);
}

/** The tables a money landing touches. */
export type MoneyLandingDb = Pick<LandingDb, "crmCompany"> & {
  erpDocument: {
    updateMany(args: unknown): Promise<{ count: number }>;
    create(args: unknown): Promise<unknown>;
  };
};

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return typeof value === "object" && value !== null ? (value as Row) : null;
}

function str(row: Row, key: string): string | null {
  const value = row[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function date(row: Row, key: string): Date | null {
  const raw = str(row, key);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A plain decimal, or null.
 *
 * Deliberately NOT `Number(...)`: the value goes to Postgres as a string and is
 * held in `NUMERIC`, so it never passes through a float at all. Anything that
 * is not a plain decimal — a thousands separator, an exponent, a currency
 * symbol the vendor left attached — lands as NO amount rather than as a number
 * somebody guessed at.
 */
const DECIMAL = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

function decimal(row: Row, key: string): string | null {
  const raw = str(row, key);
  if (raw === null) return null;
  return DECIMAL.test(raw) ? raw : null;
}

const CURRENCY = /^[A-Z]{3}$/;

/**
 * The vendor's currency IF it names one per row.
 *
 * Today `invoice` and `bill` carry no such column, so this is null on every
 * shipped track — and null is a real answer here, meaning "this ledger's own
 * home currency, which the box does not know". It is read anyway because a
 * profile or a future connector may fill it, and reading a column that arrives
 * later costs nothing while ignoring it would silently discard the answer.
 */
function currency(row: Row): string | null {
  const raw = str(row, "currency");
  if (raw === null) return null;
  const code = raw.toUpperCase();
  return CURRENCY.test(code) ? code : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002"
  );
}

export async function landMoneyDocuments(
  db: MoneyLandingDb,
  args: {
    readonly connection: LandingConnection;
    readonly entity: string;
    readonly rows: readonly unknown[];
    readonly now: Date;
  },
): Promise<LandOutcome> {
  const { connection, entity, rows, now } = args;

  if (!isCloudErpProvider(connection.provider)) {
    // A LAN ledger is a patient ledger. See the header.
    return { entity, landed: 0, skipped: rows.length, reason: "not-cloud" };
  }

  const kind = entity === "invoice" ? "RECEIVABLE" : "PAYABLE";
  const idField = entity === "invoice" ? "invoice_id" : "bill_id";
  const counterpartyField = entity === "invoice" ? "customer_id" : "vendor_id";

  let landed = 0;
  let skipped = 0;

  for (const raw of rows) {
    const row = asRow(raw);
    const externalId = row === null ? null : str(row, idField);
    if (row === null || externalId === null) {
      skipped += 1;
      continue;
    }

    const counterpartyExternalId = str(row, counterpartyField);
    // Same-connection only. A HubSpot company and a QuickBooks customer are the
    // same business and different rows, and reconciling them across
    // connections is `PartyLink`'s job (WARP-2562) — matching on a bare id
    // here would attach an invoice to whoever happened to share a string.
    const company =
      counterpartyExternalId === null
        ? null
        : await db.crmCompany.findFirst({
            where: { connectionId: connection.id, externalId: counterpartyExternalId },
            select: { id: true },
          });

    const vendorOwned = {
      kind,
      issuedAt: date(row, "issued_at"),
      dueAt: date(row, "due_at"),
      counterpartyExternalId,
      companyId: company?.id ?? null,
      amount: decimal(row, "amount"),
      balance: decimal(row, "balance"),
      currency: currency(row),
      status: str(row, "status"),
      vendorUpdatedAt: date(row, "updated_at"),
      // The only freshness claim this box is entitled to make. Never "up to
      // date": Xero's modification timestamp does not fire on a due-date edit
      // or a send-to-contact, and Stripe does not guarantee event order.
      lastReadAt: now,
    };

    const updated = await db.erpDocument.updateMany({
      where: { connectionId: connection.id, kind, externalId },
      data: vendorOwned,
    });
    if (updated.count === 0) {
      try {
        await db.erpDocument.create({
          data: {
            ...vendorOwned,
            connectionId: connection.id,
            externalSystem: connection.provider,
            externalId,
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await db.erpDocument.updateMany({
          where: { connectionId: connection.id, kind, externalId },
          data: vendorOwned,
        });
      }
    }
    landed += 1;
  }

  return { entity, landed, skipped, reason: skipped > 0 ? "unidentified" : null };
}
