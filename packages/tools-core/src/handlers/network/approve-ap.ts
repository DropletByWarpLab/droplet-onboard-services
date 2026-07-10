import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

// WARP-446: approve a discovered extender AP and push the wireless
// config. Destructive — changes the household's wireless surface
// (adds a new AP serving the household SSID/PSK). Confirmation
// required.
//
// Calls the orchestrator's `/api/aps/:mac/approve` route rather than
// the routing service directly because the state machine lives in
// the orchestrator (ApDevice row, PROVISIONING / ONLINE / FAILED
// transitions, approvedBy audit column). Same pattern
// `commission_device` uses to keep the canonical state writes in one
// place.

const inputSchema = {
  type: "object",
  properties: {
    mac: {
      type: "string",
      description: "MAC address of the discovered AP to approve (e.g. AA:BB:CC:DD:EE:FF).",
    },
    ssid: {
      type: "string",
      description: "SSID the AP should serve (typically the household SSID).",
      minLength: 1,
      maxLength: 32,
    },
    encryptionKey: {
      type: "string",
      description: "WPA2/WPA3 pre-shared key. 8-63 characters.",
      minLength: 8,
      maxLength: 63,
    },
    radio: {
      type: "string",
      description: "Optional. Radio device name on the AP (default radio0 — primary 5 GHz).",
    },
    encryption: {
      type: "string",
      description: "Optional. Encryption suite. Default psk2+ccmp (WPA2-PSK AES-only).",
    },
    network: {
      type: "string",
      description: "Optional. uci network this iface attaches to. Default 'lan'.",
    },
    displayName: {
      type: "string",
      description: "Optional. Operator-friendly label (e.g. 'Upstairs'). Defaults to model + last-3-octets of MAC.",
    },
  },
  required: ["mac", "ssid", "encryptionKey"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const mac = typeof args.mac === "string" ? args.mac : null;
  const ssid = typeof args.ssid === "string" ? args.ssid : null;
  const encryptionKey = typeof args.encryptionKey === "string" ? args.encryptionKey : null;
  if (!mac || !ssid || !encryptionKey) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "INVALID_ARGS",
        message: "mac, ssid, and encryptionKey are all required",
      },
    };
  }
  const body: Record<string, string> = { ssid, encryptionKey };
  for (const k of ["radio", "encryption", "network", "displayName"] as const) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) body[k] = v;
  }
  // Percent-encode the mac: it originates from AP discovery — an
  // untrusted, network-advertised value — so its shape can't be
  // assumed; encoding prevents a crafted value from injecting extra
  // path segments. Express decodes `:mac` once, so the orchestrator
  // route still receives the original address.
  const res = await ctx.http.orchestrator.post(
    `/api/aps/${encodeURIComponent(mac)}/approve`,
    body,
  );
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "APPROVE_FAILED",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "approve_ap",
  description:
    "Approve a discovered coverage-extender AP and push the household wireless config. Destructive: changes the wireless surface and may briefly interrupt connected devices on the main AP during reload. Requires user confirmation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
