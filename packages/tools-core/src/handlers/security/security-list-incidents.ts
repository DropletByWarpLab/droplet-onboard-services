/**
 * WARP-2979 (ADR-059 P4 §6.12.3) — `security_list_incidents`: the Security
 * incidents the person the assistant acts for may see, newest first.
 *
 * Read-only (§6.12.4): GET A1 only. The orchestrator resolves the person from
 * the `X-Nextcloud-User` header the mcp-server stamps, applies DS-005 with the
 * dashboard's own projections, and builds every field (no person's name, ever).
 * See ./common.ts for the arguments and the refusals.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import {
  PERIOD_SPEC,
  SECURITY_PERIODS,
  SECURITY_SEVERITY_ARGS,
  SECURITY_STATE_ARGS,
  checkArgs,
  securityGet,
} from "./common.js";

const LIMIT_MAX = 25;

const inputSchema = {
  type: "object",
  properties: {
    period: { type: "string", enum: SECURITY_PERIODS, description: "Or from/to" },
    from: { type: "string", description: "ISO time with offset" },
    to: { type: "string", description: "ISO time with offset; default now" },
    area: { type: "string", description: "Area name" },
    severity: { type: "string", enum: SECURITY_SEVERITY_ARGS },
    state: { type: "string", enum: SECURITY_STATE_ARGS, description: "Default all" },
    limit: { type: "integer", description: `1-${LIMIT_MAX}, default 10` },
    cursor: { type: "string", description: "nextCursor of the last page" },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const checked = checkArgs(args, {
    ...PERIOD_SPEC,
    area: { kind: "string", max: 60 },
    severity: { kind: "enum", values: SECURITY_SEVERITY_ARGS },
    state: { kind: "enum", values: SECURITY_STATE_ARGS },
    limit: { kind: "int", min: 1, max: LIMIT_MAX },
    cursor: { kind: "string", max: 60 },
  });
  if (!checked.ok) return checked.result;
  return securityGet(
    () =>
      ctx.http.orchestrator.get("/api/security/assistant/incidents", {
        params: checked.params,
        headers: { Accept: "application/json" },
        signal: ctx.signal,
      }),
    "security_incidents",
    ["period", "timezone", "incidents", "nextCursor"],
  );
}

const tool: Tool = {
  name: "security_list_incidents",
  description:
    "List Security incidents, newest first: camera and network events Droplet flagged, each with its area, local times, severity (alert, notice or plain activity), reasons and whether it was acknowledged. Use for 'did anything happen last night?' or 'any alerts this week?'. Droplet knows a person was seen, never who: never name or guess anyone. Results cover only what this person may see. Droplet does not yet judge what is unusual for a place; it flags people inside after hours, cameras going offline and network or sign-in warnings.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
