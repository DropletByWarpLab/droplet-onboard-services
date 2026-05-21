import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    ip: {
      type: "string",
      description:
        "Camera IP address on the camera subnet (e.g. 192.168.20.176). Required.",
    },
    username: {
      type: "string",
      description:
        "Admin username to set on the camera. Optional; falls back to CAMERA_DEFAULT_USERNAME on the service (default 'admin').",
    },
    password: {
      type: "string",
      description:
        "Admin password to set on the camera. Optional; falls back to CAMERA_DEFAULT_PASSWORD on the service. Strongly recommend leaving as the env default so the credential never round-trips through the LLM context.",
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

  const body: Record<string, unknown> = {};
  if (typeof args.username === "string" && args.username.trim()) body.username = args.username.trim();
  if (typeof args.password === "string" && args.password) body.password = args.password;

  const res = await ctx.http.cameras.post(
    `/cameras/${encodeURIComponent(ip)}/initialize`,
    body,
  );
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "INIT_FAILED",
        message:
          typeof payload === "object" && payload && "message" in payload && typeof (payload as Record<string, unknown>).message === "string"
            ? ((payload as Record<string, unknown>).message as string)
            : `camera-discovery returned ${res.status}`,
        details: payload,
      },
    };
  }
  return { ok: true, data: payload };
}

const tool: Tool = {
  name: "initialize_camera",
  description:
    "Run the vendor-specific first-run admin-password flow against a fresh IP camera. Required for cameras (e.g. Hanwha Wisenet) that ship in an uninitialised state and reject normal admin requests until the password is set. Pass only `ip`; the service uses CAMERA_DEFAULT_PASSWORD from env unless you override. Tier-2 destructive: requires operator confirmation in the dashboard.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
