import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Friendly name for the port forward rule." },
    src_port: { type: "string", description: "External port number to forward." },
    dest_ip: { type: "string", description: "Internal IP address of the destination device." },
    dest_port: { type: "string", description: "Internal port on the destination device." },
    proto: { type: "string", description: "Protocol: 'tcp', 'udp', or 'tcpudp'. Defaults to 'tcp'." },
  },
  required: ["name", "src_port", "dest_ip", "dest_port"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const required = ["name", "src_port", "dest_ip", "dest_port"];
  for (const k of required) {
    if (typeof args[k] !== "string" || (args[k] as string).length === 0) {
      return {
        ok: false,
        status: "error",
        error: { code: "INVALID_ARGS", message: `${k} is required` },
      };
    }
  }
  const body: Record<string, string> = {
    name: args.name as string,
    src_port: args.src_port as string,
    dest_ip: args.dest_ip as string,
    dest_port: args.dest_port as string,
    proto: typeof args.proto === "string" ? args.proto : "tcp",
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
