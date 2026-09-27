import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { pageSummary, pagesFromContext } from "./context-pages.js";
import { findDashboardPages } from "./page-match.js";

const MAX_MATCHES = 5;

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      maxLength: 200,
      description:
        'What the person is looking for, in their words — e.g. "voice settings", "wifi password", "deleted files".',
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length === 0 || query.length > 200) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "query must be 1-200 characters" },
    };
  }
  const source = pagesFromContext(ctx);
  if (!source.ok) return source.result;

  const matches = findDashboardPages(source.pages, query, MAX_MATCHES);
  if (matches.length > 0) {
    return { ok: true, data: { matches: matches.map(pageSummary) } };
  }
  // Nothing matched: hand back the whole list so the model can pick the
  // right page itself instead of inventing a path.
  return {
    ok: true,
    data: {
      matches: [],
      note: "No page matched those words. These are all the pages this person can open.",
      pages: source.pages.map(pageSummary),
    },
  };
}

const tool: Tool = {
  // A literal, not FIND_DASHBOARD_PAGE_TOOL: the TOOL_ROUTES drift gate finds
  // a handler by its `name:` literal. The handler test pins the two equal.
  name: "find_dashboard_page",
  description:
    "Look up where something lives in the Droplet dashboard and get its link. Use when the person asks where a screen or setting is, or asks for a link to it. Write the page as a markdown link using the href exactly as returned, e.g. [Voice](/voice) — never write a dashboard path you did not get from this tool. To move the person there, call open_dashboard_page instead.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
