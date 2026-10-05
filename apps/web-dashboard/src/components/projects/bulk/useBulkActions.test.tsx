/**
 * WARP-3537 — running a bulk action on the selection: planned, shown at once, sent
 * as ONE request, then either confirmed (a toast with an Undo that restores each
 * item to where it was) or refused (rolled back, and said so in words — nothing was
 * changed). The request itself is stubbed; what the server does with it is
 * `pm-bulk.pg.test.ts`'s claim.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ bulkEdit: vi.fn() }));
vi.mock("./bulkApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bulkApi")>();
  return { ...actual, bulkEdit: h.bulkEdit };
});
vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }));

import { BulkRequestError } from "./bulkApi";
import { useBulkActions } from "./useBulkActions";
import { useSelection } from "./selection";
import { useOptimisticRows } from "../table/useOptimisticRows";
import type { PmState, PmWorkItem } from "../types";

const TODO: PmState = { id: "todo", projectId: "p", name: "Todo", group: "unstarted", color: null, sortOrder: 1, isDefault: true };
const DOING: PmState = { id: "doing", projectId: "p", name: "In Progress", group: "started", color: null, sortOrder: 2, isDefault: false };
const DONE: PmState = { id: "done", projectId: "p", name: "Done", group: "completed", color: null, sortOrder: 3, isDefault: false };

function item(n: number, state: PmState = TODO): PmWorkItem {
  return {
    id: `w${n}`, projectId: "p", sequenceId: n, key: `P-${n}`, name: `Item ${n}`, descriptionHtml: null,
    stateId: state.id, state, priority: "none", parentId: null, cycleId: null, department: null, assignees: [], labels: [],
    startDate: null, dueDate: null, sortOrder: n, completedAt: null, createdById: null, commentCount: 0, subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

const ROWS = [item(1), item(2, DOING), item(3)];
const lookups = { states: [TODO, DOING, DONE], labels: [], personName: () => "Ana" };

function setup(selected: string[] = ["w1", "w2"], refresh = vi.fn().mockResolvedValue(undefined)) {
  const toast = vi.fn();
  const announce = vi.fn();
  const hook = renderHook(() => {
    const selection = useSelection();
    const optimistic = useOptimisticRows();
    const bulk = useBulkActions({ selection, rows: optimistic.apply(ROWS), lookups, optimistic, refresh, toast, announce });
    return { selection, optimistic, bulk };
  });
  act(() => hook.result.current.selection.selectAll(selected));
  return { ...hook, toast, announce, refresh };
}

beforeEach(() => {
  h.bulkEdit.mockReset();
});

describe("a bulk action that works", () => {
  it("sends one request with only the items that change, shows it at once, then confirms with an Undo", async () => {
    let release!: () => void;
    h.bulkEdit.mockImplementation(() => new Promise((r) => (release = () => r({ changed: 2, work_items: [] }))));
    const { result, toast, announce, refresh } = setup();

    let running!: Promise<void>;
    act(() => {
      running = result.current.bulk.run({ kind: "state", stateId: DONE.id });
    });

    // Drawn as asked while the request is out: the rows say Done, and say they are saving.
    await waitFor(() => expect(result.current.optimistic.pending.has("w1")).toBe(true));
    const shown = result.current.optimistic.apply(ROWS);
    expect(shown.filter((r) => r.stateId === "done").map((r) => r.id)).toEqual(["w1", "w2"]);
    expect(result.current.bulk.busy).toBe(true);
    expect(toast).not.toHaveBeenCalled(); // never "done" before the server said so

    await act(async () => {
      release();
      await running;
    });

    expect(h.bulkEdit).toHaveBeenCalledTimes(1);
    expect(h.bulkEdit).toHaveBeenCalledWith({ ids: ["w1", "w2"], patch: { stateId: "done" } });
    expect(refresh).toHaveBeenCalled();
    expect(result.current.optimistic.pending.size).toBe(0);
    expect(result.current.bulk.busy).toBe(false);
    expect(toast).toHaveBeenCalledWith("Moved 2 items to Done", "success", { label: "Undo", onClick: expect.any(Function) });
    expect(announce).toHaveBeenCalledWith("Moved 2 items to Done");
  });

  it("Undo puts each item back where IT was — one request per distinct previous value — then says so", async () => {
    h.bulkEdit.mockResolvedValue({ changed: 2, work_items: [] });
    const { result, toast } = setup();
    await act(async () => {
      await result.current.bulk.run({ kind: "state", stateId: DONE.id });
    });
    const action = toast.mock.calls.find((c) => c[2])?.[2] as { label: string; onClick: () => void };
    expect(action.label).toBe("Undo");

    h.bulkEdit.mockClear();
    await act(async () => {
      action.onClick();
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Undone", "success"));
    // w1 was in Todo, w2 in In Progress: two different moves, not "everything back to Todo".
    expect(h.bulkEdit.mock.calls.map((c) => c[0])).toEqual([
      { ids: ["w1"], patch: { stateId: "todo" } },
      { ids: ["w2"], patch: { stateId: "doing" } },
    ]);
  });

  it("says so when an Undo could not put everything back — it does not imply either extreme", async () => {
    h.bulkEdit.mockResolvedValue({ changed: 2, work_items: [] });
    const { result, toast } = setup();
    await act(async () => {
      await result.current.bulk.run({ kind: "state", stateId: DONE.id });
    });
    const action = toast.mock.calls.find((c) => c[2])?.[2] as { onClick: () => void };
    h.bulkEdit.mockReset();
    h.bulkEdit.mockResolvedValueOnce({ changed: 1, work_items: [] }).mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      action.onClick();
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't undo everything. Check the items and try again.", "error"));
  });

  it("does not make a request for items that are already as asked — it says so", async () => {
    const { result, toast } = setup(["w3"]);
    await act(async () => {
      await result.current.bulk.run({ kind: "state", stateId: TODO.id });
    });
    expect(h.bulkEdit).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Nothing to change — every selected item is already like that.", "info");
  });

  it("asks for a selection when there is none", async () => {
    const { result, toast } = setup([]);
    await act(async () => {
      await result.current.bulk.run({ kind: "priority", priority: "high" });
    });
    expect(h.bulkEdit).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Select some items first.", "info");
  });

  it("ignores a second action while one is in flight", async () => {
    let release!: () => void;
    h.bulkEdit.mockImplementation(() => new Promise((r) => (release = () => r({ changed: 1, work_items: [] }))));
    const { result } = setup();
    let first!: Promise<void>;
    act(() => {
      first = result.current.bulk.run({ kind: "priority", priority: "high" });
    });
    await act(async () => {
      await result.current.bulk.run({ kind: "priority", priority: "low" });
    });
    expect(h.bulkEdit).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await first;
    });
  });
});

describe("a bulk action that is refused", () => {
  it("rolls the rows back and says NOTHING was changed — with how many items were the reason", async () => {
    h.bulkEdit.mockRejectedValue(new BulkRequestError("work_items_forbidden", 403, "work_items_forbidden", ["w2", "w5"]));
    const { result, toast, announce } = setup();
    await act(async () => {
      await result.current.bulk.run({ kind: "state", stateId: DONE.id });
    });

    expect(result.current.optimistic.pending.size).toBe(0);
    expect(result.current.optimistic.apply(ROWS)).toEqual(ROWS);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/can't change 2 of these items, so nothing was changed/), "error");
    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/nothing was changed/));
    expect(result.current.bulk.busy).toBe(false);
  });

  it("keeps the selection, so the person can adjust it and try again", async () => {
    h.bulkEdit.mockRejectedValue(new BulkRequestError("work_item_not_found", 404, "work_item_not_found", ["w1"]));
    const { result } = setup();
    await act(async () => {
      await result.current.bulk.run({ kind: "priority", priority: "high" });
    });
    expect(result.current.selection.count).toBe(2);
  });

  it("re-reads the list after a refusal — a stale selection is the usual reason", async () => {
    h.bulkEdit.mockRejectedValue(new BulkRequestError("work_item_not_found", 404, "work_item_not_found", ["w1"]));
    const { result, refresh } = setup();
    await act(async () => {
      await result.current.bulk.run({ kind: "priority", priority: "high" });
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("explains a cross-project selection in words, not a code", async () => {
    h.bulkEdit.mockRejectedValue(new BulkRequestError("invalid_state", 422, "invalid_state", ["w2"]));
    const { result, toast } = setup();
    await act(async () => {
      await result.current.bulk.run({ kind: "state", stateId: DONE.id });
    });
    const said = toast.mock.calls[0][0] as string;
    expect(said).toMatch(/nothing was changed/);
    expect(said).not.toMatch(/invalid_state/);
  });
});
