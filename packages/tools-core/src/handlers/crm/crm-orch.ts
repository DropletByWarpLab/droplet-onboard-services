/**
 * CRM wire shapes for the business graph (WARP-2546, then ADR-045).
 *
 * This file was the client for seven `crm_*` handlers. ADR-045 slices C and D
 * collapsed those into the `business_*` verbs, and what survives here is what
 * `handlers/business/_graph.ts` imports: the three mappers below and the two
 * rules they encode. Error mapping went with the handlers — `businessError`
 * in `_graph.ts` is the one entry point now, and unlike the `crmError` that
 * used to live here it can tell a switched-off module from a missing record.
 * There is no transport re-export either: the graph imports `callOrch` from
 * `../pm/pm-orch.js` directly, where it lives.
 *
 * Provenance: `synced_from` is reported from the explicit `origin` column,
 * never inferred from `externalSystem != null` — see `toCompany`.
 *
 * Money: `amountMinor` is a decimal STRING of minor units at every hop, from
 * the Postgres BigInt to the model. It is never parsed into a number here.
 * `JSON.parse` would happily turn "9007199254740993" into 9007199254740992 —
 * off by one, silently, in a figure somebody is about to quote to a customer —
 * so nothing on this path treats it as arithmetic.
 */

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
