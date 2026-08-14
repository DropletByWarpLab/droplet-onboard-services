import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Camera id from list_discovered_cameras." },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const id = typeof args.id === "string" ? args.id : null;
  if (!id) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "id is required" },
    };
  }
  // WARP-1847: route through the orchestrator, matching list_discovered_cameras.
  // Flipping `enabled` in Postgres directly cannot adopt a camera that only
  // camera-discovery knows about: that service holds the probed RTSP URL, and it
  // verifies the stream before writing it into Frigate. A live candidate's id is
  // `mac:<MAC>`, which has no Prisma row to update at all — the old direct
  // update would just throw "record not found".
  const res = await ctx.http.orchestrator.post(
    `/api/cameras/discovered/${encodeURIComponent(id)}/accept`,
    undefined,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    const message =
      typeof body.error === "string"
        ? body.error
        : `orchestrator returned ${res.status}`;
    return {
      ok: false,
      status: "error",
      // 422 is the specific, actionable one: the stream didn't verify, so the
      // camera needs credentials or a vendor-specific RTSP path first.
      error: {
        code: res.status === 422 ? "CAMERA_NEEDS_CREDENTIALS" : "ACCEPT_FAILED",
        message,
      },
    };
  }
  return { ok: true, data: await res.json() };
}

const tool: Tool = {
  name: "accept_discovered_camera",
  description:
    "Accept a discovered camera into the Frigate config so it starts recording. Pass the `id` from list_discovered_cameras. A camera whose status is 'needs_credentials' will be refused until its stream can be reached — it needs a username/password or a corrected RTSP path.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
