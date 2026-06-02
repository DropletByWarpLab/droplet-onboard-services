import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const PROTOS = ["tcp", "udp", "tcpudp"] as const;

const inputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Friendly name for the port forward rule." },
    src_port: { type: "string", description: "External port number to forward (1-65535)." },
    dest_ip: { type: "string", description: "Internal IPv4/IPv6 address of the destination device." },
    dest_port: { type: "string", description: "Internal port on the destination device (1-65535)." },
    proto: {
      type: "string",
      enum: PROTOS,
      description: "Protocol: 'tcp', 'udp', or 'tcpudp'. Defaults to 'tcp'.",
    },
  },
  required: ["name", "src_port", "dest_ip", "dest_port"],
  additionalProperties: false,
} as const;

/** A TCP/UDP port is an integer 1-65535 (port 0 is reserved/invalid for a
 *  forward). Accept the canonical decimal form only — no leading zeros,
 *  signs, or whitespace — so we don't forward something OpenWrt's uci layer
 *  would silently coerce. */
function isValidPort(v: string): boolean {
  if (!/^[1-9][0-9]*$/.test(v)) return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** Minimal IPv4/IPv6 literal check. IPv4: four 0-255 octets. IPv6: a hextet
 *  form (full or `::`-compressed). This is a boundary fail-fast guard — the
 *  routing service remains the authority — so we keep it permissive enough
 *  to accept any real address but reject obvious garbage / hostnames. */
function isValidIp(v: string): boolean {
  // IPv4
  const v4 = v.split(".");
  if (v4.length === 4) {
    return v4.every((o) => /^[0-9]{1,3}$/.test(o) && Number(o) <= 255);
  }
  // IPv6 (incl. ::-compression and optional IPv4-mapped tail). Conservative.
  return /^(([0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|:(:[0-9a-fA-F]{1,4}){1,7}|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|::)$/.test(
    v,
  );
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
    return invalid("src_port must be an integer between 1 and 65535");
  }
  if (!isValidPort(args.dest_port as string)) {
    return invalid("dest_port must be an integer between 1 and 65535");
  }
  if (!isValidIp(args.dest_ip as string)) {
    return invalid("dest_ip must be a valid IPv4 or IPv6 address");
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
  const res = await ctx.http.routing.post("/firewall/port-forward", body);
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "PORT_FORWARD_FAILED", message: `routing returned ${res.status}` },
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
  handler,
};

export default tool;
