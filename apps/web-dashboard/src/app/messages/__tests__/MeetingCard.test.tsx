/**
 * WARP-1685 — meeting cards in the conversation pane.
 *
 * Pinned here:
 *   1. the invite card shows title, formatted time (+duration/location)
 *      and the organizer's name;
 *   2. a NON-organizer participant gets Going / Can't go buttons, wired
 *      to onRsvp with the meeting id, and their current answer is
 *      surfaced via aria-pressed;
 *   3. the ORGANIZER gets no RSVP buttons — a two-step Cancel instead
 *      (first click arms, second click fires onCancel; no window.confirm);
 *   4. a cancelled meeting renders the struck/cancelled state with NO
 *      action buttons for anyone;
 *   5. RSVP summary chips render the answers with names from the thread
 *      roster;
 *   6. the reminder card renders the subtle system-style line with the
 *      meeting title.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MeetingCard, MeetingReminderCard } from "../MeetingCard";
import type { TeamChatMeeting } from "@/lib/api";

const PARTICIPANTS = [
  { userId: "u-alice", displayName: "Alice A", username: "alice" },
  { userId: "u-bob", displayName: "Bob B", username: "bob" },
  { userId: "u-carol", displayName: "Carol C", username: "carol" },
];

// The card derives `started` from wall-clock time
// (`new Date(startsAt).getTime() <= Date.now()`), which gates the Going /
// Can't go buttons. An absolute default here is a time bomb: it passes until
// the moment it names, then fails forever on every branch. That is exactly
// what happened — a hardcoded 2026-08-10T14:30Z default went red at 14:30Z
// and reded `main` plus every open PR's `node / web-dashboard` leg. Keep the
// default RELATIVE and comfortably in the future; the tests that need a
// started meeting already override it with an explicit `Date.now() - …`.
const DEFAULT_STARTS_IN_MS = 60 * 60_000;

function meeting(over: Partial<TeamChatMeeting> = {}): TeamChatMeeting {
  return {
    id: "meet-1",
    threadId: "t1",
    inviteMessageId: "m1",
    calendarEventId: null,
    title: "Budget review",
    startsAt: new Date(Date.now() + DEFAULT_STARTS_IN_MS).toISOString(),
    durationMinutes: 45,
    location: "Kitchen",
    note: null,
    createdById: "u-alice",
    status: "scheduled",
    reminderMinutesBefore: 15,
    reminderStatus: "pending",
    createdAt: "2026-08-03T10:00:00.000Z",
    rsvps: [],
    ...over,
  };
}

const noop = vi.fn();

describe("MeetingCard (WARP-1685)", () => {
  it("shows title, duration, location, and the organizer's name", () => {
    render(
      <MeetingCard
        meeting={meeting()}
        meId="u-bob"
        participants={PARTICIPANTS}
        onRsvp={noop}
        onCancel={noop}
        busy={false}
      />,
    );
    expect(screen.getByText("Budget review")).toBeTruthy();
    expect(screen.getByText(/45 min/)).toBeTruthy();
    expect(screen.getByText(/Kitchen/)).toBeTruthy();
    expect(screen.getByText(/Alice A/)).toBeTruthy();
  });

  it("non-organizer: Going / Can't go call onRsvp; the current answer is aria-pressed", () => {
    const onRsvp = vi.fn();
    render(
      <MeetingCard
        meeting={meeting({
          rsvps: [
            { userId: "u-bob", response: "accepted", respondedAt: "2026-08-03T11:00:00.000Z" },
          ],
        })}
        meId="u-bob"
        participants={PARTICIPANTS}
        onRsvp={onRsvp}
        onCancel={noop}
        busy={false}
      />,
    );
    const going = screen.getByRole("button", { name: "Going" });
    const declined = screen.getByRole("button", { name: "Can't go" });
    expect(going.getAttribute("aria-pressed")).toBe("true");
    expect(declined.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(declined);
    expect(onRsvp).toHaveBeenCalledWith("meet-1", "declined");
  });

  it("organizer: no RSVP buttons; Cancel is two-step and only the second click fires", () => {
    const onCancel = vi.fn();
    render(
      <MeetingCard
        meeting={meeting()}
        meId="u-alice"
        participants={PARTICIPANTS}
        onRsvp={noop}
        onCancel={onCancel}
        busy={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Going" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel meeting" }));
    expect(onCancel).not.toHaveBeenCalled(); // armed, not fired

    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    expect(onCancel).toHaveBeenCalledWith("meet-1");
  });

  it("cancelled: struck state, no action buttons for anyone", () => {
    const { rerender } = render(
      <MeetingCard
        meeting={meeting({ status: "cancelled" })}
        meId="u-bob"
        participants={PARTICIPANTS}
        onRsvp={noop}
        onCancel={noop}
        busy={false}
      />,
    );
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("Budget review").className).toContain("line-through");
    expect(screen.queryByRole("button", { name: "Going" })).toBeNull();

    rerender(
      <MeetingCard
        meeting={meeting({ status: "cancelled" })}
        meId="u-alice"
        participants={PARTICIPANTS}
        onRsvp={noop}
        onCancel={noop}
        busy={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Cancel meeting" })).toBeNull();
  });

  it("a scheduled meeting that already began shows the cue instead of live RSVP pills", () => {
    render(
      <MeetingCard
        meeting={meeting({ startsAt: new Date(Date.now() - 10 * 60_000).toISOString() })}
        meId="u-bob"
        participants={PARTICIPANTS}
        onRsvp={noop}
        onCancel={noop}
        busy={false}
      />,
    );
    expect(screen.getByText("Already started")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Going" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Can't go" })).toBeNull();
  });

  it("renders RSVP summary chips with roster names", () => {
    render(
      <MeetingCard
        meeting={meeting({
          rsvps: [
            { userId: "u-bob", response: "accepted", respondedAt: "2026-08-03T11:00:00.000Z" },
            { userId: "u-carol", response: "declined", respondedAt: "2026-08-03T11:05:00.000Z" },
          ],
        })}
        meId="u-bob"
        participants={PARTICIPANTS}
        onRsvp={noop}
        onCancel={noop}
        busy={false}
      />,
    );
    expect(screen.getByText("Bob B")).toBeTruthy();
    expect(screen.getByText("Carol C")).toBeTruthy();
  });
});

describe("MeetingReminderCard (WARP-1685)", () => {
  it("renders the subtle reminder line with the meeting title", () => {
    render(
      <MeetingReminderCard
        meeting={meeting({ startsAt: new Date(Date.now() + 10 * 60_000).toISOString() })}
      />,
    );
    expect(screen.getByText(/Reminder/)).toBeTruthy();
    expect(screen.getByText(/Budget review/)).toBeTruthy();
    expect(screen.getByText(/10 min/)).toBeTruthy();
  });

  it("says the meeting was cancelled instead of a countdown", () => {
    render(
      <MeetingReminderCard
        meeting={meeting({
          status: "cancelled",
          startsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        })}
      />,
    );
    expect(screen.getByText(/cancelled/i)).toBeTruthy();
    expect(screen.queryByText(/10 min/)).toBeNull();
  });
});
