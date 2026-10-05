"use client";

// WARP-3537 — run a bulk action on the table's selection, honestly.
//
//   1. plan it (`planBulkOp`): only the items that really change are sent;
//   2. show it at once (an optimistic override per item — brief §4.4);
//   3. send it: ONE request, all or nothing;
//   4. on success refresh, drop the overrides, and say what happened in a toast with
//      an Undo that puts every item back where it WAS;
//   5. on refusal drop the overrides — the rows are the server's again, which is the
//      roll-back — and say, in words, that NOTHING was changed.
//
// Never says "done" before the server did (brief §4.4's honesty rule): the toast is
// after the response, and until then the rows are drawn as saving.

import { useCallback, useRef, useState } from "react";
import { bulkEdit, bulkErrorMessage } from "./bulkApi";
import { describeOp, planBulkOp, type BulkLookups, type BulkOp, type BulkPlan } from "./plan";
import type { Selection } from "./selection";
import type { OptimisticRows } from "../table/useOptimisticRows";
import type { PmWorkItem } from "../types";

type ToastFn = (message: string, type?: "error" | "success" | "info", action?: { label: string; onClick: () => void }) => void;

export interface UseBulkActionsArgs {
  selection: Selection;
  /** The rows as the person sees them (overrides applied): the selected items are looked up here. */
  rows: PmWorkItem[];
  lookups: BulkLookups;
  optimistic: OptimisticRows;
  /** Re-read the rows. A failure here is not a failed write. */
  refresh: () => Promise<unknown>;
  toast: ToastFn;
  announce: (message: string) => void;
}

export interface BulkActions {
  run: (op: BulkOp) => Promise<void>;
  /** A bulk write is in flight: a second one waits. */
  busy: boolean;
}

export function useBulkActions({ selection, rows, lookups, optimistic, refresh, toast, announce }: UseBulkActionsArgs): BulkActions {
  const [busy, setBusy] = useState(false);
  // A ref as well as state: two clicks in one tick must not both see `busy === false`.
  const inFlight = useRef(false);

  const safeRefresh = useCallback(async () => {
    try {
      await refresh();
    } catch {
      // The write is done; the next poll shows it.
    }
  }, [refresh]);

  const undo = useCallback(
    async (plan: BulkPlan) => {
      try {
        for (const step of plan.undo) await bulkEdit(step);
        await safeRefresh();
        toast("Undone", "success");
        announce("Undone");
      } catch (e) {
        await safeRefresh();
        // Several steps means some may already be back: say so rather than imply either extreme.
        const message =
          plan.undo.length > 1 ? "Couldn't undo everything. Check the items and try again." : bulkErrorMessage(e);
        toast(message, "error");
        announce(message);
      }
    },
    [safeRefresh, toast, announce],
  );

  const run = useCallback(
    async (op: BulkOp) => {
      if (inFlight.current) return;
      const targets = rows.filter((r) => selection.has(r.id));
      const plan = planBulkOp(op, targets, lookups);
      if (!plan.forward) {
        const message = targets.length === 0 ? "Select some items first." : "Nothing to change — every selected item is already like that.";
        toast(message, "info");
        announce(message);
        return;
      }

      inFlight.current = true;
      setBusy(true);
      const ids = plan.forward.ids;
      optimistic.set(plan.optimistic);
      try {
        await bulkEdit(plan.forward);
        await safeRefresh();
        const said = describeOp(op, ids.length, lookups);
        const tail = plan.unrestorable > 0 ? `. Undo can't restore ${plan.unrestorable} that had no state.` : "";
        toast(`${said}${tail}`, "success", plan.undo.length > 0 ? { label: "Undo", onClick: () => void undo(plan) } : undefined);
        announce(said);
      } catch (e) {
        const message = bulkErrorMessage(e);
        toast(message, "error");
        announce(message);
        // A stale selection is the usual reason a batch is refused (an item was deleted, moved): re-read.
        await safeRefresh();
      } finally {
        optimistic.clear(ids);
        inFlight.current = false;
        setBusy(false);
      }
    },
    [rows, selection, lookups, optimistic, safeRefresh, toast, announce, undo],
  );

  return { run, busy };
}
