/**
 * WARP-3521 — burndown reconstruction. A PURE function: rows in, points out. No
 * Prisma, no clock, no I/O — `pm-cycles.service.ts` loads the rows and owns the
 * word "now", so everything about the chart that can be wrong is decided, and
 * tested, here.
 *
 * ── what is reconstructed, and from what ───────────────────────────────────
 *
 * For every day of a cycle: how many items were in it (`scope`), how many of
 * those were still open (`remaining`) and how many were done (`completed`), as
 * a count and as a sum of estimates. Scope is its own series — an item added
 * mid-cycle raises it and an item pulled out lowers it — because a burndown that
 * only shows `remaining` hides the single most useful thing a sprint chart says:
 * that the target moved.
 *
 * There is no snapshot table. History is rebuilt from `PmActivity`:
 *   * `cycle_added` / `cycle_removed` rows name the cycle an item left and the
 *     one it joined (`oldValue` / `newValue`), and
 *   * `state_changed` rows name the states, whose GROUP says terminal or not
 *     (completed and cancelled both take work off the board).
 * The service turns those rows into the two event kinds below.
 *
 * ── why it anchors on the LIVE row and walks BACKWARDS ─────────────────────
 *
 * Replaying events forward from an assumed starting state looks natural and is
 * wrong in a way that shows: any change with no activity row (a state's group
 * edited under the items sitting in it; a state deleted and its items moved —
 * `updateState` / `deleteState` write none) leaves the replayed final point
 * disagreeing with the "7 of 12 done" card next to the chart.
 *
 * So every event records what the item was BEFORE it, and the state of an item
 * at any instant is "the `before` of the first event at or after that instant,
 * else what the live row says". The newest point is therefore the live truth by
 * construction; a hole in the history can only blur the PAST, never contradict
 * the present. It also makes a closed window correct for free: a cycle that
 * ended Wednesday is still drawn as Wednesday saw it after an item is reopened
 * on Friday, because the Friday event is exactly what gets undone.
 *
 * ── what it deliberately does not do ───────────────────────────────────────
 *
 *   * Day boundaries are supplied, not computed from a timezone. The service
 *     passes UTC days (cycle dates are calendar dates stored at midnight UTC);
 *     a caller that wants viewer-local days passes different boundaries and
 *     this function does not care.
 *   * An estimate edit is applied to the whole history (the weight is the item's
 *     current estimate). There is no per-item estimate history to read.
 *   * Deleted items are gone: their activity cascades with them.
 */

const DAY_MS = 86_400_000;

/** One calendar day of the chart, as the half-open instant window `[startsAt, endsAt)`. */
export interface BurndownDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  startsAt: Date;
  endsAt: Date;
}

/** An item that is, or ever was, in the cycle. */
export interface BurndownItem {
  id: string;
  /** Live truth: is the item in this cycle right now? */
  memberNow: boolean;
  /** Live truth: is the item in a completed or cancelled state right now? */
  terminalNow: boolean;
  /** The item's estimate in points; 0 when it has none. */
  weight: number;
}

/**
 * What changed, expressed as the value BEFORE the change. A membership event
 * with `wasMember: false` is a join; `wasMember: true` is a leave. A terminal
 * event with `wasTerminal: false` is the item being finished; `true` is it
 * being reopened.
 */
export type BurndownEvent =
  | { kind: "membership"; itemId: string; at: Date; wasMember: boolean }
  | { kind: "terminal"; itemId: string; at: Date; wasTerminal: boolean };

export interface BurndownInput {
  days: BurndownDay[];
  items: BurndownItem[];
  events: BurndownEvent[];
  /** Days that start after this instant have no actuals (their fields are null). */
  now: Date;
}

/**
 * One day. The actual fields are `null` for a day that has not started — the
 * chart breaks the line there — while the ideal line is always a number.
 */
export interface BurndownPoint {
  date: string;
  scope: number | null;
  remaining: number | null;
  completed: number | null;
  /** Items that joined the cycle during the day. */
  added: number | null;
  /** Items that left the cycle during the day. */
  removed: number | null;
  scopeEstimate: number | null;
  remainingEstimate: number | null;
  completedEstimate: number | null;
  ideal: number;
  idealEstimate: number;
}

/** `count` consecutive UTC calendar days starting at `startDate` (`YYYY-MM-DD`). */
export function utcDayBoundaries(startDate: string, count: number): BurndownDay[] {
  if (count <= 0) return [];
  const [y, m, d] = startDate.split("-").map(Number);
  const out: BurndownDay[] = [];
  for (let i = 0; i < count; i += 1) {
    // Date.UTC normalises day overflow by calendar (31 Dec + 1 = 1 Jan), which
    // is exactly what is wanted and is why this is not `start + i * DAY_MS`
    // through a local-time Date.
    const startsAt = new Date(Date.UTC(y, m - 1, d + i));
    out.push({
      date: startsAt.toISOString().slice(0, 10),
      startsAt,
      endsAt: new Date(startsAt.getTime() + DAY_MS),
    });
  }
  return out;
}

interface Timeline {
  /** Event instants, ascending (ties keep input order). */
  times: number[];
  /** The value immediately BEFORE each event. */
  before: boolean[];
  /** What the live row says now. */
  live: boolean;
}

function buildTimeline(events: Array<{ at: Date; before: boolean }>, live: boolean): Timeline {
  // Array#sort is stable, so events at the same instant keep their input order.
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    times: sorted.map((e) => e.at.getTime()),
    before: sorted.map((e) => e.before),
    live,
  };
}

/** The value at instant `t`: the `before` of the first event at or after `t`,
 *  else the live value. (An event AT `t` has not happened yet — windows are
 *  half-open.) */
function valueAt(tl: Timeline, t: number): boolean {
  let lo = 0;
  let hi = tl.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tl.times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo < tl.times.length ? tl.before[lo] : tl.live;
}

/** Two decimals — an estimate sum must not leak `0.30000000000000004` to a chart. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function reconstructBurndown(input: BurndownInput): BurndownPoint[] {
  const { days, items, events, now } = input;
  if (days.length === 0) return [];

  const byItem = new Map<string, { membership: Array<{ at: Date; before: boolean }>; terminal: Array<{ at: Date; before: boolean }> }>();
  for (const it of items) byItem.set(it.id, { membership: [], terminal: [] });
  for (const ev of events) {
    const bucket = byItem.get(ev.itemId);
    if (!bucket) continue; // an event for an item we were not given: nothing to anchor it to
    if (ev.kind === "membership") bucket.membership.push({ at: ev.at, before: ev.wasMember });
    else bucket.terminal.push({ at: ev.at, before: ev.wasTerminal });
  }

  const timelines = items.map((it) => {
    const b = byItem.get(it.id)!;
    return {
      weight: it.weight,
      membership: buildTimeline(b.membership, it.memberNow),
      terminal: buildTimeline(b.terminal, it.terminalNow),
      // for the per-day added / removed tallies
      membershipEvents: b.membership,
    };
  });

  interface Snapshot {
    scope: number;
    remaining: number;
    completed: number;
    scopeEstimate: number;
    remainingEstimate: number;
    completedEstimate: number;
    added: number;
    removed: number;
  }

  const snapshots: Snapshot[] = days.map((day) => {
    const t = day.endsAt.getTime();
    const s0 = day.startsAt.getTime();
    const snap: Snapshot = {
      scope: 0,
      remaining: 0,
      completed: 0,
      scopeEstimate: 0,
      remainingEstimate: 0,
      completedEstimate: 0,
      added: 0,
      removed: 0,
    };
    for (const tl of timelines) {
      if (valueAt(tl.membership, t)) {
        const terminal = valueAt(tl.terminal, t);
        snap.scope += 1;
        snap.scopeEstimate += tl.weight;
        if (terminal) {
          snap.completed += 1;
          snap.completedEstimate += tl.weight;
        } else {
          snap.remaining += 1;
          snap.remainingEstimate += tl.weight;
        }
      }
      for (const ev of tl.membershipEvents) {
        const when = ev.at.getTime();
        if (when >= s0 && when < t) {
          if (ev.before) snap.removed += 1;
          else snap.added += 1;
        }
      }
    }
    return snap;
  });

  // The ideal line burns the work that was OPEN at the end of the first day
  // (the planning day) down to zero on the last. Done work is not "to burn",
  // and scope added later deliberately does not move it — that gap is the
  // scope-creep signal the chart exists to show.
  const baseline = snapshots[0];
  const last = days.length - 1;
  const idealAt = (base: number, i: number): number =>
    last === 0 ? 0 : round2((base * (last - i)) / last);

  const nowMs = now.getTime();
  return days.map((day, i) => {
    const snap = snapshots[i];
    const started = day.startsAt.getTime() <= nowMs;
    return {
      date: day.date,
      scope: started ? snap.scope : null,
      remaining: started ? snap.remaining : null,
      completed: started ? snap.completed : null,
      added: started ? snap.added : null,
      removed: started ? snap.removed : null,
      scopeEstimate: started ? round2(snap.scopeEstimate) : null,
      remainingEstimate: started ? round2(snap.remainingEstimate) : null,
      completedEstimate: started ? round2(snap.completedEstimate) : null,
      ideal: idealAt(baseline.remaining, i),
      idealEstimate: idealAt(baseline.remainingEstimate, i),
    };
  });
}
