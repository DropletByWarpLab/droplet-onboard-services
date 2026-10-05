/**
 * WARP-3537 — "Group by" and "Columns". They edit the view's display options; these
 * tests pin what they offer, what they report, and that neither can take the title away.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { PM_TABLE_DEFAULT_COLUMNS } from "@droplet/shared-types";
import { DisplayControls, type DisplayControlsProps } from "./DisplayControls";

function setup(over: Partial<DisplayControlsProps> = {}) {
  const onGroupBy = vi.fn();
  const onColumns = vi.fn();
  render(
    <div className="pm-scope">
      <DisplayControls
        layout="table"
        scope="project"
        groupBy={null}
        onGroupBy={onGroupBy}
        columns={[...PM_TABLE_DEFAULT_COLUMNS.project]}
        onColumns={onColumns}
        departments={false}
        {...over}
      />
    </div>,
  );
  return { onGroupBy, onColumns };
}

const group = () => screen.getByRole("group", { name: "Group by" });

describe("Group by", () => {
  it("offers None first on a table, then the fields a project can name", () => {
    setup();
    expect(within(group()).getAllByRole("button").map((b) => b.textContent)).toEqual(["None", "State", "Assignee", "Priority", "Label"]);
  });

  it("offers no None on a list — a list is grouped by default", () => {
    setup({ layout: "list", groupBy: "state" });
    expect(within(group()).getAllByRole("button").map((b) => b.textContent)).toEqual(["State", "Assignee", "Priority", "Label"]);
  });

  it("offers project and stage instead of state and label across projects", () => {
    setup({ scope: "workspace", layout: "list", groupBy: "project" });
    expect(within(group()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Project", "Stage", "Assignee", "Priority"]);
  });

  it("offers Department only when the box has departments", () => {
    setup({ departments: true });
    expect(within(group()).getByRole("button", { name: "Department" })).toBeInTheDocument();
  });

  it("marks the one in use, and reports a click (None as null)", () => {
    const { onGroupBy } = setup({ groupBy: "priority" });
    expect(within(group()).getByRole("button", { name: "Priority" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group()).getByRole("button", { name: "None" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(group()).getByRole("button", { name: "Assignee" }));
    expect(onGroupBy).toHaveBeenLastCalledWith("assignee");
    fireEvent.click(within(group()).getByRole("button", { name: "None" }));
    expect(onGroupBy).toHaveBeenLastCalledWith(null);
  });
});

describe("the column picker", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Columns" }));

  it("is for the table only", () => {
    setup({ layout: "list", groupBy: "state" });
    expect(screen.queryByRole("button", { name: "Columns" })).toBeNull();
  });

  it("lists a project's columns with the current ones ticked, the title locked on, and no Project column", () => {
    setup();
    open();
    const dialog = screen.getByRole("dialog", { name: "Choose columns" });
    expect(within(dialog).queryByRole("checkbox", { name: "Project" })).toBeNull();
    expect(within(dialog).getByRole("checkbox", { name: "Title" })).toBeDisabled();
    expect(within(dialog).getByRole("checkbox", { name: "Title" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "State" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Start date" })).not.toBeChecked();
  });

  it("offers Project to a workspace table", () => {
    setup({ scope: "workspace", columns: [...PM_TABLE_DEFAULT_COLUMNS.workspace] });
    open();
    expect(screen.getByRole("checkbox", { name: "Project" })).toBeChecked();
  });

  it("reports the new set at once, in the table's own order — not the order they were ticked", () => {
    const { onColumns } = setup();
    open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Start date" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Department" }));
    expect(onColumns).toHaveBeenNthCalledWith(1, ["key", "name", "state", "priority", "assignees", "labels", "dueDate", "startDate", "updatedAt"]);
    // The component reports against the columns it was GIVEN; the second tick is on top of the originals.
    expect(onColumns).toHaveBeenNthCalledWith(2, ["key", "name", "state", "priority", "assignees", "labels", "dueDate", "updatedAt", "department"]);
  });

  it("hides a column when it is unticked", () => {
    const { onColumns } = setup();
    open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Labels" }));
    expect(onColumns).toHaveBeenLastCalledWith(["key", "name", "state", "priority", "assignees", "dueDate", "updatedAt"]);
  });

  it("Reset to default reports an empty list — which the display state stores as 'the default'", () => {
    const { onColumns } = setup();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(onColumns).toHaveBeenCalledWith([]);
  });

  it("Done closes it", () => {
    setup();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Choose columns" })).toBeNull();
  });
});
