/**
 * WARP-3528 — the composer: Reply or Internal note, and the honest line about a
 * reply that nothing sends yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const sendReply = vi.fn();
const addNote = vi.fn();
vi.mock("./useSupport", async () => {
  const actual = await vi.importActual<typeof import("./useSupport")>("./useSupport");
  return { ...actual, supportActions: () => ({ sendReply, addNote }) };
});

import { Composer } from "./Composer";
import { makeDesk, makeTicket } from "./support.test-fixtures";

const mount = (desk = makeDesk()) => {
  const onSent = vi.fn();
  render(<Composer ticket={makeTicket()} desk={desk} onSent={onSent} />);
  return onSent;
};

beforeEach(() => {
  toast.mockReset();
  sendReply.mockReset().mockResolvedValue({});
  addNote.mockReset().mockResolvedValue({});
});

describe("Composer copy", () => {
  it("says a reply is recorded, not sent, while no channel is bound", () => {
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("Reply will be recorded — connect an email channel to send it.");
  });

  it("says who a reply goes to once a channel is bound", () => {
    mount(makeDesk({ channels: [{ id: "ch-1", kind: "EMAIL", enabled: true }] }));
    expect(screen.getByRole("status")).toHaveTextContent("Reply will be sent to dana@example.test.");
  });

  it("says a note stays with the team", () => {
    mount();
    fireEvent.click(screen.getByRole("radio", { name: "Internal note" }));
    expect(screen.getByRole("status")).toHaveTextContent("Only your team sees this note.");
    expect(screen.getByRole("button", { name: /Add note/ })).toBeInTheDocument();
  });

  it("starts on Reply, with the toggle as a labelled radio group", () => {
    mount();
    expect(screen.getByRole("radiogroup", { name: "Message type" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Reply" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Internal note" })).not.toBeChecked();
  });
});

describe("sending", () => {
  it("cannot send an empty message", () => {
    mount();
    expect(screen.getByRole("button", { name: /Send reply/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: /Send reply/ })).toBeDisabled();
  });

  it("sends a reply as escaped paragraphs and tells the agent it was recorded", async () => {
    const onSent = mount();
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "On it <b>now</b>\n\nThanks" } });
    fireEvent.click(screen.getByRole("button", { name: /Send reply/ }));
    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
    expect(sendReply).toHaveBeenCalledWith("t-1", "<p>On it &lt;b&gt;now&lt;/b&gt;</p><p>Thanks</p>", undefined);
    expect(addNote).not.toHaveBeenCalled();
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("Reply recorded", "success");
    expect(screen.getByLabelText("Reply")).toHaveValue("");
  });

  it("adds a note through the note route, never the reply route", async () => {
    mount();
    fireEvent.click(screen.getByRole("radio", { name: "Internal note" }));
    fireEvent.change(screen.getByLabelText("Internal note"), { target: { value: "Check the toner" } });
    fireEvent.click(screen.getByRole("button", { name: /Add note/ }));
    await waitFor(() => expect(addNote).toHaveBeenCalledWith("t-1", "<p>Check the toner</p>", undefined));
    expect(sendReply).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Note added", "success");
  });

  it("sends with the keyboard shortcut", async () => {
    mount();
    const box = screen.getByLabelText("Reply");
    fireEvent.change(box, { target: { value: "Quick one" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
  });

  it("sets the status in the same change, and not when it is already that status", async () => {
    mount();
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "Waiting on you" } });
    fireEvent.change(screen.getByLabelText("Then set the status to"), { target: { value: "st-pending" } });
    fireEvent.click(screen.getByRole("button", { name: /Send reply/ }));
    await waitFor(() => expect(sendReply).toHaveBeenCalledWith("t-1", "<p>Waiting on you</p>", "st-pending"));

    sendReply.mockClear();
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "Again" } });
    fireEvent.change(screen.getByLabelText("Then set the status to"), { target: { value: "st-new" } });
    fireEvent.click(screen.getByRole("button", { name: /Send reply/ }));
    await waitFor(() => expect(sendReply).toHaveBeenCalledWith("t-1", "<p>Again</p>", undefined));
  });

  it("keeps what was typed and says why when the server refuses", async () => {
    sendReply.mockRejectedValue(Object.assign(new Error("desk_archived"), { code: "desk_archived", status: 409 }));
    mount();
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: /Send reply/ }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]![0]).toMatch(/archived/i);
    expect(toast.mock.calls[0]![0]).not.toMatch(/desk_archived/);
    expect(toast.mock.calls[0]![1]).toBe("error");
    expect(screen.getByLabelText("Reply")).toHaveValue("Keep me");
  });
});
