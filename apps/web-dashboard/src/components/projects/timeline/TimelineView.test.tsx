// WARP-3523 — the Timeline (Gantt) layout: placement on calendar dates in any
// zone, grouping, dependency connectors, milestones, today line, zoom / window
// navigation, drag / resize / keyboard rescheduling (optimistic, rolls back),
// virtualised rows for 1,000 items, read-only, and every state.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import type { PmState, PmWorkItem } from "../types";
import type { PmTimeline } from "./types";
import { diffDays } from "../calendar/dateOnly";
import { makeScale, rangeFor } from "./scale";
import { ROW_H } from "./rows";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const updateItem = vi.fn();
vi.mock("../usePm", () => ({ pmActions: () => ({ updateItem }), PmRequestError: class extends Error {} }));

const todayRef = { current: "2026-10-03" };
vi.mock("../calendar/useToday", () => ({ useToday: () => todayRef.current }));

const hook = {
  data: undefined as PmTimeline | undefined,
  error: undefined as unknown,
  isLoading: false,
  calls: [] as Array<{ projectId: string | null; from: string; to: string }>,
  mutate: vi.fn(async () => undefined),
};
vi.mock("./useTimeline", () => ({
  useTimeline: (projectId: string | null, range: { from: string; to: string }) => {
    hook.calls.push({ projectId, from: range.from, to: range.to });
    return { timeline: hook.data, error: hook.error, isLoading: hook.isLoading, mutate: hook.mutate };
  },
}));

import { TimelineView, HEADER_H, type TimelineViewProps } from "./TimelineView";

const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

beforeAll(() => {
  // jsdom ships no PointerEvent; the drag handlers read clientX / button / pointerId.
  if (typeof window.PointerEvent === "undefined") {
    class PE extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (window as unknown as { PointerEvent: unknown }).PointerEvent = PE;
  }
});

const TODO: PmState = { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true };
const DOING: PmState = { id: "s2", projectId: "p", name: "In Progress", group: "started", color: "#f59e0b", sortOrder: 2, isDefault: false };
const DONE: PmState = { id: "s3", projectId: "p", name: "Done", group: "completed", color: "#22c55e", sortOrder: 3, isDefault: false };

let seq = 0;
function item(over: Partial<PmWorkItem> = {}): PmWorkItem {
  seq += 1;
  return {
    id: `w${seq}`,
    projectId: "p",
    sequenceId: seq,
    key: `INBOX-${seq}`,
    name: `Task ${seq}`,
    descriptionHtml: null,
    stateId: TODO.id,
    state: TODO,
    priority: "none",
    parentId: null,
    cycleId: null,
    department: null,
    assignees: [],
    labels: [],
    startDate: null,
    dueDate: null,
    sortOrder: seq,
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}
const wire = (d: string) => `${d}T00:00:00.000Z`;
const span = (start: string, due: string, over: Partial<PmWorkItem> = {}) =>
  item({ startDate: wire(start), dueDate: wire(due), ...over });

function timeline(over: Partial<PmTimeline> = {}): PmTimeline {
  return { from: "", to: "", items: [], relations: [], milestones: [], unscheduledCount: 0, truncated: false, ...over };
}

const LABEL_W = 280;
const weekScale = () => makeScale(rangeFor(todayRef.current, "week"), "week");
const leftOf = (day: string) => LABEL_W + weekScale().x(day);

function setup(items: PmWorkItem[], extra: Partial<PmTimeline> = {}, props: Partial<TimelineViewProps> = {}) {
  hook.data = timeline({ items, ...extra });
  const onOpen = vi.fn();
  const utils = render(
    <TimelineView
      projectId="p"
      visibleIds={null}
      revision="r1"
      domain="populated"
      readOnly={false}
      onOpen={onOpen}
      onChanged={async () => undefined}
      {...props}
    />,
  );
  return { ...utils, onOpen };
}

const bar = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-tl-item="${id}"]`)!;
const grip = (el: HTMLElement, which: "start" | "end") => el.querySelector<HTMLElement>(`[data-tl-grip="${which}"]`)!;
const px = (el: HTMLElement) => ({ left: parseFloat(el.style.left), width: parseFloat(el.style.width) });
const PPD = 14; // week zoom

beforeEach(() => {
  seq = 0;
  toast.mockReset();
  updateItem.mockReset();
  hook.data = undefined;
  hook.error = undefined;
  hook.isLoading = false;
  hook.calls = [];
  hook.mutate = vi.fn(async () => undefined);
  todayRef.current = "2026-10-03";
});

describe("window and zoom", () => {
  it("asks for ONE window around today — 12 weeks back, 26 ahead — at the default week zoom", () => {
    setup([span("2026-10-05", "2026-10-10")]);
    expect(hook.calls[0]).toEqual({ projectId: "p", from: "2026-07-11", to: "2027-04-03" });
  });

  it("zoom changes the window; every window stays inside the API's 1100-day cap", () => {
    const { container } = setup([span("2026-10-05", "2026-10-10")]);
    const scroller = container.querySelector<HTMLElement>("[data-pm-tl-scroll]")!;
    // Pretend the view is scrolled so that today sits a third of the way across the track.
    Object.defineProperty(scroller, "scrollLeft", { configurable: true, writable: true, value: weekScale().x("2026-10-03") + 7 - 80 });
    for (const [label, from, to] of [
      ["Day", "2026-09-03", "2026-12-02"],
      ["Month", "2026-04-06", "2027-10-03"],
      ["Quarter", "2025-10-03", "2028-10-02"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      const last = hook.calls[hook.calls.length - 1];
      expect([last.from, last.to]).toEqual([from, to]);
      expect(diffDays(last.from, last.to) + 1).toBeLessThanOrEqual(1100);
      expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
      // Re-centre on today in the zoom just selected, so the next click starts from a known day.
      const z = label.toLowerCase() as "day" | "month" | "quarter";
      const s = makeScale(rangeFor("2026-10-03", z), z);
      Object.defineProperty(scroller, "scrollLeft", {
        configurable: true,
        writable: true,
        value: s.x("2026-10-03") + s.pxPerDay / 2 - 80,
      });
    }
  });

  it("Earlier and Later move the window by a step; Today brings it back", () => {
    setup([span("2026-10-05", "2026-10-10")]);
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(hook.calls[hook.calls.length - 1].from).toBe(rangeFor("2026-12-26", "week").from); // today + 84 days
    fireEvent.click(screen.getByRole("button", { name: "Earlier" }));
    fireEvent.click(screen.getByRole("button", { name: "Earlier" }));
    expect(hook.calls[hook.calls.length - 1].from).toBe(rangeFor("2026-07-11", "week").from); // today - 84 days
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(hook.calls[hook.calls.length - 1]).toMatchObject({ from: "2026-07-11", to: "2027-04-03" });
  });

  it("refetches when the board's data changes (an edit in the drawer), but not on first render", () => {
    const { rerender } = setup([span("2026-10-05", "2026-10-10")]);
    expect(hook.mutate).not.toHaveBeenCalled();
    rerender(
      <TimelineView projectId="p" visibleIds={null} revision="r2" domain="populated" readOnly={false} onOpen={() => undefined} onChanged={async () => undefined} />,
    );
    expect(hook.mutate).toHaveBeenCalledTimes(1);
  });
});

describe.each(["America/Los_Angeles", "Pacific/Auckland"])("placement on calendar dates — TZ=%s", (tz) => {
  it("a span sits from its first day to the end of its last, not a day early", () => {
    process.env.TZ = tz;
    const a = span("2026-10-05", "2026-10-10");
    const { container } = setup([a]);
    expect(px(bar(container, a.id))).toEqual({ left: leftOf("2026-10-05"), width: 6 * PPD });
  });

  it("a one-date item is a diamond on that day, whichever date it carries", () => {
    process.env.TZ = tz;
    const due = item({ dueDate: wire("2026-10-05") });
    const start = item({ startDate: wire("2026-10-07") });
    const { container } = setup([due, start]);
    expect(bar(container, due.id)).toHaveAttribute("data-tl-bar", "point");
    expect(bar(container, start.id)).toHaveAttribute("data-tl-bar", "point");
    // Centre of the day, minus half the 14px diamond, minus the 5px that widens it to a 24px target.
    expect(px(bar(container, due.id)).left).toBe(leftOf("2026-10-05") + PPD / 2 - 7);
    expect(px(bar(container, start.id)).left).toBe(leftOf("2026-10-07") + PPD / 2 - 7);
  });
});

describe("rows", () => {
  it("groups by state in board order with counts, and collapses a group on its header", () => {
    const a = item({ dueDate: wire("2026-10-05"), state: DOING, stateId: DOING.id });
    const b = item({ dueDate: wire("2026-10-06") });
    const c = item({ dueDate: wire("2026-10-07") });
    const { container } = setup([a, b, c]);
    const heads = [...container.querySelectorAll(".pm-tl-grouphead")].map((h) => h.textContent);
    expect(heads).toEqual(["Todo2", "In Progress1"]);
    expect(container.querySelectorAll("[data-tl-item]")).toHaveLength(3);

    const todo = screen.getByRole("button", { name: /^Todo/ });
    expect(todo).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(todo);
    expect(todo).toHaveAttribute("aria-expanded", "false");
    expect([...container.querySelectorAll("[data-tl-item]")].map((e) => e.getAttribute("data-tl-item"))).toEqual([a.id]);
  });

  it("only shows what the page's filters admit", () => {
    const a = item({ dueDate: wire("2026-10-05") });
    const b = item({ dueDate: wire("2026-10-06") });
    const { container } = setup([a, b], {}, { visibleIds: new Set([b.id]) });
    expect(bar(container, a.id)).toBeNull();
    expect(bar(container, b.id)).toBeTruthy();
  });

  it("each item's accessible name carries its key, title, dates and state", () => {
    const a = span("2026-10-05", "2026-10-10");
    const { container } = setup([a]);
    expect(bar(container, a.id)).toHaveAccessibleName("INBOX-1, Task 1, Oct 5 – Oct 10, Todo");
  });

  it("an open item past its due date is orange-flagged and named overdue; due today and finished are not", () => {
    const late = item({ dueDate: wire("2026-10-02") });
    const today = item({ dueDate: wire("2026-10-03") });
    const done = item({ dueDate: wire("2026-10-01"), state: DONE, stateId: DONE.id });
    const { container } = setup([late, today, done]);
    expect(bar(container, late.id)).toHaveClass("overdue");
    expect(bar(container, late.id)).toHaveAccessibleName(/, overdue/);
    expect(bar(container, today.id)).not.toHaveClass("overdue");
    expect(bar(container, done.id)).not.toHaveClass("overdue");
    expect(bar(container, done.id)).toHaveClass("done");
  });
});

describe("dependencies, milestones and today", () => {
  it("draws a connector per BLOCKS relation and flags one whose blocked item starts too early", () => {
    const a = span("2026-10-05", "2026-10-10");
    const b = span("2026-10-08", "2026-10-12"); // starts before a ends -> conflict
    const c = span("2026-10-20", "2026-10-22"); // starts after a ends -> fine
    const { container } = setup([a, b, c], {
      relations: [
        { id: "r1", kind: "BLOCKS", fromId: a.id, toId: b.id },
        { id: "r2", kind: "BLOCKS", fromId: a.id, toId: c.id },
      ],
    });
    const paths = [...container.querySelectorAll<SVGPathElement>("path.pm-tl-link")];
    expect(paths).toHaveLength(2);
    expect(paths.filter((p) => p.dataset.conflict === "true")).toHaveLength(1);
  });

  it("names the dependency on both bars, and ignores a relation whose other end is not drawn", () => {
    const a = span("2026-10-05", "2026-10-10");
    const b = span("2026-10-20", "2026-10-22");
    const { container } = setup([a, b], {
      relations: [
        { id: "r1", kind: "BLOCKS", fromId: a.id, toId: b.id },
        { id: "r2", kind: "BLOCKS", fromId: a.id, toId: "not-in-view" },
      ],
    });
    expect(bar(container, a.id)).toHaveAccessibleName(/, blocks INBOX-2$/);
    expect(bar(container, b.id)).toHaveAccessibleName(/, blocked by INBOX-1$/);
    expect(container.querySelectorAll("path.pm-tl-link")).toHaveLength(1);
  });

  it("collapsing a group removes connectors to its rows", () => {
    const a = span("2026-10-05", "2026-10-10");
    const b = span("2026-10-20", "2026-10-22", { state: DOING, stateId: DOING.id });
    const { container } = setup([a, b], { relations: [{ id: "r1", kind: "BLOCKS", fromId: a.id, toId: b.id }] });
    expect(container.querySelectorAll("path.pm-tl-link")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^In Progress/ }));
    expect(container.querySelectorAll("path.pm-tl-link")).toHaveLength(0);
  });

  it("shows module target dates inside the window as milestones, and a line for today", () => {
    const { container } = setup([span("2026-10-05", "2026-10-10")], {
      milestones: [
        { id: "m1", name: "Beta", status: "in_progress", targetDate: "2026-10-30" },
        { id: "m2", name: "Someday", status: "planned", targetDate: "2030-01-01" },
      ],
    });
    expect(screen.getByRole("img", { name: "Milestone: Beta, Oct 30" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Someday/ })).toBeNull();
    const line = container.querySelector<HTMLElement>(".pm-tl-today")!;
    expect(parseFloat(line.style.left)).toBe(weekScale().x("2026-10-03") + PPD / 2);
  });

  it("has no today line when today is outside the window", () => {
    todayRef.current = "2026-10-03";
    const { container } = setup([span("2026-10-05", "2026-10-10")]);
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(container.querySelector(".pm-tl-today")).toBeNull();
  });
});

describe("pointer: move and resize", () => {
  const down = (el: HTMLElement, x: number) => fireEvent.pointerDown(el, { clientX: x, button: 0, pointerId: 1 });
  const move = (el: HTMLElement, x: number) => fireEvent.pointerMove(el, { clientX: x, pointerId: 1 });
  const up = (el: HTMLElement, x: number) => fireEvent.pointerUp(el, { clientX: x, pointerId: 1 });

  it("dragging a bar moves BOTH dates by whole days, previewing live and PATCHing on release", async () => {
    const a = span("2026-10-05", "2026-10-10");
    let resolve!: (v: unknown) => void;
    updateItem.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const { container } = setup([a]);
    const el = bar(container, a.id);

    down(el, 500);
    move(el, 500 + 3 * PPD + 4); // 3.3 days -> rounds to 3
    expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-08"));
    expect(updateItem).not.toHaveBeenCalled();
    up(el, 500 + 3 * PPD + 4);

    expect(updateItem).toHaveBeenCalledWith(a.id, {
      start_date: "2026-10-08T00:00:00.000Z",
      due_date: "2026-10-13T00:00:00.000Z",
    });
    // Optimistic while the request is in flight.
    expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-08"));
    await act(async () => {
      resolve({ work_item: { ...a, startDate: wire("2026-10-08"), dueDate: wire("2026-10-13") } });
    });
    expect(hook.mutate).toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("a rejected save snaps the bar back and toasts", async () => {
    const a = span("2026-10-05", "2026-10-10");
    updateItem.mockRejectedValueOnce(new Error("nope"));
    const { container } = setup([a]);
    const el = bar(container, a.id);
    down(el, 500);
    move(el, 500 + 2 * PPD);
    await act(async () => {
      up(el, 500 + 2 * PPD);
    });
    await waitFor(() => expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-05")));
    expect(toast).toHaveBeenCalledWith("Couldn't move that item — try again.", "error");
  });

  it("dragging the right edge changes only the due date", async () => {
    const a = span("2026-10-05", "2026-10-10");
    updateItem.mockResolvedValueOnce({ work_item: a });
    const { container } = setup([a]);
    const handle = grip(bar(container, a.id), "end");
    down(handle, 700);
    move(handle, 700 + 2 * PPD);
    expect(px(bar(container, a.id))).toEqual({ left: leftOf("2026-10-05"), width: 8 * PPD });
    await act(async () => {
      up(handle, 700 + 2 * PPD);
    });
    expect(updateItem).toHaveBeenCalledWith(a.id, { due_date: "2026-10-12T00:00:00.000Z" });
  });

  it("dragging the left edge changes only the start date", async () => {
    const a = span("2026-10-05", "2026-10-10");
    updateItem.mockResolvedValueOnce({ work_item: a });
    const { container } = setup([a]);
    const handle = grip(bar(container, a.id), "start");
    down(handle, 700);
    move(handle, 700 - 2 * PPD);
    await act(async () => {
      up(handle, 700 - 2 * PPD);
    });
    expect(updateItem).toHaveBeenCalledWith(a.id, { start_date: "2026-10-03T00:00:00.000Z" });
  });

  it("an edge cannot be dragged past the other: the span stays at least one day", async () => {
    const a = span("2026-10-05", "2026-10-10");
    updateItem.mockResolvedValueOnce({ work_item: a });
    const { container } = setup([a]);
    const handle = grip(bar(container, a.id), "start");
    down(handle, 700);
    move(handle, 700 + 40 * PPD);
    await act(async () => {
      up(handle, 700 + 40 * PPD);
    });
    expect(updateItem).toHaveBeenCalledWith(a.id, { start_date: "2026-10-10T00:00:00.000Z" });
  });

  it("a diamond moves the one date it has", async () => {
    const a = item({ dueDate: wire("2026-10-05") });
    const b = item({ startDate: wire("2026-10-07") });
    updateItem.mockResolvedValue({ work_item: a });
    const { container } = setup([a, b]);
    down(bar(container, a.id), 300);
    move(bar(container, a.id), 300 + PPD);
    await act(async () => {
      up(bar(container, a.id), 300 + PPD);
    });
    expect(updateItem).toHaveBeenLastCalledWith(a.id, { due_date: "2026-10-06T00:00:00.000Z" });
    down(bar(container, b.id), 300);
    move(bar(container, b.id), 300 - PPD);
    await act(async () => {
      up(bar(container, b.id), 300 - PPD);
    });
    expect(updateItem).toHaveBeenLastCalledWith(b.id, { start_date: "2026-10-06T00:00:00.000Z" });
  });

  it("keeps the calendar date across the LA fall-back and the Auckland spring-forward", async () => {
    for (const [tz, start, due, shift, expectStart, expectDue] of [
      ["America/Los_Angeles", "2026-10-30", "2026-11-01", 2, "2026-11-01", "2026-11-03"],
      ["Pacific/Auckland", "2026-09-25", "2026-09-27", 2, "2026-09-27", "2026-09-29"],
    ] as const) {
      process.env.TZ = tz;
      updateItem.mockReset();
      updateItem.mockResolvedValue({ work_item: item() });
      const a = span(start, due);
      const { container, unmount } = setup([a]);
      const el = bar(container, a.id);
      down(el, 400);
      move(el, 400 + shift * PPD);
      await act(async () => {
        up(el, 400 + shift * PPD);
      });
      expect(updateItem).toHaveBeenCalledWith(a.id, { start_date: wire(expectStart), due_date: wire(expectDue) });
      unmount();
    }
  });

  it("a click opens the item; a drag does not (the click that follows it is swallowed)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const a = span("2026-10-05", "2026-10-10");
      updateItem.mockResolvedValue({ work_item: a });
      const { container, onOpen } = setup([a]);
      const el = bar(container, a.id);
      down(el, 500);
      up(el, 500);
      fireEvent.click(el);
      expect(onOpen).toHaveBeenCalledTimes(1);

      down(el, 500);
      move(el, 500 + 2 * PPD);
      await act(async () => {
        up(el, 500 + 2 * PPD);
      });
      fireEvent.click(el);
      expect(onOpen).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.runAllTimers();
      });
      fireEvent.click(el);
      expect(onOpen).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("the gesture does not depend on the element that started it", () => {
    const winDown = down;
    const release = (x: number, pointerId = 1) => fireEvent.pointerUp(document.body, { clientX: x, pointerId });

    it("an edge dragged before the fetched window keeps its grip mounted, and a release anywhere saves it", async () => {
      // Week zoom starts 2026-07-11. This bar starts two days later.
      const a = span("2026-07-13", "2026-07-30");
      updateItem.mockResolvedValueOnce({ work_item: a });
      const { container } = setup([a]);
      const handle = grip(bar(container, a.id), "start");
      winDown(handle, 700);
      move(handle, 700 - 5 * PPD); // start 2026-07-08: before the window, so the bar is now clipped
      expect(bar(container, a.id)).toHaveClass("clip-start", "is-dragging");
      // The element that owns the pointer capture is still in the document ...
      expect(handle.isConnected).toBe(true);
      expect(grip(bar(container, a.id), "start")).toBe(handle);
      // ... and, because the gesture is on window, so is a release over something else entirely.
      await act(async () => {
        release(700 - 5 * PPD);
      });
      expect(updateItem).toHaveBeenCalledTimes(1);
      expect(updateItem).toHaveBeenCalledWith(a.id, { start_date: "2026-07-08T00:00:00.000Z" });
      expect(bar(container, a.id)).not.toHaveClass("is-dragging");
    });

    it("an edge dragged past the end of the window does the same", async () => {
      // Week zoom ends 2027-04-03.
      const a = span("2027-03-25", "2027-04-01");
      updateItem.mockResolvedValueOnce({ work_item: a });
      const { container } = setup([a]);
      const handle = grip(bar(container, a.id), "end");
      winDown(handle, 900);
      move(handle, 900 + 5 * PPD); // due 2027-04-06
      expect(bar(container, a.id)).toHaveClass("clip-end");
      expect(handle.isConnected).toBe(true);
      await act(async () => {
        release(900 + 5 * PPD);
      });
      expect(updateItem).toHaveBeenCalledWith(a.id, { due_date: "2027-04-06T00:00:00.000Z" });
    });

    it("a bar carried entirely out of the window stays mounted until it is released", async () => {
      const a = span("2026-10-05", "2026-10-10");
      updateItem.mockResolvedValueOnce({ work_item: a });
      const { container } = setup([a]);
      const el = bar(container, a.id);
      winDown(el, 500);
      move(el, 500 + 300 * PPD); // ~10 months later, long past the window's end
      expect(el.isConnected).toBe(true);
      expect(bar(container, a.id)).toBe(el);
      await act(async () => {
        release(500 + 300 * PPD);
      });
      expect(updateItem).toHaveBeenCalledWith(a.id, {
        start_date: "2027-08-01T00:00:00.000Z",
        due_date: "2027-08-06T00:00:00.000Z",
      });
    });

    it("a pointercancel anywhere abandons the gesture without saving", () => {
      const a = span("2026-10-05", "2026-10-10");
      const { container } = setup([a]);
      const el = bar(container, a.id);
      winDown(el, 500);
      move(el, 500 + 3 * PPD);
      expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-08"));
      fireEvent.pointerCancel(document.body, { pointerId: 1 });
      expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-05"));
      expect(bar(container, a.id)).not.toHaveClass("is-dragging");
      expect(updateItem).not.toHaveBeenCalled();
    });

    it("once settled, later pointer movement does nothing (the window listeners are gone)", async () => {
      const a = span("2026-10-05", "2026-10-10");
      let resolve!: (v: unknown) => void;
      updateItem.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
      const { container } = setup([a]);
      const el = bar(container, a.id);
      winDown(el, 500);
      move(el, 500 + 2 * PPD);
      release(500 + 2 * PPD);
      expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-07")); // optimistic, from the save
      fireEvent.pointerMove(document.body, { clientX: 500 + 9 * PPD, pointerId: 1 });
      expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-07"));
      fireEvent.pointerUp(document.body, { clientX: 500 + 9 * PPD, pointerId: 1 });
      expect(updateItem).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolve({ work_item: a });
      });
    });

    it("another finger cannot move or end the gesture", async () => {
      const a = span("2026-10-05", "2026-10-10");
      updateItem.mockResolvedValueOnce({ work_item: a });
      const { container } = setup([a]);
      const el = bar(container, a.id);
      winDown(el, 500);
      move(el, 500 + 2 * PPD);
      fireEvent.pointerMove(document.body, { clientX: 500 + 9 * PPD, pointerId: 2 });
      release(500 + 9 * PPD, 2);
      expect(updateItem).not.toHaveBeenCalled();
      expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-07"));
      await act(async () => {
        release(500 + 2 * PPD, 1);
      });
      expect(updateItem).toHaveBeenCalledWith(a.id, {
        start_date: "2026-10-07T00:00:00.000Z",
        due_date: "2026-10-12T00:00:00.000Z",
      });
    });

    it("starting a new gesture while one never saw its release drops the old preview", () => {
      const a = span("2026-10-05", "2026-10-10");
      const b = span("2026-10-06", "2026-10-12");
      const { container } = setup([a, b]);
      winDown(bar(container, a.id), 500);
      move(bar(container, a.id), 500 + 3 * PPD);
      expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-08"));
      // The release was lost; the user presses another bar.
      winDown(bar(container, b.id), 300);
      expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-05"));
      expect(bar(container, a.id)).not.toHaveClass("is-dragging");
      release(300);
      expect(updateItem).not.toHaveBeenCalled();
    });

    it("a plain click after a press that moved nowhere leaves no preview behind", () => {
      const a = span("2026-10-05", "2026-10-10");
      const { container, onOpen } = setup([a]);
      const el = bar(container, a.id);
      winDown(el, 500);
      release(500);
      fireEvent.click(el);
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(bar(container, a.id)).not.toHaveClass("is-dragging");
      expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-05"));
    });
  });

  it("Escape cancels a drag in progress", () => {
    const a = span("2026-10-05", "2026-10-10");
    const { container } = setup([a]);
    const el = bar(container, a.id);
    down(el, 500);
    move(el, 500 + 3 * PPD);
    expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-08"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-05"));
    up(el, 500 + 3 * PPD);
    expect(updateItem).not.toHaveBeenCalled();
  });

  it("read-only roles get no resize grips and cannot drag", () => {
    const a = span("2026-10-05", "2026-10-10");
    const { container } = setup([a], {}, { readOnly: true });
    expect(container.querySelector("[data-tl-grip]")).toBeNull();
    const el = bar(container, a.id);
    down(el, 500);
    move(el, 500 + 3 * PPD);
    up(el, 500 + 3 * PPD);
    expect(updateItem).not.toHaveBeenCalled();
    expect(px(bar(container, a.id)).left).toBe(leftOf("2026-10-05"));
  });

  it("a bar too narrow for grips offers none", () => {
    const a = span("2026-10-05", "2026-10-06"); // 2 days = 28px
    const { container } = setup([a]);
    expect(container.querySelector("[data-tl-grip]")).toBeNull();
  });
});

describe("keyboard", () => {
  it.each([
    ["ArrowRight", {}, "2026-10-06", "2026-10-11"],
    ["ArrowLeft", {}, "2026-10-04", "2026-10-09"],
    ["ArrowRight", { shiftKey: true }, "2026-10-12", "2026-10-17"],
    ["ArrowLeft", { shiftKey: true }, "2026-09-28", "2026-10-03"],
  ])("%s %j moves the whole span (%s – %s) and keeps focus", async (key, mods, start, due) => {
    const a = span("2026-10-05", "2026-10-10");
    updateItem.mockResolvedValue({ work_item: a });
    const { container } = setup([a]);
    bar(container, a.id).focus();
    await act(async () => {
      fireEvent.keyDown(bar(container, a.id), { key, ...mods });
    });
    expect(updateItem).toHaveBeenCalledWith(a.id, { start_date: wire(start), due_date: wire(due) });
    expect(document.activeElement).toBe(bar(container, a.id));
  });

  it("↑ and ↓ move focus to the neighbouring row's bar", () => {
    const a = span("2026-10-05", "2026-10-10");
    const b = span("2026-10-06", "2026-10-12");
    const c = item({ dueDate: wire("2026-10-07") });
    const { container } = setup([a, b, c]);
    bar(container, a.id).focus();
    fireEvent.keyDown(bar(container, a.id), { key: "ArrowDown" });
    expect(document.activeElement).toBe(bar(container, b.id));
    fireEvent.keyDown(bar(container, b.id), { key: "ArrowDown" });
    expect(document.activeElement).toBe(bar(container, c.id));
    fireEvent.keyDown(bar(container, c.id), { key: "ArrowDown" });
    expect(document.activeElement).toBe(bar(container, c.id));
    fireEvent.keyDown(bar(container, c.id), { key: "ArrowUp" });
    expect(document.activeElement).toBe(bar(container, b.id));
    expect(updateItem).not.toHaveBeenCalled();
  });

  it("Enter and Space open the item", () => {
    const a = span("2026-10-05", "2026-10-10");
    const { container, onOpen } = setup([a]);
    fireEvent.keyDown(bar(container, a.id), { key: "Enter" });
    fireEvent.keyDown(bar(container, a.id), { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("is a single tab stop (roving), not one per bar", () => {
    const rows = [span("2026-10-05", "2026-10-10"), span("2026-10-06", "2026-10-12"), span("2026-10-07", "2026-10-13")];
    const { container } = setup(rows);
    const stops = [...container.querySelectorAll<HTMLElement>("[data-tl-item]")].filter((e) => e.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0].dataset.tlItem).toBe(rows[0].id);
    fireEvent.focus(bar(container, rows[2].id));
    const after = [...container.querySelectorAll<HTMLElement>("[data-tl-item]")].filter((e) => e.tabIndex === 0);
    expect(after.map((e) => e.dataset.tlItem)).toEqual([rows[2].id]);
  });

  it("ignores modified arrows, and read-only roles can look but not move", () => {
    const a = span("2026-10-05", "2026-10-10");
    const b = span("2026-10-06", "2026-10-12");
    const { container } = setup([a, b], {}, { readOnly: true });
    fireEvent.keyDown(bar(container, a.id), { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(bar(container, a.id), { key: "ArrowRight" });
    expect(updateItem).not.toHaveBeenCalled();
    bar(container, a.id).focus();
    fireEvent.keyDown(bar(container, a.id), { key: "ArrowDown" });
    expect(document.activeElement).toBe(bar(container, b.id));
  });

  it("announces a keyboard move for screen readers", async () => {
    const a = span("2026-10-05", "2026-10-10");
    updateItem.mockResolvedValue({ work_item: a });
    const { container } = setup([a]);
    await act(async () => {
      fireEvent.keyDown(bar(container, a.id), { key: "ArrowRight" });
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved INBOX-1 to Oct 6 – Oct 11"));
  });
});

describe("virtualised rows", () => {
  it("renders a bounded slice of 1,000 items and follows the scroll position", () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      span("2026-10-05", "2026-10-10", { sortOrder: i, sequenceId: i + 1, key: `BIG-${i + 1}`, id: `big${i + 1}` }),
    );
    const { container } = setup(many);
    const inner = container.querySelector<HTMLElement>(".pm-tl-inner")!;
    // 1 group header + 1000 rows, each ROW_H tall, under the sticky header.
    expect(parseFloat(inner.style.height)).toBe(HEADER_H + 1001 * ROW_H);

    const first = container.querySelectorAll("[data-tl-item]").length;
    expect(first).toBeGreaterThan(5);
    expect(first).toBeLessThan(40);
    expect(container.querySelector('[data-tl-row-index="500"]')).toBeNull();

    const scroller = container.querySelector<HTMLElement>("[data-pm-tl-scroll]")!;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 500 * ROW_H });
    fireEvent.scroll(scroller);
    expect(container.querySelector('[data-tl-row-index="500"]')).not.toBeNull();
    expect(container.querySelector('[data-tl-row-index="5"]')).toBeNull();
    expect(container.querySelectorAll("[data-tl-item]").length).toBeLessThan(40);
    // Rows are positioned from the stable row index, so they do not shift as the window moves.
    expect(container.querySelector<HTMLElement>('[data-tl-row-index="500"]')!.style.top).toBe(`${500 * ROW_H}px`);
  });

  it("draws only the connectors that touch the rendered rows", () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      span("2026-10-05", "2026-10-10", { sortOrder: i, sequenceId: i + 1, id: `c${i + 1}`, key: `C-${i + 1}` }),
    );
    const relations = Array.from({ length: 299 }, (_, i) => ({
      id: `r${i}`,
      kind: "BLOCKS" as const,
      fromId: `c${i + 1}`,
      toId: `c${i + 2}`,
    }));
    const { container } = setup(many, { relations });
    expect(container.querySelectorAll("path.pm-tl-link").length).toBeLessThan(40);
    expect(container.querySelectorAll("path.pm-tl-link").length).toBeGreaterThan(0);
  });
});

describe("states", () => {
  it("loading is a skeleton, not a spinner", () => {
    hook.isLoading = true;
    hook.data = undefined;
    const { container } = render(
      <TimelineView projectId="p" visibleIds={null} revision="r" domain="populated" readOnly={false} onOpen={() => undefined} onChanged={() => undefined} />,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(container.querySelector(".pm-skel")).toBeTruthy();
  });

  it("an error offers Try again, which revalidates", () => {
    hook.error = new Error("down");
    hook.data = undefined;
    render(
      <TimelineView projectId="p" visibleIds={null} revision="r" domain="populated" readOnly={false} onOpen={() => undefined} onChanged={() => undefined} />,
    );
    expect(screen.getByText("Couldn't load this project.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(hook.mutate).toHaveBeenCalledTimes(1);
  });

  it("a window with nothing in it says so, naming the window", () => {
    const { container } = setup([]);
    expect(within(container).getByText(/Nothing is scheduled between Jul 11 and Apr 3, 2027\./)).toBeInTheDocument();
  });

  it("a project with no items uses the project-empty copy, with New item for writers only", () => {
    hook.data = timeline();
    const onNewItem = vi.fn();
    const { rerender } = render(
      <TimelineView projectId="p" visibleIds={null} revision="r" domain="empty" readOnly={false} onOpen={() => undefined} onChanged={() => undefined} onNewItem={onNewItem} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /New item/ }));
    expect(onNewItem).toHaveBeenCalledTimes(1);
    rerender(
      <TimelineView projectId="p" visibleIds={null} revision="r" domain="empty" readOnly onOpen={() => undefined} onChanged={() => undefined} onNewItem={onNewItem} />,
    );
    expect(screen.queryByRole("button", { name: /New item/ })).toBeNull();
    expect(screen.getByText("No work items in this project yet — add one to get started.")).toBeInTheDocument();
  });

  it("filters that hide everything say so, from the page's domain or from the id filter", () => {
    const a = item({ dueDate: wire("2026-10-05") });
    const { unmount } = setup([a], {}, { domain: "filtered" });
    expect(screen.getByText("No work items match these filters.")).toBeInTheDocument();
    unmount();
    setup([a], {}, { visibleIds: new Set() });
    expect(screen.getByText("No work items match these filters.")).toBeInTheDocument();
  });

  it("says how many items have no dates instead of hiding them silently", () => {
    const { unmount } = setup([span("2026-10-05", "2026-10-10")], { unscheduledCount: 1 });
    expect(screen.getByText(/1 item has no dates, so it isn't shown here/)).toBeInTheDocument();
    unmount();
    setup([span("2026-10-05", "2026-10-10")], { unscheduledCount: 12 });
    expect(screen.getByText(/12 items have no dates, so they aren't shown here/)).toBeInTheDocument();
  });

  it("warns when the server truncated the range", () => {
    setup([span("2026-10-05", "2026-10-10")], { truncated: true });
    expect(screen.getByText(/more items than can be drawn/)).toBeInTheDocument();
  });
});
