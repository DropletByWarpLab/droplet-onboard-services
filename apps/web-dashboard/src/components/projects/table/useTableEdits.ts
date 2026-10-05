"use client";

// WARP-3537 — editing ONE work item where it stands in the table (spec: state,
// priority, assignee and due date; brief §4.2 adds the title).
//
// Every edit is optimistic (brief §4.4): the cell shows the new value at once, the
// write goes through the routes the drawer and the board already use (`transition`
// for state, PATCH for the rest — nothing new), then the list is refreshed. A
// rejection puts the cell back and says so in a toast and in the live region
// (brief §5.5: "live-region announcements for optimistic results"). A person who
// cannot write never reaches these — the cells that call them are not drawn.

import { useCallback, useMemo } from "react";
import { translateError } from "@/lib/friendly-errors";
import { pmActions } from "../usePm";
import type { ItemOverride } from "../bulk/plan";
import type { OptimisticRows } from "./useOptimisticRows";
import type { PmState, PmWorkItem, Priority } from "../types";
import { PRIORITY } from "../config";

export interface TableEdits {
  setState: (item: PmWorkItem, state: PmState) => Promise<void>;
  setPriority: (item: PmWorkItem, priority: Priority) => Promise<void>;
  setAssignees: (item: PmWorkItem, assigneeIds: string[]) => Promise<void>;
  /** A calendar date `YYYY-MM-DD`, or null to clear. */
  setDueDate: (item: PmWorkItem, ymd: string | null) => Promise<void>;
  rename: (item: PmWorkItem, name: string) => Promise<void>;
}

export interface UseTableEditsArgs {
  optimistic: OptimisticRows;
  /** Re-read the rows. A failure here is not a failed write: the write already happened. */
  refresh: () => Promise<unknown>;
  toast: (message: string, type?: "error" | "success" | "info") => void;
  announce: (message: string) => void;
}

/** A due date is a calendar date; the API still takes an instant, so send midnight UTC of the day
 *  chosen — the shape WS-1's date-only rule stores (`00:00:00Z`), and not the browser's local midnight. */
export function dueDateWire(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}

export function useTableEdits({ optimistic, refresh, toast, announce }: UseTableEditsArgs): TableEdits {
  const write = useCallback(
    async (item: PmWorkItem, override: ItemOverride, send: () => Promise<unknown>, done: string, failed: string) => {
      optimistic.set(new Map([[item.id, override]]));
      try {
        await send();
        try {
          await refresh();
        } catch {
          // The change is saved; the next poll shows it. Not a failure to report.
        }
        announce(done);
      } catch (e) {
        toast(translateError(e, "projects"), "error");
        announce(failed);
      } finally {
        optimistic.clear([item.id]);
      }
    },
    [optimistic, refresh, toast, announce],
  );

  return useMemo<TableEdits>(
    () => ({
      setState: (item, state) =>
        write(
          item,
          { stateId: state.id, state },
          () => pmActions().transitionItem(item.id, state.id),
          `${item.key} moved to ${state.name}`,
          `Couldn't move ${item.key} — try again`,
        ),
      setPriority: (item, priority) =>
        write(
          item,
          { priority },
          () => pmActions().updateItem(item.id, { priority }),
          `${item.key} priority set to ${PRIORITY[priority].label}`,
          `Couldn't change the priority of ${item.key} — try again`,
        ),
      setAssignees: (item, assigneeIds) =>
        write(
          item,
          { assignees: assigneeIds },
          () => pmActions().updateItem(item.id, { assignees: assigneeIds }),
          `${item.key} assignees updated`,
          `Couldn't change the assignees of ${item.key} — try again`,
        ),
      setDueDate: (item, ymd) =>
        write(
          item,
          // The wire value is what the row holds, so what the cell shows is what the server will return.
          { dueDate: ymd === null ? null : dueDateWire(ymd) },
          () => pmActions().updateItem(item.id, { due_date: ymd === null ? null : dueDateWire(ymd) }),
          ymd === null ? `${item.key} due date cleared` : `${item.key} due date set to ${ymd}`,
          `Couldn't change the due date of ${item.key} — try again`,
        ),
      rename: (item, name) =>
        write(
          item,
          { name },
          () => pmActions().updateItem(item.id, { name }),
          `${item.key} renamed`,
          `Couldn't rename ${item.key} — try again`,
        ),
    }),
    [write],
  );
}
