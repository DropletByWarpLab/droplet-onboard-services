/**
 * WARP-2979 (ADR-059 P4 §6.12.3) — `security_zone_status`: Security right
 * now — whether the site is open, closed or away and why (never who set it),
 * and for each area the person can see, what covers it and whether it is
 * reporting.
 *
 * Read-only (§6.12.4): GET A4 only. See ./common.ts.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { checkArgs, securityGet } from "./common.js";

const inputSchema = {
  type: "object",
  properties: {
    area: { type: "string", description: "Area name; default all" },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const checked = checkArgs(args, { area: { kind: "string", max: 60 } });
  if (!checked.ok) return checked.result;
  return securityGet(
    () =>
      ctx.http.orchestrator.get("/api/security/assistant/areas", {
        params: checked.params,
        headers: { Accept: "application/json" },
        signal: ctx.signal,
      }),
    "security_areas",
    ["site", "areas", "moreAreas", "suggestionsWaiting"],
  );
}

const tool: Tool = {
  name: "security_zone_status",
  description:
    "Security right now: whether the site is open, closed or away and why, and for each area the cameras and parts of camera views that cover it, whether each is reporting, whether a person or Droplet linked it, and the last activity. Use for 'is the back door covered?' or 'is any camera offline?'.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
