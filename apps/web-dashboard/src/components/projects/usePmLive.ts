"use client";

/**
 * WARP-3536 (Work Suite WS-19) — boards, lists and the open drawer refresh when
 * someone else changes work.
 *
 * `usePmLive()` is mounted once, by the Projects page. It listens to the socket
 * the layout already holds open (lib/pm-live-events.ts, fed by
 * NotificationToaster — there is no second socket) and re-reads the PM reads a
 * frame affects through SWR, so what arrives is the normal, authorized answer;
 * the frame itself carries ids and a kind and nothing to show.
 *
 *   Which reads.   Every mounted `/api/pm/*` read the frame touches
 *                  (`keyAffectedBy`): the project list and summary (their counts
 *                  move with the items), that project's work-item reads (board,
 *                  list, the open item's sub-issues), and that item's own reads
 *                  (comments, activity, detail). Another project's board is left
 *                  alone, and so are the reads item activity cannot change (a
 *                  project's states and labels). A key nobody is showing is never
 *                  fetched: SWR revalidates mounted hooks only.
 *   Debounced.     250 ms after the last frame, so the five rows one edit writes
 *                  are one refresh. A stream that never goes quiet (an import)
 *                  is refreshed at least every 2 s rather than not at all.
 *   Held.          While a card is being dragged (`usePmLivePause`) nothing is
 *                  re-read, so a remote change cannot move a card from under the
 *                  pointer. Frames queue; one refresh runs after the drop.
 *   Resync.        When the socket reconnects everything on screen is re-read:
 *                  frames are not replayed, so any that fell in the gap are gone.
 *
 * Failure is the old behaviour. With the broker down, or the socket unable to
 * connect, no frame ever arrives and the page revalidates on focus and reconnect
 * exactly as it did before this existed. Nothing here fetches on its own, so
 * nothing here can error or log.
 */

import { useEffect } from "react";
import { useSWRConfig } from "swr";
import { subscribePmLive, type PmChangedEvent } from "@/lib/pm-live-events";

/** Quiet time after the last frame before the reads are refreshed. */
export const PM_LIVE_DEBOUNCE_MS = 250;
/** A stream that never goes quiet is still refreshed this often. */
export const PM_LIVE_MAX_WAIT_MS = 2_000;
/** Distinct items remembered per refresh; past this, "something changed" re-reads everything on screen. */
const MAX_PENDING = 500;

const PM_PREFIX = "/api/pm/";

/** True when `rest` is `id` itself or something under it (a path or a query), not another id that merely starts with it. */
function isOrUnder(rest: string, id: string): boolean {
  if (!rest.startsWith(id)) return false;
  const next = rest.charAt(id.length);
  return next === "" || next === "/" || next === "?";
}

/** Reads that an item's activity cannot change. */
const UNAFFECTED_PROJECT_READS = /^(states|labels)(\?|$)/;

/**
 * Does the frame for `e` make `key` stale? Only string `/api/pm/` keys ever do:
 * everything else on the page (a presence beat, the directory, another module)
 * is left to its own rules.
 */
export function keyAffectedBy(key: unknown, e: Pick<PmChangedEvent, "projectId" | "workItemId">): boolean {
  if (typeof key !== "string" || !key.startsWith(PM_PREFIX)) return false;
  const rest = key.slice(PM_PREFIX.length);

  // Counts and lists that any item change can move.
  if (rest === "summary" || rest.startsWith("summary?")) return true;
  if (rest === "projects" || rest.startsWith("projects?")) return true;
  if (rest === "assigned-to-me" || rest.startsWith("assigned-to-me?")) return true;
  if (rest === "my-work" || rest.startsWith("my-work?")) return true;
  if (rest.startsWith("work-items?")) return true; // workspace search

  if (rest.startsWith("projects/")) {
    const [segment = "", ...tail] = rest.slice("projects/".length).split("/");
    if (segment.split("?")[0] !== e.projectId) return false;
    // The project itself and everything under it, bar what item activity cannot move.
    return !UNAFFECTED_PROJECT_READS.test(tail.join("/"));
  }
  if (rest.startsWith("work-items/")) return isOrUnder(rest.slice("work-items/".length), e.workItemId);
  return false;
}

// ── holding the refresh while a card is dragged ─────────────────────────────

let holds = 0;
const resumeListeners = new Set<() => void>();

/** Is a drag (or anything else that called `usePmLivePause`) holding refreshes back? */
export function isPmLivePaused(): boolean {
  return holds > 0;
}

/**
 * Hold live refreshes while `active` — call it with "a card is being dragged".
 * Counted, so two holds at once release only when both have. Released on unmount,
 * so a board that goes away mid-drag cannot leave live updates off.
 */
export function usePmLivePause(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    holds += 1;
    return () => {
      holds -= 1;
      if (holds === 0) for (const resume of [...resumeListeners]) resume();
    };
  }, [active]);
}

// ── the hook ────────────────────────────────────────────────────────────────

export function usePmLive(): void {
  const { mutate } = useSWRConfig();

  useEffect(() => {
    const pending = new Map<string, PmChangedEvent>();
    let everything = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** When the current run of frames began; 0 when none is waiting. */
    let windowStart = 0;

    const flush = () => {
      timer = null;
      windowStart = 0;
      if (isPmLivePaused()) return; // the resume listener re-arms it
      const events = [...pending.values()];
      const all = everything;
      pending.clear();
      everything = false;
      if (!all && events.length === 0) return;
      void mutate(
        (key) =>
          typeof key === "string" &&
          key.startsWith(PM_PREFIX) &&
          (all || events.some((e) => keyAffectedBy(key, e))),
      );
    };

    const arm = () => {
      if (isPmLivePaused()) return;
      const now = Date.now();
      if (windowStart === 0) windowStart = now;
      if (timer !== null) clearTimeout(timer);
      const untilMaxWait = windowStart + PM_LIVE_MAX_WAIT_MS - now;
      timer = setTimeout(flush, Math.max(0, Math.min(PM_LIVE_DEBOUNCE_MS, untilMaxWait)));
    };

    const off = subscribePmLive((signal) => {
      if (signal.type === "resync") {
        everything = true;
      } else if (!everything) {
        pending.set(`${signal.projectId}:${signal.workItemId}`, signal);
        if (pending.size > MAX_PENDING) {
          everything = true;
          pending.clear();
        }
      }
      arm();
    });

    const resume = () => {
      if (everything || pending.size > 0) arm();
    };
    resumeListeners.add(resume);

    return () => {
      off();
      resumeListeners.delete(resume);
      if (timer !== null) clearTimeout(timer);
    };
  }, [mutate]);
}
