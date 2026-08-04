/**
 * WARP-1685 (UX review pin) — the meeting dialog is a real <form>, so
 * pressing Enter in the Title/Starts fields submits (keyboard parity with
 * clicking "Schedule meeting"). Pinned via form submission driving the
 * createTeamChatMeeting call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MeetingDialog } from "../MeetingDialog";

const { createTeamChatMeetingMock } = vi.hoisted(() => ({
  createTeamChatMeetingMock: vi.fn(async () => ({
    meeting: { id: "meet-1" },
    message: { id: "msg-1" },
  })),
}));

vi.mock("@/lib/api", () => ({
  createTeamChatMeeting: createTeamChatMeetingMock,
}));

beforeEach(() => {
  createTeamChatMeetingMock.mockClear();
});

describe("MeetingDialog (WARP-1685)", () => {
  it("submits via the FORM (Enter parity), sending the trimmed payload", async () => {
    const onCreated = vi.fn();
    const { baseElement } = render(
      <MeetingDialog open onClose={vi.fn()} threadId="t1" onCreated={onCreated} />,
    );

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "  Budget review  " },
    });
    const startsLocal = new Date(Date.now() + 60 * 60_000);
    const localValue = new Date(
      startsLocal.getTime() - startsLocal.getTimezoneOffset() * 60_000,
    )
      .toISOString()
      .slice(0, 16);
    fireEvent.change(screen.getByLabelText("Starts"), {
      target: { value: localValue },
    });

    // Submit the FORM itself — what Enter in a text field triggers.
    const form = baseElement.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createTeamChatMeetingMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ title: "Budget review" }),
    );
  });

  it("refuses a past start with inline copy instead of submitting", async () => {
    const { baseElement } = render(
      <MeetingDialog open onClose={vi.fn()} threadId="t1" onCreated={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Sync" } });
    const past = new Date(Date.now() - 60 * 60_000);
    const localValue = new Date(past.getTime() - past.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    fireEvent.change(screen.getByLabelText("Starts"), {
      target: { value: localValue },
    });
    // Drive the form directly (jsdom doesn't synthesize submit from a
    // button click) — the refusal under test is create()'s, not the DOM's.
    fireEvent.submit(baseElement.querySelector("form")!);

    expect(await screen.findByText("Pick a start time in the future.")).toBeTruthy();
    expect(createTeamChatMeetingMock).not.toHaveBeenCalled();
  });
});
