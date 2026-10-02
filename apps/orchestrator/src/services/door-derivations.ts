/**
 * ADR-055 (P4a) — the §9.7 pieces of door state the doors service reads today.
 * Pure: no clock, no I/O, no database. Only what has a caller lives here: a
 * door's position from its newest event, and what a door is able to alarm on.
 * The forced-door, held-open, relock and position-unknown derivations are not
 * built: nothing writes an event until `services/access-control/` exists, so
 * they have no caller, and the rules below are what its slice must implement.
 *
 * The rules, as the brief states them (§9.7):
 *
 *   forced door   door position open while the latch still reports extended
 *                 and no grant, no request-to-exit and no key override
 *                 preceded it. On a strike-only door (DP-1) there is no latch
 *                 term: forced degrades to the weaker "open with no preceding
 *                 grant or REX", and the row says which claim it is.
 *   held open     door position open past the door's held-open time after a
 *                 grant or REX. A key override authorises an opening (it is
 *                 not forced) but NEVER arms this: nothing granted it. The
 *                 derivation must come back with a test that pins it.
 *   relock        fires on door-closed + latch-extended, NOT on a timer.
 *   unknown       a door whose cell has died cannot report; when link
 *                 supervision lapses its position is UNKNOWN — never left at
 *                 "closed". NOT built, and not by the age of the last event (a
 *                 device that reports only on change would read unknown after
 *                 every close): it needs supervision data, and ships with the
 *                 supervision writer (P1 link).
 *   none          `doorPositionSource = none` gets no forced-door and no
 *                 held-open claim. An alarm the product cannot derive is not
 *                 one it advertises. (Built: `alarmClaimsFor`; the database
 *                 refuses the rows too, migration 20261002110200.)
 *
 * "Authorised" is a running fact of the event stream, not a time window: a
 * grant, REX or key override stands until the door is next secure (a relock),
 * because the brief defines relock by state, never by a timer. Whatever
 * derivation implements it therefore takes no clock. That has one honest
 * consequence, stated here so nobody discovers it later: on a strike-only door
 * a grant that is never used stays outstanding until the next time the door
 * closes, because no latch report exists there to say the strike re-secured.
 * The brief calls the strike-only claim "weaker" and requires the UI to label
 * it as such; this is part of why.
 */
import type {
  AccessEventKind,
  AccessForcedClaim,
  AccessTroubleCode,
  DoorPositionSource,
} from "@prisma/client";

// ── position ──────────────────────────────────────────────────────────────

export type DoorPosition = "open" | "closed" | "unknown" | "not_monitored";

/**
 * What a door's position is, from the newest position-bearing event on it
 * (`door_open`, `door_closed`, or the cartridge's `trouble` /
 * `position_unknown`). No event, or anything that is not a clear reading, is
 * UNKNOWN — never closed. A `none` door is not monitored, which is a
 * different answer, and the one the UI says out loud.
 */
export function positionOf(
  source: DoorPositionSource,
  latest: { kind: AccessEventKind; troubleCode: AccessTroubleCode | null } | null,
): DoorPosition {
  if (source === "none") return "not_monitored";
  if (latest === null) return "unknown";
  if (latest.kind === "door_open") return "open";
  if (latest.kind === "door_closed") return "closed";
  return "unknown";
}

/** What a door can and cannot claim, for a surface that must say which. */
export function alarmClaimsFor(source: DoorPositionSource): {
  forcedDoor: AccessForcedClaim | null;
  heldOpen: boolean;
} {
  if (source === "lock") return { forcedDoor: "latch_witnessed", heldOpen: true };
  if (source === "dp1") return { forcedDoor: "unwitnessed_open", heldOpen: true };
  return { forcedDoor: null, heldOpen: false };
}
