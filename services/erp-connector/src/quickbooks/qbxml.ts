/**
 * WARP-2108 — qbXML: the request documents we hand the Web Connector, and the
 * response documents it hands back.
 *
 * qbXML is QuickBooks Desktop's native request format. It is not a transport:
 * the Web Connector carries it, and this module only decides WHAT is asked and
 * what the answer means — the same separation the SQL track keeps between its
 * read registry and the bridge that executes statements. There is therefore
 * exactly one definition of what "an open bill" is per product, not one per
 * transport.
 *
 * PURE: no I/O, no clock.
 */
import { childrenNamed, escapeXml, parseXml, textAt, type XmlElement } from "./xml.js";
import { roundCents } from "../api-dto.js";

/**
 * qbXML spec version we request.
 *
 * Pinned, and low deliberately. Every supported QuickBooks Desktop release
 * understands 13.0, and the fields this integration reads (RefNumber, TxnDate,
 * DueDate, the ref names, the open-amount fields) have been stable across it.
 * Asking for a newer spec than the installed QuickBooks supports fails the
 * whole session rather than degrading, so the conservative pin is the one that
 * connects at the most sites.
 */
export const QBXML_VERSION = "13.0";

/** The entity queries this integration issues, in the order a session runs. */
export const QBXML_STEPS = ["invoice", "bill"] as const;
export type QbxmlStep = (typeof QBXML_STEPS)[number];

/**
 * Build the request document for one step.
 *
 * `IncludeLineItems` is false on both: line items multiply the response size by
 * the number of lines per document and this integration reads none of them.
 * That matters more here than it looks — the Web Connector holds QuickBooks
 * single-threaded while a session runs, so an oversized response is time the
 * front desk cannot use their own software.
 */
export function buildRequest(step: QbxmlStep, requestId = "1"): string {
  const rq =
    step === "invoice"
      ? `<InvoiceQueryRq requestID="${escapeXml(requestId)}"><IncludeLineItems>false</IncludeLineItems></InvoiceQueryRq>`
      : `<BillQueryRq requestID="${escapeXml(requestId)}"><IncludeLineItems>false</IncludeLineItems></BillQueryRq>`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<?qbxml version="${QBXML_VERSION}"?>` +
    `<QBXML><QBXMLMsgsRq onError="stopOnError">${rq}</QBXMLMsgsRq></QBXML>`
  );
}

/** A qbXML response that reported a failure. Distinct from a parse failure:
 *  QuickBooks understood us and said no, which is actionable differently. */
export class QbxmlStatusError extends Error {
  readonly code = "QBXML_STATUS";
  constructor(readonly statusCode: string, readonly statusMessage: string) {
    super(`QuickBooks rejected the request (status ${statusCode}): ${statusMessage}`);
    this.name = "QbxmlStatusError";
  }
}

/**
 * Total the money fields that make up a document's face value.
 *
 * `undefined` when NONE of them is present, so an absent amount stays
 * distinguishable from a zero one — but a present field plus a missing sibling
 * (an untaxed invoice has no `SalesTaxTotal`) totals what is there rather than
 * collapsing to undefined.
 */
function sumFields(row: XmlElement, fields: readonly string[]): number | undefined {
  let total: number | undefined;
  for (const field of fields) {
    const value = money(textAt(row, field));
    if (value === undefined) continue;
    total = (total ?? 0) + value;
  }
  return total === undefined ? undefined : roundCents(total);
}

/** Money as QuickBooks prints it in qbXML: a plain decimal string, with
 *  thousands separators tolerated. The gate keeps that sentence true — bare
 *  `Number()` also accepted hex ("0x10") and exponent ("1e3") forms
 *  QuickBooks never prints, reading malformed data as a plausible amount. */
function money(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const plain = raw.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(plain)) return undefined;
  return Number(plain);
}

/** qbXML dates are `YYYY-MM-DD`; the canonical form is a full ISO instant, and
 *  every other track produces UTC midnight for a date-only value. */
function date(raw: string | undefined): string | undefined {
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  return `${raw}T00:00:00.000Z`;
}

/** A `*Ref` element carries both an opaque ListID and a FullName. The name is
 *  what a person reading "who do we owe" needs; the id is useless in an answer.
 *  Falls back to the id so a ref with a missing name is still identifiable. */
function refName(row: XmlElement, refElement: string): string | undefined {
  return textAt(row, `${refElement}.FullName`) ?? textAt(row, `${refElement}.ListID`);
}

/**
 * The response element names, per step.
 *
 * `BalanceRemaining` (invoices) and `OpenAmount` (bills) are the OUTSTANDING
 * figures. QuickBooks also prints `Subtotal` / `AmountDue`, which are the
 * ORIGINAL document totals — summing those instead would overstate what is owed
 * by the full value of every part-paid document, and would look entirely
 * plausible while doing it.
 */
const SHAPE = {
  invoice: {
    responseElement: "InvoiceQueryRs",
    rowElement: "InvoiceRet",
    idColumn: "invoice_id",
    partyColumn: "customer_id",
    refElement: "CustomerRef",
    // ⚠ `Subtotal` is the PRE-TAX line total, not the document total. Reading
    // it as `amount` understated a taxed invoice by the whole tax line, and —
    // worse — disagreed with the other two tracks for the same invoice: QBO
    // reports `TotalAmt` and an exported report's `Amount` column, both of
    // which include tax. The document total is Subtotal + SalesTaxTotal.
    amountFields: ["Subtotal", "SalesTaxTotal"],
    balanceField: "BalanceRemaining",
  },
  bill: {
    responseElement: "BillQueryRs",
    rowElement: "BillRet",
    idColumn: "bill_id",
    partyColumn: "vendor_id",
    refElement: "VendorRef",
    // A bill's `AmountDue` IS the document total; QuickBooks carries vendor tax
    // in the line items rather than a sibling total field.
    amountFields: ["AmountDue"],
    balanceField: "OpenAmount",
  },
} as const;

/**
 * Parse a qbXML response into canonical rows for the step's dataset.
 *
 * Throws {@link QbxmlStatusError} when QuickBooks reported a failure, so a
 * session never ingests a partial or error response as though it were data —
 * the failure mode that would silently understate what a practice owes.
 */
export function parseResponse(step: QbxmlStep, xml: string): Record<string, unknown>[] {
  const shape = SHAPE[step];
  const root = parseXml(xml);

  const msgs = root.name === "QBXMLMsgsRs" ? root : root.children.find((c) => c.name === "QBXMLMsgsRs");
  if (!msgs) throw new QbxmlStatusError("missing", "response carried no QBXMLMsgsRs element");

  const rs = msgs.children.find((c) => c.name === shape.responseElement);
  if (!rs) {
    throw new QbxmlStatusError("missing", `response carried no ${shape.responseElement} element`);
  }

  const statusCode = rs.attributes.statusCode ?? "";
  // 0 is success. 1 is "no matching records", which is a real, empty answer —
  // a practice with no unpaid bills is a good outcome, not a fault. Anything
  // else is a refusal and must not be read as data.
  if (statusCode !== "0" && statusCode !== "1") {
    throw new QbxmlStatusError(statusCode || "unknown", rs.attributes.statusMessage ?? "");
  }
  if (statusCode === "1") return [];

  return childrenNamed(rs, shape.rowElement).map((row) => {
    const id = textAt(row, "RefNumber") ?? textAt(row, "TxnID");
    return {
      [shape.idColumn]: id,
      issued_at: date(textAt(row, "TxnDate")),
      due_at: date(textAt(row, "DueDate")),
      [shape.partyColumn]: refName(row, shape.refElement),
      amount: sumFields(row, shape.amountFields),
      balance: money(textAt(row, shape.balanceField)),
      status: undefined as string | undefined,
      // WARP-2464 — declared canonical for `invoice`/`bill`, present-and-
      // undefined here. `InvoiceRet`/`BillRet` do carry `TimeModified`, but
      // this track does not request it yet and its shape is a full local
      // timestamp rather than the date-only cells `date()` normalizes, so
      // mapping it is its own change. Undefined is what tells a watermark to
      // fall back to its ordering key; `TxnDate` here would be a creation time
      // wearing a modification time's name.
      updated_at: undefined as string | undefined,
    };
  });
}
