/**
 * Orchestrator-backed client for the `crm_*` tool handlers (WARP-2546).
 *
 * The transport is `callOrch` from the PM handlers, imported rather than
 * copied. It carries the WARP-887 fix — reject the race AND abort the request,
 * in that order, so a slow orchestrator does not leak a socket per tool call —
 * and a second copy of that would be a second place to get it wrong. Only the
 * error CODES differ between the two domains, and those live in `crmError`
 * below.
 *
 * Money: `amountMinor` is a decimal STRING of minor units at every hop, from
 * the Postgres BigInt to the model. It is never parsed into a number here.
 * `JSON.parse` would happily turn "9007199254740993" into 9007199254740992 —
 * off by one, silently, in a figure somebody is about to quote to a customer —
 * so nothing on this path treats it as arithmetic.
 */

import type { ToolResult } from "../../types.js";
import { callOrch, OrchPmError } from "../pm/pm-orch.js";

export { callOrch };
/** The transport error. Named for its origin; it is not PM-specific. */
export { OrchPmError as OrchError };

// ── Wire shapes the tools return ─────────────────────────────────────────────
// Deliberately a SUBSET of the orchestrator's Api* shapes: a tool result is
// read by a model with a finite context, so addresses, timestamps nobody asks
// about and internal ids are dropped. What survives is what a question about a
// customer actually needs.

export interface CrmCompanyOut {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  open_deals: number;
  contacts: number;
  /** Which upstream owns this record, when one does. */
  synced_from: string | null;
}

export interface CrmDealOut {
  id: string;
  title: string;
  company: string | null;
  stage: string;
  /** OPEN | WON | LOST — the outcome, which is never the stage NAME. */
  outcome: string;
  /** Decimal string of minor units. Never a number — see the header. */
  amount_minor: string | null;
  currency: string | null;
  expected_close: string | null;
  closed_at: string | null;
}

export interface CrmActivityOut {
  id: string;
  kind: string;
  summary: string;
  occurred_at: string;
}

interface ApiCompany {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  openDealCount: number;
  contactCount: number;
  origin: string;
  externalSystem: string | null;
}

interface ApiDeal {
  id: string;
  title: string;
  companyName: string | null;
  stage: { name: string; kind: string };
  amountMinor: string | null;
  currency: string | null;
  expectedCloseOn: string | null;
  closedAt: string | null;
}

interface ApiActivity {
  id: string;
  kind: string;
  summary: string;
  occurredAt: string;
}

export function toCompany(row: ApiCompany): CrmCompanyOut {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    industry: row.industry,
    open_deals: row.openDealCount,
    contacts: row.contactCount,
    // Reported from `origin`, not from `externalSystem != null` — the two can
    // disagree only if something is wrong, and `origin` is the explicit column.
    synced_from: row.origin === "EXTERNAL" ? row.externalSystem : null,
  };
}

export function toDeal(row: ApiDeal): CrmDealOut {
  return {
    id: row.id,
    title: row.title,
    company: row.companyName,
    stage: row.stage.name,
    outcome: row.stage.kind,
    amount_minor: row.amountMinor,
    currency: row.currency,
    expected_close: row.expectedCloseOn,
    closed_at: row.closedAt,
  };
}

export function toActivity(row: ApiActivity): CrmActivityOut {
  return { id: row.id, kind: row.kind, summary: row.summary, occurred_at: row.occurredAt };
}

/**
 * One error mapping for every `crm_*` handler.
 *
 * 404 → NOT_FOUND so the model can say "I couldn't find that customer" rather
 * than "something went wrong". 422 keeps its message, because the orchestrator's
 * 422s (`invalid_stage`, `amount_needs_currency`) name a fixable mistake and the
 * model can act on them. Everything else is CRM_API_ERROR.
 */
export function crmError(err: unknown): ToolResult {
  if (err instanceof OrchPmError) {
    const code =
      err.status === 404 ? "CRM_NOT_FOUND" : err.status === 422 ? "CRM_INVALID_REQUEST" : "CRM_API_ERROR";
    return { ok: false, status: "error", error: { code, message: err.message } };
  }
  // Not a transport error — let the agent loop see it rather than flattening
  // a programming mistake into a tidy tool failure.
  throw err;
}
