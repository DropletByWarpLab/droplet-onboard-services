import type { Tool, ToolContext, ToolResult } from "../../types.js";

/**
 * Write one point on a building device (BACnet/IP, Modbus TCP, SNMP, KNX/IP)
 * through the orchestrator's `/api/building` route.
 *
 * `requiresConfirmation` puts the generic interceptor in front of this: the
 * first call is refused with a token bound to these exact arguments and the
 * handler only runs once a human approves. The route does NOT confirm again
 * (it mints no token — WARP-2472), it audits fail-closed, and the gateway
 * re-checks the point is writable and the value in bounds.
 *
 * `value` is a string in the schema (no union types: WARP-1839's grammar
 * lesson) and is coerced here to the point's kind, read from the registry,
 * so a "21.5" for a number point goes out as 21.5 and "off" for a switch as
 * false — never as text a controller would reject or misread.
 */

const TRUE = new Set(["true", "on", "yes", "1", "open", "start"]);
const FALSE = new Set(["false", "off", "no", "0", "closed", "close", "stop"]);

type Coerced = { ok: true; value: boolean | number | string } | { ok: false; message: string };

export function coerce(kind: string, raw: unknown): Coerced {
  if (kind === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    const s = String(raw).trim().toLowerCase();
    if (TRUE.has(s)) return { ok: true, value: true };
    if (FALSE.has(s)) return { ok: true, value: false };
    return { ok: false, message: `expected on/off, got ${JSON.stringify(raw)}` };
  }
  if (kind === "number") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (typeof raw === "boolean" || String(raw).trim() === "" || !Number.isFinite(n)) {
      return { ok: false, message: `expected a number, got ${JSON.stringify(raw)}` };
    }
    return { ok: true, value: n };
  }
  return { ok: true, value: String(raw) };
}

function error(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const device = typeof args.device === "string" ? args.device : "";
  const point = typeof args.point === "string" ? args.point : "";
  if (!device || !point || args.value === undefined || args.value === null) {
    return error("INVALID_ARGS", "device, point and value are required");
  }
  const id = encodeURIComponent(device);

  const metaRes = await ctx.http.orchestrator.get(`/api/building/devices/${id}`);
  if (!metaRes.ok) {
    return error(metaRes.status === 404 ? "DEVICE_NOT_FOUND" : "DEVICE_GATEWAY_ERROR", `device ${device}: orchestrator returned ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as { points: { id: string; kind: string; writable: boolean }[] };
  const p = meta.points.find((x) => x.id === point);
  if (!p) return error("POINT_NOT_FOUND", `${device} has no point ${point}`);
  if (!p.writable) return error("READ_ONLY", `${device} ${point} is read-only`);
  const coerced = coerce(p.kind, args.value);
  if (!coerced.ok) return error("INVALID_VALUE", `${point}: ${coerced.message}`);

  const res = await ctx.http.orchestrator.post(
    `/api/building/devices/${id}/points/${encodeURIComponent(point)}/write`,
    { value: coerced.value },
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof body.error === "string" ? body.error : `orchestrator returned ${res.status}`;
    return error(res.status === 422 ? "WRITE_REJECTED" : "DEVICE_GATEWAY_ERROR", message);
  }
  if (body.applied !== true) {
    // DEVICE_GATEWAY_LIVE_WRITES is off: planned, not sent. Say so plainly.
    return { ok: true, data: { applied: false, note: "Live writes are off on this box; nothing was sent.", plan: body.plan } };
  }
  return { ok: true, data: { applied: true, readback: body.readback ?? null } };
}

const inputSchema = {
  type: "object",
  properties: {
    device: { type: "string" },
    point: { type: "string" },
    value: { type: "string", description: "Number, on/off, or text" },
  },
  required: ["device", "point", "value"],
  additionalProperties: false,
} as const;

const tool: Tool = {
  name: "set_building_point",
  description:
    "Set a writable point on a building device (e.g. a setpoint or a light) by the ids get_building_devices returns. Asks the user first; bounds are enforced.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
