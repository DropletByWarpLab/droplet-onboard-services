/**
 * WARP-3537 — the floating bulk bar: state, priority, assignee, labels, archive.
 * It draws choices and hands the one picked up as a BulkOp; what the op does is the
 * hook's (`useBulkActions.test.tsx`) and the server's.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { BulkBar, type BulkBarProps } from "./BulkBar";
import type { PmLabel, PmState } from "../types";

const STATES: PmState[] = [
  { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: null, sortOrder: 1, isDefault: true },
  { id: "s2", projectId: "p", name: "Done", group: "completed", color: null, sortOrder: 2, isDefault: false },
];
const LABELS: PmLabel[] = [{ id: "l1", projectId: "p", name: "Bug", color: null }];
const PEOPLE = [
  { value: "u-ana", label: "Ana" },
  { value: "u-bo", label: "Bo" },
];

function setup(over: Partial<BulkBarProps> = {}) {
  const onRun = vi.fn();
  const onClear = vi.fn();
  render(
    <div className="pm-scope">
      <BulkBar
        count={3}
        capped={false}
        busy={false}
        scope="project"
        states={STATES}
        labels={LABELS}
        people={PEOPLE}
        canArchive
        onRun={onRun}
        onClear={onClear}
        {...over}
      />
    </div>,
  );
  return { onRun, onClear };
}

const bar = () => screen.getByRole("region", { name: "Bulk actions" });
const open = (name: string) => fireEvent.click(within(bar()).getByRole("button", { name }));

describe("what the bar says and offers", () => {
  it("says how many are selected, politely", () => {
    setup({ count: 12 });
    expect(within(bar()).getByRole("status")).toHaveTextContent("12 selected");
  });

  it("offers state, priority, assignee, labels and archive for a project's rows", () => {
    setup();
    const names = within(bar()).getAllByRole("button").map((b) => b.textContent?.trim());
    expect(names).toEqual(["State", "Priority", "Assignee", "Labels", "Archive", "Clear selection"]);
  });

  it("offers no state or labels across projects — they are per project, and the rows are in many", () => {
    setup({ scope: "workspace", states: [], labels: [] });
    const names = within(bar()).getAllByRole("button").map((b) => b.textContent?.trim());
    expect(names).toEqual(["Priority", "Assignee", "Archive", "Clear selection"]);
  });

  it("offers no label action when the project has no labels, and no archive over archived rows", () => {
    setup({ labels: [], canArchive: false });
    const names = within(bar()).getAllByRole("button").map((b) => b.textContent?.trim());
    expect(names).toEqual(["State", "Priority", "Assignee", "Clear selection"]);
  });

  it("says the cap is the cap when the selection stopped short", () => {
    setup({ capped: true });
    expect(within(bar()).getByText(/most one change can cover \(500\)/)).toBeInTheDocument();
  });

  it("is quiet while a write is in flight: the actions wait, the clear does not", () => {
    setup({ busy: true });
    for (const name of ["State", "Priority", "Assignee", "Labels", "Archive"]) {
      expect(within(bar()).getByRole("button", { name })).toBeDisabled();
    }
    expect(within(bar()).getByRole("button", { name: "Clear selection" })).toBeEnabled();
  });
});

describe("what each choice asks for", () => {
  it("State → a state", () => {
    const { onRun } = setup();
    open("State");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Done" }));
    expect(onRun).toHaveBeenCalledWith({ kind: "state", stateId: "s2" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Priority → a priority", () => {
    const { onRun } = setup();
    open("Priority");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /High/ }));
    expect(onRun).toHaveBeenCalledWith({ kind: "priority", priority: "high" });
  });

  it("Assignee → the set that was ticked, which REPLACES what each item had; Assign waits for a choice", () => {
    const { onRun } = setup();
    open("Assignee");
    const dialog = screen.getByRole("dialog", { name: "Assignee" });
    expect(within(dialog).getByRole("button", { name: "Assign" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Ana" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Bo" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign" }));
    expect(onRun).toHaveBeenCalledWith({ kind: "assignees", assigneeIds: ["u-ana", "u-bo"] });
  });

  it("Assignee → nobody is its own named button, never a stray empty Apply", () => {
    const { onRun } = setup();
    open("Assignee");
    fireEvent.click(screen.getByRole("button", { name: "Clear assignees" }));
    expect(onRun).toHaveBeenCalledWith({ kind: "assignees", assigneeIds: [] });
  });

  it("Labels → add a label (the default), or remove one", () => {
    const { onRun } = setup();
    open("Labels");
    fireEvent.click(screen.getByRole("menuitem", { name: "Bug" }));
    expect(onRun).toHaveBeenLastCalledWith({ kind: "label", labelId: "l1", mode: "add" });

    open("Labels");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bug" }));
    expect(onRun).toHaveBeenLastCalledWith({ kind: "label", labelId: "l1", mode: "remove" });
  });

  it("Archive → archive, with no menu in between", () => {
    const { onRun } = setup();
    fireEvent.click(within(bar()).getByRole("button", { name: "Archive" }));
    expect(onRun).toHaveBeenCalledWith({ kind: "archive" });
  });

  it("Clear selection → clears", () => {
    const { onClear } = setup();
    fireEvent.click(within(bar()).getByRole("button", { name: "Clear selection" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("opening one menu closes the one before", () => {
    setup();
    open("State");
    expect(screen.getByRole("menu", { name: "State" })).toBeInTheDocument();
    open("Priority");
    expect(screen.queryByRole("menu", { name: "State" })).toBeNull();
    expect(screen.getByRole("menu", { name: "Priority" })).toBeInTheDocument();
  });
});
