import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { erpNotConnected } from "./_erp.js";

const inputSchema = {
  type: "object",
  properties: {
    date: {
      type: "string",
      description: "ISO date (YYYY-MM-DD) for the schedule. Defaults to today.",
    },
  },
  required: [],
  additionalProperties: false,
} as const;

async function handler(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  // WARP-1094: DB-independent slice — no DB access; the live read path lands
  // in WARP-1095+ once the connector's copy-DB-gated phase ships.
  return erpNotConnected();
}

const tool: Tool = {
  name: "erp_get_schedule_today",
  description:
    "Get the practice's appointment schedule for a day (defaults to today) from the " +
    "connected ERP (Eaglesoft). Read-only. Not live yet — returns ERP_NOT_CONNECTED " +
    "until the integration ships (WARP-1095+).",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
