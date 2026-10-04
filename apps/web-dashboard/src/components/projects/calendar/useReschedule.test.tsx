import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { PmWorkItem } from "../types";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const updateItem = vi.fn();
vi.mock("../usePm", () => ({ pmActions: () => ({ updateItem }) }));

import { useReschedule, RESCHEDULE_FAILED } from "./useReschedule";

function item(over: Partial<PmWorkItem> = {}): PmWorkItem {
  return {
    id: "w1",
    projectId: "p",
    sequenceId: 1,
    key: "INBOX-1",
    name: "First task",
    descriptionHtml: null,
    stateId: "s1",
    state: { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: null, sortOrder: 1, isDefault: true },
    priority: "none",
    parentId: null,
    cycleId: null,
    department: null,
    assignees: [],
    labels: [],
    startDate: null,
    dueDate: "2026-10-03T00:00:00.000Z",
    sortOrder: 1,
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  toast.mockReset();
  updateItem.mockReset();
});

describe("useReschedule", () => {
  it("paints the new date at once, PATCHes only what changed, then drops the overlay after onSaved", async () => {
    const d = deferred<{ work_item: PmWorkItem }>();
    updateItem.mockReturnValueOnce(d.promise);
    const onSaved = vi.fn(async () => undefined);
    const announce = vi.fn();
    const base = [item()];
    const { result } = renderHook(() => useReschedule({ onSaved, announce }));

    let saved: Promise<boolean> = Promise.resolve(false);
    act(() => {
      saved = result.current.reschedule(base[0], { startDate: null, dueDate: "2026-10-09" });
    });

    // Optimistic: the displayed item already carries the new calendar date.
    expect(result.current.withPending(base)[0].dueDate).toBe("2026-10-09");
    expect(result.current.isPending("w1")).toBe(true);
    expect(updateItem).toHaveBeenCalledWith("w1", { due_date: "2026-10-09T00:00:00.000Z" });

    await act(async () => {
      d.resolve({ work_item: item({ dueDate: "2026-10-09T00:00:00.000Z" }) });
      await saved;
    });

    await expect(saved).resolves.toBe(true);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Moved INBOX-1 to Oct 9");
    expect(result.current.isPending("w1")).toBe(false);
    expect(result.current.withPending(base)).toBe(base);
    expect(toast).not.toHaveBeenCalled();
  });

  it("rolls back on a failed save: overlay dropped, toast with the verbatim brief copy, announcement", async () => {
    updateItem.mockRejectedValueOnce(new Error("boom"));
    const announce = vi.fn();
    const onSaved = vi.fn();
    const base = [item()];
    const { result } = renderHook(() => useReschedule({ onSaved, announce }));

    let ok = true;
    await act(async () => {
      ok = await result.current.reschedule(base[0], { startDate: null, dueDate: "2026-10-09" });
    });

    expect(ok).toBe(false);
    expect(result.current.withPending(base)[0].dueDate).toBe("2026-10-03T00:00:00.000Z");
    expect(result.current.isPending("w1")).toBe(false);
    expect(toast).toHaveBeenCalledWith(RESCHEDULE_FAILED, "error");
    expect(RESCHEDULE_FAILED).toBe("Couldn't move that item — try again.");
    expect(announce).toHaveBeenCalledWith(RESCHEDULE_FAILED);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("moves a span by sending both dates, as UTC-midnight datetimes", async () => {
    updateItem.mockResolvedValueOnce({ work_item: item({ startDate: "2026-11-01T00:00:00.000Z", dueDate: "2026-11-05T00:00:00.000Z" }) });
    const span = item({ startDate: "2026-10-30T00:00:00.000Z", dueDate: "2026-11-03T00:00:00.000Z" });
    const { result } = renderHook(() => useReschedule());
    await act(async () => {
      await result.current.reschedule(span, { startDate: "2026-11-01", dueDate: "2026-11-05" });
    });
    expect(updateItem).toHaveBeenCalledWith("w1", {
      start_date: "2026-11-01T00:00:00.000Z",
      due_date: "2026-11-05T00:00:00.000Z",
    });
  });

  it("does nothing when the schedule is unchanged", async () => {
    const { result } = renderHook(() => useReschedule());
    let ok = false;
    await act(async () => {
      ok = await result.current.reschedule(item(), { startDate: null, dueDate: "2026-10-03" });
    });
    expect(ok).toBe(true);
    expect(updateItem).not.toHaveBeenCalled();
    expect(result.current.isPending("w1")).toBe(false);
  });

  it("serialises saves for one item: the second waits for the first and the last gesture wins", async () => {
    const first = deferred<{ work_item: PmWorkItem }>();
    const second = deferred<{ work_item: PmWorkItem }>();
    updateItem.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const base = [item()];
    const { result } = renderHook(() => useReschedule());

    let p1: Promise<boolean> = Promise.resolve(false);
    let p2: Promise<boolean> = Promise.resolve(false);
    act(() => {
      p1 = result.current.reschedule(base[0], { startDate: null, dueDate: "2026-10-05" });
      p2 = result.current.reschedule(base[0], { startDate: null, dueDate: "2026-10-07" });
    });

    // Only the first request is on the wire; the overlay already shows the latest gesture.
    expect(updateItem).toHaveBeenCalledTimes(1);
    expect(result.current.withPending(base)[0].dueDate).toBe("2026-10-07");

    await act(async () => {
      first.resolve({ work_item: item({ dueDate: "2026-10-05T00:00:00.000Z" }) });
      await p1;
    });
    await waitFor(() => expect(updateItem).toHaveBeenCalledTimes(2));
    // The second PATCH is diffed against what the server confirmed, not the original.
    expect(updateItem).toHaveBeenLastCalledWith("w1", { due_date: "2026-10-07T00:00:00.000Z" });
    // The overlay survives until the last save lands.
    expect(result.current.isPending("w1")).toBe(true);

    await act(async () => {
      second.resolve({ work_item: item({ dueDate: "2026-10-07T00:00:00.000Z" }) });
      await p2;
    });
    expect(result.current.isPending("w1")).toBe(false);
  });

  it("a failed first save does not stop the queued one, which keeps the overlay", async () => {
    const first = deferred<{ work_item: PmWorkItem }>();
    updateItem.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ work_item: item({ dueDate: "2026-10-07T00:00:00.000Z" }) });
    const base = [item()];
    const { result } = renderHook(() => useReschedule());

    let p1: Promise<boolean> = Promise.resolve(true);
    let p2: Promise<boolean> = Promise.resolve(false);
    act(() => {
      p1 = result.current.reschedule(base[0], { startDate: null, dueDate: "2026-10-05" });
      p2 = result.current.reschedule(base[0], { startDate: null, dueDate: "2026-10-07" });
    });
    await act(async () => {
      first.reject(new Error("nope"));
      await p1;
      await p2;
    });
    await expect(p1).resolves.toBe(false);
    await expect(p2).resolves.toBe(true);
    // Diffed against the ORIGINAL date because the first save never confirmed anything.
    expect(updateItem).toHaveBeenLastCalledWith("w1", { due_date: "2026-10-07T00:00:00.000Z" });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(result.current.isPending("w1")).toBe(false);
  });
});
