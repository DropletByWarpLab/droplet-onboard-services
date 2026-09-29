/**
 * `doors_list` — the doors this box knows about (ADR-055 P4a, brief §11.5).
 *
 * READ-ONLY, and not by convention: this handler issues one GET and takes no
 * argument at all, so there is nothing a model could pass to make it do
 * anything else. §11.5: the assistant never opens a door, issues a credential
 * or changes a grant, and no confirmation-token flow makes that acceptable.
 *
 * Excluded from the default chat pool (chat-tool-scope.ts): the module ships
 * dark and module gating does not yet reach the chat pool for an owner. Still
 * reachable over MCP and `/api/doors`.
 *
 * The description is a few words on purpose: the registry has ~500 chars of
 * headroom left and `base-prompt-budget.test.ts` is not to be raised to make
 * room. The caveats a model would get wrong live in the RESULT, where they
 * cost nothing until a door is asked about.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch } from "../pm/pm-orch.js";
import { doorsError } from "./doors-orch.js";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

interface WireDoor {
  id: string;
  name: string;
  position: "open" | "closed" | "unknown" | "not_monitored";
  claims: { forcedDoor: "latch_witnessed" | "unwitnessed_open" | null; heldOpen: boolean };
}

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const wire = await callOrch<{ doors: WireDoor[] }>(ctx, "get", "/api/doors");
    const doors = wire.doors.map((d) => ({
      id: d.id,
      name: d.name,
      position: d.position,
      // What this door is able to alarm on. `null` / `false` means it CANNOT —
      // a door with no position source has no forced-door or held-open claim.
      alarms: { forced_door: d.claims.forcedDoor, held_open: d.claims.heldOpen },
    }));
    return {
      ok: true,
      data: {
        doors,
        count: doors.length,
        note:
          "position 'unknown' means the door has not reported recently — never read it as closed. " +
          "'not_monitored' means it has no position sensor, so it raises no forced-door or held-open alarm. " +
          "This tool is read-only: it cannot lock, unlock or open any door.",
      },
    };
  } catch (err) {
    return doorsError(err);
  }
}

const tool: Tool = {
  name: "doors_list",
  description: "List doors: open, closed, unknown or unmonitored, and the alarms each can raise. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
