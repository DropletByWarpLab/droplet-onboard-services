import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";
import type { ChatAttachment } from "@/lib/types";

describe("ChatInput", () => {
  it("renders textarea and send button", () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.getByPlaceholderText("Send a message...")).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("calls onSend with the input value", () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Send a message...");

    fireEvent.change(textarea, { target: { value: "Hello AI" } });
    fireEvent.click(screen.getByRole("button"));

    expect(onSend).toHaveBeenCalledWith("Hello AI");
  });

  it("clears input after sending", () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByPlaceholderText(
      "Send a message..."
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button"));

    expect(textarea.value).toBe("");
  });

  it("does not send empty messages", () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);

    fireEvent.click(screen.getByRole("button"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables input when disabled prop is true", () => {
    render(<ChatInput onSend={vi.fn()} disabled />);
    const textarea = screen.getByPlaceholderText("Send a message...");
    expect(textarea).toBeDisabled();
  });

  it("sends on Enter key", () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Send a message...");

    fireEvent.change(textarea, { target: { value: "Test message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onSend).toHaveBeenCalledWith("Test message");
  });

  it("does not send on Shift+Enter", () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Send a message...");

    fireEvent.change(textarea, { target: { value: "Test" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });
});

// ── WARP-295: Stop button while streaming + IME guard ──

describe("ChatInput stop button (WARP-295)", () => {
  it("renders the Stop button (not Send) while isStreaming is true", () => {
    render(
      <ChatInput onSend={vi.fn()} onStop={vi.fn()} isStreaming />,
    );
    const stop = screen.getByLabelText("Stop generating");
    expect(stop).toBeInTheDocument();
    // Send button is no longer the visible primary action.
    expect(screen.queryByLabelText("Send message")).not.toBeInTheDocument();
  });

  it("calls onStop when the Stop button is clicked", () => {
    const onStop = vi.fn();
    render(
      <ChatInput onSend={vi.fn()} onStop={onStop} isStreaming />,
    );
    fireEvent.click(screen.getByLabelText("Stop generating"));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("falls back to the Send button when isStreaming is false (or unset)", () => {
    render(<ChatInput onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
    expect(screen.queryByLabelText("Stop generating")).not.toBeInTheDocument();
  });

  it("uses text-system-red on the Stop icon so it reads as a destructive primary", () => {
    render(
      <ChatInput onSend={vi.fn()} onStop={vi.fn()} isStreaming />,
    );
    const stop = screen.getByLabelText("Stop generating");
    // The stop icon (or its wrapper) carries text-system-red — sniffing
    // for either the button or any descendant with the token.
    const hasRedToken =
      stop.className.includes("text-system-red") ||
      stop.querySelector('[class*="text-system-red"]') !== null;
    expect(hasRedToken).toBe(true);
  });
});

// ── WARP-301: hit-target audit (WCAG 2.5.5 AA → 44 px) ──

describe("ChatInput hit-targets (WARP-301)", () => {
  it("Send button is ≥ 44×44 px (uses w-11 h-11 utility)", () => {
    render(<ChatInput onSend={vi.fn()} />);
    const send = screen.getByLabelText("Send message");
    // Tailwind's w-11/h-11 = 2.75rem = 44 px. The audit floor.
    expect(send.className).toMatch(/(^|\s)w-11(\s|$)/);
    expect(send.className).toMatch(/(^|\s)h-11(\s|$)/);
  });

  it("Stop button is ≥ 44×44 px (uses w-11 h-11 utility)", () => {
    render(<ChatInput onSend={vi.fn()} onStop={vi.fn()} isStreaming />);
    const stop = screen.getByLabelText("Stop generating");
    expect(stop.className).toMatch(/(^|\s)w-11(\s|$)/);
    expect(stop.className).toMatch(/(^|\s)h-11(\s|$)/);
  });

  it("Paperclip / attach button is ≥ 44×44 px (uses w-11 h-11 utility)", () => {
    render(<ChatInput onSend={vi.fn()} onAttach={vi.fn()} />);
    const attach = screen.getByLabelText("Attach a file");
    expect(attach.className).toMatch(/(^|\s)w-11(\s|$)/);
    expect(attach.className).toMatch(/(^|\s)h-11(\s|$)/);
  });
});

describe("ChatInput IME composition guard (WARP-295)", () => {
  it("does NOT send on Enter while the user is composing a CJK character", () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Send a message...");

    fireEvent.change(textarea, { target: { value: "你好" } });
    // jsdom's KeyboardEvent doesn't surface `isComposing` through the
    // synthetic event; ChatInput reads it off `e.nativeEvent.isComposing`,
    // so we set it on the underlying KeyboardEvent.
    const evt = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: false,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(evt, "isComposing", { value: true });
    textarea.dispatchEvent(evt);

    expect(onSend).not.toHaveBeenCalled();
  });
});

// ── WARP-203: chat-attached files ──

describe("ChatInput attachments", () => {
  it("hides paperclip + attachment-row when onAttach is omitted (back-compat)", () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.queryByLabelText("Attach a file")).not.toBeInTheDocument();
    expect(screen.queryByTestId("attachment-row")).not.toBeInTheDocument();
  });

  it("renders the paperclip + hidden file input when onAttach is provided", () => {
    render(<ChatInput onSend={vi.fn()} onAttach={vi.fn()} />);
    expect(screen.getByLabelText("Attach a file")).toBeInTheDocument();
    expect(screen.getByTestId("chat-file-input")).toBeInTheDocument();
  });

  it("calls onAttach for each file selected through the picker", () => {
    const onAttach = vi.fn();
    render(<ChatInput onSend={vi.fn()} onAttach={onAttach} />);
    const input = screen.getByTestId("chat-file-input") as HTMLInputElement;

    const f1 = new File(["a"], "a.txt", { type: "text/plain" });
    const f2 = new File(["b"], "b.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [f1, f2] } });

    expect(onAttach).toHaveBeenCalledTimes(2);
    expect(onAttach).toHaveBeenNthCalledWith(1, f1);
    expect(onAttach).toHaveBeenNthCalledWith(2, f2);
  });

  it("calls onAttach for files dropped on the panel", () => {
    const onAttach = vi.fn();
    render(<ChatInput onSend={vi.fn()} onAttach={onAttach} />);
    const panel = screen.getByTestId("chat-input");

    const file = new File(["x"], "drop.txt", { type: "text/plain" });
    fireEvent.dragOver(panel, { dataTransfer: { files: [file] } });
    expect(panel).toHaveAttribute("data-dragging", "true");
    fireEvent.drop(panel, { dataTransfer: { files: [file] } });
    expect(onAttach).toHaveBeenCalledWith(file);
    // Drag-state clears after drop.
    expect(panel).not.toHaveAttribute("data-dragging");
  });

  it("renders one chip per attachment with status text", () => {
    const attachments: ChatAttachment[] = [
      {
        localId: "a1",
        itemId: "bmi-1",
        filename: "notes.md",
        bytes: 1234,
        status: "indexing",
      },
      {
        localId: "a2",
        filename: "broken.pdf",
        bytes: 5678,
        status: "failed",
        error: "extractor_unavailable",
      },
    ];
    render(
      <ChatInput
        onSend={vi.fn()}
        onAttach={vi.fn()}
        attachments={attachments}
      />,
    );
    const chips = screen.getAllByTestId("attachment-chip");
    expect(chips.length).toBe(2);
    expect(chips[0].getAttribute("data-status")).toBe("indexing");
    expect(chips[1].getAttribute("data-status")).toBe("failed");
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    // WARP-294: failed chips render the friendly chat-domain
    // translation of `error`, never the raw orchestrator token.
    expect(screen.queryByText(/extractor_unavailable/)).not.toBeInTheDocument();
  });

  it("calls onRemoveAttachment when the chip's X button is clicked", () => {
    const onRemoveAttachment = vi.fn();
    const attachments: ChatAttachment[] = [
      {
        localId: "a1",
        itemId: "bmi-1",
        filename: "x.txt",
        bytes: 12,
        status: "ready",
      },
    ];
    render(
      <ChatInput
        onSend={vi.fn()}
        onAttach={vi.fn()}
        attachments={attachments}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );
    fireEvent.click(screen.getByLabelText("Remove x.txt"));
    expect(onRemoveAttachment).toHaveBeenCalledWith("a1");
  });
});
