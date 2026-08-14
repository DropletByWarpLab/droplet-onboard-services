import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

interface Candidate {
  id: string;
  name: string;
  ip?: string;
  mac?: string | null;
  manufacturer: string | null;
  model: string | null;
  status: string;
  hasCredentials: boolean;
  discoveredAt: string | null;
}

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // WARP-1847: route through the orchestrator instead of querying Postgres
  // directly. The old `prisma.camera.findMany({ enabled: false,
  // autoDiscovered: true })` could never match a freshly discovered camera —
  // the discovery upsert left `enabled` at its schema default of true — so this
  // tool always answered "nothing found" while camera-discovery held a live
  // pending list. GET /api/cameras/discovered is now the one place that merges
  // the live list with those DB rows, so voice, chat and the dashboard all see
  // the same cameras. Same fix class as scan_for_cameras (WARP-1462).
  const res = await ctx.http.orchestrator.get("/api/cameras/discovered", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "DISCOVERY_UNAVAILABLE",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const body = (await res.json()) as {
    cameras?: Candidate[];
    discoveryOnline?: boolean;
  };
  const cameras = Array.isArray(body.cameras) ? body.cameras : [];

  return {
    ok: true,
    data: {
      // Addresses stay out of the model's context (same redaction as
      // list_cameras) — `id` is all it needs to accept one.
      pending: cameras.slice(0, 20).map((c) => ({
        id: c.id,
        name: c.name,
        manufacturer: c.manufacturer,
        model: c.model,
        status: c.status,
        needs_credentials: c.status === "needs_credentials",
        discovered_at: c.discoveredAt,
      })),
      // Lets the model say "the scanner isn't running" rather than
      // "no cameras found", which are very different answers.
      discovery_online: body.discoveryOnline !== false,
    },
  };
}

const tool: Tool = {
  name: "list_discovered_cameras",
  description:
    "List IP cameras the camera-discovery service has found on the network but that have NOT yet been added to Frigate. Each entry has a status: 'ready' (can be added now), 'needs_credentials' (found, but the stream needs a username/password or a corrected RTSP path), or 'unverified' (something answered on a camera port but no stream is confirmed). Use accept_discovered_camera to add a 'ready' one.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
