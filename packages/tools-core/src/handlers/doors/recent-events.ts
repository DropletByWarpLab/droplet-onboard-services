/**
 * `doors_recent_events` — what happened at the doors, newest first
 * (ADR-055 P4b, brief §11.5). Read-only: one GET, and the arguments are a door
 * id and a count — nothing a model could bend into a write.
 *
 * Absent unless the `doors` module is on (WARP-2972: the module gate works on
 * the tool's domain, see `list.ts`).
 *
 * No cursor crosses this boundary. A model asks for "recent"; handing it a
 * resumable cursor invites it to walk the whole log into its own context, and
 * a cursor beside a truncated body is the WARP-2203 defect. The result says
 * whether the list was cut short (`more_available`) and stops there.
 *
 * The result carries the page's own honesty rules: an empty list is never a
 * quiet night (a door reports only through its lock or sensor, and nothing
 * writes events on a box that has neither), and the weaker forced-door claim is
 * never worded as "forced".
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
/** The route takes a UUID and answers anything else with an opaque 400, so a wrong id is refused here, with the way out. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WireEvent {
  kind: string;
  occurredAt: string;
  doorName: string;
  forcedClaim: string | null;
  troubleCode: string | null;
}

function boundedLimit(raw: unknown): number {
  // A small local model often writes the integer as a string.
  const n = typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  let path = `/api/doors/events?limit=${boundedLimit(args.limit)}`;
  if (typeof args.door_id === "string" && args.door_id.length > 0) {
    if (!UUID.test(args.door_id)) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "DOORS_INVALID_REQUEST",
          message: "door_id must be a door's id from doors_list, not its name. Nothing was read.",
        },
      };
    }
    path += `&door=${encodeURIComponent(args.door_id)}`;
  }
  try {
    const wire = await callOrch<{ events: WireEvent[]; nextCursor: string | null }>(ctx, "get", path);
    const events = wire.events.map((e) => ({
      time: e.occurredAt,
      door: e.doorName,
      kind: e.kind,
      // Which forced-door claim a derived row makes — a lock is its own
      // witness, a strike-only door is not, and the difference is the point.
      ...(e.forcedClaim ? { claim: e.forcedClaim } : {}),
      ...(e.troubleCode ? { trouble: e.troubleCode } : {}),
    }));
    return {
      ok: true,
      data: {
        events,
        count: events.length,
        more_available: wire.nextCursor !== null,
        note:
          "Newest first; time is when the door's device says it happened. " +
          "An empty list does not mean nothing happened: a door reports only through its lock or sensor. " +
          "forced_door with claim latch_witnessed = the latch was still out when it opened; with unwitnessed_open the door has no latch report, " +
          "so say 'opened with no unlock or exit first', not 'forced'. trouble position_unknown = the door stopped reporting. " +
          "Read-only: this cannot lock, unlock or open a door.",
      },
    };
  } catch (err) {
    return doorsError(err);
  }
}

const tool: Tool = {
  name: "doors_recent_events",
  description: "Recent door events, newest first; door_id from doors_list.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
