/**
 * ADR-055 (P4a) — the §9.7 door-state derivations. Pure: no clock, no I/O, no
 * database. `deriveAlarms` is the function the future access-control service
 * calls; everything else is a piece of it, exported so each rule has a test.
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
 *                 not forced) but does not start this: nothing granted it.
 *   relock        fires on door-closed + latch-extended, NOT on a timer.
 *   unknown       a door whose cell has died cannot report; on the third
 *                 missed heartbeat its position is UNKNOWN — never left at
 *                 "closed".
 *   none          `doorPositionSource = none` gets no forced-door and no
 *                 held-open claim. An alarm the product cannot derive is not
 *                 one it advertises. Every function below that could make
 *                 either claim returns "no claim" for it, first.
 *
 * "Authorised" is a running fact of the event stream, not a time window: a
 * grant, REX or key override stands until the door is next secure (a relock),
 * because the brief defines relock by state, never by a timer. The state
 * machine therefore takes no clock. That has one honest consequence, stated
 * here so nobody discovers it later: on a strike-only door a grant that is
 * never used stays outstanding until the next time the door closes, because
 * no latch report exists there to say the strike re-secured. The brief calls
 * the strike-only claim "weaker" and requires the UI to label it as such; this
 * is part of why.
 */
import type {
  AccessEventKind,
  AccessForcedClaim,
  AccessTroubleCode,
  DoorPositionSource,
} from "@prisma/client";

/** An event as the derivations need it. `id` is a BigInt column read back as a string. */
export interface DoorEventLike {
  id: string;
  kind: AccessEventKind;
  at: Date;
}

/** What a door's event stream has established so far. */
export interface DoorState {
  /** `null` until a position event has been seen. */
  open: boolean | null;
  /** `null` until the lock has reported its latch. */
  latch: "extended" | "retracted" | null;
  /** A grant, REX or (on a lock) key override stands, unspent by a relock. Keeps an opening from being forced. */
  authorized: boolean;
  /** A grant or REX stands, unspent by a relock. Only these start held-open (§9.7); a key override does not. */
  heldOpenArmed: boolean;
  /** When the current opening began. `null` unless `open`. */
  openedAt: number | null;
  /** Whether the current opening followed a grant or REX. */
  openedAuthorized: boolean;
}

export const INITIAL_DOOR_STATE: DoorState = Object.freeze({
  open: null,
  latch: null,
  authorized: false,
  heldOpenArmed: false,
  openedAt: null,
  openedAuthorized: false,
});

/**
 * Which events make an opening expected. A lock has a key cylinder it can
 * sense; a strike-only door has nothing that could report a key, so the brief
 * lists "grant or REX" only.
 */
function authorizes(source: DoorPositionSource, kind: AccessEventKind): boolean {
  if (source === "none") return false;
  if (kind === "unlock_granted" || kind === "rex") return true;
  return source === "lock" && kind === "key_override";
}

/** Closed, and (on a lock) latched: the state a relock names. */
function isSecure(source: DoorPositionSource, state: DoorState): boolean {
  if (source === "lock") return state.open === false && state.latch === "extended";
  if (source === "dp1") return state.open === false;
  return false;
}

/**
 * Apply one event. `relock` is true when this event completed the closed +
 * latched pair while an authorisation was outstanding (the authorisation is
 * spent in the returned state). No clock is taken on purpose: time cannot
 * relock a door.
 */
export function advanceDoorState(
  source: DoorPositionSource,
  state: DoorState,
  event: Pick<DoorEventLike, "kind" | "at">,
): { state: DoorState; relock: boolean } {
  const next: DoorState = { ...state };
  switch (event.kind) {
    case "door_open":
      if (source !== "none" && state.open !== true) {
        next.open = true;
        next.openedAt = event.at.getTime();
        next.openedAuthorized = state.heldOpenArmed;
      }
      break;
    case "door_closed":
      if (source !== "none") {
        next.open = false;
        next.openedAt = null;
        next.openedAuthorized = false;
      }
      break;
    case "latch_extended":
      next.latch = "extended";
      break;
    case "latch_retracted":
      next.latch = "retracted";
      break;
    default:
      if (authorizes(source, event.kind)) next.authorized = true;
      if (source !== "none" && (event.kind === "unlock_granted" || event.kind === "rex")) next.heldOpenArmed = true;
  }

  // The relock is evaluated only on the events that can complete the pair. A
  // grant that arrives on a door already closed and latched must not be spent
  // by the state it arrives into.
  const completes =
    event.kind === "door_closed" || (source === "lock" && event.kind === "latch_extended");
  if (completes && next.authorized && isSecure(source, next)) {
    next.authorized = false;
    next.heldOpenArmed = false;
    return { state: next, relock: true };
  }
  return { state: next, relock: false };
}

/** Fold events (oldest first) into a state. */
export function foldDoorState(
  source: DoorPositionSource,
  events: ReadonlyArray<Pick<DoorEventLike, "kind" | "at">>,
): DoorState {
  let state: DoorState = INITIAL_DOOR_STATE;
  for (const e of events) state = advanceDoorState(source, state, e).state;
  return state;
}

/**
 * The forced-door claim an opening makes, given the state just BEFORE it —
 * or `null` for no claim. A `none` door never makes one. On a lock the claim
 * needs the latch to have reported extended: a retracted or never-reported
 * latch is not "still extended", and the product does not guess.
 */
export function assessDoorOpen(
  source: DoorPositionSource,
  before: DoorState,
): AccessForcedClaim | null {
  if (source === "none") return null;
  // Already open: this is the same opening reported twice, not a new one.
  if (before.open === true) return null;
  if (before.authorized) return null;
  if (source === "lock") return before.latch === "extended" ? "latch_witnessed" : null;
  return "unwitnessed_open";
}

/**
 * Is the current opening past its held-open time? Only after a grant or REX
 * (an unauthorised opening is a forced door, not a held one; a key override
 * starts nothing, §9.7), only while still open, and never on a `none` door.
 * "Past" is strict.
 */
export function heldOpenDue(
  source: DoorPositionSource,
  heldOpenSeconds: number,
  state: DoorState,
  now: Date,
): boolean {
  if (source === "none") return false;
  if (state.open !== true || !state.openedAuthorized || state.openedAt === null) return false;
  return now.getTime() - state.openedAt > heldOpenSeconds * 1000;
}

export interface DerivedAlarmDraft {
  kind: "forced_door" | "held_open";
  /** Set for `forced_door` only. */
  forcedClaim?: AccessForcedClaim;
  /** The `door_open` row this alarm was derived from (§11.3). */
  derivedFromId: string;
  /** Forced door: when the door opened. Held open: when the time ran out. */
  occurredAt: Date;
  /** One alarm per (kind, opening): re-deriving the same stream adds nothing. */
  dedupeKey: string;
}

/**
 * The alarms a door's event stream implies as of `now`. `events` need not be
 * sorted; they are ordered by time, then id. A `none` door yields nothing.
 */
export function deriveAlarms(
  source: DoorPositionSource,
  heldOpenSeconds: number,
  events: ReadonlyArray<DoorEventLike>,
  now: Date,
): DerivedAlarmDraft[] {
  if (source === "none") return [];
  const ordered = [...events].sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0),
  );

  const out: DerivedAlarmDraft[] = [];
  let state: DoorState = INITIAL_DOOR_STATE;
  let currentOpen: DoorEventLike | null = null;
  for (const e of ordered) {
    if (e.kind === "door_open" && state.open !== true) {
      const claim = assessDoorOpen(source, state);
      if (claim) {
        out.push({
          kind: "forced_door",
          forcedClaim: claim,
          derivedFromId: e.id,
          occurredAt: e.at,
          dedupeKey: `derived:forced_door:${e.id}`,
        });
      }
      currentOpen = e;
    }
    if (e.kind === "door_closed") currentOpen = null;
    state = advanceDoorState(source, state, e).state;
  }

  if (currentOpen && heldOpenDue(source, heldOpenSeconds, state, now)) {
    out.push({
      kind: "held_open",
      derivedFromId: currentOpen.id,
      occurredAt: new Date((state.openedAt as number) + heldOpenSeconds * 1000),
      dedupeKey: `derived:held_open:${currentOpen.id}`,
    });
  }
  return out;
}

// ── position ──────────────────────────────────────────────────────────────

/** §6.4: 30 s actuators (locks), 60 s sensors (DP-1). */
export const HEARTBEAT_SECONDS = { lock: 30, dp1: 60 } as const;
/** §6.4: three consecutive misses. */
export const HEARTBEAT_MISSES_FOR_UNKNOWN = 3;

/**
 * Has a door gone quiet for long enough that its position must be reported
 * unknown? The third missed heartbeat: ~90 s for a lock, ~180 s for a DP-1.
 * A `none` door has no position to lose.
 */
export function positionUnknownDue(input: {
  source: DoorPositionSource;
  lastHeartbeatAt: Date;
  now: Date;
}): boolean {
  if (input.source === "none") return false;
  const window = HEARTBEAT_SECONDS[input.source] * HEARTBEAT_MISSES_FOR_UNKNOWN * 1000;
  return input.now.getTime() - input.lastHeartbeatAt.getTime() >= window;
}

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
