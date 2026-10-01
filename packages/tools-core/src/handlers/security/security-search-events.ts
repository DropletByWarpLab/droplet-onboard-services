/**
 * WARP-2979 (ADR-059 P4 §6.12.3) — `security_search_events`: the Security
 * events the person may see, newest first — detections, cameras going
 * offline or back, network and sign-in warnings (owner/admin only, by the
 * route) and changes of the site mode.
 *
 * Read-only (§6.12.4): GET A3 only. A camera or area the person cannot see
 * answers exactly like one that does not exist. See ./common.ts.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { PERIOD_SPEC, SECURITY_EVENT_KIND_ARGS, SECURITY_LABEL_ARGS, SECURITY_PERIODS, checkArgs, securityGet } from "./common.js";

const LIMIT_MAX = 40;

const inputSchema = {
  type: "object",
  properties: {
    period: { type: "string", enum: SECURITY_PERIODS, description: "Or from/to" },
    from: { type: "string", description: "ISO time with offset" },
    to: { type: "string", description: "ISO time with offset; default now" },
    area: { type: "string", description: "Area name" },
    camera: { type: "string", description: "Camera name" },
    label: { type: "string", enum: SECURITY_LABEL_ARGS },
    kind: { type: "string", enum: SECURITY_EVENT_KIND_ARGS },
    limit: { type: "integer", description: `1-${LIMIT_MAX}, default 20` },
    cursor: { type: "string", description: "nextCursor of the last page" },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const checked = checkArgs(args, {
    ...PERIOD_SPEC,
    area: { kind: "string", max: 60 },
    camera: { kind: "string", max: 64 },
    label: { kind: "enum", values: SECURITY_LABEL_ARGS },
    kind: { kind: "enum", values: SECURITY_EVENT_KIND_ARGS },
    limit: { kind: "int", min: 1, max: LIMIT_MAX },
    cursor: { kind: "string", max: 40 },
  });
  if (!checked.ok) return checked.result;
  return securityGet(
    () =>
      ctx.http.orchestrator.get("/api/security/assistant/events", {
        params: checked.params,
        headers: { Accept: "application/json" },
        signal: ctx.signal,
      }),
    "security_events",
    ["period", "timezone", "events", "nextCursor"],
  );
}

const tool: Tool = {
  name: "security_search_events",
  description:
    "Search the last 30 days of Security events: camera detections, cameras going offline or coming back, network or sign-in warnings and site mode changes. Filter by area, camera, label, kind and period; times are local. Use for 'was anyone in the stock room after 9?'. Droplet knows a person was seen, not who. Only covers what this person may see.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
