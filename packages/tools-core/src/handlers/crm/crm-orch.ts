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
 * the Postgres BigInt to the LAST one, and it is never parsed into a number
 * (`JSON.parse` would turn "9007199254740993" into …992 — off by one, silently,
 * in a figure somebody is about to quote to a customer). At that last hop the
 * model gets MAJOR units instead (WARP-3400): given the cents string it read
 * "1000000" as dollars and quoted a $10,000.00 deal as "USD 1,000,000".
 */
import { majorFromMinor } from "../../major-units.js";

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
  /** MAJOR units as a decimal string, e.g. "10000.00". Never a number. */
  amount: string | null;
  /** Ready to quote, e.g. "$10,000.00". */
  amount_display: string | null;
  currency: string | null;
  expected_close: string | null;
  closed_at: string | null;
  /** Which upstream owns this record, when one does. The same field
   *  `CrmCompanyOut` and the contact projection already carry — the deal was
   *  the only one of the three that dropped it (WARP-2750). */
  synced_from: string | null;
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
  // WARP-2750 — the orchestrator has always emitted both of these
  // (`dealToApi` in crm.service.ts); this interface simply never declared
  // them, so `toDeal` could not have read them if it wanted to.
  origin: string;
  externalSystem: string | null;
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
  const money = majorFromMinor(row.amountMinor, row.currency);
  return {
    id: row.id,
    title: row.title,
    company: row.companyName,
    stage: row.stage.name,
    outcome: row.stage.kind,
    amount: money?.amount ?? null,
    amount_display: money?.display ?? null,
    currency: row.currency,
    expected_close: row.expectedCloseOn,
    closed_at: row.closedAt,
    // Reported from `origin`, not from `externalSystem != null` — the two can
    // disagree only if something is wrong, and `origin` is the explicit column.
    // The same rule `toCompany` follows above.
    //
    // WARP-2750 — the deal was the ONLY one of the three graph projections
    // that dropped provenance, which is why "why is this HubSpot deal showing
    // as idle" had no answer visible anywhere in a tool result.
    synced_from: row.origin === "EXTERNAL" ? row.externalSystem : null,
  };
}

export function toActivity(row: ApiActivity): CrmActivityOut {
  return { id: row.id, kind: row.kind, summary: row.summary, occurred_at: row.occurredAt };
}
