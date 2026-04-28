import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

// list_drives reaches a device-bridge endpoint that exposes
// /proc/mounts plus the automount state file. In the legacy orchestrator
// handler this was a direct fetch to host.docker.internal; in tools-core
// we route it through the file-indexer HTTP client (the file-indexer
// already has a host bridge for filesystem inspection).
async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.fileIndexer.get("/drives", { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "DRIVES_UNAVAILABLE", message: `device-bridge returned ${res.status}` },
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
