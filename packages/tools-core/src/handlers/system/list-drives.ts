import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

// WARP-1144: reach the SAME storage source of truth the dashboard's Drives
// page uses — the orchestrator's GET /api/storage/drives (which proxies the
// host device-bridge, applies the WARP-827 data-drive filter, and joins the
// customer-chosen labels). The previous routing via ctx.http.fileIndexer was
// wrong twice over: compose never sets FILE_INDEXER_URL so the mcp-server
// client fell back to file-indexer:8000 (the indexer's HTTP server listens
// on :8090), and the file-indexer has no /drives route anyway — every call
// died as a raw "fetch failed" in chat. The orchestrator target auto-injects
// the mcp service-principal bearer (services/mcp-server/src/index.ts
// createHttpClient), same as get_system_health.
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  let res: Response;
  try {
    res = await ctx.http.orchestrator.get("/api/storage/drives", {
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
        message: "Couldn't reach the storage service — drive information is unavailable right now.",
      },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "DRIVES_UNAVAILABLE", message: `storage service returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "list_drives",
  description:
    "List every data drive mounted under /mnt on the device — NVMe partitions plus any hot-plugged USB drives. Returns device, mount point, label, total/used/free bytes.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
