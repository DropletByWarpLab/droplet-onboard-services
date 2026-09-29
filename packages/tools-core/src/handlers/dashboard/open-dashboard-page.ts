import type { DashboardNavigateAction } from "@droplet/shared-types";

import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { pageSummary, pagesFromContext } from "./context-pages.js";
import { resolveDashboardPage } from "./page-match.js";

const inputSchema = {
  type: "object",
  properties: {
    page: {
      type: "string",
      maxLength: 200,
      description:
        'Page label, path or the person\'s words.',
    },
  },
  required: ["page"],
  additionalProperties: false,
} as const;

/**
 * Resolves the page and returns it as a navigate action. The handler moves
 * nothing itself: the dashboard that sent the turn reads the action off the
 * live `tool_result` and routes there once the reply finishes, so there is
 * no box state to change and nothing to confirm.
 */
async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const reference = typeof args.page === "string" ? args.page.trim() : "";
  if (reference.length === 0 || reference.length > 200) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "page must be 1-200 characters" },
    };
  }
  const source = pagesFromContext(ctx);
  if (!source.ok) return source.result;

  const resolution = resolveDashboardPage(source.pages, reference);
  switch (resolution.kind) {
    case "match": {
      const action: DashboardNavigateAction = {
        action: "navigate",
        href: resolution.page.href,
        label: resolution.page.label,
      };
      return { ok: true, data: action };
    }
    case "ambiguous":
      return {
        ok: false,
        status: "error",
        error: {
          code: "AMBIGUOUS_PAGE",
          message:
            "More than one page fits. Ask the person which one they mean, or call again with the exact label.",
          details: { candidates: resolution.candidates.map(pageSummary) },
        },
      };
    case "none":
      return {
        ok: false,
        status: "error",
        error: {
          code: "UNKNOWN_PAGE",
          message: `No page matches "${reference}". Pick one of these and call again with its label, or tell the person it isn't in the dashboard.`,
          details: { pages: source.pages.map(pageSummary) },
        },
      };
  }
}

const tool: Tool = {
  // A literal, not OPEN_DASHBOARD_PAGE_TOOL: the TOOL_ROUTES drift gate finds
  // a handler by its `name:` literal. The handler test pins the two equal.
  name: "open_dashboard_page",
  description:
    'Take the person to a dashboard page; their screen switches when your reply finishes. Use when they ask to go to or open part of the app. Pass the label, path or their own words, never a guessed path. Reply with one short sentence linking it, e.g. "Opening [Voice](/voice)."',
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
