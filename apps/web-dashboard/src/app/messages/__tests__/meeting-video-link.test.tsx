/**
 * WARP-1874 — attaching a Zoom / Teams / Meet / Webex link to a meeting
 * scheduled from Messages, and rendering it as a real Join link.
 *
 * Two halves:
 *   1. MeetingDialog — an explicit "Add video call link" control that sits
 *      ALONGSIDE the physical Location field, so a meeting can be both in
 *      the living room and on a call. Client-side scheme check gives the
 *      organizer the error at paste time instead of a 400 on submit.
 *   2. MeetingCard — the pasted URL becomes a real anchor, with the
 *      scheme re-checked at render. That second check is not redundant: a
 *      meeting row can predate the meetingUrl column or arrive from an
 *      ICS sync, and this component is the last thing between a stored
 *      string and an href on another household member's screen.
 *   3. MeetingReminderCard — the same anchor on the 15-minutes-before
 *      reminder. That is peak intent for the whole feature: without it the
 *      member has to scroll back up the thread to the invite to find the
 *      link they need right now.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MeetingDialog } from "../MeetingDialog";
import { MeetingCard, MeetingReminderCard } from "../MeetingCard";
import type { TeamChatMeeting } from "@/lib/api";

const { createTeamChatMeetingMock } = vi.hoisted(() => ({
  createTeamChatMeetingMock: vi.fn(async () => ({
    meeting: { id: "meet-1" },
    message: { id: "msg-1" },
  })),
}));

vi.mock("@/lib/api", () => ({
  createTeamChatMeeting: createTeamChatMeetingMock,
}));

beforeEach(() => createTeamChatMeetingMock.mockClear());

const ZOOM = "https://warplab.zoom.us/j/98765?pwd=abc";

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Budget review" },
  });
  const soon = new Date(Date.now() + 60 * 60_000);
  fireEvent.change(screen.getByLabelText("Starts"), {
    target: {
      value: new Date(soon.getTime() - soon.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16),
    },
  });
}

describe("MeetingDialog — video call link", () => {
  it("keeps the link field behind an explicit control, so the default stays a plain place", () => {
    render(<MeetingDialog open onClose={vi.fn()} threadId="t1" onCreated={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Add video call link" })).toBeTruthy();
    expect(screen.queryByLabelText("Video call link")).toBeNull();
    // The physical location field is untouched and still the primary path.
    expect(screen.getByLabelText(/Location/)).toBeTruthy();
  });

  it("reveals the field on request and sends the link alongside the physical location", async () => {
    const onCreated = vi.fn();
    const { baseElement } = render(
      <MeetingDialog open onClose={vi.fn()} threadId="t1" onCreated={onCreated} />,
    );
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText(/Location/), {
      target: { value: "Living Room" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add video call link" }));
    fireEvent.change(screen.getByLabelText("Video call link"), {
      target: { value: ZOOM },
    });
    fireEvent.submit(baseElement.querySelector("form")!);

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createTeamChatMeetingMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ location: "Living Room", meetingUrl: ZOOM }),
    );
  });

  it("names the recognized provider back to the organizer as confirmation", () => {
    render(<MeetingDialog open onClose={vi.fn()} threadId="t1" onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add video call link" }));
    fireEvent.change(screen.getByLabelText("Video call link"), {
      target: { value: ZOOM },
    });
    expect(screen.getByText("Zoom link")).toBeTruthy();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "http://zoom.us/j/1",
    "the kitchen",
  ])("refuses %s with inline copy instead of submitting", async (hostile) => {
    const onCreated = vi.fn();
    const { baseElement } = render(
      <MeetingDialog open onClose={vi.fn()} threadId="t1" onCreated={onCreated} />,
    );
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Add video call link" }));
    fireEvent.change(screen.getByLabelText("Video call link"), {
      target: { value: hostile },
    });
    fireEvent.submit(baseElement.querySelector("form")!);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Video call links need to start with https://",
      ),
    );
    expect(createTeamChatMeetingMock).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("accepts an unrecognized https link — an allowlist that drops a valid link is the worse bug", async () => {
    const onCreated = vi.fn();
    const { baseElement } = render(
      <MeetingDialog open onClose={vi.fn()} threadId="t1" onCreated={onCreated} />,
    );
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Add video call link" }));
    fireEvent.change(screen.getByLabelText("Video call link"), {
      target: { value: "https://vc.warp-lab.ai/room/kitchen" },
    });
    fireEvent.submit(baseElement.querySelector("form")!);

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createTeamChatMeetingMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ meetingUrl: "https://vc.warp-lab.ai/room/kitchen" }),
    );
  });

  it("omits meetingUrl entirely when the organizer removes the field again", async () => {
    const onCreated = vi.fn();
    const { baseElement } = render(
      <MeetingDialog open onClose={vi.fn()} threadId="t1" onCreated={onCreated} />,
    );
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Add video call link" }));
    fireEvent.change(screen.getByLabelText("Video call link"), {
      target: { value: ZOOM },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove video call link" }));
    fireEvent.submit(baseElement.querySelector("form")!);

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const body = (
      createTeamChatMeetingMock.mock.calls as unknown as Array<
        [string, Record<string, unknown>]
      >
    )[0][1];
    expect("meetingUrl" in body).toBe(false);
  });
});

// ── the invite card ─────────────────────────────────────────────────

const PARTICIPANTS = [
  { userId: "u-alice", displayName: "Alice A", username: "alice" },
  { userId: "u-bob", displayName: "Bob B", username: "bob" },
];

function meeting(over: Partial<TeamChatMeeting> = {}): TeamChatMeeting {
  return {
    id: "meet-1",
    threadId: "t1",
    inviteMessageId: "m1",
    calendarEventId: null,
    title: "Budget review",
    startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    durationMinutes: 45,
    location: null,
    meetingUrl: null,
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

function renderCard(over: Partial<TeamChatMeeting> = {}) {
  return render(
    <MeetingCard
      meeting={meeting(over)}
      meId="u-bob"
      participants={PARTICIPANTS}
      onRsvp={vi.fn()}
      onCancel={vi.fn()}
      busy={false}
    />,
  );
}

describe("MeetingCard — Join link", () => {
  it("renders the link as a real anchor, not plain text", () => {
    renderCard({ meetingUrl: ZOOM });
    const join = screen.getByRole("link", { name: /Join Zoom/ });
    expect(join.getAttribute("href")).toBe(ZOOM);
  });

  it("opens in a new tab with rel=noopener noreferrer", () => {
    // The opener reference and the referrer both leak from a link a
    // household member did not author.
    renderCard({ meetingUrl: ZOOM });
    const join = screen.getByRole("link", { name: /Join Zoom/ });
    expect(join.getAttribute("target")).toBe("_blank");
    expect(join.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it.each([
    ["https://teams.microsoft.com/l/meetup-join/19%3aabc", "Join Microsoft Teams"],
    ["https://meet.google.com/abc-defg-hij", "Join Google Meet"],
    ["https://warplab.webex.com/meet/stefan", "Join Webex"],
    ["https://vc.warp-lab.ai/room/kitchen", "Join video call"],
  ])("labels %s as %s", (url, label) => {
    renderCard({ meetingUrl: url });
    expect(screen.getByRole("link", { name: new RegExp(label) })).toBeTruthy();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "http://zoom.us/j/1",
    "Living Room",
  ])("refuses to render %s as an href", (hostile) => {
    // Defense in depth. The server already refuses these, but a row can
    // predate the column or arrive from an ICS sync — the component is
    // the last gate before the attribute exists.
    const { container } = renderCard({ meetingUrl: hostile });
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
  });

  it("shows the link and the physical location together", () => {
    renderCard({ meetingUrl: ZOOM, location: "Living Room" });
    expect(screen.getByText(/Living Room/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Join Zoom/ })).toBeTruthy();
  });

  it("drops the Join link on a cancelled meeting", () => {
    // Joining a call that was called off is not an action to offer.
    renderCard({ meetingUrl: ZOOM, status: "cancelled" });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders nothing extra when there is no link", () => {
    renderCard({ location: "Kitchen" });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/Join/)).toBeNull();
  });
});

// ── the reminder ────────────────────────────────────────────────────

describe("MeetingReminderCard — Join link", () => {
  function renderReminder(over: Partial<TeamChatMeeting> = {}) {
    return render(
      <MeetingReminderCard
        meeting={meeting({
          startsAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          ...over,
        })}
      />,
    );
  }

  it("carries the Join link next to the countdown", () => {
    // The reminder fires 15 minutes out — the moment the link is actually
    // wanted. Sending the member back up the thread to the invite is the
    // gap this closes.
    renderReminder({ meetingUrl: ZOOM });
    expect(screen.getByText(/starts in 15 min/)).toBeTruthy();
    const join = screen.getByRole("link", { name: /Join Zoom/ });
    expect(join.getAttribute("href")).toBe(ZOOM);
  });

  it("opens in a new tab with rel=noopener noreferrer", () => {
    renderReminder({ meetingUrl: ZOOM });
    const join = screen.getByRole("link", { name: /Join Zoom/ });
    expect(join.getAttribute("target")).toBe("_blank");
    expect(join.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("drops the Join link on a cancelled meeting", () => {
    // Same suppression as the invite card, from the same guard: the
    // reminder for a cancelled meeting says so, and offers nothing to do.
    renderReminder({ meetingUrl: ZOOM, status: "cancelled" });
    expect(screen.getByText(/cancelled/i)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://zoom.us/j/1",
    "Living Room",
  ])("refuses to render %s as an href", (hostile) => {
    const { container } = renderReminder({ meetingUrl: hostile });
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
  });

  it("renders the bare line when the meeting has no link", () => {
    renderReminder();
    expect(screen.getByText(/starts in 15 min/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders the bare line when the meeting row is gone", () => {
    render(<MeetingReminderCard meeting={null} />);
    expect(screen.getByText("Meeting reminder")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
