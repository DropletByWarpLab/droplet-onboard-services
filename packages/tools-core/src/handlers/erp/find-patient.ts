import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { erpNotConnected } from "./_erp.js";

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description: "Patient search term (last-name prefix).",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

async function handler(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  // WARP-1094: DB-independent slice — no DB access; the live read path lands
  // in WARP-1095+ once the connector's copy-DB-gated phase ships.
  return erpNotConnected();
}

const tool: Tool = {
  name: "erp_find_patient",
  description:
    "Search patients in the connected ERP (Eaglesoft) by name, returning minimum-necessary " +
    "fields. Read-only. Not live yet — returns ERP_NOT_CONNECTED until the integration " +
    "ships (WARP-1095+).",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
