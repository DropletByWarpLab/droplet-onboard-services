/**
 * `doors_list` — the doors this box knows about, and what each last reported
 * (ADR-055 P4b, brief §11.5).
 *
 * READ-ONLY, and not by convention: this handler issues one GET and takes no
 * argument at all, so there is nothing a model could pass to make it do
 * anything else. §11.5: the assistant never opens a door, issues a credential
 * or changes a grant, and no confirmation-token flow makes that acceptable.
 *
 * Absent unless the `doors` module is on. Nothing here checks that: module
 * gating works on the tool's DOMAIN (WARP-2972, `module-gate.ts`), so with the
 * module off or absent this tool is not in the chat pool, `/api/llm/tools` or
 * MCP at all.
 *
 * The description is a few words on purpose: `base-prompt-budget.test.ts`'s
 * full-registry tripwire is not to be raised to make room. The caveats a model
 * would get wrong live in the RESULT, where they cost nothing until a door is
 * asked about. The load-bearing one is the page's rule: a position is the
 * door's LAST report and is never offered without its time, because the box
 * does not age a report into "unknown" (that waits for link supervision), so
 * an old "closed" is still the last thing the door said.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch } from "../pm/pm-orch.js";
import { doorsError } from "./doors-orch.js";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

type WirePosition = "open" | "closed" | "unknown" | "not_monitored";

interface WireDoor {
  id: string;
  name: string;
  doorPositionSource: string;
  position: WirePosition;
  /** When the newest position report happened. `null` when none has, and for a door with no position source. */
  positionSince: string | null;
  claims: { forcedDoor: "latch_witnessed" | "unwitnessed_open" | null; heldOpen: boolean };
}

/** The wire's source names in the words the assistant says them in (`dp1` is a door sensor). */
const SOURCE_WORDS: Readonly<Record<string, string>> = { lock: "lock", dp1: "door_sensor", none: "none" };

/**
 * What a door's newest report says. An open or closed report that arrives with
 * no usable time is unknown, never current: the same rule the /doors page
 * applies, so the assistant cannot say what the page would not.
 */
function shownPosition(door: WireDoor): { position: WirePosition; since: string | null } {
  const ms = door.positionSince === null ? Number.NaN : Date.parse(door.positionSince);
  if ((door.position === "open" || door.position === "closed") && Number.isNaN(ms)) {
    return { position: "unknown", since: null };
  }
  return { position: door.position, since: Number.isNaN(ms) ? null : new Date(ms).toISOString() };
}

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const wire = await callOrch<{ doors: WireDoor[] }>(ctx, "get", "/api/doors");
    const doors = wire.doors.map((d) => {
      const { position, since } = shownPosition(d);
      return {
        id: d.id,
        name: d.name,
        position,
        since,
        position_from: SOURCE_WORDS[d.doorPositionSource] ?? d.doorPositionSource,
        // What this door is able to flag. `null` / `false` means it CANNOT: a
        // door with no position source has no forced-door or held-open claim.
        can_flag: { forced_door: d.claims.forcedDoor, held_open: d.claims.heldOpen },
      };
    });
    return {
      ok: true,
      data: {
        doors,
        count: doors.length,
        note:
          "position is the door's last report, made at `since`: always say when, never 'now' or 'currently'. " +
          "unknown: no report yet, or the door stopped reporting (`since` is when); never read it as closed. " +
          "not_monitored: nothing reports this door's position, so Droplet can't tell whether it is open or closed, forced open or left open. " +
          "can_flag.forced_door: latch_witnessed = the lock saw the latch still out; unwitnessed_open = a sensor only, so Droplet can't tell forced from not; null = nothing could tell. " +
          "Read-only: this cannot lock, unlock or open a door.",
      },
    };
  } catch (err) {
    return doorsError(err);
  }
}

const tool: Tool = {
  name: "doors_list",
  description: "List doors with last reported position and when.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
