import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

// BUG-3 / ADR-019: read-only mdadm pool inventory. WARP-1144: reach the SAME
// source of truth the dashboard uses — the orchestrator's GET
// /api/storage/pools (which proxies the host device-bridge's /proc/mdstat
// snapshot and joins the owner-chosen labels). The previous fileIndexer
// routing shared list_drives' broken URL construction (unset FILE_INDEXER_URL
// → file-indexer:8000, wrong port, and no /pools route on the indexer at
// all). READ-ONLY and safe for the AI — it answers "is my storage healthy?".
// Returns [] honestly when no array exists (never a fabricated pool). The
// DESTRUCTIVE pool ops are deliberately NOT registered as tools at all
// (ADR-019 D5) so the AI cannot create/destroy/format an array.
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  let res: Response;
  try {
    res = await ctx.http.orchestrator.get("/api/storage/pools", {
      headers: { Accept: "application/json" },
    });
  } catch {
    // Honest tool error — a network-level failure must surface as "the
    // storage service is unreachable", never as undici's raw "fetch failed".
    return {
      ok: false,
      status: "error",
      error: {
        code: "STORAGE_UNREACHABLE",
        message: "Couldn't reach the storage service — pool information is unavailable right now.",
      },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "POOLS_UNAVAILABLE", message: `storage service returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "list_storage_pools",
  description:
    "List the device's storage pools (mdadm software-RAID arrays): device, RAID level, health status (active/degraded/resyncing/failed), and member disks. Returns an empty list when no pool is configured. Read-only — use to answer 'is my storage healthy?' or 'is an array degraded?'. Cannot create, destroy, or format pools.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
