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
  // WARP-2098: this handler returns the orchestrator body VERBATIM, so the
  // route's new `totals` and `system_disk` keys reach the model with no code
  // change here. The description must therefore name them — otherwise the model
  // sees an unexplained disk object and can mistake the box's install disk for
  // a data drive it may offer to erase or add to a pool.
  //
  // EVERY CHARACTER HERE IS BUDGETED. Tool descriptions are part of the chat
  // system block, and base-prompt-budget.test.ts caps the full pool at 60,000
  // chars. On stage that pool sat at 59,987 — THIRTEEN chars of headroom — so
  // naming the two new fields at any comfortable length blew the gate, and the
  // rest of this description had to be compressed to pay for them (308 -> 259
  // chars, net -49). If you add words here, run
  // `vitest run src/services/base-prompt-budget.test.ts` in apps/orchestrator
  // BEFORE pushing, and expect to have to take words out somewhere.
  description:
    "Data drives under /mnt: device, mount, label, total/used/free bytes. A pooled drive carries pool:\"<mdN>\", null if standalone. `totals` sums only these drives, never pool capacity. `system_disk` is the box's install disk, not a drive: never erase or pool it.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
