import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const PROTOS = ["tcp", "udp", "tcpudp"] as const;

const inputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Friendly name for the port forward rule." },
    src_port: { type: "string", description: "External port number to forward (1-65535 or a lo-hi range e.g. '8000-8100')." },
    dest_ip: { type: "string", description: "Internal IPv4 address of the destination device." },
    dest_port: { type: "string", description: "Internal port on the destination device (1-65535 or a lo-hi range e.g. '8000-8100')." },
    proto: {
      type: "string",
      enum: PROTOS,
      description: "Protocol: 'tcp', 'udp', or 'tcpudp'. Defaults to 'tcp'.",
    },
  },
  required: ["name", "src_port", "dest_ip", "dest_port"],
  additionalProperties: false,
} as const;

/** A TCP/UDP port: integer 1-65535 or a lo-hi range (e.g. "8000-8100") as
 *  accepted by the routing service's PortForwardRequest schema. Accept
 *  canonical decimal form only — no leading zeros, signs, or whitespace. */
function isValidPort(v: string): boolean {
  const isInt = (s: string): boolean => {
    if (!/^[1-9][0-9]*$/.test(s)) return false;
    const n = Number(s);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  };
  const dash = v.indexOf("-");
  if (dash !== -1) {
    const lo = v.slice(0, dash);
    const hi = v.slice(dash + 1);
    return isInt(lo) && isInt(hi) && Number(lo) <= Number(hi);
  }
  return isInt(v);
}

/** IPv4 literal check: four 0-255 octets. The routing service's
 *  PortForwardRequest constrains dest_ip to IPv4 only; IPv6 inputs would
 *  pass this guard but receive an opaque 422 downstream — reject them here
 *  with a clean INVALID_ARGS instead. */
function isValidIp(v: string): boolean {
  const v4 = v.split(".");
  if (v4.length !== 4) return false;
  return v4.every((o) => /^[0-9]{1,3}$/.test(o) && Number(o) <= 255);
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const invalid = (message: string): ToolResult => ({
    ok: false,
    status: "error",
    error: { code: "INVALID_ARGS", message },
  });

  const required = ["name", "src_port", "dest_ip", "dest_port"];
  for (const k of required) {
    if (typeof args[k] !== "string" || (args[k] as string).length === 0) {
      return invalid(`${k} is required`);
    }
  }

  // Fail fast on malformed inputs rather than forwarding garbage to the
  // routing service's uci layer for it to reject opaquely.
  if (!isValidPort(args.src_port as string)) {
    return invalid("src_port must be an integer 1-65535 or a lo-hi range (e.g. '8000-8100')");
  }
  if (!isValidPort(args.dest_port as string)) {
    return invalid("dest_port must be an integer 1-65535 or a lo-hi range (e.g. '8000-8100')");
  }
  if (!isValidIp(args.dest_ip as string)) {
    return invalid("dest_ip must be a valid IPv4 address");
  }
  const proto = args.proto === undefined ? "tcp" : args.proto;
  if (typeof proto !== "string" || !(PROTOS as readonly string[]).includes(proto)) {
    return invalid("proto must be one of 'tcp', 'udp', 'tcpudp'");
  }

  const body: Record<string, string> = {
    name: args.name as string,
    src_port: args.src_port as string,
    dest_ip: args.dest_ip as string,
    dest_port: args.dest_port as string,
    proto,
  };
  const res = await ctx.http.orchestrator.post("/api/network/firewall/port-forward", body);
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "PORT_FORWARD_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "add_port_forward",
  description:
    "Add a port-forwarding rule (external port -> internal IP:port). Destructive: requires user confirmation.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  // WARP-2472 — POST /api/network/firewall/port-forward evaluates
  // `add_port_forward` as Tier 2 and answers 202 with its own
  // dashboard-redeemable token, so the route is the single gate and the
  // interceptor stands down.
  confirmationOwner: "route",
  handler,
};

export default tool;
