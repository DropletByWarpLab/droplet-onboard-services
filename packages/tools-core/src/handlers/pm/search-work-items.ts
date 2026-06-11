import type { Tool, ToolContext, ToolResult } from "../../types.js";

import {
  listProjects,
  listWorkItems,
  PlaneApiError,
  type PlaneWorkItem,
} from "./pm-client.js";
import { mapPlaneAuthError } from "./pm-errors.js";

const inputSchema = {
  type: "object",
  properties: {
    workspace_slug: { type: "string" },
    query: { type: "string", minLength: 1 },
    per_page: { type: "number", minimum: 1, maximum: 100 },
  },
  required: ["workspace_slug", "query"],
  additionalProperties: false,
} as const;

interface Args {
  workspace_slug: string;
  query: string;
  per_page?: number;
}

const MAX_RESULTS = 100;

/** A match annotated with the owning project so the model can follow up
 *  with pm_get_work_item / pm_update_work_item, which need project_id —
 *  Plane's issue payload doesn't carry it. */
type SearchHit = PlaneWorkItem & {
  project_id: string;
  project_identifier: string;
};

/** Strip tags before matching so a query like "div" or "p" can't match
 *  every HTML description in the workspace. */
function htmlToText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

function matches(item: PlaneWorkItem, needle: string): boolean {
  if (item.name.toLowerCase().includes(needle)) return true;
  const desc = item.description_html;
  return desc !== undefined && htmlToText(desc).toLowerCase().includes(needle);
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { workspace_slug, query, per_page } = args as unknown as Args;
  const limit = Math.min(per_page ?? MAX_RESULTS, MAX_RESULTS);
  const needle = query.toLowerCase();
  try {
    // WARP-860 — Plane CE v0.24.1 has no /api/v1/workspaces/<slug>/search/
    // endpoint (live-probed 404), so workspace search is emulated over the
    // endpoints CE does expose: list the projects, then substring-filter
    // each project's work items on name + tag-stripped description.
    // Sequential with an early exit so the scan stops paging the box's
    // Plane instance as soon as `limit` matches are in hand.
    const projects = await listProjects(workspace_slug, undefined, ctx.pmApiKey);
    const work_items: SearchHit[] = [];
    for (const project of projects) {
      if (work_items.length >= limit) break;
      const items = await listWorkItems(
        workspace_slug,
        project.id,
        { perPage: MAX_RESULTS },
        ctx.pmApiKey,
      );
      for (const item of items) {
        if (work_items.length >= limit) break;
        if (matches(item, needle)) {
          work_items.push({
            ...item,
            project_id: project.id,
            project_identifier: project.identifier,
          });
        }
      }
    }
    return { ok: true, data: { work_items } };
  } catch (err) {
    const auth = mapPlaneAuthError(err);
    if (auth) return auth;
    if (err instanceof PlaneApiError) {
      // Fail closed — a partial scan would silently drop matches from the
      // projects not yet visited, so any upstream failure fails the search.
      return {
        ok: false,
        status: "error",
        error: { code: "PM_API_ERROR", message: err.message },
      };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_search_work_items",
  description:
    "Free-text search over work items in a Plane workspace, matching on name and description. " +
    "Scans up to 100 work items per project and returns up to 100 matches. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
