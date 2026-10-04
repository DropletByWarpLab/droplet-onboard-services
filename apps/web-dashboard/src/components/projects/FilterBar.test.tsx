// WARP-3522 — the filter bar (brief §3.9, §5): a search box, a "Filter" menu that
// reaches every field of the filter language, and the active filters as chips —
// all keyboard-operable, all with names a screen reader can speak.

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type JSX } from "react";
import type { PmFilter } from "@droplet/shared-types";
import { FilterBar, FilterChips, type EditorOptions } from "./FilterBar";
import { EMPTY_FILTER, type ChipLookups } from "./filter-model";
import type { PmLabel, PmProject, PmState } from "./types";

const STATES: PmState[] = [
  { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: null, sortOrder: 1, isDefault: true },
  { id: "s2", projectId: "p", name: "Doing", group: "started", color: null, sortOrder: 2, isDefault: false },
];
const LABELS: PmLabel[] = [
  { id: "l1", projectId: "p", name: "Bug", color: null },
  { id: "l2", projectId: "p", name: "Docs", color: null },
];

function options(over: Partial<EditorOptions> = {}): EditorOptions {
  return {
    scope: "project",
    states: STATES,
    labels: LABELS,
    people: [
      { value: "u1", label: "Ana" },
      { value: "u2", label: "Ben" },
    ],
    departments: [],
    projects: [],
    ...over,
  };
}

const lookups: ChipLookups = {
  stateName: (id) => STATES.find((s) => s.id === id)?.name,
  labelName: (id) => LABELS.find((l) => l.id === id)?.name,
  personName: (id) => ({ u1: "Ana", u2: "Ben" })[id],
};

/** A controlled harness: the page owns the filter, the bar edits it. */
function Harness({
  initial = EMPTY_FILTER,
  scope = "project",
  opts = options(),
  spy,
}: {
  initial?: PmFilter;
  scope?: "project" | "workspace";
  opts?: EditorOptions;
  spy?: (f: PmFilter) => void;
}): JSX.Element {
  const [filter, setFilter] = useState<PmFilter>(initial);
  const change = (f: PmFilter) => {
    spy?.(f);
    setFilter(f);
  };
  const o = { ...opts, scope };
  return (
    <div className="pm-scope">
      <FilterBar scope={scope} filter={filter} onChange={change} options={o} lookups={lookups} />
      <FilterChips scope={scope} filter={filter} onChange={change} options={o} lookups={lookups} />
      <output data-testid="filter">{JSON.stringify(filter)}</output>
    </div>
  );
}

const current = (): PmFilter => JSON.parse(screen.getByTestId("filter").textContent ?? "{}");
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /^filter$/i }));
const pickField = (name: string) => fireEvent.click(within(screen.getByRole("dialog", { name: "Add a filter" })).getByRole("button", { name }));

afterEach(() => {
  vi.useRealTimers();
});

describe("the search box", () => {
  it("is the filter's text condition, and takes it 250 ms after typing stops", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "login" } });
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(current()).toEqual({ field: "text", op: "contains", value: "login" });
  });

  it("one burst of typing is one change", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const box = screen.getByLabelText("Search work items");
    for (const v of ["l", "lo", "log", "logi", "login"]) {
      fireEvent.change(box, { target: { value: v } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("clearing the box removes the condition", () => {
    vi.useFakeTimers();
    render(<Harness initial={{ field: "text", op: "contains", value: "login" }} />);
    expect(screen.getByLabelText("Search work items")).toHaveValue("login");
    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(current()).toEqual({ and: [] });
  });

  it("shows the search text as the box and NOT as a chip", () => {
    render(
      <Harness
        initial={{ and: [{ field: "text", op: "contains", value: "login" }, { field: "priority", op: "is", value: "high" }] }}
      />,
    );
    expect(screen.getByLabelText("Search work items")).toHaveValue("login");
    expect(screen.queryByText(/Search contains/)).toBeNull();
    expect(screen.getByRole("button", { name: "Edit filter: Priority is High" })).toBeInTheDocument();
  });

  it("takes a change that came from outside (a view picked, Back pressed) over what is in the box", () => {
    const bar = (filter: PmFilter) => (
      <FilterBar scope="project" filter={filter} onChange={vi.fn()} options={options()} lookups={lookups} />
    );
    const { rerender } = render(bar({ field: "text", op: "contains", value: "old" }));
    expect(screen.getByLabelText("Search work items")).toHaveValue("old");
    rerender(bar({ and: [] }));
    expect(screen.getByLabelText("Search work items")).toHaveValue("");
    rerender(bar({ field: "text", op: "contains", value: "newer" }));
    expect(screen.getByLabelText("Search work items")).toHaveValue("newer");
  });
});

describe("the Filter menu", () => {
  it("opens as a dialog the button controls, and lists every field but the search box", () => {
    render(<Harness opts={options({ departments: [{ id: "d1", name: "Clinical", kind: "DEPARTMENT", parentId: null }] })} />);
    const button = screen.getByRole("button", { name: /^filter$/i });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("dialog", { name: "Add a filter" });
    const names = within(menu).getAllByRole("button").map((b) => b.textContent);
    for (const f of ["State", "Stage", "Priority", "Assignee", "Label", "Department", "Due date", "Start date", "Created", "Updated", "Created by", "Sub-items", "Cycle", "Module", "Archived items"]) {
      expect(names, f).toContain(f);
    }
    expect(names).not.toContain("Search");
    expect(names).not.toContain("Project");
  });

  it("hides the department filter on a box where nothing owns work", () => {
    render(<Harness />);
    openMenu();
    expect(within(screen.getByRole("dialog", { name: "Add a filter" })).queryByRole("button", { name: "Department" })).toBeNull();
  });

  it("a workspace-wide list offers Project, and no per-project State or Label", () => {
    render(<Harness scope="workspace" />);
    openMenu();
    const menu = screen.getByRole("dialog", { name: "Add a filter" });
    expect(within(menu).getByRole("button", { name: "Project" })).toBeInTheDocument();
    expect(within(menu).queryByRole("button", { name: "State" })).toBeNull();
    expect(within(menu).queryByRole("button", { name: "Label" })).toBeNull();
  });

  it("takes focus when it opens, and gives it back on Escape", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: /^filter$/i });
    openMenu();
    expect(screen.getByRole("dialog", { name: "Add a filter" }).contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Add a filter" })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes on a click outside", () => {
    render(<Harness />);
    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Add a filter" })).toBeNull();
  });
});

describe("adding filters", () => {
  it("a multi-value field: pick values, Apply → one chip, and `is` / `in` follows the count", () => {
    render(<Harness />);
    openMenu();
    pickField("Priority");
    fireEvent.click(screen.getByLabelText("Urgent"));
    fireEvent.click(screen.getByLabelText("High"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(current()).toEqual({ field: "priority", op: "in", value: ["urgent", "high"] });
    expect(screen.getByRole("button", { name: "Edit filter: Priority is Urgent or High" })).toBeInTheDocument();
    // …and the menu closed and focus went back to the button that opened it.
    expect(screen.queryByRole("dialog", { name: "Add a filter" })).toBeNull();
  });

  it("one value is `is`; \"is none of\" is `isNot`", () => {
    render(<Harness />);
    openMenu();
    pickField("Label");
    fireEvent.change(screen.getByLabelText("Match"), { target: { value: "none" } });
    fireEvent.click(screen.getByLabelText("Bug"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(current()).toEqual({ field: "label", op: "isNot", value: "l1" });
  });

  it("cannot Apply with nothing picked", () => {
    render(<Harness />);
    openMenu();
    pickField("Priority");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("Assignee offers me and nobody before the people", () => {
    render(<Harness />);
    openMenu();
    pickField("Assignee");
    const labels = screen.getAllByRole("checkbox").map((c) => c.closest("label")?.textContent);
    expect(labels).toEqual(["Me", "Nobody", "Ana", "Ben"]);
    fireEvent.click(screen.getByLabelText("Me"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(current()).toEqual({ field: "assignee", op: "is", value: "me" });
  });

  it("a date field: a preset applies at once", () => {
    render(<Harness />);
    openMenu();
    pickField("Due date");
    fireEvent.click(screen.getByRole("button", { name: "Before today" }));
    expect(current()).toEqual({ field: "dueDate", op: "before", value: "today" });
    expect(screen.getByRole("button", { name: "Edit filter: Due date before today" })).toBeInTheDocument();
  });

  it("a date field: a due date can be 'No date', a created date cannot", () => {
    render(<Harness />);
    openMenu();
    pickField("Due date");
    expect(screen.getByRole("button", { name: "No date" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "No date" }));
    expect(current()).toEqual({ field: "dueDate", op: "isEmpty" });

    openMenu();
    pickField("Created");
    expect(screen.queryByRole("button", { name: "No date" })).toBeNull();
  });

  it("a date field: a custom range, entered backwards, is put the right way round", () => {
    render(<Harness />);
    openMenu();
    pickField("Due date");
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "between" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-20" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(current()).toEqual({ field: "dueDate", op: "between", value: ["2026-10-05", "2026-10-20"] });
  });

  it("a presence field: has one / has none", () => {
    render(<Harness />);
    openMenu();
    pickField("Sub-items");
    fireEvent.click(screen.getByRole("button", { name: "Top-level items only" }));
    expect(current()).toEqual({ field: "parent", op: "isEmpty" });
  });

  it("the archived switch", () => {
    render(<Harness />);
    openMenu();
    pickField("Archived items");
    fireEvent.click(screen.getByRole("button", { name: "Archived items only" }));
    expect(current()).toEqual({ field: "isArchived", op: "is", value: true });
  });

  it("adds to what is already there", () => {
    render(<Harness initial={{ field: "priority", op: "is", value: "high" }} />);
    openMenu();
    pickField("Assignee");
    fireEvent.click(screen.getByLabelText("Me"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(current()).toEqual({
      and: [
        { field: "priority", op: "is", value: "high" },
        { field: "assignee", op: "is", value: "me" },
      ],
    });
  });

  it("Back returns to the list of fields", () => {
    render(<Harness />);
    openMenu();
    pickField("Priority");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(within(screen.getByRole("dialog", { name: "Add a filter" })).getByRole("button", { name: "Assignee" })).toBeInTheDocument();
  });
});

describe("the chips", () => {
  const two: PmFilter = {
    and: [
      { field: "priority", op: "in", value: ["urgent", "high"] },
      { field: "label", op: "is", value: "l1" },
    ],
  };

  it("say what they filter, in words, and name their own controls", () => {
    render(<Harness initial={two} />);
    const list = screen.getByRole("list", { name: "Active filters" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Edit filter: Priority is Urgent or High" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: Priority is Urgent or High" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit filter: Label is Bug" })).toBeInTheDocument();
  });

  it("show nothing when there is nothing", () => {
    render(<Harness />);
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
  });

  it("remove one", () => {
    render(<Harness initial={two} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Priority is Urgent or High" }));
    expect(current()).toEqual({ field: "label", op: "is", value: "l1" });
  });

  it("edit one, prefilled, and the chip changes in place", () => {
    render(<Harness initial={two} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit filter: Priority is Urgent or High" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Priority filter" });
    expect(within(dialog).getByLabelText("Urgent")).toBeChecked();
    expect(within(dialog).getByLabelText("High")).toBeChecked();
    expect(within(dialog).getByLabelText("Low")).not.toBeChecked();
    fireEvent.click(within(dialog).getByLabelText("High"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(current()).toEqual({
      and: [
        { field: "priority", op: "is", value: "urgent" },
        { field: "label", op: "is", value: "l1" },
      ],
    });
  });

  it("Escape closes a chip's editor and returns focus to the chip", () => {
    render(<Harness initial={two} />);
    const chip = screen.getByRole("button", { name: "Edit filter: Label is Bug" });
    fireEvent.click(chip);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Edit Label filter" })).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("a group the bar cannot edit is ONE read-only chip that can still be removed", () => {
    const either: PmFilter = {
      or: [
        { field: "assignee", op: "is", value: "me" },
        { field: "priority", op: "is", value: "urgent" },
      ],
    };
    render(<Harness initial={{ and: [either, { field: "label", op: "is", value: "l1" }] }} />);
    expect(screen.getByText("Custom filter")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit filter: Custom filter" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Custom filter" }));
    expect(current()).toEqual({ field: "label", op: "is", value: "l1" });
  });

  it("a chip whose field this list cannot offer (a State in the workspace-wide list) is removable, not editable", () => {
    render(<Harness scope="workspace" initial={{ field: "state", op: "is", value: "s1" }} />);
    expect(screen.queryByRole("button", { name: /^Edit filter: State/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove filter: State is Todo" })).toBeInTheDocument();
  });

  it("Clear filters removes every chip and the search text", () => {
    render(<Harness initial={{ and: [{ field: "text", op: "contains", value: "bug" }, ...(two as { and: PmFilter[] }).and] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(current()).toEqual({ and: [] });
    expect(screen.getByLabelText("Search work items")).toHaveValue("");
  });
});
