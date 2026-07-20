/**
 * WARP-1450 — `get_drive_health` LLM tool.
 *
 * SMART health + temperature per data drive, read from the orchestrator's
 * `GET /api/storage/drives` — the same WARP-1144-corrected source of truth
 * `list_drives` uses (the device-bridge snapshot filtered to real data
 * drives, joined with the customer-chosen labels). The device-bridge
 * attaches `smart` ("PASSED"/"FAILED") and `temp_c` per drive ONLY when
 * `DRIVE_SMART_ENABLED` is set on the bridge (WARP-612); the fields are
 * null/absent otherwise.
 *
 * SMART-off is NOT a failure: when every drive lacks the enrichment the
 * tool still succeeds with `smartEnabled: false` plus a hint naming the
 * knob — the appliance is healthy-unknown, not broken. Any drive whose
 * SMART self-assessment reads FAILED raises a top-level `warning` so the
 * agent leads with it. Tier-1 read — no writes, no confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

const SMART_DISABLED_HINT =
  "SMART monitoring is disabled — set DRIVE_SMART_ENABLED=1 on the device bridge";

/** The /api/storage/drives fields this tool reads (DriveWithLabel subset —
 *  apps/orchestrator/src/routes/storage.ts). */
interface DriveRow {
  device: string;
  mount: string;
  label: string;
  size_bytes: number;
  used_bytes: number;
  free_bytes: number;
  displayName: string | null;
  smart?: string | null;
  temp_c?: number | null;
}

function drivesUnavailable(detail: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: "DRIVES_UNAVAILABLE",
      message: `drive health is not available — ${detail}`,
    },
  };
}

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  let res: Response;
  try {
    res = await ctx.http.orchestrator.get("/api/storage/drives", {
      headers: { Accept: "application/json" },
    });
  } catch {
    // Never leak undici's raw "fetch failed" into chat (same lesson as
    // WARP-1144's list_drives fix).
    return drivesUnavailable("the storage service is unreachable");
  }
  if (!res.ok) {
    return drivesUnavailable(`storage service returned ${res.status}`);
  }
  const payload = (await res.json()) as { drives?: unknown };
  if (!Array.isArray(payload.drives)) {
    return drivesUnavailable("storage service returned an unexpected shape");
  }

  const drives = (payload.drives as DriveRow[]).map((d) => ({
    // Best human name: customer label (WARP-174) → filesystem label → device.
    name: d.displayName ?? (d.label || d.device),
    device: d.device,
    mount: d.mount,
    sizeBytes: d.size_bytes,
    usedBytes: d.used_bytes,
    freeBytes: d.free_bytes,
    // Normalize to the tri-state contract: only the two smartctl overall
    // verdicts pass through; anything else (absent field on an older
    // bridge, null when SMART is off or unreadable) is an explicit null.
    smart: d.smart === "PASSED" || d.smart === "FAILED" ? d.smart : null,
    tempC: typeof d.temp_c === "number" ? d.temp_c : null,
  }));

  const smartEnabled = drives.some((d) => d.smart !== null || d.tempC !== null);
  const failed = drives.filter((d) => d.smart === "FAILED");

  return {
    ok: true,
    data: {
      type: "get_drive_health",
      drives,
      smartEnabled,
      ...(failed.length > 0
        ? {
            warning: `SMART self-assessment FAILED on ${failed
              .map((d) => d.name)
              .join(", ")} — back up its data and plan a replacement`,
          }
        : {}),
      ...(smartEnabled ? {} : { hint: SMART_DISABLED_HINT }),
    },
  };
}

const tool: Tool = {
  name: "get_drive_health",
  description:
    "Drive health for every data drive on the appliance: SMART self-assessment (PASSED/FAILED) and temperature in °C per drive, plus capacity figures. SMART monitoring is OFF by default — when disabled the result says so (smartEnabled: false; enable with DRIVE_SMART_ENABLED=1 on the device bridge) and per-drive smart/tempC are null. A FAILED drive raises a top-level warning. Tier-1 read; safe to call without operator confirmation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
