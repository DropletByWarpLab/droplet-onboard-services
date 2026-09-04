/**
 * ADR-045 slice C — the shared half of the two business GRAPH reads.
 *
 * `business_find` and `business_timeline` replaced ten noun-shaped tools
 * (`crm_search_customers`, `crm_get_customer`, `crm_list_deals`,
 * `crm_get_deal`, `crm_pipeline_summary`, `pm_list_workspaces`,
 * `pm_list_projects`, `pm_list_work_items`, `pm_get_work_item`,
 * `pm_search_work_items`). Two verbs over one typed graph, not ten nouns over
 * two silos — because the question a person asks is "what is going on with
 * Acme", and answering it used to need a tool from each suite plus the
 * knowledge that the two suites existed.
 *
 * ── why the dispatch calls are NOT in this file ────────────────────────────
 *
 * `tool-routes.test.ts` discovers a handler's real hops by parsing the SOURCE
 * FILE THAT DECLARES THE TOOL'S `name`, and cross-checks it against
 * `TOOL_ROUTES` in BOTH directions. A `callOrch(ctx, …)` moved in here would
 * be invisible to that parse, and the manifest would be free to claim routes
 * nothing calls (or miss routes something does). So this module owns shapes,
 * validation and error mapping; every hop stays in `find.ts` / `timeline.ts`
 * where the gate can see it. `crm-orch.ts` follows the same split.
 *
 * ── why the mappers are imported, not re-implemented ───────────────────────
 *
 * `toCompany` / `toDeal` / `toActivity` already exist in `crm-orch.ts` and
 * already carry the two decisions worth keeping: provenance is read off the
 * explicit `origin` column rather than inferred from `externalSystem != null`
 * (an IS-NULL derivation is what CLAUDE.md forbids), and `amountMinor` stays a
 * decimal STRING at every hop — `JSON.parse` turns "9007199254740993" into
 * …992, off by one, silently, in a figure somebody is about to quote to a
 * customer. Copying either would be a second place to get them wrong.
 *
 * NOTE FOR SLICE D: when the last `crm_*` tool leaves the registry, the
 * mappers move HERE — `crm-orch.ts` must not simply be deleted, or these two
 * reads lose the provenance and money rules with it.
 *
 * ── the module gate this collapse crosses ──────────────────────────────────
 *
 * `crm` and `pm` are module-gated tool domains (module-registry.ts
 * `toolDomains`), `business` is not — `access-catalog.ts`'s
 * `UNCLAIMED_DOMAINS` lists business alongside system/data/erp. So moving
 * these reads into `business` moves them OUT of the `crm`/`projects` module
 * gate at the TOOL layer. The data is still gated: `requireModuleEnabled`
 * 404s `/api/crm/*` and `/api/pm/projects*` with `{"error":"module_disabled"}`
 * when the module is off. What changes is who explains it, so
 * `businessError()` maps that 404 to its own code and a sentence naming the
 * switch. The precedent is `cloud_query_dataset`: advertising a reader that
 * can say "this box will never have that" beats leaving the model to find no
 * tool and invent an outage.
 */

import type { ToolResult } from "../../types.js";
import { callOrch, OrchPmError, toPlaneProject, toPlaneWorkItem } from "../pm/pm-orch.js";
import { toActivity, toCompany, toDeal } from "../crm/crm-orch.js";

export { callOrch, toPlaneProject };

// ── Argument vocabulary ─────────────────────────────────────────────────────

/** The `business_find` discriminator. `pipeline` is an entity, not a flag —
 *  see the tool's header for why the roll-up did not become a property. */
export const FIND_ENTITIES = [
  "customer",
  "contact",
  "deal",
  "project",
  "work_item",
  "pipeline",
] as const;
export type FindEntity = (typeof FIND_ENTITIES)[number];

/** The `business_timeline` discriminator — the nodes that HAVE a feed.
 *  `project` and `pipeline` are absent because no route serves one: PM
 *  activity is per work item, and a pipeline is a roll-up, not a node. */
export const TIMELINE_ENTITIES = ["customer", "contact", "deal", "work_item"] as const;
export type TimelineEntity = (typeof TIMELINE_ENTITIES)[number];

/** Deal outcome. The stage KIND, never the stage name — a stage called
 *  "Closed — signed" is `WON`, and no string match would say so. */
export const DEAL_STATUSES = ["OPEN", "WON", "LOST"] as const;

/**
 * Which optional arguments each entity actually honours.
 *
 * Declared as data rather than checked ad hoc in the switch, because the
 * alternative is the failure mode CLAUDE.md's "no guessing" rule exists to
 * stop: silently ignoring `idle_days` on a work-item search looks like an
 * answer and is a lie. A misused argument is refused by name, once, and the
 * agent loop fixes it on the next iteration.
 */
const HONOURED_ARGS: Record<FindEntity, ReadonlySet<string>> = {
  customer: new Set(["id", "query", "limit"]),
  contact: new Set(["id", "query", "parent_id", "limit"]),
  deal: new Set(["id", "query", "status", "parent_id", "idle_days", "limit"]),
  project: new Set(["id", "query", "limit"]),
  work_item: new Set(["id", "query", "parent_id", "limit"]),
  pipeline: new Set(["id"]),
};

/** Human-readable reason, so the refusal names the fix rather than the rule. */
const ARG_HINT: Record<string, string> = {
  status: 'status only applies to entity "deal"',
  idle_days: 'idle_days only applies to entity "deal"',
  parent_id:
    'parent_id is a customer id for entity "deal"/"contact" and a project id for entity "work_item"',
  query: "this entity has no free-text search",
};

/**
 * Refuse an argument the chosen entity cannot honour, or `null` to proceed.
 *
 * `id` is deliberately NOT rejected anywhere: every entity accepts it, and it
 * is the argument that turns a search into a node read.
 */
export function rejectMisusedArgs(
  entity: FindEntity,
  supplied: Record<string, unknown>,
): ToolResult | null {
  const honoured = HONOURED_ARGS[entity];
  for (const key of ["query", "status", "parent_id", "idle_days"]) {
    if (supplied[key] === undefined || supplied[key] === null) continue;
    if (honoured.has(key)) continue;
    return fail(
      "BUSINESS_INVALID_REQUEST",
      `${ARG_HINT[key] ?? `${key} is not accepted here`} (you asked for "${entity}")`,
    );
  }
  return null;
}

/** Normalise + validate a deal status without a schema `enum` doing it for us
 *  on the fallback path. Uppercased, because a model writes "open". */
export function normalizeStatus(raw: string | undefined): string | ToolResult | undefined {
  if (raw === undefined) return undefined;
  const up = raw.trim().toUpperCase();
  return (DEAL_STATUSES as readonly string[]).includes(up)
    ? up
    : fail("BUSINESS_INVALID_REQUEST", `status must be one of ${DEAL_STATUSES.join(", ")}`);
}

/**
 * Page size, clamped HARDER than the API's 200.
 *
 * A tool result is read by a model with a finite context; 200 customers is a
 * context flood, not an answer. Same reasoning and same numbers as the tools
 * this replaced.
 */
export function clampLimit(raw: number | undefined, fallback = 20): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.trunc(raw), 1), 50);
}

// ── Wire shapes ─────────────────────────────────────────────────────────────
// Deliberately a SUBSET of the orchestrator's Api* shapes. Addresses,
// timestamps nobody asked about and internal ids are dropped; what survives is
// what a question about the thing actually needs.

/** A deal, plus the one edge the CRM shapes already carry and `toDeal` drops:
 *  the project a won deal became. That link is the ONLY path from a customer
 *  to its delivery work — `PmProject` has no company column. */
export function toGraphDeal(row: Parameters<typeof toDeal>[0] & { projectId?: string | null }) {
  return { ...toDeal(row), project_id: row.projectId ?? null };
}

export const toGraphCompany = toCompany;

export interface ApiCrmContactRow {
  id: string;
  displayName: string;
  organization: string | null;
  jobTitle: string | null;
  titleAtCompany: string | null;
  emails: Array<{ address: string; isPrimary: boolean }>;
  phones: Array<{ number: string; isPrimary: boolean }>;
  origin: string;
  externalSystem: string | null;
  companyIds: string[];
  dealIds: string[];
}

/** One person. Primary email/phone only — a model asking "who do I call at
 *  Acme" wants the number, not the vCard. */
export function toGraphContact(row: ApiCrmContactRow) {
  return {
    id: row.id,
    name: row.displayName,
    // Role at THIS company when the listing was company-scoped, else their own
    // job title. Two different facts; the company one wins because it is the
    // one that answers "who signs at Acme".
    title: row.titleAtCompany ?? row.jobTitle,
    company: row.organization,
    email: row.emails.find((e) => e.isPrimary)?.address ?? row.emails[0]?.address ?? null,
    phone: row.phones.find((p) => p.isPrimary)?.number ?? row.phones[0]?.number ?? null,
    // Read from the explicit `origin` column, never from `externalSystem !=
    // null` — the same rule `toCompany` follows.
    synced_from: row.origin === "EXTERNAL" ? row.externalSystem : null,
    deals: row.dealIds.length,
  };
}

/** A work item. `description_html` is carried ONLY on a single-node read:
 *  twenty of them is the whole context window. */
export function toGraphWorkItem(
  row: Parameters<typeof toPlaneWorkItem>[0],
  opts: { full: boolean },
) {
  const w = toPlaneWorkItem(row);
  return opts.full
    ? w
    : {
        id: w.id,
        name: w.name,
        state: w.state,
        assignees: w.assignees,
        labels: w.labels,
        updated_at: w.updated_at,
      };
}

interface ApiStageSummary {
  stageName: string;
  kind: string;
  dealCount: number;
  /** WARP-2556 — `priced` | `mixed_currencies` | `unpriced`. */
  valuation: string;
  amountMinor: string;
  currency: string | null;
}

/**
 * One pipeline stage, rolled up. Moved verbatim from `crm_pipeline_summary`
 * (deleted in this change) so WARP-2556's fix travels with it.
 *
 * READ THE STATE, NOT THE NULL. This branched on `currency === null`, which
 * the server emitted for BOTH "several currencies, cannot sum" and "nothing
 * here is priced" — so an ordinary early-pipeline stage full of deals nobody
 * had put a number on yet was reported to the model as mixed currencies, on
 * essentially every new box, for the one question this shape exists to answer.
 */
export function toStageRollup(s: ApiStageSummary) {
  return {
    stage: s.stageName,
    outcome: s.kind,
    deals: s.dealCount,
    ...(s.valuation === "priced"
      ? { amount_minor: s.amountMinor, currency: s.currency }
      : s.valuation === "mixed_currencies"
        ? { total: null, total_note: "mixed currencies — not summed" }
        : { total: null, total_note: "no amounts entered yet" }),
  };
}

// ── Timeline ────────────────────────────────────────────────────────────────

export interface TimelineEntryOut {
  id: string;
  /** Where it came from — `crm` or `pm`. The model is reading ONE feed over
   *  two subsystems, and without this it cannot tell a stage move from a
   *  status change. */
  source: "crm" | "pm";
  kind: string;
  summary: string;
  occurred_at: string;
}

export function crmTimelineEntry(row: Parameters<typeof toActivity>[0]): TimelineEntryOut {
  const a = toActivity(row);
  return { id: a.id, source: "crm", kind: a.kind, summary: a.summary, occurred_at: a.occurred_at };
}

interface PmActivityRow {
  id: string;
  verb: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

interface PmCommentRow {
  id: string;
  commentHtml: string;
  createdAt: string;
}

/** Longest comment excerpt a timeline row carries. A feed is a list of what
 *  happened; the full text is one `business_find` away. */
const COMMENT_EXCERPT_CHARS = 240;

/**
 * Sanitized PM comment HTML → a line a model can read.
 *
 * The stored HTML has already been through `sanitizePmHtml` at the write
 * boundary, so this is a rendering step and not a security one: tags out,
 * whitespace collapsed, the five XML entities decoded, then truncated.
 */
export function commentToLine(html: string): string {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > COMMENT_EXCERPT_CHARS
    ? `${text.slice(0, COMMENT_EXCERPT_CHARS - 1)}…`
    : text;
}

/**
 * Merge a work item's activity rows and its comments into one ordered feed.
 *
 * `addComment` writes BOTH a `PmComment` and a `verb: "commented"` activity
 * row, so a naive merge reports every comment twice — once with its text and
 * once as a bare "commented". The activity row is the one that gets dropped:
 * it carries strictly less.
 */
export function mergePmFeed(
  activity: PmActivityRow[],
  comments: PmCommentRow[],
): TimelineEntryOut[] {
  const out: TimelineEntryOut[] = [];
  for (const a of activity) {
    if (a.verb === "commented") continue;
    out.push({
      id: a.id,
      source: "pm",
      kind: a.verb.toUpperCase(),
      summary: a.field
        ? `${a.field}: ${a.oldValue ?? "—"} → ${a.newValue ?? "—"}`
        : a.verb,
      occurred_at: a.createdAt,
    });
  }
  for (const c of comments) {
    out.push({
      id: c.id,
      source: "pm",
      kind: "COMMENT",
      summary: commentToLine(c.commentHtml),
      occurred_at: c.createdAt,
    });
  }
  return out;
}

/** Newest first, then capped. Sorted here rather than trusting either
 *  producer: `/api/crm/activities` pages newest-first and `/api/pm/…/activity`
 *  is documented "oldest to newest", so a merge that trusted order would
 *  interleave two different promises. */
export function orderAndCap(entries: TimelineEntryOut[], limit: number): TimelineEntryOut[] {
  return [...entries]
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0))
    .slice(0, limit);
}

// ── Errors ──────────────────────────────────────────────────────────────────

export function fail(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

/**
 * The entities whose routes sit behind the `projects` module gate. Only
 * `/api/pm/projects*` and `/api/crm/*` are `requireModuleEnabled`-guarded
 * (module-registry.ts `routePrefixes`), so the entity is enough to name the
 * switch that is off.
 */
const PROJECTS_MODULE_ENTITIES: ReadonlySet<string> = new Set(["project", "work_item", "task"]);

/**
 * One error mapping for every `business_*` verb — reads and writes alike.
 * `callOrch` throws `OrchPmError` whatever the target, so one mapper covers
 * the PM and CRM routes. `write-shared.ts` RE-EXPORTS this rather than
 * carrying a copy: the write path once shipped without the `module_disabled`
 * branch, precisely because it had its own.
 *
 * `module_disabled` is separated from an ordinary 404 on purpose. Both arrive
 * as HTTP 404, but they mean opposite things to the person asking: one is
 * "there is no such customer", the other is "this Droplet is not running the
 * CRM". Collapsing them would have the model tell an owner their customer does
 * not exist because a module toggle is off.
 *
 * 400 and 422 keep their message: the orchestrator's 422s (`invalid_stage`,
 * `amount_needs_currency`, `invalid_state`) and zod's 400s name a fixable
 * mistake and the model can act on it.
 */
export function businessError(err: unknown, entity: string): ToolResult {
  if (err instanceof OrchPmError) {
    if (err.message === "module_disabled") {
      const mod = PROJECTS_MODULE_ENTITIES.has(entity) ? "Projects" : "CRM";
      return fail(
        "BUSINESS_MODULE_OFF",
        `The ${mod} module is switched off on this Droplet, so that record cannot be reached. It can be turned on in Settings.`,
      );
    }
    const code =
      err.status === 404
        ? "BUSINESS_NOT_FOUND"
        : err.status === 400 || err.status === 422
          ? "BUSINESS_INVALID_REQUEST"
          : "BUSINESS_API_ERROR";
    return fail(code, err.message);
  }
  // Not a transport error — let the agent loop see it rather than flattening a
  // programming mistake into a tidy tool failure.
  throw err;
}
