"use client";

// Optimistic reschedule with rollback — the write path behind every drag, resize
// and keyboard nudge in the calendar and the timeline (WARP-3523, brief §4.1,
// §4.4).
//
// The optimistic state is a LOCAL overlay on whatever list the view renders, not
// a mutation of the SWR cache. The board's cache shape is owned by other slices
// (WS-1 pages it, WS-6 moves it behind a query API); an overlay keyed by item id
// keeps this working through both.
//
// Contract:
//   * `reschedule(item, next)` paints `next` immediately, PATCHes only the dates
//     that changed, and on success hands control to `onSaved` (revalidate the
//     caller's data) before dropping the overlay, so the item never flickers
//     back to its old date between the response and the refetch.
//   * A failure drops the overlay (the item snaps back), toasts, and announces.
//   * Saves for ONE item run strictly in order — a second drag before the first
//     response is queued behind it — so the last gesture wins on the server too.

import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { pmActions } from "../usePm";
import type { PmWorkItem } from "../types";
import { describeSchedule, sameSchedule, scheduleBody, scheduleOf, type Schedule } from "./schedule";

/** Brief §6, "Write rejected (toast)" — one verbatim string per concept. */
export const RESCHEDULE_FAILED = "Couldn't move that item — try again.";

type Overlaid = Pick<PmWorkItem, "id" | "startDate" | "dueDate">;

interface ItemSaves {
  /** The last schedule the server confirmed (or the one the first gesture started from). */
  confirmed: Schedule;
  /** Saves queued or in flight for this item. */
  pending: number;
  /** Tail of this item's save chain. */
  tail: Promise<unknown>;
}

export interface UseRescheduleOptions {
  /** Revalidate the caller's data. Awaited before the optimistic overlay is dropped. */
  onSaved?: (item: PmWorkItem) => Promise<unknown> | void;
  /** Screen-reader announcement (brief §5.5), e.g. into an `aria-live` region. */
  announce?: (message: string) => void;
}

export interface UseRescheduleResult {
  /** `items` with in-flight schedules overlaid. Returns `items` itself when nothing is pending. */
  withPending: <T extends Overlaid>(items: T[]) => T[];
  isPending: (id: string) => boolean;
  /** Resolves true when the server accepted the change (or there was nothing to change). */
  reschedule: (item: PmWorkItem, next: Schedule) => Promise<boolean>;
}

export function useReschedule({ onSaved, announce }: UseRescheduleOptions = {}): UseRescheduleResult {
  const { toast } = useToast();
  const [overlay, setOverlay] = useState<Record<string, Schedule>>({});
  const saves = useRef(new Map<string, ItemSaves>());
  // Latest callbacks, so `reschedule` keeps one identity across renders.
  const latest = useRef({ onSaved, announce, toast });
  latest.current = { onSaved, announce, toast };

  const dropOverlay = useCallback((id: string) => {
    setOverlay((o) => {
      if (!(id in o)) return o;
      const { [id]: _gone, ...rest } = o;
      return rest;
    });
  }, []);

  const reschedule = useCallback(
    (item: PmWorkItem, next: Schedule): Promise<boolean> => {
      const id = item.id;
      if (sameSchedule(scheduleOf(item), next)) return Promise.resolve(true);

      let entry = saves.current.get(id);
      if (!entry) {
        entry = { confirmed: scheduleOf(item), pending: 0, tail: Promise.resolve() };
        saves.current.set(id, entry);
      }
      const state = entry;
      state.pending += 1;
      setOverlay((o) => ({ ...o, [id]: next }));

      const run = async (): Promise<boolean> => {
        let ok = false;
        try {
          const body = scheduleBody(state.confirmed, next);
          if (Object.keys(body).length > 0) {
            const res = await pmActions().updateItem(id, body);
            state.confirmed = res?.work_item ? scheduleOf(res.work_item) : next;
          }
          ok = true;
        } catch {
          ok = false;
        }
        state.pending -= 1;

        const cb = latest.current;
        if (ok) {
          cb.announce?.(
            next.startDate || next.dueDate
              ? `Moved ${item.key} to ${describeSchedule(next)}`
              : `Cleared the dates on ${item.key}`,
          );
        } else {
          cb.toast(RESCHEDULE_FAILED, "error");
          cb.announce?.(RESCHEDULE_FAILED);
        }

        if (state.pending === 0) {
          if (ok) {
            try {
              await cb.onSaved?.(item);
            } catch {
              // The save succeeded; a failed refetch must not undo it.
            }
          }
          // A new gesture can land while `onSaved` is awaited; it owns the
          // overlay now and cleans up after itself.
          if (state.pending === 0) {
            dropOverlay(id);
            saves.current.delete(id);
          }
        }
        return ok;
      };

      // Alone in the queue: send now. Otherwise wait for the item's earlier
      // saves to settle (either way) so they reach the server in gesture order.
      const result = state.pending === 1 ? run() : state.tail.then(run, run);
      state.tail = result;
      return result;
    },
    [dropOverlay],
  );

  const withPending = useCallback(
    <T extends Overlaid>(items: T[]): T[] => {
      if (Object.keys(overlay).length === 0) return items;
      return items.map((it) => {
        const o = overlay[it.id];
        return o ? { ...it, startDate: o.startDate, dueDate: o.dueDate } : it;
      });
    },
    [overlay],
  );

  const isPending = useCallback((id: string) => id in overlay, [overlay]);

  return { withPending, isPending, reschedule };
}
