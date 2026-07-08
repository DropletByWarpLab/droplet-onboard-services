import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { erpNotConnected } from "./_erp.js";

const inputSchema = {
  type: "object",
  properties: {
    patient_id: { type: "string", description: "Patient the appointment is for." },
    appt_time: { type: "string", description: "ISO datetime for the appointment start." },
    provider_id: { type: "string", description: "Provider (dentist/hygienist) id." },
    operatory_id: { type: "string", description: "Operatory / chair id." },
  },
  required: ["patient_id", "appt_time", "provider_id"],
  additionalProperties: false,
} as const;

async function handler(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  // WARP-1094: DB-independent slice — no DB access, no write. The live write
  // path lands in WARP-1095+: this Write-tier tool will STAGE an
  // ErpWriteRequest (outbox → human confirm → apply → verify, brief §11.1),
  // never writing to Eaglesoft directly.
  return erpNotConnected();
}

const tool: Tool = {
  name: "erp_schedule_appointment",
  description:
    "Schedule (create/reschedule) an appointment in the connected ERP (Eaglesoft). Requires " +
    "confirmation. Stages a write request for human approval; never writes directly. Not live " +
    "yet — returns ERP_NOT_CONNECTED until the integration ships (WARP-1095+).",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
