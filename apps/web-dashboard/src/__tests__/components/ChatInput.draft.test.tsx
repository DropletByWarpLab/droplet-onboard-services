/**
 * WARP-3062 — a half-typed message survives the composer unmounting (the
 * assistant layout's switch to Overview and back): with a `draftKey` the
 * unsent text lives in this tab's sessionStorage until it is sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";
import { CHAT_DRAFT_KEY } from "@/lib/types";
import { clearChatHandoffs } from "@/lib/session-reset";
import { SIDE_STORAGE_KEYS } from "@/lib/assistant-side";

const field = () => screen.getByPlaceholderText("Ask Droplet anything…") as HTMLTextAreaElement;

beforeEach(() => {
  sessionStorage.clear();
});

describe("ChatInput draftKey", () => {
  it("puts a half-typed message back after the composer unmounts and returns", () => {
    const first = render(<ChatInput onSend={vi.fn()} draftKey={CHAT_DRAFT_KEY} />);
    fireEvent.change(field(), { target: { value: "Draft the Hartwell renewal" } });
    first.unmount();

    render(<ChatInput onSend={vi.fn()} draftKey={CHAT_DRAFT_KEY} />);
    expect(field().value).toBe("Draft the Hartwell renewal");
  });

  it("sending clears the draft, so it does not come back", () => {
    const onSend = vi.fn();
    const first = render(<ChatInput onSend={onSend} draftKey={CHAT_DRAFT_KEY} />);
    fireEvent.change(field(), { target: { value: "What's on today?" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("What's on today?");
    expect(sessionStorage.getItem(CHAT_DRAFT_KEY)).toBeNull();
    first.unmount();

    render(<ChatInput onSend={vi.fn()} draftKey={CHAT_DRAFT_KEY} />);
    expect(field().value).toBe("");
  });

  it("emptying the field by hand clears the draft too", () => {
    render(<ChatInput onSend={vi.fn()} draftKey={CHAT_DRAFT_KEY} />);
    fireEvent.change(field(), { target: { value: "x" } });
    expect(sessionStorage.getItem(CHAT_DRAFT_KEY)).toBe("x");
    fireEvent.change(field(), { target: { value: "" } });
    expect(sessionStorage.getItem(CHAT_DRAFT_KEY)).toBeNull();
  });

  it("without a draftKey the composer forgets on unmount, as before", () => {
    const first = render(<ChatInput onSend={vi.fn()} />);
    fireEvent.change(field(), { target: { value: "gone" } });
    first.unmount();
    expect(sessionStorage.length).toBe(0);

    render(<ChatInput onSend={vi.fn()} />);
    expect(field().value).toBe("");
  });

  it("sign-out forgets the draft and the remembered places with the hand-offs", () => {
    sessionStorage.setItem(CHAT_DRAFT_KEY, "private words");
    sessionStorage.setItem(SIDE_STORAGE_KEYS.ask, "/chat?c=abc");
    sessionStorage.setItem(SIDE_STORAGE_KEYS.business, "/customers/42");
    clearChatHandoffs();
    expect(sessionStorage.getItem(CHAT_DRAFT_KEY)).toBeNull();
    expect(sessionStorage.getItem(SIDE_STORAGE_KEYS.ask)).toBeNull();
    expect(sessionStorage.getItem(SIDE_STORAGE_KEYS.business)).toBeNull();
  });
});
