/**
 * WARP-3536 — the page-wide fan-out for `droplet/pm/<username>`.
 *
 * One socket already exists on every signed-in page (NotificationToaster's,
 * mounted in the layout); it hands each Projects frame to `publishPmLiveFrame`,
 * and the Projects page's `usePmLive` subscribes. A second socket would add a
 * connection per tab for no gain — the same reasoning as agent-run-events.ts.
 *
 * A frame is `{ type: "pm.changed", projectId, workItemId, verb }`: ids and a
 * kind, never content (services/pm/pm-live.ts). Only that shape gets through,
 * rebuilt field by field, and the ids are only ever COMPARED with SWR keys —
 * never put into a URL — so a malformed or hostile frame can at worst cause one
 * extra read.
 *
 * `resync` is not a frame: it is what the socket's owner says when the
 * connection COMES BACK. Frames are not replayed, so whatever was missed while it
 * was down has to be re-read.
 */

export interface PmChangedEvent {
  type: "pm.changed";
  projectId: string;
  workItemId: string;
  /** The activity verb (`state_changed`, `commented`, …). A hint; never branched on. */
  verb: string;
}

export type PmLiveSignal = PmChangedEvent | { type: "resync" };

type Listener = (signal: PmLiveSignal) => void;
const listeners = new Set<Listener>();

/** A uuid is 36 characters; anything much longer is not an id. */
const MAX_ID = 64;

export function subscribePmLive(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(signal: PmLiveSignal): void {
  for (const fn of [...listeners]) {
    try {
      fn(signal);
    } catch (err) {
      // A subscriber's bug must not take the socket's other consumers with it.
      console.error("pm live subscriber failed", err);
    }
  }
}

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;

/** A frame off the socket; anything that is not a Projects `pm.changed` frame is ignored. */
export function publishPmLiveFrame(topic: unknown, payload: unknown): void {
  if (typeof topic !== "string" || !topic.startsWith("droplet/pm/")) return;
  if (typeof payload !== "object" || payload === null) return;
  const p = payload as Record<string, unknown>;
  if (p.type !== "pm.changed" || !isId(p.projectId) || !isId(p.workItemId) || !isId(p.verb)) return;
  emit({ type: "pm.changed", projectId: p.projectId, workItemId: p.workItemId, verb: p.verb });
}

/** The socket reconnected: re-read what was on screen. */
export function notifyPmLiveResync(): void {
  emit({ type: "resync" });
}
