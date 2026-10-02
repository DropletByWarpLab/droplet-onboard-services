/**
 * WARP-2979 (ADR-059 P4 §6.12.3) — `security_zone_status`: Security right
 * now — whether the site is open, closed or away and why (never who set it),
 * and for each area the person can see, what covers it and whether it is
 * reporting.
 *
 * WARP-3194 — A4 fits its answer under the tool-result cap; `nextOffset` is
 * where the next page starts among the areas THIS person can see (so it
 * counts no hidden area), and `offset` asks for it.
 *
 * Read-only (§6.12.4): GET A4 only. See ./common.ts.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { checkArgs, securityGet } from "./common.js";

/** The orchestrator's SECURITY_ZONE_ACTIVE_LIMIT: past it no page exists, and A4 refuses the offset. */
const OFFSET_MAX = 64;

const inputSchema = {
  type: "object",
  properties: {
    area: { type: "string", description: "Area name; default all" },
    offset: { type: "integer", description: "nextOffset of the last page" },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const checked = checkArgs(args, { area: { kind: "string", max: 60 }, offset: { kind: "int", min: 0, max: OFFSET_MAX } });
  if (!checked.ok) return checked.result;
  return securityGet(
    () =>
      ctx.http.orchestrator.get("/api/security/assistant/areas", {
        params: checked.params,
        headers: { Accept: "application/json" },
        signal: ctx.signal,
      }),
    "security_areas",
    ["site", "areas", "moreAreas", "nextOffset", "suggestionsWaiting"],
  );
}

const tool: Tool = {
  name: "security_zone_status",
  description:
    "Security right now: whether the site is open, closed or away and why, and for each area the cameras, parts of camera views and door locks that cover it, whether each is reporting, whether a person or Droplet linked it, and the last activity. Use for 'is the back door covered?' or 'is any camera offline?'.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
