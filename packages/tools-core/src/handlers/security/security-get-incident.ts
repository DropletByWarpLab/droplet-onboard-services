/**
 * WARP-2979 (ADR-059 P4 §6.12.3) — `security_get_incident`: one incident the
 * person may see, by id — its reasons with their evidence, its events, and
 * when it was acknowledged or resolved (never by whom).
 *
 * Read-only (§6.12.4): GET A2 only. Missing and hidden are the same answer
 * (INCIDENT_NOT_FOUND). See ./common.ts.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { checkArgs, invalidArgs, isUuid, securityGet } from "./common.js";

const inputSchema = {
  type: "object",
  properties: {
    incident_id: { type: "string", description: "id from security_list_incidents" },
  },
  required: ["incident_id"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { incident_id: id, ...rest } = args;
  const checked = checkArgs(rest, {});
  if (!checked.ok) return checked.result;
  if (!isUuid(id)) return invalidArgs("incident_id must be an incident id from security_list_incidents");
  return securityGet(
    () =>
      ctx.http.orchestrator.get(`/api/security/assistant/incidents/${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
        signal: ctx.signal,
      }),
    "security_incident",
    ["incident"],
  );
}

const tool: Tool = {
  name: "security_get_incident",
  description:
    "One Security incident by id: the reasons Droplet flagged it (these are what is true), the events behind it with local times, and whether it was acknowledged or resolved. Never name or guess who a person was; Droplet does not know. Events are kept 30 days; the reasons stay for a year.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
