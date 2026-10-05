/**
 * WARP-3537 — the table layout, as a person meets it: columns, sort, select,
 * edit-in-place, groups, the keyboard, and a thousand rows.
 *
 * The data is handed in (the page owns the query), the edits are spies (what an edit
 * DOES is `useTableEdits`'s), the selection is the real hook (it is the contract the
 * bulk bar reads). jsdom has no layout, so the window math is tested in
 * `virtual.test.ts` and here only what it does to the DOM.
 */
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React, { createRef } from "react";
import { PM_BULK_MAX_IDS, type PmSortSpec } from "@droplet/shared-types";
import { TableView, type TableApi, type TableViewProps } from "./TableView";
import { useSelection } from "../bulk/selection";
import type { PmLabel, PmState, PmWorkItem } from "../types";

const TODO: PmState = { id: "s-todo", projectId: "p1", name: "Todo", group: "unstarted", color: "#111111", sortOrder: 1, isDefault: true };
const DOING: PmState = { id: "s-doing", projectId: "p1", name: "In Progress", group: "started", color: "#222222", sortOrder: 2, isDefault: false };
const DONE: PmState = { id: "s-done", projectId: "p1", name: "Done", group: "completed", color: "#333333", sortOrder: 3, isDefault: false };
const BUG: PmLabel = { id: "l-bug", projectId: "p1", name: "Bug", color: null };
const PEOPLE = [
  { value: "u-ana", label: "Ana" },
  { value: "u-bo", label: "Bo" },
];

function item(n: number, over: Partial<PmWorkItem> = {}): PmWorkItem {
  return {
    id: `w${n}`,
    projectId: "p1",
    sequenceId: n,
    key: `INBOX-${n}`,
    name: `Item ${n}`,
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
    sortOrder: n,
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}
const many = (n: number) => Array.from({ length: n }, (_, i) => item(i + 1));

function makeEdits() {
  return {
    setState: vi.fn().mockResolvedValue(undefined),
    setPriority: vi.fn().mockResolvedValue(undefined),
    setAssignees: vi.fn().mockResolvedValue(undefined),
    setDueDate: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
}

const COLUMNS: TableViewProps["columns"] = ["key", "name", "state", "priority", "assignees", "dueDate"];

interface Harness {
  edits: ReturnType<typeof makeEdits>;
  onOpen: ReturnType<typeof vi.fn>;
  onSort: ReturnType<typeof vi.fn>;
  onAnnounce: ReturnType<typeof vi.fn>;
  api: React.RefObject<TableApi | null>;
  selection: { current: ReturnType<typeof useSelection> | null };
}

function setup(props: Partial<TableViewProps> = {}): Harness & ReturnType<typeof render> {
  const edits = makeEdits();
  const onOpen = vi.fn();
  const onSort = vi.fn();
  const onAnnounce = vi.fn();
  const api = createRef<TableApi>();
  const selection: Harness["selection"] = { current: null };

  function Wrapper() {
    const sel = useSelection();
    selection.current = sel;
    return (
      <div className="pm-scope">
        <TableView
          rows={many(3)}
          domain="populated"
          scope="project"
          columns={COLUMNS}
          sort={null}
          onSort={onSort}
          groupBy={null}
          loadingMore={false}
          readOnly={false}
          selection={sel}
          pending={new Set()}
          states={[TODO, DOING, DONE]}
          people={PEOPLE}
          groupContext={{ personName: (id) => PEOPLE.find((p) => p.value === id)?.label ?? "Former member" }}
          edits={edits}
          onOpen={onOpen}
          onAnnounce={onAnnounce}
          apiRef={api}
          {...props}
        />
      </div>
    );
  }
  const utils = render(<Wrapper />);
  return { ...utils, edits, onOpen, onSort, onAnnounce, api, selection };
}

const rowOf = (key: string) => screen.getByRole("row", { name: new RegExp(`^${key},`) });
/** Focus an element the way a person does: React sees it, and its state settles before the next key. */
const focus = (el: HTMLElement) => act(() => el.focus());
const rowsShown = () => screen.getAllByRole("row").filter((r) => r.getAttribute("aria-label")?.includes("INBOX-"));

describe("the grid", () => {
  it("is a grid of work items with a header, a row per item and the row count a screen reader needs", () => {
    setup();
    const grid = screen.getByRole("grid", { name: "Work items" });
    expect(grid).toHaveAttribute("aria-rowcount", "4"); // header + 3
    expect(grid).toHaveAttribute("aria-multiselectable", "true");
    const headers = within(grid).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["", "Key", "Title", "State", "Priority", "Assignees", "Due date"]);
    expect(rowsShown()).toHaveLength(3);
    expect(rowOf("INBOX-1")).toHaveAccessibleName("INBOX-1, Item 1");
  });

  it("draws the key in mono and the title as text", () => {
    setup();
    expect(within(rowOf("INBOX-2")).getByText("INBOX-2")).toHaveClass("pm-mono");
    expect(within(rowOf("INBOX-2")).getByText("Item 2")).toBeInTheDocument();
  });

  it("draws only the columns it is given, in the order given", () => {
    setup({ columns: ["name", "dueDate"] });
    expect(within(screen.getByRole("grid")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["", "Title", "Due date"]);
  });

  it("opens the item's details when its row is clicked", () => {
    const { onOpen } = setup();
    fireEvent.click(within(rowOf("INBOX-2")).getByText("Item 2"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "w2" }));
  });

  it("marks a row that is being saved", () => {
    setup({ pending: new Set(["w2"]) });
    expect(rowOf("INBOX-2")).toHaveAttribute("aria-busy", "true");
    expect(rowOf("INBOX-1")).not.toHaveAttribute("aria-busy");
  });
});

describe("sorting", () => {
  it("has a button on a column the server can order by, and plain text on one it cannot", () => {
    setup();
    const grid = screen.getByRole("grid");
    expect(within(grid).getByRole("button", { name: /^Due date/ })).toBeInTheDocument();
    expect(within(grid).queryByRole("button", { name: /^Assignees/ })).toBeNull();
  });

  it("asks for ascending on the first click, with the field the server sorts by", () => {
    const { onSort } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Due date/ }));
    expect(onSort).toHaveBeenCalledWith([{ field: "dueDate", dir: "asc" }]);
  });

  it("then descending, then the default order", () => {
    const { onSort, rerender } = setup({ sort: [{ field: "dueDate", dir: "asc" }] });
    void rerender;
    fireEvent.click(screen.getByRole("button", { name: /^Due date/ }));
    expect(onSort).toHaveBeenLastCalledWith([{ field: "dueDate", dir: "desc" }]);
  });

  it("goes back to the default (null) after descending", () => {
    const { onSort } = setup({ sort: [{ field: "dueDate", dir: "desc" }] });
    fireEvent.click(screen.getByRole("button", { name: /^Due date/ }));
    expect(onSort).toHaveBeenLastCalledWith(null);
  });

  it("adds a tie-break on shift-click", () => {
    const sort: PmSortSpec[] = [{ field: "priority", dir: "asc" }];
    const { onSort } = setup({ sort });
    fireEvent.click(screen.getByRole("button", { name: /^Due date/ }), { shiftKey: true });
    expect(onSort).toHaveBeenLastCalledWith([
      { field: "priority", dir: "asc" },
      { field: "dueDate", dir: "asc" },
    ]);
  });

  it("says which column is sorted, and which way, to a screen reader", () => {
    setup({ sort: [{ field: "priority", dir: "desc" }] });
    const grid = screen.getByRole("grid");
    expect(within(grid).getByRole("columnheader", { name: /Priority/ })).toHaveAttribute("aria-sort", "descending");
    expect(within(grid).getByRole("columnheader", { name: /Due date/ })).toHaveAttribute("aria-sort", "none");
  });
});

describe("selecting", () => {
  it("a row's checkbox selects it, marks the row and does not open it", () => {
    const { selection, onOpen } = setup();
    const box = within(rowOf("INBOX-2")).getByRole("checkbox", { name: "Select INBOX-2" });
    fireEvent.click(box);
    expect(selection.current!.has("w2")).toBe(true);
    expect(rowOf("INBOX-2")).toHaveAttribute("aria-selected", "true");
    expect(rowOf("INBOX-1")).toHaveAttribute("aria-selected", "false");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shift-click selects the range from the last one clicked", () => {
    const { selection } = setup({ rows: many(6) });
    fireEvent.click(within(rowOf("INBOX-2")).getByRole("checkbox"));
    fireEvent.click(within(rowOf("INBOX-5")).getByRole("checkbox"), { shiftKey: true });
    expect([...selection.current!.ids].sort()).toEqual(["w2", "w3", "w4", "w5"]);
  });

  it("the header checkbox selects everything, then nothing — and is half-ticked for a part", () => {
    const { selection } = setup({ rows: many(4) });
    const all = screen.getByRole("checkbox", { name: "Select all" }) as HTMLInputElement;
    fireEvent.click(all);
    expect(selection.current!.count).toBe(4);
    expect(all.checked).toBe(true);
    fireEvent.click(all);
    expect(selection.current!.count).toBe(0);

    fireEvent.click(within(rowOf("INBOX-1")).getByRole("checkbox"));
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);
  });

  it("select-all stops at the 500 a bulk request may change", () => {
    const { selection } = setup({ rows: many(PM_BULK_MAX_IDS + 120) });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(selection.current!.count).toBe(PM_BULK_MAX_IDS);
    expect(selection.current!.capped).toBe(true);
  });

  it("forgets a selected item that is no longer in the list", () => {
    const { selection, rerender } = setup({ rows: many(3) });
    fireEvent.click(within(rowOf("INBOX-3")).getByRole("checkbox"));
    expect(selection.current!.has("w3")).toBe(true);
    void rerender;
    // The same harness re-rendered with fewer rows: simulate with a fresh mount sharing nothing is not enough,
    // so drive the hook directly through the API the table uses.
    act(() => selection.current!.prune(new Set(["w1", "w2"])));
    expect(selection.current!.has("w3")).toBe(false);
  });
});

describe("the keyboard", () => {
  it("is one tab stop: the first row, until another is moved to", () => {
    setup();
    expect(rowOf("INBOX-1")).toHaveAttribute("tabindex", "0");
    expect(rowOf("INBOX-2")).toHaveAttribute("tabindex", "-1");
    // …and the controls in the other rows are not tab stops either.
    expect(within(rowOf("INBOX-2")).getByRole("checkbox")).toHaveAttribute("tabindex", "-1");
    expect(within(rowOf("INBOX-1")).getByRole("checkbox")).toHaveAttribute("tabindex", "0");
  });

  it("↓ and ↑ move the focus (and the tab stop) between rows, without going past the ends", () => {
    setup();
    focus(rowOf("INBOX-1"));
    fireEvent.keyDown(rowOf("INBOX-1"), { key: "ArrowDown" });
    expect(rowOf("INBOX-2")).toHaveFocus();
    expect(rowOf("INBOX-2")).toHaveAttribute("tabindex", "0");
    expect(rowOf("INBOX-1")).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(rowOf("INBOX-2"), { key: "ArrowDown" });
    fireEvent.keyDown(rowOf("INBOX-3"), { key: "ArrowDown" });
    expect(rowOf("INBOX-3")).toHaveFocus();
    fireEvent.keyDown(rowOf("INBOX-3"), { key: "ArrowUp" });
    expect(rowOf("INBOX-2")).toHaveFocus();
  });

  it("Home and End go to the first and last row", () => {
    setup({ rows: many(5) });
    focus(rowOf("INBOX-3"));
    fireEvent.keyDown(rowOf("INBOX-3"), { key: "End" });
    expect(rowOf("INBOX-5")).toHaveFocus();
    fireEvent.keyDown(rowOf("INBOX-5"), { key: "Home" });
    expect(rowOf("INBOX-1")).toHaveFocus();
  });

  it("Enter on a row opens its details", () => {
    const { onOpen } = setup();
    focus(rowOf("INBOX-2"));
    fireEvent.keyDown(rowOf("INBOX-2"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "w2" }));
  });

  it("Enter on a control INSIDE the row does that control's job, not 'open the row'", () => {
    const { onOpen } = setup();
    const btn = within(rowOf("INBOX-1")).getByRole("button", { name: "Change priority for INBOX-1" });
    focus(btn);
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("an arrow key typed in a field inside a row is the field's, not a row move", () => {
    setup();
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Edit title of INBOX-1" }));
    const field = screen.getByRole("textbox", { name: "Title of INBOX-1" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field).toBeInTheDocument();
    expect(rowOf("INBOX-2")).not.toHaveFocus();
  });
});

describe("the imperative API behind j, k, x, e, a, s and p", () => {
  it("move(1) with nothing active lands on the first row; move(-1) on the last", () => {
    const { api } = setup({ rows: many(4) });
    act(() => api.current!.move(1));
    expect(rowOf("INBOX-1")).toHaveFocus();
  });

  it("move(-1) with nothing active lands on the last row", () => {
    const { api } = setup({ rows: many(4) });
    act(() => api.current!.move(-1));
    expect(rowOf("INBOX-4")).toHaveFocus();
  });

  it("moves one row at a time from the active one", () => {
    const { api } = setup({ rows: many(4) });
    act(() => api.current!.move(1));
    act(() => api.current!.move(1));
    expect(rowOf("INBOX-2")).toHaveFocus();
    act(() => api.current!.move(-1));
    expect(rowOf("INBOX-1")).toHaveFocus();
  });

  it("toggleSelect selects the ACTIVE row, and unselects it again", () => {
    const { api, selection } = setup();
    act(() => api.current!.move(1));
    act(() => api.current!.move(1));
    act(() => api.current!.toggleSelect());
    expect([...selection.current!.ids]).toEqual(["w2"]);
    act(() => api.current!.toggleSelect());
    expect(selection.current!.count).toBe(0);
  });

  it("toggleSelect does nothing until a row has been moved to — the tab stop alone is not a choice", () => {
    const { api, selection } = setup();
    act(() => api.current!.toggleSelect());
    expect(selection.current!.count).toBe(0);
  });

  it.each([
    ["state", "Change state"],
    ["priority", "Change priority"],
    ["assignees", "Change assignees"],
  ] as const)("edit(%s) opens that editor on the active row", (kind, name) => {
    const { api } = setup();
    act(() => api.current!.move(1));
    act(() => api.current!.edit(kind));
    expect(screen.getByRole(kind === "assignees" ? "dialog" : "menu", { name })).toBeInTheDocument();
  });

  it("edit(name) turns the active row's title into a field", () => {
    const { api } = setup();
    act(() => api.current!.move(1));
    act(() => api.current!.edit("name"));
    expect(screen.getByRole("textbox", { name: "Title of INBOX-1" })).toHaveFocus();
  });

  it("says what to do when no row is active", () => {
    const { api, onAnnounce } = setup();
    act(() => api.current!.edit("state"));
    expect(onAnnounce).toHaveBeenCalledWith("Move to a row first, then press the key again.");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("says so, instead of doing nothing, when the column is hidden", () => {
    const { api, onAnnounce } = setup({ columns: ["key", "name"] });
    act(() => api.current!.move(1));
    act(() => api.current!.edit("priority"));
    expect(onAnnounce).toHaveBeenCalledWith("Show the priority column to change it from the keyboard.");
  });

  it("does not offer state on a workspace-wide table: its rows are in different projects", () => {
    const { api, onAnnounce } = setup({ scope: "workspace", states: [] });
    act(() => api.current!.move(1));
    act(() => api.current!.edit("state"));
    expect(onAnnounce).toHaveBeenCalledWith("State can't be changed from here — open the project.");
  });

  it("a reader's edit does nothing at all", () => {
    const { api, onAnnounce } = setup({ readOnly: true });
    act(() => api.current!.move(1));
    act(() => api.current!.edit("state"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onAnnounce).not.toHaveBeenCalled();
  });
});

describe("editing in place", () => {
  it("state: pick one from the menu → the edit, with that state", () => {
    const { edits } = setup();
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Change state for INBOX-1" }));
    const menu = screen.getByRole("menu", { name: "Change state" });
    expect(within(menu).getAllByRole("menuitemradio").map((b) => b.textContent)).toEqual(["Todo", "In Progress", "Done"]);
    expect(within(menu).getByRole("menuitemradio", { name: "Todo" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Done" }));
    expect(edits.setState).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }), DONE);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("state: picking the one it already has changes nothing", () => {
    const { edits } = setup();
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Change state for INBOX-1" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Todo" }));
    expect(edits.setState).not.toHaveBeenCalled();
  });

  it("priority: pick one → the edit", () => {
    const { edits } = setup();
    fireEvent.click(within(rowOf("INBOX-2")).getByRole("button", { name: "Change priority for INBOX-2" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Urgent/ }));
    expect(edits.setPriority).toHaveBeenCalledWith(expect.objectContaining({ id: "w2" }), "urgent");
  });

  it("assignees: tick people, Save → the COMPLETE set (a full replacement, brief §4.2)", () => {
    const { edits } = setup({ rows: [item(1, { assignees: ["u-ana"] })] });
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Change assignees for INBOX-1" }));
    const dialog = screen.getByRole("dialog", { name: "Change assignees" });
    expect(within(dialog).getByRole("checkbox", { name: "Ana" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Bo" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(edits.setAssignees).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }), ["u-ana", "u-bo"]);
  });

  it("assignees: unticking everyone and saving is a valid way to unassign one row", () => {
    const { edits } = setup({ rows: [item(1, { assignees: ["u-ana"] })] });
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Change assignees for INBOX-1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Ana" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(edits.setAssignees).toHaveBeenCalledWith(expect.anything(), []);
  });

  it("assignees: someone who has left stays on the item — a click that never showed them cannot drop them", () => {
    const { edits } = setup({ rows: [item(1, { assignees: ["u-gone", "u-ana"] })] });
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Change assignees for INBOX-1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Bo" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(edits.setAssignees).toHaveBeenCalledWith(expect.anything(), ["u-gone", "u-ana", "u-bo"]);
  });

  it("due date: pick a day, Save → that calendar date", () => {
    const { edits } = setup();
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Change due date for INBOX-1" }));
    const dialog = screen.getByRole("dialog", { name: "Change due date" });
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Due date"), { target: { value: "2026-11-05" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(edits.setDueDate).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }), "2026-11-05");
  });

  it("due date: Clear removes it, and is offered only when there is one", () => {
    const { edits } = setup({ rows: [item(1, { dueDate: "2026-11-05T00:00:00.000Z" }), item(2)] });
    fireEvent.click(within(rowOf("INBOX-2")).getByRole("button", { name: "Change due date for INBOX-2" }));
    expect(screen.queryByRole("button", { name: "Clear date" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Change due date for INBOX-1" }));
    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toBe("2026-11-05");
    fireEvent.click(screen.getByRole("button", { name: "Clear date" }));
    expect(edits.setDueDate).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }), null);
  });

  it("a menu closes on Escape and hands the focus back to its button", () => {
    setup();
    const btn = within(rowOf("INBOX-1")).getByRole("button", { name: "Change priority for INBOX-1" });
    fireEvent.click(btn);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(btn).toHaveFocus();
  });

  it("a menu closes when the table scrolls under it", () => {
    setup();
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Change priority for INBOX-1" }));
    fireEvent.scroll(screen.getByRole("grid"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keys pressed in a menu are the menu's: they do not also move the row it was opened from", () => {
    setup();
    focus(rowOf("INBOX-1"));
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Change priority for INBOX-1" }));
    const items = screen.getAllByRole("menuitemradio");
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    expect(rowOf("INBOX-2")).not.toHaveFocus();
  });

  it("the arrow keys walk a menu's items", () => {
    setup();
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Change priority for INBOX-1" }));
    const items = screen.getAllByRole("menuitemradio");
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: "End" });
    expect(items[items.length - 1]).toHaveFocus();
  });
});

describe("editing the title", () => {
  const open = () => {
    const h = setup();
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("button", { name: "Edit title of INBOX-1" }));
    return { ...h, field: screen.getByRole("textbox", { name: "Title of INBOX-1" }) as HTMLInputElement };
  };

  it("opens as a field holding the title, focused", () => {
    const { field } = open();
    expect(field.value).toBe("Item 1");
    expect(field).toHaveFocus();
  });

  it("Enter commits the new title", () => {
    const { field, edits } = open();
    fireEvent.change(field, { target: { value: "  Better name  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(edits.rename).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }), "Better name");
    expect(screen.queryByRole("textbox", { name: "Title of INBOX-1" })).toBeNull();
  });

  it("blur commits too", () => {
    const { field, edits } = open();
    fireEvent.change(field, { target: { value: "Via blur" } });
    fireEvent.blur(field);
    expect(edits.rename).toHaveBeenCalledWith(expect.anything(), "Via blur");
  });

  it("Esc puts it back and sends nothing", () => {
    const { field, edits } = open();
    fireEvent.change(field, { target: { value: "Never mind" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(edits.rename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Title of INBOX-1" })).toBeNull();
    expect(within(rowOf("INBOX-1")).getByText("Item 1")).toBeInTheDocument();
  });

  it("an unchanged title sends nothing", () => {
    const { field, edits } = open();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(edits.rename).not.toHaveBeenCalled();
  });

  it("an empty title is refused in place — brief §6's own words — and the field stays open", () => {
    const { field, edits } = open();
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("Name can't be empty.");
    expect(screen.getByRole("textbox", { name: "Title of INBOX-1" })).toBeInTheDocument();
    expect(edits.rename).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Title of INBOX-1" }), { target: { value: "Fixed" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Esc inside the field is the field's: it does not also clear the selection", () => {
    const { field, selection } = open();
    act(() => selection.current!.select("w1", { order: ["w1"] }));
    fireEvent.keyDown(field, { key: "Escape" });
    expect(selection.current!.count).toBe(1);
  });
});

describe("a reader", () => {
  it("sees the rows and nothing to change them with: no checkboxes, no editors, no pencil", () => {
    setup({ readOnly: true, rows: [item(1, { assignees: ["u-ana"], dueDate: "2026-11-05T00:00:00.000Z" })] });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Change / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit title/ })).toBeNull();
    expect(screen.getByRole("grid")).not.toHaveAttribute("aria-multiselectable");
    expect(within(rowOf("INBOX-1")).getByText("Todo")).toBeInTheDocument();
  });

  it("can still move around and open an item", () => {
    const { onOpen } = setup({ readOnly: true });
    focus(rowOf("INBOX-1"));
    fireEvent.keyDown(rowOf("INBOX-1"), { key: "ArrowDown" });
    expect(rowOf("INBOX-2")).toHaveFocus();
    fireEvent.keyDown(rowOf("INBOX-2"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalled();
  });
});

describe("a workspace-wide table", () => {
  it("shows the project, and edits everything but state — its rows have different projects' states", () => {
    setup({
      scope: "workspace",
      columns: ["key", "name", "project", "state", "priority"],
      states: [],
      projects: [{ id: "p1", name: "Onboarding", identifier: "INBOX" } as never],
    });
    const row = rowOf("INBOX-1");
    expect(within(row).getByText("Onboarding")).toBeInTheDocument();
    expect(within(row).getByText("INBOX", { selector: ".pm-linechip" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Change state/ })).toBeNull();
    expect(within(row).getByRole("button", { name: /Change priority/ })).toBeInTheDocument();
  });
});

describe("groups", () => {
  const rows = [item(1), item(2, { stateId: DOING.id, state: DOING }), item(3), item(4, { stateId: DONE.id, state: DONE })];

  it("draws a header per group with its name and count, rows under it", () => {
    setup({ rows, groupBy: "state" });
    const todo = screen.getByRole("button", { name: /Todo/ });
    expect(todo).toHaveAttribute("aria-expanded", "true");
    expect(todo).toHaveTextContent("Todo");
    expect(todo).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /In Progress/ })).toHaveTextContent("1");
    expect(rowsShown()).toHaveLength(4);
  });

  it("collapses a group to its header, and opens it again", () => {
    setup({ rows, groupBy: "state" });
    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));
    expect(screen.getByRole("button", { name: /Todo/ })).toHaveAttribute("aria-expanded", "false");
    expect(rowsShown().map((r) => r.getAttribute("aria-label"))).toEqual(["INBOX-2, Item 2", "INBOX-4, Item 4"]);
    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));
    expect(rowsShown()).toHaveLength(4);
  });

  it("an item with two assignees is under both, and 'Unassigned' comes last", () => {
    setup({
      rows: [item(1, { assignees: ["u-ana", "u-bo"] }), item(2)],
      groupBy: "assignee",
    });
    const headers = screen.getAllByRole("button", { expanded: true }).map((b) => b.textContent?.replace(/\s+/g, " ").trim());
    expect(headers.filter((h) => /^(Ana|Bo|Unassigned)/.test(h ?? ""))).toEqual(["Ana1 item", "Bo1 item", "Unassigned1 item"]);
    expect(rowsShown().map((r) => r.getAttribute("aria-label"))).toEqual([
      "INBOX-1, Item 1",
      "INBOX-1, Item 1",
      "INBOX-2, Item 2",
    ]);
  });

  it("reads a group's exact size off the server while rows are still arriving", () => {
    setup({ rows: [item(1)], groupBy: "state", loadingMore: true, groupCounts: [{ key: TODO.id, count: 240 }] });
    expect(screen.getByRole("button", { name: /Todo/ })).toHaveTextContent("240");
  });

  it("and counts what it holds once everything has arrived — an optimistic move is a move", () => {
    setup({ rows: [item(1)], groupBy: "state", loadingMore: false, groupCounts: [{ key: TODO.id, count: 240 }] });
    expect(screen.getByRole("button", { name: /Todo/ })).toHaveTextContent("1");
  });

  it("shift-select ranges over what is shown, not over a collapsed group's hidden rows", () => {
    const { selection } = setup({ rows, groupBy: "state" });
    fireEvent.click(screen.getByRole("button", { name: /In Progress/ }));
    fireEvent.click(within(rowOf("INBOX-1")).getByRole("checkbox"));
    fireEvent.click(within(rowOf("INBOX-4")).getByRole("checkbox"), { shiftKey: true });
    // INBOX-2 is hidden in the collapsed group: it is not swept in.
    expect([...selection.current!.ids].sort()).toEqual(["w1", "w3", "w4"]);
  });
});

describe("a thousand rows", () => {
  it("draws a window of them, not all — and says how many there are", () => {
    setup({ rows: many(1000) });
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "1001");
    const drawn = rowsShown().length;
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(60);
  });

  it("draws different rows after a scroll", () => {
    setup({ rows: many(1000) });
    const grid = screen.getByRole("grid");
    expect(screen.queryByRole("row", { name: /^INBOX-500,/ })).toBeNull();
    Object.defineProperty(grid, "scrollTop", { value: 500 * 44, configurable: true, writable: true });
    fireEvent.scroll(grid);
    expect(screen.getByRole("row", { name: /^INBOX-500,/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /^INBOX-1,/ })).toBeNull();
    expect(rowsShown().length).toBeLessThan(60);
  });

  it("End goes to the last row even though it was not drawn", () => {
    setup({ rows: many(1000) });
    focus(rowOf("INBOX-1"));
    fireEvent.keyDown(rowOf("INBOX-1"), { key: "End" });
    expect(screen.getByRole("row", { name: /^INBOX-1000,/ })).toHaveFocus();
  });

  it("j keeps moving through rows that were not drawn a moment ago", () => {
    const { api } = setup({ rows: many(1000) });
    for (let i = 0; i < 60; i += 1) act(() => api.current!.move(1));
    expect(screen.getByRole("row", { name: /^INBOX-60,/ })).toHaveFocus();
  });
});

describe("states", () => {
  it("loading is a skeleton, not a spinner", () => {
    setup({ domain: "loading" });
    expect(screen.getByLabelText("Loading work items")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("empty says what brief §6 says, with a New item for a writer in a project", () => {
    const onNewItem = vi.fn();
    setup({ domain: "empty", rows: [], onNewItem });
    expect(screen.getByText("No work items in this project yet — add one to get started.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New item/ }));
    expect(onNewItem).toHaveBeenCalled();
  });

  it("empty offers a reader no New item", () => {
    setup({ domain: "empty", rows: [], readOnly: true, onNewItem: vi.fn() });
    expect(screen.queryByRole("button", { name: /New item/ })).toBeNull();
  });

  it("filtered-to-empty is not the truly-empty case, and offers to clear the filters", () => {
    const onClearFilters = vi.fn();
    setup({ domain: "filtered", rows: [], onClearFilters });
    expect(screen.getByText("No work items match these filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClearFilters).toHaveBeenCalled();
  });

  it("an error is calm, and can be retried", () => {
    const onRetry = vi.fn();
    setup({ domain: "error", rows: [], onRetry });
    expect(screen.getByText("Couldn't load this project.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

void BUG;
