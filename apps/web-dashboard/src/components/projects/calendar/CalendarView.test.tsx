// WARP-3523 — the calendar layout: placement on calendar dates in any zone,
// drag to reschedule (optimistic, rolls back), keyboard nudging, the Unscheduled
// panel, overdue styling, read-only, every domain state and the narrow agenda.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { PmState, PmWorkItem } from "../types";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const updateItem = vi.fn();
vi.mock("../usePm", () => ({ pmActions: () => ({ updateItem }) }));

const todayRef = { current: "2026-10-03" };
vi.mock("./useToday", () => ({ useToday: () => todayRef.current }));

import { CalendarView, type CalendarViewProps } from "./CalendarView";

const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const TODO: PmState = { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true };
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

type Props = Partial<CalendarViewProps>;
let setItemsRef: ((fn: (prev: PmWorkItem[]) => PmWorkItem[]) => void) | null = null;

function Harness({ initial, ...rest }: Props & { initial: PmWorkItem[] }) {
  const [items, setItems] = useState(initial);
  setItemsRef = setItems;
  return (
    <CalendarView
      items={items}
      domain="populated"
      readOnly={false}
      onOpen={() => undefined}
      onChanged={async () => undefined}
      {...rest}
    />
  );
}

/** A PATCH that the "server" applies to the harness list, like a revalidation would. */
function serverApplies() {
  updateItem.mockImplementation(async (id: string, body: { start_date?: string | null; due_date?: string | null }) => {
    let saved: PmWorkItem | undefined;
    setItemsRef?.((prev) =>
      prev.map((i) => {
        if (i.id !== id) return i;
        saved = {
          ...i,
          ...(body.start_date !== undefined ? { startDate: body.start_date } : {}),
          ...(body.due_date !== undefined ? { dueDate: body.due_date } : {}),
        };
        return saved;
      }),
    );
    return { work_item: saved };
  });
}

const cell = (container: HTMLElement, day: string) => container.querySelector<HTMLElement>(`[data-date="${day}"]`)!;
const chipsIn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[data-cal-item]")];
const firstChip = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-cal-first="true"][data-cal-item="${id}"]`)!;
const dt = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });

beforeEach(() => {
  seq = 0;
  toast.mockReset();
  updateItem.mockReset();
  todayRef.current = "2026-10-03";
  setItemsRef = null;
});
afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe.each(["America/Los_Angeles", "Pacific/Auckland"])("placement on calendar dates — TZ=%s", (tz) => {
  it("an item due on the API's 2026-10-03 sits in the Oct 3 cell, not the day before", () => {
    process.env.TZ = tz;
    const a = item({ dueDate: wire("2026-10-03") });
    const { container } = render(<Harness initial={[a]} />);
    expect(chipsIn(cell(container, "2026-10-03")).map((c) => c.dataset.calItem)).toEqual([a.id]);
    expect(chipsIn(cell(container, "2026-10-02"))).toEqual([]);
    expect(chipsIn(cell(container, "2026-10-04"))).toEqual([]);
  });

  it("a span covers exactly its days, including across the DST change inside it", () => {
    process.env.TZ = tz;
    // LA falls back on 2026-11-01, Auckland springs forward on 2026-09-27.
    todayRef.current = "2026-10-15";
    const a = item({ startDate: wire("2026-10-30"), dueDate: wire("2026-11-03") });
    const { container } = render(<Harness initial={[a]} />);
    const days = ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"];
    expect(days.map((d) => chipsIn(cell(container, d)).length)).toEqual([0, 1, 1, 1, 1, 1, 0]);
  });
});

describe("grid", () => {
  it("shows the month containing today in six Sunday-first weeks, with today marked", () => {
    const { container } = render(<Harness initial={[item({ dueDate: wire("2026-10-05") })]} />);
    expect(screen.getByRole("heading", { name: "October 2026" })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-date]")).toHaveLength(42);
    expect(container.querySelector("[data-date]")!.getAttribute("data-date")).toBe("2026-09-27");
    expect(cell(container, "2026-10-03")).toHaveAttribute("aria-current", "date");
    expect(container.querySelectorAll('[aria-current="date"]')).toHaveLength(1);
  });

  it("navigates by month and back to today", () => {
    render(<Harness initial={[item({ dueDate: wire("2026-10-05") })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { name: "November 2026" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("heading", { name: "October 2026" })).toBeInTheDocument();
  });

  it("switches to a single week row", () => {
    const { container } = render(<Harness initial={[item({ dueDate: wire("2026-10-05") })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(container.querySelectorAll("[data-date]")).toHaveLength(7);
    expect(screen.getByRole("heading", { name: "Sep 27 – Oct 3, 2026" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.getByRole("heading", { name: "Oct 4 – Oct 10, 2026" })).toBeInTheDocument();
  });

  it("collapses overflow into '+N more', which opens that week with everything visible", () => {
    const many = Array.from({ length: 5 }, () => item({ dueDate: wire("2026-10-07") }));
    const { container } = render(<Harness initial={many} />);
    expect(chipsIn(cell(container, "2026-10-07"))).toHaveLength(3);
    fireEvent.click(within(cell(container, "2026-10-07")).getByRole("button", { name: /2 more on Wednesday, October 7/ }));
    expect(container.querySelectorAll("[data-date]")).toHaveLength(7);
    expect(chipsIn(cell(container, "2026-10-07"))).toHaveLength(5);
  });

  it("opens the work item on click and exposes key, title, dates and state as the accessible name", () => {
    const onOpen = vi.fn();
    const a = item({ startDate: wire("2026-10-06"), dueDate: wire("2026-10-08") });
    const { container } = render(<Harness initial={[a]} onOpen={onOpen} />);
    const chip = firstChip(container, a.id);
    expect(chip).toHaveAccessibleName("INBOX-1, Task 1, Oct 6 – Oct 8, Todo");
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: a.id }));
  });
});

describe("overdue styling", () => {
  it("an open item due before today is orange-flagged and named overdue; due today is not", () => {
    const late = item({ dueDate: wire("2026-10-02") });
    const dueToday = item({ dueDate: wire("2026-10-03") });
    const finished = item({ dueDate: wire("2026-10-01"), state: DONE, stateId: DONE.id });
    const { container } = render(<Harness initial={[late, dueToday, finished]} />);
    expect(firstChip(container, late.id)).toHaveClass("overdue");
    expect(firstChip(container, late.id)).toHaveAccessibleName(/, overdue/);
    expect(firstChip(container, dueToday.id)).not.toHaveClass("overdue");
    expect(firstChip(container, finished.id)).not.toHaveClass("overdue");
    expect(firstChip(container, finished.id)).toHaveClass("done");
  });
});

describe("drag to reschedule", () => {
  it("moves an item to the dropped day optimistically, PATCHes only due_date, then keeps it there", async () => {
    const a = item({ dueDate: wire("2026-10-05") });
    let resolve!: (v: unknown) => void;
    updateItem.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const { container } = render(<Harness initial={[a]} />);

    fireEvent.dragStart(firstChip(container, a.id), { dataTransfer: dt() });
    fireEvent.dragOver(cell(container, "2026-10-09"), { dataTransfer: dt() });
    expect(cell(container, "2026-10-09")).toHaveClass("is-drop");
    fireEvent.drop(cell(container, "2026-10-09"), { dataTransfer: dt() });

    // Optimistic: already in the new cell while the request is in flight.
    expect(chipsIn(cell(container, "2026-10-09")).map((c) => c.dataset.calItem)).toEqual([a.id]);
    expect(chipsIn(cell(container, "2026-10-05"))).toEqual([]);
    expect(updateItem).toHaveBeenCalledWith(a.id, { due_date: "2026-10-09T00:00:00.000Z" });

    await act(async () => {
      resolve({ work_item: { ...a, dueDate: wire("2026-10-09") } });
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("rolls the chip back and toasts when the PATCH is rejected", async () => {
    const a = item({ dueDate: wire("2026-10-05") });
    updateItem.mockRejectedValueOnce(new Error("nope"));
    const { container } = render(<Harness initial={[a]} />);

    fireEvent.dragStart(firstChip(container, a.id), { dataTransfer: dt() });
    await act(async () => {
      fireEvent.drop(cell(container, "2026-10-09"), { dataTransfer: dt() });
    });

    await waitFor(() => expect(chipsIn(cell(container, "2026-10-05")).map((c) => c.dataset.calItem)).toEqual([a.id]));
    expect(chipsIn(cell(container, "2026-10-09"))).toEqual([]);
    expect(toast).toHaveBeenCalledWith("Couldn't move that item — try again.", "error");
  });

  it("moves a whole span by how far the pointer travelled from the day it picked up", async () => {
    const a = item({ startDate: wire("2026-10-06"), dueDate: wire("2026-10-08") });
    serverApplies();
    const { container } = render(<Harness initial={[a]} />);

    // Pick the bar up on its middle day (Oct 7) and drop that day on Oct 14.
    const middle = chipsIn(cell(container, "2026-10-07"))[0];
    fireEvent.dragStart(middle, { dataTransfer: dt() });
    await act(async () => {
      fireEvent.drop(cell(container, "2026-10-14"), { dataTransfer: dt() });
    });

    expect(updateItem).toHaveBeenCalledWith(a.id, {
      start_date: "2026-10-13T00:00:00.000Z",
      due_date: "2026-10-15T00:00:00.000Z",
    });
    await waitFor(() =>
      expect(["2026-10-13", "2026-10-14", "2026-10-15"].map((d) => chipsIn(cell(container, d)).length)).toEqual([1, 1, 1]),
    );
    expect(chipsIn(cell(container, "2026-10-07"))).toEqual([]);
  });

  it("dropping on the day it already sits on does nothing", () => {
    const a = item({ dueDate: wire("2026-10-05") });
    const { container } = render(<Harness initial={[a]} />);
    fireEvent.dragStart(firstChip(container, a.id), { dataTransfer: dt() });
    fireEvent.drop(cell(container, "2026-10-05"), { dataTransfer: dt() });
    expect(updateItem).not.toHaveBeenCalled();
  });

  it("keeps the calendar date across the LA fall-back (Oct 30 -> Nov 2)", async () => {
    process.env.TZ = "America/Los_Angeles";
    const a = item({ dueDate: wire("2026-10-30") });
    serverApplies();
    const { container } = render(<Harness initial={[a]} />);
    fireEvent.dragStart(firstChip(container, a.id), { dataTransfer: dt() });
    await act(async () => {
      fireEvent.drop(cell(container, "2026-11-02"), { dataTransfer: dt() });
    });
    expect(updateItem).toHaveBeenCalledWith(a.id, { due_date: "2026-11-02T00:00:00.000Z" });
    await waitFor(() => expect(chipsIn(cell(container, "2026-11-02")).map((c) => c.dataset.calItem)).toEqual([a.id]));
  });

  it("keeps the calendar date across the Auckland spring-forward (Sep 26 -> Sep 28)", async () => {
    process.env.TZ = "Pacific/Auckland";
    todayRef.current = "2026-09-15";
    const a = item({ dueDate: wire("2026-09-26") });
    serverApplies();
    const { container } = render(<Harness initial={[a]} />);
    fireEvent.dragStart(firstChip(container, a.id), { dataTransfer: dt() });
    await act(async () => {
      fireEvent.drop(cell(container, "2026-09-28"), { dataTransfer: dt() });
    });
    expect(updateItem).toHaveBeenCalledWith(a.id, { due_date: "2026-09-28T00:00:00.000Z" });
    await waitFor(() => expect(chipsIn(cell(container, "2026-09-28")).map((c) => c.dataset.calItem)).toEqual([a.id]));
  });

  it("a start-only item moves its start date", async () => {
    const a = item({ startDate: wire("2026-10-05") });
    serverApplies();
    const { container } = render(<Harness initial={[a]} />);
    fireEvent.dragStart(firstChip(container, a.id), { dataTransfer: dt() });
    await act(async () => {
      fireEvent.drop(cell(container, "2026-10-08"), { dataTransfer: dt() });
    });
    expect(updateItem).toHaveBeenCalledWith(a.id, { start_date: "2026-10-08T00:00:00.000Z" });
  });
});

describe("Unscheduled panel", () => {
  it("lists open items without dates; finished and dated ones stay out", () => {
    const open = item({ name: "No date yet" });
    const dated = item({ dueDate: wire("2026-10-05") });
    const finished = item({ state: DONE, stateId: DONE.id });
    render(<Harness initial={[open, dated, finished]} />);
    const panel = screen.getByRole("complementary", { name: "Unscheduled work items" });
    expect(within(panel).getByText("No date yet")).toBeInTheDocument();
    expect(within(panel).queryByText(dated.name)).toBeNull();
    expect(within(panel).queryByText(finished.name)).toBeNull();
    expect(within(panel).getByText("1")).toBeInTheDocument();
  });

  it("dragging a card onto a day sets its due date", async () => {
    const open = item({ name: "No date yet" });
    serverApplies();
    const { container } = render(<Harness initial={[open]} />);
    const card = container.querySelector<HTMLElement>(`[data-unscheduled-item="${open.id}"]`)!;
    fireEvent.dragStart(card, { dataTransfer: dt() });
    await act(async () => {
      fireEvent.drop(cell(container, "2026-10-12"), { dataTransfer: dt() });
    });
    expect(updateItem).toHaveBeenCalledWith(open.id, { due_date: "2026-10-12T00:00:00.000Z" });
    await waitFor(() => expect(chipsIn(cell(container, "2026-10-12")).map((c) => c.dataset.calItem)).toEqual([open.id]));
    expect(container.querySelector(`[data-unscheduled-item="${open.id}"]`)).toBeNull();
  });

  it("the date control on a card is the keyboard / touch route: pick a day, press Set", async () => {
    const open = item({ name: "No date yet" });
    serverApplies();
    render(<Harness initial={[open]} />);
    const input = screen.getByLabelText("Set due date for INBOX-1");
    const set = screen.getByRole("button", { name: "Schedule INBOX-1 on the chosen date" });
    expect(set).toBeDisabled();
    fireEvent.change(input, { target: { value: "2026-10-20" } });
    // Choosing a date is a draft: nothing is written until Set.
    expect(updateItem).not.toHaveBeenCalled();
    expect(set).toBeEnabled();
    await act(async () => {
      fireEvent.click(set);
    });
    expect(updateItem).toHaveBeenCalledTimes(1);
    expect(updateItem).toHaveBeenCalledWith(open.id, { due_date: "2026-10-20T00:00:00.000Z" });
  });

  it("typing a year digit by digit schedules ONCE, on the real year — never on 0002, 0020 or 0202", async () => {
    // A segmented date input reports a complete date after each digit typed into
    // its year segment. Saving from `change` wrote the item into year 2.
    const open = item({ name: "No date yet" });
    serverApplies();
    render(<Harness initial={[open]} />);
    const input = screen.getByLabelText("Set due date for INBOX-1");
    const set = screen.getByRole("button", { name: "Schedule INBOX-1 on the chosen date" });

    for (const intermediate of ["0002-10-20", "0020-10-20", "0202-10-20"]) {
      fireEvent.change(input, { target: { value: intermediate } });
      expect(set).toBeDisabled();
      expect(input).toHaveAttribute("aria-invalid", "true");
      // Even if the form is submitted another way (Enter), an implausible year is refused.
      fireEvent.submit(input.closest("form")!);
    }
    expect(updateItem).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "2026-10-20" } });
    expect(updateItem).not.toHaveBeenCalled();
    expect(set).toBeEnabled();
    expect(input).not.toHaveAttribute("aria-invalid");
    await act(async () => {
      fireEvent.click(set);
    });
    expect(updateItem).toHaveBeenCalledTimes(1);
    expect(updateItem).toHaveBeenCalledWith(open.id, { due_date: "2026-10-20T00:00:00.000Z" });
  });

  it("Enter in the field (a form submit) commits a plausible date, and the control limits the picker to a sensible span", async () => {
    const open = item({ name: "No date yet" });
    serverApplies();
    render(<Harness initial={[open]} />);
    const input = screen.getByLabelText("Set due date for INBOX-1");
    // Five years back to twenty ahead of today (2026-10-03).
    expect(input).toHaveAttribute("min", "2021-01-01");
    expect(input).toHaveAttribute("max", "2046-12-31");
    fireEvent.change(input, { target: { value: "2026-11-02" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    expect(updateItem).toHaveBeenCalledWith(open.id, { due_date: "2026-11-02T00:00:00.000Z" });
  });

  it("refuses a date far outside the span even when it is a complete, real date", () => {
    const open = item({ name: "No date yet" });
    render(<Harness initial={[open]} />);
    const input = screen.getByLabelText("Set due date for INBOX-1");
    const set = screen.getByRole("button", { name: "Schedule INBOX-1 on the chosen date" });
    for (const far of ["1999-10-20", "2020-12-31", "2047-01-01", "2099-10-20"]) {
      fireEvent.change(input, { target: { value: far } });
      expect(set).toBeDisabled();
    }
    for (const near of ["2021-01-01", "2046-12-31"]) {
      fireEvent.change(input, { target: { value: near } });
      expect(set).toBeEnabled();
    }
    expect(updateItem).not.toHaveBeenCalled();
  });

  it("says so when there is nothing to schedule", () => {
    render(<Harness initial={[item({ dueDate: wire("2026-10-05") })]} />);
    expect(screen.getByText("Nothing unscheduled.")).toBeInTheDocument();
  });
});

describe("keyboard nudging", () => {
  it.each([
    ["ArrowRight", {}, "2026-10-06"],
    ["ArrowLeft", {}, "2026-10-04"],
    ["ArrowDown", {}, "2026-10-12"],
    ["ArrowUp", {}, "2026-09-28"],
    ["ArrowRight", { shiftKey: true }, "2026-10-12"],
    ["ArrowLeft", { shiftKey: true }, "2026-09-28"],
  ])("%s %j moves a chip to %s and keeps focus on it", async (key, mods, expected) => {
    const a = item({ dueDate: wire("2026-10-05") });
    serverApplies();
    const { container } = render(<Harness initial={[a]} />);
    firstChip(container, a.id).focus();
    await act(async () => {
      fireEvent.keyDown(firstChip(container, a.id), { key, ...mods });
    });
    expect(updateItem).toHaveBeenCalledWith(a.id, { due_date: `${expected}T00:00:00.000Z` });
    await waitFor(() => expect(chipsIn(cell(container, expected)).map((c) => c.dataset.calItem)).toEqual([a.id]));
    await waitFor(() => expect(document.activeElement).toBe(firstChip(container, a.id)));
  });

  it("moves a span as one piece and announces the result", async () => {
    const a = item({ startDate: wire("2026-10-06"), dueDate: wire("2026-10-08") });
    serverApplies();
    const { container } = render(<Harness initial={[a]} />);
    await act(async () => {
      fireEvent.keyDown(firstChip(container, a.id), { key: "ArrowRight" });
    });
    expect(updateItem).toHaveBeenCalledWith(a.id, {
      start_date: "2026-10-07T00:00:00.000Z",
      due_date: "2026-10-09T00:00:00.000Z",
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved INBOX-1 to Oct 7 – Oct 9"));
  });

  it("follows the item into the next month so it never disappears from view", async () => {
    todayRef.current = "2026-10-15";
    const a = item({ dueDate: wire("2026-11-07") });
    serverApplies();
    const { container } = render(<Harness initial={[a]} />);
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    // Week of Nov 8 – Nov 14 is not showing Nov 7; go to Nov 1–7.
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    await act(async () => {
      fireEvent.keyDown(firstChip(container, a.id), { key: "ArrowRight" });
    });
    // Nov 8 is outside the Nov 1–7 week: the view moves with it.
    await waitFor(() => expect(chipsIn(cell(container, "2026-11-08")).map((c) => c.dataset.calItem)).toEqual([a.id]));
  });

  it("a nudged chip that lands under '+N more' does not steal focus on a later render", async () => {
    // Three items already fill the three visible lanes of Oct 7; the fourth, nudged
    // onto that day from Oct 6, is hidden behind "+1 more". Its focus request must
    // die with that render, not wait for the week view to draw it.
    const crowd = [1, 2, 3].map(() => item({ dueDate: wire("2026-10-07") }));
    const mover = item({ dueDate: wire("2026-10-06") });
    serverApplies();
    const { container } = render(<Harness initial={[...crowd, mover]} />);
    firstChip(container, mover.id).focus();
    await act(async () => {
      fireEvent.keyDown(firstChip(container, mover.id), { key: "ArrowRight" });
    });
    await waitFor(() => expect(updateItem).toHaveBeenCalledTimes(1));
    expect(container.querySelector(`[data-cal-first="true"][data-cal-item="${mover.id}"]`)).toBeNull();

    fireEvent.click(within(cell(container, "2026-10-07")).getByRole("button", { name: /1 more on Wednesday, October 7/ }));
    // The week view now draws it — and focus stays where it was, not on the chip.
    expect(firstChip(container, mover.id)).toBeTruthy();
    expect(document.activeElement).not.toBe(firstChip(container, mover.id));
  });

  it("ignores modified arrows so browser shortcuts keep working", () => {
    const a = item({ dueDate: wire("2026-10-05") });
    const { container } = render(<Harness initial={[a]} />);
    fireEvent.keyDown(firstChip(container, a.id), { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(firstChip(container, a.id), { key: "ArrowRight", metaKey: true });
    expect(updateItem).not.toHaveBeenCalled();
  });
});

describe("read-only", () => {
  it("offers no dragging, nudging, date controls or move hint", () => {
    const a = item({ dueDate: wire("2026-10-05") });
    const open = item({ name: "Undated" });
    const { container } = render(<Harness initial={[a, open]} readOnly />);
    expect(firstChip(container, a.id)).toHaveAttribute("draggable", "false");
    expect(container.querySelector(`[data-unscheduled-item="${open.id}"]`)).toHaveAttribute("draggable", "false");
    expect(screen.queryByLabelText(/Set due date for/)).toBeNull();
    fireEvent.keyDown(firstChip(container, a.id), { key: "ArrowRight" });
    fireEvent.dragStart(firstChip(container, a.id), { dataTransfer: dt() });
    fireEvent.drop(cell(container, "2026-10-09"), { dataTransfer: dt() });
    expect(updateItem).not.toHaveBeenCalled();
    expect(firstChip(container, a.id)).not.toHaveAttribute("aria-describedby");
  });
});

describe("domain states", () => {
  const base = { items: [] as PmWorkItem[], readOnly: false, onOpen: () => undefined, onChanged: () => undefined };

  it("loading is a skeleton, not a spinner", () => {
    const { container } = render(<CalendarView {...base} domain="loading" />);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(container.querySelector(".pm-skel")).toBeTruthy();
  });

  it("error uses the project-load copy", () => {
    render(<CalendarView {...base} domain="error" />);
    expect(screen.getByText("Couldn't load this project.")).toBeInTheDocument();
    expect(screen.getByText("Check the appliance connection and try again.")).toBeInTheDocument();
  });

  it("empty offers a New item action to writers only", () => {
    const onNewItem = vi.fn();
    const { rerender } = render(<CalendarView {...base} domain="empty" onNewItem={onNewItem} />);
    fireEvent.click(screen.getByRole("button", { name: /New item/ }));
    expect(onNewItem).toHaveBeenCalledTimes(1);
    rerender(<CalendarView {...base} domain="empty" readOnly onNewItem={onNewItem} />);
    expect(screen.queryByRole("button", { name: /New item/ })).toBeNull();
    expect(screen.getByText("No work items in this project yet — add one to get started.")).toBeInTheDocument();
  });

  it("filtered-to-empty names the filters", () => {
    render(<CalendarView {...base} domain="filtered" />);
    expect(screen.getByText("No work items match these filters.")).toBeInTheDocument();
    expect(screen.getByText("Try clearing a filter.")).toBeInTheDocument();
  });

  it("nothing scheduled yet says so and points at the panel", () => {
    render(<Harness initial={[item({ name: "Undated" })]} />);
    expect(screen.getByText(/Nothing is scheduled yet — drag an item from Unscheduled onto a day\./)).toBeInTheDocument();
  });
});

describe("narrow screens", () => {
  it("render a dated agenda instead of the grid, each item once under its first day in view", () => {
    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    const onOpen = vi.fn();
    const span = item({ startDate: wire("2026-10-06"), dueDate: wire("2026-10-08") });
    const late = item({ dueDate: wire("2026-10-02") });
    const { container } = render(<Harness initial={[span, late]} onOpen={onOpen} />);
    expect(container.querySelector("[data-date]")).toBeNull();
    const rows = screen.getAllByRole("button", { name: /INBOX-/ });
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "INBOX-2, Task 2, Oct 2, overdue",
      "INBOX-1, Task 1, Oct 6 – Oct 8",
    ]);
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    fireEvent.click(rows[1]);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: span.id }));
  });
});
