/**
 * WARP-3536 — a card that is being dragged is not moved by someone else's
 * change: the board holds the picture it had when the card was picked up, and
 * live refreshes are held back until the drop.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BoardView } from "./board";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import { isPmLivePaused } from "./usePmLive";
import type { PmState, PmWorkItem } from "./types";

const STATES: PmState[] = [
  { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  { id: "s2", projectId: "p", name: "In Progress", group: "started", color: "#f59e0b", sortOrder: 2, isDefault: false },
];

function item(over: Partial<PmWorkItem> = {}): PmWorkItem {
  return {
    id: "w1",
    projectId: "p",
    sequenceId: 1,
    key: "INBOX-1",
    name: "First task",
    descriptionHtml: null,
    stateId: "s1",
    state: STATES[0] ?? null,
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

function board(items: PmWorkItem[], onTransition = vi.fn()) {
  const ui = (list: PmWorkItem[]) => (
    <PeopleContext.Provider value={(id) => makePerson(id, "Tester")}>
      <BoardView
        states={STATES}
        items={list}
        domain="populated"
        readOnly={false}
        onOpen={() => undefined}
        onTransition={onTransition}
        onNewItem={() => undefined}
      />
    </PeopleContext.Provider>
  );
  const view = render(ui(items));
  return { ...view, onTransition, show: (list: PmWorkItem[]) => view.rerender(ui(list)) };
}

const card = (key: string) => screen.getByRole("button", { name: new RegExp(`^${key},`) });
const columnOf = (key: string) => card(key).closest(".pm-col")?.querySelector(".pm-sect")?.textContent ?? "";

describe("BoardView while a card is held", () => {
  it("keeps the card where it was picked up when someone else moves it", () => {
    const { show } = board([item(), item({ id: "w2", key: "INBOX-2", name: "Second", sortOrder: 2 })]);
    expect(columnOf("INBOX-1")).toContain("Todo");

    fireEvent.dragStart(card("INBOX-1"));
    // A colleague moves INBOX-1 to In Progress while it is in the user's hand.
    show([item({ stateId: "s2", state: STATES[1] ?? null }), item({ id: "w2", key: "INBOX-2", name: "Second", sortOrder: 2 })]);
    expect(columnOf("INBOX-1")).toContain("Todo"); // not yanked

    fireEvent.dragEnd(card("INBOX-1"));
    expect(columnOf("INBOX-1")).toContain("In Progress"); // the board catches up once it is let go
  });

  it("does not show a card that arrived mid-drag until the drop, nor lose one that left", () => {
    const { show } = board([item()]);
    fireEvent.dragStart(card("INBOX-1"));
    show([item(), item({ id: "w3", key: "INBOX-3", name: "Third", sortOrder: 3 })]);
    expect(screen.queryByRole("button", { name: /^INBOX-3,/ })).toBeNull();

    fireEvent.dragEnd(card("INBOX-1"));
    expect(screen.getByRole("button", { name: /^INBOX-3,/ })).toBeTruthy();
  });

  it("holds live refreshes for exactly as long as the card is held", () => {
    board([item()]);
    expect(isPmLivePaused()).toBe(false);

    fireEvent.dragStart(card("INBOX-1"));
    expect(isPmLivePaused()).toBe(true);

    fireEvent.dragEnd(card("INBOX-1"));
    expect(isPmLivePaused()).toBe(false);
  });

  it("releases the hold on a drop too, and still makes the transition", () => {
    const { container, onTransition } = board([item()]);
    fireEvent.dragStart(card("INBOX-1"));
    expect(isPmLivePaused()).toBe(true);

    const target = container.querySelectorAll(".pm-col")[1] as HTMLElement; // In Progress
    fireEvent.dragOver(target);
    fireEvent.drop(target);

    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition.mock.calls[0]?.[0]).toMatchObject({ id: "w1" });
    expect(onTransition.mock.calls[0]?.[1]).toBe("s2");
    expect(isPmLivePaused()).toBe(false);
  });

  it("releases the hold when the board goes away mid-drag", () => {
    const { unmount } = board([item()]);
    fireEvent.dragStart(card("INBOX-1"));
    expect(isPmLivePaused()).toBe(true);
    unmount();
    expect(isPmLivePaused()).toBe(false);
  });

  it("is unchanged when nothing is being dragged: new data shows at once", () => {
    const { show } = board([item()]);
    show([item({ stateId: "s2", state: STATES[1] ?? null })]);
    expect(columnOf("INBOX-1")).toContain("In Progress");
  });
});
