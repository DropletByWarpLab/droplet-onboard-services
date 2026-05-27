import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    ip: {
      type: "string",
      description:
        "Camera IP address on the camera subnet (e.g. 192.168.20.176). Get from list_discovered_cameras or a smart-port event.",
    },
  },
  required: ["ip"],
  additionalProperties: false,
} as const;

function isValidIp(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const ip = typeof args.ip === "string" ? args.ip.trim() : null;
  if (!ip || !isValidIp(ip)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "ip must be a dotted IPv4 address" },
    };
  }

  const res = await ctx.http.cameras.get(`/cameras/${encodeURIComponent(ip)}/init-status`);
  if (res.status === 404) {
    // camera-discovery's vendor_init.check_status returns None for BOTH
    // "no vendor matched" AND "probe failed transiently" (connection
    // refused, timeout). A Hanwha that's still booting (10–30 s
    // post-PoE) presents the same 404 as a brand-X camera that's
    // genuinely not a known vendor. Don't collapse the two states into
    // `needs_initialization=false` — that would tell the smart-port
    // agent to silently adopt the camera with its factory-default
    // password. Return `null` with `ambiguous=true` so the agent
    // re-scans or surfaces to the operator instead.
    return {
      ok: true,
      data: {
        ip,
        vendor: null,
        initialized: null,
        needs_initialization: null,
        ambiguous: true,
        details:
          "init-status returned 404 — could be (a) genuinely-unknown vendor, or (b) a known vendor whose first-run probe timed out / got connection-refused. Re-scan or ask the operator before adopting.",
      },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "INIT_STATUS_FAILED", message: `camera-discovery returned ${res.status}` },
    };
  }
  return { ok: true, data: await res.json() };
}

const tool: Tool = {
  name: "get_camera_init_status",
  description:
    "Check whether an IP camera at the given LAN address needs its first-run admin password set. Returns {vendor, initialized, needs_initialization, details}. Returns initialized=null when the camera does not advertise a vendor-specific init flow (treat as 'already initialized or unsupported'). Tier-1 read; safe to call without operator confirmation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
