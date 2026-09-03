/**
 * `money_list_open_documents` — what the business is owed and what it owes
 * (WARP-2581).
 *
 * 🔴 EXCLUDED from the chat pool, and correctly RULELESS.
 * `base-prompt-budget.test.ts`'s tripwire sits 59 characters under its 60,000
 * ceiling and that assertion is the wire payload of the
 * `TOOL_SELECTION_MODE=off` rollback path, so it is not cosmetic. WARP-2547
 * owns the decision between re-baselining it and dropping a vertical suite;
 * until then this tool joins `erp`, `pm` and `switch` in
 * `EXCLUDED_FROM_CHAT_TOOLS` — reachable over MCP and `/api/money`, never
 * advertised on a chat turn. A DOMAIN_RULES entry would be a gate pointing at
 * a tool the model can never be offered.
 *
 * Money crosses this boundary as a STRING and is never parsed. `JSON.parse`
 * turns "9007199254740993" into 9007199254740992 — off by one, silently, in a
 * figure somebody is about to quote to a customer.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch } from "../pm/pm-orch.js";
import { moneyError } from "./money-orch.js";

const inputSchema = {
  type: "object",
  properties: {
    direction: {
      type: "string",
      enum: ["owed_to_us", "owed_by_us"],
      description: "Limit to invoices (owed_to_us) or bills (owed_by_us). Omit for both.",
    },
    overdue_only: {
      type: "boolean",
      description: "Only documents whose due date has passed and that are still unpaid.",
    },
  },
  required: [],
  additionalProperties: false,
} as const;

/** The subset a question about money actually needs. */
interface DocumentOut {
  document: string;
  direction: "owed_to_us" | "owed_by_us";
  counterparty: string | null;
  due: string | null;
  /** The invoiced total, as a decimal string. */
  amount: string | null;
  /** What remains UNPAID — not the same number as `amount`. */
  balance: string | null;
  /** Null means "this ledger's own currency", which the box does not know. */
  currency: string | null;
  status: string | null;
  overdue: boolean;
  source: string;
}

interface WireDocument {
  externalId: string;
  kind: "RECEIVABLE" | "PAYABLE";
  counterparty: { name: string | null; externalId: string | null };
  dueAt: string | null;
  amount: string | null;
  balance: string | null;
  currency: string | null;
  status: string | null;
  isOverdue: boolean;
  externalSystem: string;
  lastReadAt: string;
}

/**
 * When this box last read ANY of these documents.
 *
 * A timestamp the box cannot parse is dropped rather than guessed at: the only
 * freshness claim this surface may make is a true one, and `null` ("I do not
 * know when I last read") is a claim it is always entitled to.
 */
function newestRead(documents: readonly WireDocument[]): string | null {
  let newest: number | null = null;
  for (const doc of documents) {
    const ms = Date.parse(doc.lastReadAt);
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest) newest = ms;
  }
  return newest === null ? null : new Date(newest).toISOString();
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const query = new URLSearchParams();
  if (args.direction === "owed_to_us") query.set("kind", "receivable");
  if (args.direction === "owed_by_us") query.set("kind", "payable");
  if (args.overdue_only === true) query.set("overdue", "1");
  const suffix = query.toString() === "" ? "" : `?${query.toString()}`;

  try {
    const wire = await callOrch<{ documents: WireDocument[] }>(
      ctx,
      "get",
      `/api/money/documents${suffix}`,
    );
    const documents: DocumentOut[] = wire.documents.map((doc) => ({
      document: doc.externalId,
      direction: doc.kind === "RECEIVABLE" ? "owed_to_us" : "owed_by_us",
      counterparty: doc.counterparty.name ?? doc.counterparty.externalId,
      due: doc.dueAt,
      amount: doc.amount,
      balance: doc.balance,
      currency: doc.currency,
      status: doc.status,
      overdue: doc.isOverdue,
      source: doc.externalSystem,
    }));

    return {
      ok: true,
      data: {
        documents,
        // 🔴 No total. Two ledgers do not add — a document's currency is
        // usually its ledger's own, which this box does not know — and a model
        // handed a `total` field would quote it.
        count: documents.length,
        note:
          "Balances are what remains unpaid, not the invoiced total. Figures from " +
          "different ledgers are not comparable and must not be added. This is what " +
          "the box last read, not necessarily what the vendor holds now.",
        // 🔴 The NEWEST read across these rows, never `documents[0]`.
        // `/api/money/documents` orders by `dueAt asc, externalId asc`, so the
        // first row is the soonest-DUE one and its read time is arbitrary —
        // reporting it understates how recently the box read, which is the one
        // claim this whole surface is built to make precisely.
        last_read: newestRead(wire.documents),
      },
    };
  } catch (err) {
    return moneyError(err);
  }
}

const tool: Tool = {
  name: "money_list_open_documents",
  description:
    "List the invoices and bills this box has read from connected accounting systems " +
    "(Xero, QuickBooks, Stripe): who owes what, what is due and what is overdue. " +
    "Read-only — the accounting system stays the system of record. Balances are " +
    "unpaid amounts, and figures from different ledgers must never be added.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
