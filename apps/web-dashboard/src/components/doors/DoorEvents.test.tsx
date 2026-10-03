/**
 * ADR-055 P4b — the doors' recent activity.
 *
 * What it must hold: every one of the fourteen kinds reads in plain words with
 * a glyph (an exhaustive list, so a kind added later fails here); a forced-door
 * row says WHICH claim it makes (§9.7); an empty log never reads as a quiet
 * night; a failed read is not an empty log; and "Show older" pages without
 * losing keyboard focus.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { DoorEventKind, DoorEventView } from "@/lib/types";
import { DoorEvents, iconFor, type DoorEventsProps } from "./DoorEvents";
import { COPY, EVENT_LABEL, FORCED_LABEL, TROUBLE_LABEL, eventText } from "./door-copy";

const NOW = new Date("2026-09-29T20:00:00.000Z");

const KINDS: readonly DoorEventKind[] = [
  "door_open",
  "door_closed",
  "latch_retracted",
  "latch_extended",
  "bolt_thrown",
  "bolt_withdrawn",
  "rex",
  "key_override",
  "unlock_granted",
  "unlock_denied",
  "forced_door",
  "held_open",
  "tamper",
  "trouble",
];

function event(id: string, over: Partial<DoorEventView> = {}): DoorEventView {
  return {
    id,
    doorId: "d1",
    doorName: "Front door",
    kind: "door_open",
    occurredAt: "2026-09-29T18:02:00.000Z",
    forcedClaim: null,
    troubleCode: null,
    derivedFromId: null,
    correlationKey: null,
    ...over,
  };
}

function props(over: Partial<DoorEventsProps> = {}): DoorEventsProps {
  return {
    events: [event("2"), event("1", { kind: "door_closed", occurredAt: "2026-09-28T09:00:00.000Z" })],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    now: NOW,
    timeZone: "UTC",
    ...over,
  };
}

describe("the rows", () => {
  it("name the door, say what happened in words, and carry the time as an instant", () => {
    render(<DoorEvents {...props()} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Front door")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Opened")).toBeInTheDocument();
    const time = within(rows[0]!).getByText("6:02 PM");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("dateTime", "2026-09-29T18:02:00.000Z");
    expect(within(rows[1]!).getByText("Closed")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Mon 9:00 AM")).toBeInTheDocument();
  });

  it("keep the order they were given (newest first is the box's)", () => {
    render(<DoorEvents {...props()} />);
    expect(screen.getAllByRole("listitem").map((r) => r.getAttribute("data-event-id"))).toEqual(["2", "1"]);
  });

  it.each(KINDS)("%s has a label, and a glyph", (kind) => {
    const { label } = eventText({ kind, forcedClaim: kind === "forced_door" ? "latch_witnessed" : null, troubleCode: kind === "trouble" ? "position_unknown" : null });
    expect(label.length).toBeGreaterThan(0);
    expect(iconFor(kind)).toBeDefined();
    const { container } = render(<DoorEvents {...props({ events: [event("9", { kind })] })} />);
    expect(container.querySelector("li svg")).not.toBeNull();
  });

  it("the labels cover every kind but the two that need a second field", () => {
    expect(Object.keys(EVENT_LABEL).sort()).toEqual(KINDS.filter((k) => k !== "forced_door" && k !== "trouble").sort());
  });

  it("a forced-door row from a lock says the latch was still out", () => {
    render(<DoorEvents {...props({ events: [event("5", { kind: "forced_door", forcedClaim: "latch_witnessed", derivedFromId: "4" })] })} />);
    expect(screen.getByText(new RegExp(FORCED_LABEL.latch_witnessed.label))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(FORCED_LABEL.latch_witnessed.note))).toBeInTheDocument();
  });

  it("a forced-door row from a sensor-only door is the WEAKER claim, and says so", () => {
    render(<DoorEvents {...props({ events: [event("5", { kind: "forced_door", forcedClaim: "unwitnessed_open", derivedFromId: "4" })] })} />);
    expect(screen.getByText(new RegExp(FORCED_LABEL.unwitnessed_open.label))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(FORCED_LABEL.unwitnessed_open.note))).toBeInTheDocument();
    expect(screen.queryByText(/latch was still out/)).toBeNull();
  });

  it("a lost link reads as unknown, never as closed", () => {
    render(<DoorEvents {...props({ events: [event("6", { kind: "trouble", troubleCode: "position_unknown" })] })} />);
    expect(screen.getByText(TROUBLE_LABEL.position_unknown)).toBeInTheDocument();
    expect(screen.queryByText("Closed")).toBeNull();
  });

  it("a long door name wraps rather than being cut off", () => {
    const name = "The very long name of a door at the back of the warehouse ".repeat(1).trim();
    render(<DoorEvents {...props({ events: [event("7", { doorName: name })] })} />);
    const nm = screen.getByText(name);
    expect(nm).toHaveStyle({ whiteSpace: "normal" });
  });
});

describe("the other states", () => {
  it("loading says nothing about activity yet", () => {
    render(<DoorEvents {...props({ events: [], isLoading: true })} />);
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText(COPY.emptyEventsTitle)).toBeNull();
  });

  it("an empty log says an empty list does not mean nothing happened", () => {
    render(<DoorEvents {...props({ events: [] })} />);
    expect(screen.getByText(COPY.emptyEventsTitle)).toBeInTheDocument();
    expect(screen.getByText(COPY.emptyEventsBody)).toBeInTheDocument();
    expect(screen.getByText(COPY.emptyEventsBody)).toHaveTextContent(/doesn't mean nothing happened/);
  });

  it("a failed read is an alert, not an empty log, and it can be retried", () => {
    const onRetry = vi.fn();
    render(<DoorEvents {...props({ events: [], error: new Error("x"), onRetry })} />);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(COPY.eventsFailedTitle)).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyEventsTitle)).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: COPY.retryLabel }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("a failed refresh with rows on screen keeps the rows", () => {
    render(<DoorEvents {...props({ error: new Error("x") })} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Show older", () => {
  it("is offered only when the box says there is more", () => {
    const { rerender } = render(<DoorEvents {...props()} />);
    expect(screen.queryByRole("button", { name: COPY.moreEvents })).toBeNull();
    rerender(<DoorEvents {...props({ hasMore: true })} />);
    expect(screen.getByRole("button", { name: COPY.moreEvents })).toBeInTheDocument();
  });

  it("asks for the next page", () => {
    const onLoadMore = vi.fn();
    render(<DoorEvents {...props({ hasMore: true, onLoadMore })} />);
    fireEvent.click(screen.getByRole("button", { name: COPY.moreEvents }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("while a page loads it is aria-disabled, not disabled: the pressed button keeps focus, and a second press asks for nothing", () => {
    const onLoadMore = vi.fn();
    render(<DoorEvents {...props({ hasMore: true, isLoadingMore: true, onLoadMore })} />);
    const button = screen.getByRole("button", { name: COPY.moreEvents });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    button.focus();
    fireEvent.click(button);
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });
});
