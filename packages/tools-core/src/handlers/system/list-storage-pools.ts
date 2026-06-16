import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

// BUG-3 / ADR-019: read-only mdadm pool inventory. Reaches the same
// device-bridge host endpoint family as list_drives (GET /pools alongside
// /drives), routed through the file-indexer HTTP client. READ-ONLY and safe
// for the AI — it answers "is my storage healthy?". Returns [] honestly when
// no array exists (never a fabricated pool). The DESTRUCTIVE pool ops are
// deliberately NOT registered as tools at all (ADR-019 D5) so the AI cannot
// create/destroy/format an array.
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.fileIndexer.get("/pools", { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "POOLS_UNAVAILABLE", message: `device-bridge returned ${res.status}` },
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
