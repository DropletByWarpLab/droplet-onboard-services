/**
 * ADR-055 P4b — every word on /doors that a person reads, and the small
 * formatting the page shares. Scanned by `doors-copy.test.ts`.
 *
 * Droplet shows what a door REPORTS. It does not lock or unlock one from this
 * page, it does not raise an alarm, and nothing here says a door is safe. A
 * position is only ever shown with the time it was reported: the box never
 * ages a report into "unknown" on its own (that waits for link supervision),
 * so an old "Closed" is still the last thing the door said, and the page says
 * when.
 */
import { formatSiteWhen } from "@/lib/security-time";
import type { DoorEventKind, DoorEventView, DoorPosition, DoorPositionSource, DoorView } from "@/lib/types";

export const COPY = {
  title: "Doors",
  sub: "The doors Droplet knows about, and what each one last reported. Nothing here locks or unlocks a door.",
  listTitle: "Your doors",
  positionNote:
    "A position is the last thing the door reported, with when it reported it. If a door stops reporting, it keeps its last position here.",
  activityTitle: "Recent activity",
  activitySub: "What your doors have reported, newest first.",

  add: "Add a door",
  edit: "Change",
  retire: "Retire door",
  retryLabel: "Try again",

  emptyTitle: "No doors yet.",
  emptyOwner: "Add a door to keep a list of what it reports.",
  emptyOthers: "The owner adds doors here.",
  loadFailedTitle: "Couldn't load your doors",
  loadFailedBody: "This is not the same as there being none. Try again in a moment.",

  statusActive: "In use",
  statusRetired: "Retired",
  retiredTitle: "Retired doors",
  retiredOn: "Retired {when}",

  // A door's position. Always followed by "since {when}" when there is a time.
  positionOpen: "Open",
  positionClosed: "Closed",
  positionUnknown: "Position unknown",
  positionNotTracked: "Not tracked",
  since: "since {when}",
  noReportYet: "Nothing reported yet.",
  stoppedReporting: "Droplet stopped hearing from this door.",
  notTracked:
    "Nothing reports this door's position, so Droplet can't tell whether it's open or closed, forced open or left open.",

  // Where a door's position comes from.
  sourceLock: "Position comes from the lock.",
  sourceSensor: "Position comes from a door sensor.",

  // The add / change form.
  addTitle: "Add a door",
  editTitle: "Change this door",
  formSub: "Name the door and say what tells Droplet whether it's open or closed.",
  nameLabel: "Name",
  nameRequired: "Give the door a name.",
  nameTooLong: "Keep the name to 80 characters or fewer.",
  sourceLegend: "What tells Droplet whether it's open?",
  sourceRequired: "Choose what tells Droplet whether the door is open.",
  cancel: "Cancel",
  save: "Save",
  addConfirm: "Add door",

  // Retiring a door. Plain about what it does and does not do; no way back from here.
  retireTitle: "Retire {name}?",
  retireBody:
    "It stops being listed as a door in use. What it already reported stays in the activity list. You can't bring it back from this page.",
  retireConfirm: "Retire door",

  added: "Added {name}.",
  changed: "Saved {name}.",
  retired: "Retired {name}.",

  moreEvents: "Show older",
  emptyEventsTitle: "Nothing reported yet.",
  emptyEventsBody:
    "A door shows up here once its lock or sensor reports something, so an empty list doesn't mean nothing happened.",
  eventsFailedTitle: "Couldn't load the activity",
  eventsFailedBody: "This is not the same as nothing happening. Try again in a moment.",
} as const;

/** Fills `{name}` style slots. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? "");
}

/** The choice's name, and what it means, in the add / change form. */
export const SOURCE_CHOICES: ReadonlyArray<{ value: DoorPositionSource; label: string; help: string }> = [
  { value: "lock", label: "The lock", help: "The lock itself says when the door opens and closes." },
  { value: "dp1", label: "A door sensor", help: "A separate sensor on the door and frame says so." },
  { value: "none", label: "Nothing", help: "Droplet can't tell if the door is open, forced open or left open." },
];

/**
 * What a door's newest report says, as words. A position is never shown
 * without its time: an open or closed report that arrives with no time is
 * treated as unknown, never as current.
 */
export function shownPosition(door: Pick<DoorView, "position" | "positionSince">): DoorPosition {
  if ((door.position === "open" || door.position === "closed") && !door.positionSince) return "unknown";
  return door.position;
}

export const POSITION_LABEL: Record<DoorPosition, string> = {
  open: COPY.positionOpen,
  closed: COPY.positionClosed,
  unknown: COPY.positionUnknown,
  not_monitored: COPY.positionNotTracked,
};

/** A time as the page says it, in the browser's own zone: "6:02 PM", "Fri 6:02 PM", "Sep 27, 6:02 PM". */
export function whenText(instant: string, now: Date, timeZone: string): string {
  return formatSiteWhen(instant, timeZone, now);
}

export const EVENT_LABEL: Record<Exclude<DoorEventKind, "forced_door" | "trouble">, string> = {
  door_open: "Opened",
  door_closed: "Closed",
  latch_retracted: "Latch pulled back",
  latch_extended: "Latch pushed out",
  bolt_thrown: "Bolt extended",
  bolt_withdrawn: "Bolt withdrawn",
  rex: "Inside handle turned",
  key_override: "Opened with a key",
  unlock_granted: "Unlock allowed",
  unlock_denied: "Unlock refused",
  held_open: "Left open",
  tamper: "Tamper reported",
};

/**
 * A forced-door report says which claim it makes (§9.7). A lock is its own
 * witness: it saw the latch still out. A door with only a sensor has no latch
 * report, so its claim is the weaker one, and the row says so.
 */
export const FORCED_LABEL = {
  latch_witnessed: { label: "Forced open", note: "The latch was still out when the door opened." },
  unwitnessed_open: {
    label: "Opened with no unlock or exit first",
    note: "This door has no latch report, so Droplet can't tell forced from not.",
  },
  unspecified: { label: "Forced open", note: "" },
} as const;

export const TROUBLE_LABEL = {
  position_unknown: "Stopped reporting, so its position is unknown",
  other: "Trouble reported",
} as const;

/** The words for one event row: the headline and, when there is one, a second line. */
export function eventText(e: Pick<DoorEventView, "kind" | "forcedClaim" | "troubleCode">): { label: string; note: string } {
  if (e.kind === "forced_door") {
    const f = FORCED_LABEL[e.forcedClaim ?? "unspecified"];
    return { label: f.label, note: f.note };
  }
  if (e.kind === "trouble") {
    return { label: e.troubleCode === "position_unknown" ? TROUBLE_LABEL.position_unknown : TROUBLE_LABEL.other, note: "" };
  }
  return { label: EVENT_LABEL[e.kind], note: "" };
}
