// WARP-3520 -- cards and rows show the work item's kind, its estimate and its
// start date beside the due date.

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { EstimateChip, StartChip, TypeIcon } from "./TypeBits";
import { BoardView, ListView } from "./board";
import { PeopleContext } from "./bits";
import { fmtEstimate, makePerson } from "./config";
import type { PmState, PmWorkItem } from "./types";

const STATE: PmState = { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true };

function item(over: Partial<PmWorkItem> = {}): PmWorkItem {
  return {
    id: "w1",
    projectId: "p",
    sequenceId: 1,
    key: "INBOX-1",
    name: "First task",
    descriptionHtml: null,
    stateId: "s1",
    state: STATE,
    priority: "none",
    parentId: null,
    cycleId: null,
    department: null,
    assignees: [],
    labels: [],
    startDate: null,
    dueDate: null,
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

const wrap = (node: React.ReactNode) =>
  render(<PeopleContext.Provider value={(id) => makePerson(id, "Tester")}>{node}</PeopleContext.Provider>);
const noop = () => undefined;

describe("fmtEstimate", () => {
  it("pluralises and is null for not estimated", () => {
    expect(fmtEstimate(5)).toBe("5 pts");
    expect(fmtEstimate(1)).toBe("1 pt");
    expect(fmtEstimate(0.5)).toBe("0.5 pts");
    expect(fmtEstimate(0)).toBe("0 pts");
    for (const none of [null, undefined, Number.NaN]) expect(fmtEstimate(none)).toBeNull();
  });
});

describe("marks", () => {
  it("TypeIcon names the kind for assistive tech (never colour alone)", () => {
    wrap(<TypeIcon type="bug" />);
    expect(screen.getByRole("img", { name: "Bug" })).toBeInTheDocument();
  });

  it("TypeIcon falls back to a task for an item that predates kinds", () => {
    wrap(<TypeIcon />);
    expect(screen.getByRole("img", { name: "Task" })).toBeInTheDocument();
  });

  it("EstimateChip renders only for an estimated item", () => {
    const { container, rerender } = render(<EstimateChip estimate={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<EstimateChip estimate={8} />);
    expect(screen.getByText("8 pts")).toBeInTheDocument();
  });

  it("StartChip renders only with a start date, and says 'Starts' to a screen reader", () => {
    const { container, rerender } = render(<StartChip item={{ startDate: null }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<StartChip item={{ startDate: "2026-10-04T12:00:00.000Z" }} />);
    expect(screen.getByText("Starts", { exact: false })).toBeInTheDocument();
  });
});

describe("board card", () => {
  it("shows kind, estimate and the start date beside the due date", () => {
    wrap(
      <BoardView
        states={[STATE]}
        items={[item({ type: "bug", estimate: 5, startDate: "2026-10-04T12:00:00.000Z", dueDate: "2999-10-09T12:00:00.000Z" })]}
        domain="populated"
        readOnly
        onOpen={noop}
        onTransition={noop}
        onNewItem={noop}
      />,
    );
    const card = screen.getByRole("button", { name: "INBOX-1, First task" });
    expect(within(card).getByRole("img", { name: "Bug" })).toBeInTheDocument();
    expect(within(card).getByText("5 pts")).toBeInTheDocument();
    expect(within(card).getByText("Starts", { exact: false })).toBeInTheDocument();
    // The due chip is still there beside it.
    expect(card.querySelector(".pm-duechip.info")).not.toBeNull();
  });

  it("an item with none of the new fields looks as it did, plus the default task mark", () => {
    wrap(
      <BoardView states={[STATE]} items={[item()]} domain="populated" readOnly onOpen={noop} onTransition={noop} onNewItem={noop} />,
    );
    const card = screen.getByRole("button", { name: "INBOX-1, First task" });
    expect(within(card).getByRole("img", { name: "Task" })).toBeInTheDocument();
    expect(within(card).queryByText(/pts?$/)).toBeNull();
    expect(within(card).queryByText("Starts", { exact: false })).toBeNull();
  });
});

describe("list row", () => {
  it("shows kind and estimate", () => {
    wrap(<ListView states={[STATE]} items={[item({ type: "incident", estimate: 2 })]} domain="populated" onOpen={noop} />);
    const row = screen.getByRole("button", { name: "INBOX-1, First task" });
    expect(within(row).getByRole("img", { name: "Incident" })).toBeInTheDocument();
    expect(within(row).getByText("2 pts")).toBeInTheDocument();
  });
});
