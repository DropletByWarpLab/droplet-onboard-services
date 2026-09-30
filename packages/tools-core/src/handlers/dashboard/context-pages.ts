import { dashboardPagesSchema, type DashboardPage } from "@droplet/shared-types";

import type { ToolContext, ToolResult } from "../../types.js";

/**
 * The caller's dashboard pages, or a refusal the model can relay.
 *
 * The list arrives from the dashboard through the orchestrator
 * (`_meta.dashboardPages`, stdio-trusted) and was validated there. It is
 * parsed again here because this is where it becomes a navigation target,
 * and a handler must not trust a shape it did not check.
 *
 * No list means the turn did not come from the web dashboard — voice, a
 * phone, an external MCP client — and there is no screen to move.
 */
export function pagesFromContext(
  ctx: ToolContext,
): { ok: true; pages: DashboardPage[] } | { ok: false; result: ToolResult } {
  const parsed = dashboardPagesSchema.safeParse(ctx.dashboardPages);
  if (parsed.success && parsed.data.length > 0) {
    return { ok: true, pages: parsed.data };
  }
  return {
    ok: false,
    result: {
      ok: false,
      status: "error",
      error: {
        code: "NAVIGATION_UNAVAILABLE",
        message:
          "Dashboard pages are only available in the Droplet web dashboard chat. Describe where the setting lives instead of giving a link.",
      },
    },
  };
}

/** The slice of a page the model needs to write a link. */
export function pageSummary(page: DashboardPage): {
  href: string;
  label: string;
  section?: string;
} {
  return {
    href: page.href,
    label: page.label,
    ...(page.section ? { section: page.section } : {}),
  };
}
