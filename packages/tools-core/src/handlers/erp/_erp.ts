import type { ToolResult } from "../../types.js";

/**
 * WARP-1094 — shared ERP-tool helper.
 *
 * In this DB-independent slice every ERP tool returns the SAME typed
 * not-connected result. The live read/write paths (through the orchestrator's
 * erp.service → the erp-connector sidecar) land in WARP-1095+, once a copy of
 * PattersonPM.db + the SAP SQL Anywhere client are available. Handlers do NO
 * database access here (brief §17 Phase 0 is DB-independent).
 */
export const ERP_NOT_CONNECTED_CODE = "ERP_NOT_CONNECTED" as const;

/** The single typed result every ERP tool returns until the connector ships. */
export function erpNotConnected(): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: ERP_NOT_CONNECTED_CODE,
      message:
        "ERP not connected yet — the Eaglesoft integration is not live. " +
        "The read/write paths ship in WARP-1095+ (needs a copy of PattersonPM.db " +
        "and the SAP SQL Anywhere client).",
    },
  };
}
