/**
 * `doors_recent_events` — what happened at the doors, newest first
 * (ADR-055 P4a, brief §11.5). Read-only: one GET, and the arguments are a door
 * id and a count — nothing a model could bend into a write.
 *
 * No cursor crosses this boundary. A model asks for "recent"; handing it a
 * resumable cursor invites it to walk the whole log into its own context, and
 * a cursor beside a truncated body is the WARP-2203 defect. The result says
 * whether the list was cut short (`more_available`) and stops there.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch } from "../pm/pm-orch.js";
import { doorsError } from "./doors-orch.js";

const inputSchema = {
  type: "object",
  properties: {
    door_id: { type: "string" },
    limit: { type: "integer" },
  },
  additionalProperties: false,
} as const;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface WireEvent {
  kind: string;
  occurredAt: string;
  doorName: string;
  forcedClaim: string | null;
  troubleCode: string | null;
}

function boundedLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  let path = `/api/doors/events?limit=${boundedLimit(args.limit)}`;
  if (typeof args.door_id === "string" && args.door_id.length > 0) {
    path += `&door=${encodeURIComponent(args.door_id)}`;
  }
  try {
    const wire = await callOrch<{ events: WireEvent[]; nextCursor: string | null }>(ctx, "get", path);
    const events = wire.events.map((e) => ({
      time: e.occurredAt,
      door: e.doorName,
      kind: e.kind,
      // Which forced-door claim a derived alarm makes — a lock is its own
      // witness, a strike-only door is not, and the difference is the point.
      ...(e.forcedClaim ? { claim: e.forcedClaim } : {}),
      ...(e.troubleCode ? { trouble: e.troubleCode } : {}),
    }));
    return {
      ok: true,
      data: { events, count: events.length, more_available: wire.nextCursor !== null },
    };
  } catch (err) {
    return doorsError(err);
  }
}

const tool: Tool = {
  name: "doors_recent_events",
  description: "Recent door events, newest first. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
