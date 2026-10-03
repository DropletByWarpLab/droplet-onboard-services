/**
 * Error mapping for the `doors_*` tools (ADR-055 P4b).
 *
 * Same shape as `money-orch.ts`, and the same point: the code is the part a
 * model reasons over, so a door question that fails must not report itself as
 * a different domain's problem. `/api/doors/*` is gated by the `doors`
 * module's `routePrefixes`, so a 404 here is "this box has no doors module
 * switched on" — a whole surface that is ABSENT, not a record that is
 * missing. `DOORS_NOT_AVAILABLE` says that, and a model reading it will not
 * offer to look again. (The tools themselves are withheld while the module is
 * off, WARP-2972, so a 404 is the rare case of a toggle that landed mid-turn.)
 *
 * A 5xx is never an empty list: a failed read says `DOORS_API_ERROR`, so a
 * model cannot report "no doors" or "nothing happened" from a read that failed.
 */
import type { ToolResult } from "../../types.js";
import { OrchPmError } from "../pm/pm-orch.js";

export type DoorsErrorCode =
  /** The `doors` module is off (DOORS_ENABLED) — there are no doors on this box to read. */
  | "DOORS_NOT_AVAILABLE"
  /** The calling principal may not read doors. */
  | "DOORS_FORBIDDEN"
  /** A fixable mistake in the request; the orchestrator's message names it. */
  | "DOORS_INVALID_REQUEST"
  /** Anything else, including the 504 `callOrch` raises on its own deadline. */
  | "DOORS_API_ERROR";

export function doorsErrorCode(status: number): DoorsErrorCode {
  if (status === 404) return "DOORS_NOT_AVAILABLE";
  if (status === 403) return "DOORS_FORBIDDEN";
  if (status === 400 || status === 422) return "DOORS_INVALID_REQUEST";
  return "DOORS_API_ERROR";
}

/** One error mapping for every `doors_*` handler. */
export function doorsError(err: unknown): ToolResult {
  if (err instanceof OrchPmError) {
    return {
      ok: false,
      status: "error",
      error: { code: doorsErrorCode(err.status), message: err.message },
    };
  }
  // Not a transport error — let the agent loop see it rather than flattening a
  // programming mistake into a tidy tool failure.
  throw err;
}
