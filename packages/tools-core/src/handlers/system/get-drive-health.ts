/**
 * WARP-1450 — `get_drive_health` LLM tool.
 *
 * SMART health + temperature per data drive, read from the orchestrator's
 * `GET /api/storage/drives` — the same WARP-1144-corrected source of truth
 * `list_drives` uses (the device-bridge snapshot filtered to real data
 * drives, joined with the customer-chosen labels). The device-bridge
 * reports explicit monitoring status alongside `smart` and `temp_c`.
 * Only an explicit disabled status warrants the enable hint; older bridges
 * with no readings remain unknown. A FAILED verdict from an available read
 * raises a top-level warning. Tier-1 read — no writes, no confirmation.
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
  smart_status?: unknown;
  temp_c?: number | null;
}

type SmartStatus = "disabled" | "available" | "unsupported" | "unavailable" | "unknown";

function smartStatus(d: DriveRow): SmartStatus {
  switch (d.smart_status) {
    case "disabled":
    case "available":
    case "unsupported":
    case "unavailable":
      return d.smart_status;
    default:
      // Before explicit status existed, a verdict or measured temperature
      // proves collection worked. Explicit unknown/invalid states still win.
      if (d.smart_status === undefined && (
        d.smart === "PASSED" || d.smart === "FAILED" ||
        (typeof d.temp_c === "number" && Number.isFinite(d.temp_c))
      )) return "available";
      return "unknown";
  }
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

  const drives = (payload.drives as DriveRow[]).map((d) => {
    const status = smartStatus(d);
    return {
      // Best human name: customer label (WARP-174) → filesystem label → device.
      name: d.displayName ?? (d.label || d.device),
      device: d.device,
      mount: d.mount,
      sizeBytes: d.size_bytes,
      usedBytes: d.used_bytes,
      freeBytes: d.free_bytes,
      smartStatus: status,
      smart: status === "available" && (d.smart === "PASSED" || d.smart === "FAILED") ? d.smart : null,
      tempC: status === "available" && typeof d.temp_c === "number" && Number.isFinite(d.temp_c) ? d.temp_c : null,
    };
  });

  const smartEnabled = drives.some((d) => ["available", "unsupported", "unavailable"].includes(d.smartStatus))
    ? true
    : drives.length > 0 && drives.every((d) => d.smartStatus === "disabled") ? false : null;
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
      ...(smartEnabled === false ? { hint: SMART_DISABLED_HINT } : {}),
    },
  };
}

const tool: Tool = {
  name: "get_drive_health",
  description:
    "Drive capacity, SMART PASSED/FAILED, °C temperature and smartStatus (available/disabled/unsupported/unavailable/unknown). smartEnabled: true if enabled, false only if all drives disabled, null if unknown/no drives. SMART defaults off; only disabled gets DRIVE_SMART_ENABLED=1 hint. Missing readings prove neither health nor disablement. Available FAILED raises a warning.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
