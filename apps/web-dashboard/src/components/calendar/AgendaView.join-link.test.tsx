/**
 * WARP-1905 — the video-call link on Agenda rows.
 *
 * A saved meeting link used to be invisible in the Agenda list (only the
 * detail sheet showed it, WARP-1874). The row now carries a real Join
 * anchor, re-parsed at render for the same reason MeetingCard does it: an
 * event row can arrive from an external ICS feed no zod schema ever saw,
 * and this component is the last thing between a stored string and an
 * href. When the URL embeds a passcode (Zoom pwd=, Teams p=), the row
 * shows it as a one-click copy chip — the raw URL stays the href.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import { AgendaView } from "./AgendaView";

const ZOOM = "https://warplab.zoom.us/j/98765?pwd=Ab12Cd34";
const MEET = "https://meet.google.com/abc-defg-hij";
const START = new Date(2026, 8, 1, 9, 0, 0, 0);

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "ev-1",
    userId: "u1",
    title: "Design review",
    description: null,
    location: null,
    meetingUrl: null,
    startsAt: START.toISOString(),
    endsAt: new Date(START.getTime() + 3600_000).toISOString(),
    allDay: false,
    source: "local",
    sourceId: null,
    externalUid: null,
    createdAt: START.toISOString(),
    updatedAt: START.toISOString(),
    ...over,
  };
}

beforeEach(() => {
  cleanup();
});

describe("AgendaView — join link on rows", () => {
  it("renders a safe Join anchor when the event has a video call link", () => {
    render(<AgendaView events={[event({ meetingUrl: ZOOM })]} />);

    const join = screen.getByRole("link", { name: /Join Zoom/ });
    expect(join.getAttribute("href")).toBe(ZOOM);
    expect(join.getAttribute("target")).toBe("_blank");
    expect(join.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("labels an unrecognized https provider generically", () => {
    render(
      <AgendaView events={[event({ meetingUrl: "https://jitsi.warp-lab.ai/room-7" })]} />,
    );
    expect(screen.getByRole("link", { name: /Join video call/ })).toBeTruthy();
  });

  it("renders nothing extra when the event has no link", () => {
    render(<AgendaView events={[event()]} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/passcode/i)).toBeNull();
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "Kitchen"])(
    "refuses to render %s as an href (ICS rows bypass the write-path gate)",
    (hostile) => {
      const { container } = render(<AgendaView events={[event({ meetingUrl: hostile })]} />);
      expect(container.querySelector("a")).toBeNull();
    },
  );

  it("keeps the join anchor outside the row button (no nested interactive controls)", () => {
    render(<AgendaView events={[event({ meetingUrl: ZOOM })]} />);
    const join = screen.getByRole("link", { name: /Join Zoom/ });
    expect(join.closest("button")).toBeNull();
  });

  it("still opens the event detail when the row itself is clicked", () => {
    const onSelect = vi.fn();
    render(<AgendaView events={[event({ meetingUrl: ZOOM })]} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Design review"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("does not open the event detail when the Join link is clicked", () => {
    const onSelect = vi.fn();
    render(<AgendaView events={[event({ meetingUrl: ZOOM })]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("link", { name: /Join Zoom/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("AgendaView — passcode chip", () => {
  it("shows the URL-embedded passcode and copies it on click", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    const onSelect = vi.fn();
    render(<AgendaView events={[event({ meetingUrl: ZOOM })]} onSelect={onSelect} />);

    const chip = screen.getByRole("button", { name: /copy passcode/i });
    expect(within(chip).getByText("Ab12Cd34")).toBeTruthy();

    fireEvent.click(chip);
    expect(writeText).toHaveBeenCalledWith("Ab12Cd34");
    // Copying must not double as "open the detail sheet".
    expect(onSelect).not.toHaveBeenCalled();
    // The chip confirms, then the row stays calm — no toast, no relayout.
    expect(await screen.findByText(/copied/i)).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("renders no passcode chip when the link carries none", () => {
    render(<AgendaView events={[event({ meetingUrl: MEET })]} />);
    expect(screen.getByRole("link", { name: /Join Google Meet/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /copy passcode/i })).toBeNull();
  });
});
