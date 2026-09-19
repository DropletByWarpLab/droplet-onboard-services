/**
 * `business_timeline` — one activity feed for any node in the business graph
 * (ADR-045 slice C).
 *
 * ## Why this is its own tool
 *
 * "What has been happening with Acme" and "what has been happening on
 * WARP-1234" are the SAME question, and before this they were answered by
 * three different mechanisms: `crm_get_customer` inlined a company timeline,
 * `crm_get_deal` inlined a deal timeline, and a work item's history was
 * reachable only through the dashboard because no `pm_*` tool served
 * `/api/pm/work-items/:id/activity` at all.
 *
 * Splitting the feed off `business_find` costs a second call on the CRM path
 * and buys three things: `business_find`'s node reads stop carrying a payload
 * most turns do not want, the PM half becomes reachable for the first time,
 * and there is ONE shape for "what happened" instead of two inline variants
 * plus a gap. Both tools sit in the `business` domain, so per-turn selection
 * advertises them together — the pairing costs no extra domain match.
 *
 * ## This is the READ half only
 *
 * Appending to a timeline is `crm_log_activity` today and
 * `business_log_activity` after ADR-045 slice D. Nothing here writes, and
 * nothing here needs a confirmation: `requiresConfirmation` implies
 * `requiresWrite` (registry.test.ts pins confirm ⇒ write), and this tool is
 * neither.
 *
 * ## Two subsystems, one order
 *
 * `/api/crm/activities` pages newest-first; `/api/pm/work-items/:id/activity`
 * is documented "oldest to newest". A merge that trusted either promise would
 * interleave them wrongly, so `orderAndCap` re-sorts on `occurred_at` and
 * caps afterwards. `limit` is therefore applied to the MERGED feed, which is
 * also the only option on the PM side — neither `listActivity` nor
 * `listComments` paginates.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import {
  businessError,
  callOrch,
  clampLimit,
  crmTimelineEntry,
  fail,
  mergePmFeed,
  orderAndCap,
  TIMELINE_ENTITIES,
  type TimelineEntity,
} from "./_graph.js";

const inputSchema = {
  type: "object",
  properties: {
    entity: {
      type: "string",
      enum: ["customer", "contact", "deal", "work_item"],
      description: "What the feed is about.",
    },
    id: { type: "string" },
    limit: { type: "number", minimum: 1, maximum: 50 },
  },
  required: ["entity", "id"],
  additionalProperties: false,
} as const;

interface Args {
  entity?: string;
  id?: string;
  limit?: number;
}

/** entity → the `subject_type` the CRM activity route expects. `project` and
 *  `pipeline` are absent from this tool's enum precisely because neither has
 *  a row here and neither has a PM feed of its own. */
const CRM_SUBJECT: Record<string, string> = {
  customer: "COMPANY",
  contact: "CONTACT",
  deal: "DEAL",
};

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const a = args as unknown as Args;

  // Server-side validation, not merely schema validation: the plain-string
  // fallback documented in `find.ts` removes the enum, and an external MCP
  // client can send anything regardless.
  const entity = a.entity as TimelineEntity;
  if (!entity || !(TIMELINE_ENTITIES as readonly string[]).includes(entity)) {
    return fail(
      "BUSINESS_INVALID_REQUEST",
      `entity must be one of ${TIMELINE_ENTITIES.join(", ")}`,
    );
  }
  const raw = a.id?.trim();
  if (!raw) return fail("BUSINESS_INVALID_REQUEST", "id is required");
  const id = encodeURIComponent(raw);
  const limit = clampLimit(a.limit, 15);

  try {
    if (entity === "work_item") {
      const [activity, comments] = await Promise.all([
        callOrch<{ activity?: Parameters<typeof mergePmFeed>[0] }>(
          ctx,
          "get",
          `/api/pm/work-items/${id}/activity`,
        ),
        callOrch<{ comments?: Parameters<typeof mergePmFeed>[1] }>(
          ctx,
          "get",
          `/api/pm/work-items/${id}/comments`,
        ),
      ]);
      const merged = mergePmFeed(activity.activity ?? [], comments.comments ?? []);
      return {
        ok: true,
        data: { entity, timeline: orderAndCap(merged, limit) },
      };
    }

    const params = new URLSearchParams({
      subject_type: CRM_SUBJECT[entity],
      subject_id: raw,
      per_page: String(limit),
    });
    const data = await callOrch<{ activities?: Parameters<typeof crmTimelineEntry>[0][] }>(
      ctx,
      "get",
      `/api/crm/activities?${params.toString()}`,
    );
    return {
      ok: true,
      data: {
        entity,
        timeline: orderAndCap((data.activities ?? []).map(crmTimelineEntry), limit),
      },
    };
  } catch (err) {
    return businessError(err, entity);
  }
}

const tool: Tool = {
  name: "business_timeline",
  description:
    "What has happened on one customer, contact, deal or work item — notes, calls, emails, stage moves, comments — newest first.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
