import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput";
import type { ChatAttachment } from "@/lib/types";

describe("ChatInput", () => {
  it("renders textarea and send button", () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.getByPlaceholderText("Ask Droplet anything…")).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("calls onSend with the input value", () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Ask Droplet anything…");

    fireEvent.change(textarea, { target: { value: "Hello AI" } });
    fireEvent.click(screen.getByRole("button"));

    expect(onSend).toHaveBeenCalledWith("Hello AI");
  });

  it("clears input after sending", () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByPlaceholderText(
      "Ask Droplet anything…"
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
    const textarea = screen.getByPlaceholderText("Ask Droplet anything…");
    expect(textarea).toBeDisabled();
  });

  it("sends on Enter key", () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Ask Droplet anything…");

    fireEvent.change(textarea, { target: { value: "Test message" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onSend).toHaveBeenCalledWith("Test message");
  });

  it("does not send on Shift+Enter", () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Ask Droplet anything…");

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

  it("renders Stop as the design-handoff neutral chat-stop variant (WARP-855)", () => {
    // The Ask AI handoff replaced the red destructive Stop with a quiet
    // bordered square (surface-2 + --text) — Claude-style "stop keeps
    // partial text", not a destructive action.
    render(
      <ChatInput onSend={vi.fn()} onStop={vi.fn()} isStreaming />,
    );
    const stop = screen.getByLabelText("Stop generating");
    expect(stop.className).toMatch(/(^|\s)chat-send(\s|$)/);
    expect(stop.className).toMatch(/(^|\s)chat-stop(\s|$)/);
  });
});

// ── WARP-855: composer control contract (Ask AI design handoff) ──
//
// The handoff supersedes WARP-301's 44 px floor INSIDE the composer card:
// send is a 34 px brand square, attach/mic are 30 px quiet icon buttons
// (chat.css spec values). Both clear WCAG 2.5.8 AA's 24 px minimum; the
// card itself provides the generous touch surround on mobile.

describe("ChatInput composer controls (WARP-855)", () => {
  it("Send is the 34 px brand square (chat-send)", () => {
    render(<ChatInput onSend={vi.fn()} />);
    const send = screen.getByLabelText("Send message");
    expect(send.className).toMatch(/(^|\s)chat-send(\s|$)/);
  });

  it("Stop swaps in as chat-send chat-stop", () => {
    render(<ChatInput onSend={vi.fn()} onStop={vi.fn()} isStreaming />);
    const stop = screen.getByLabelText("Stop generating");
    expect(stop.className).toMatch(/(^|\s)chat-stop(\s|$)/);
  });

  it("Paperclip / attach is a quiet 30 px icon button (chat-iconbtn)", () => {
    render(<ChatInput onSend={vi.fn()} onAttach={vi.fn()} />);
    const attach = screen.getByLabelText("Attach a file");
    expect(attach.className).toMatch(/(^|\s)chat-iconbtn(\s|$)/);
  });

  it("Paperclip icon renders at the handoff's size 15", () => {
    render(<ChatInput onSend={vi.fn()} onAttach={vi.fn()} />);
    const attach = screen.getByLabelText("Attach a file");
    const svg = attach.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("width")).toBe("15");
    expect(svg!.getAttribute("height")).toBe("15");
  });
});

// ── WARP-829: seed() imperative handle (prime the composer from /tools) ──

describe("ChatInput seed (WARP-829)", () => {
  it("seed() sets the textarea value to the seed text", () => {
    const ref = createRef<ChatInputHandle>();
    render(<ChatInput ref={ref} onSend={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(
      "Ask Droplet anything…",
    ) as HTMLTextAreaElement;

    // act() flushes the setValue state update + the deferred focus microtask
    // the imperative handle schedules.
    act(() => {
      ref.current!.seed("Block a device from the internet for ");
    });

    expect(textarea.value).toBe("Block a device from the internet for ");
  });

  it("seed() focuses the textarea and puts the caret at the end", async () => {
    const ref = createRef<ChatInputHandle>();
    render(<ChatInput ref={ref} onSend={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(
      "Ask Droplet anything…",
    ) as HTMLTextAreaElement;

    act(() => {
      ref.current!.seed("Set the wifi name to ");
    });

    // Focus + caret are scheduled in a microtask after the value flush; wait
    // for the textarea to take focus.
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    // Caret collapsed at the end so the user keeps typing after the seed.
    expect(textarea.selectionStart).toBe("Set the wifi name to ".length);
    expect(textarea.selectionEnd).toBe("Set the wifi name to ".length);
  });

  it("seed() REPLACES any existing value (it does not prepend like insertQuote)", () => {
    const ref = createRef<ChatInputHandle>();
    render(<ChatInput ref={ref} onSend={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(
      "Ask Droplet anything…",
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "leftover draft" } });
    act(() => {
      ref.current!.seed("Fresh starter line ");
    });

    expect(textarea.value).toBe("Fresh starter line ");
  });
});

describe("ChatInput IME composition guard (WARP-295)", () => {
  it("does NOT send on Enter while the user is composing a CJK character", () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByPlaceholderText("Ask Droplet anything…");

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

  it("calls onAttach for files pasted into the textarea", () => {
    const onAttach = vi.fn();
    render(<ChatInput onSend={vi.fn()} onAttach={onAttach} />);
    const textarea = screen.getByPlaceholderText("Ask Droplet anything…");

    const file = new File(["x"], "pasted.png", { type: "image/png" });
    fireEvent.paste(textarea, { clipboardData: { files: [file] } });
    expect(onAttach).toHaveBeenCalledWith(file);
  });

  it("leaves text-only pastes to the default textarea behavior", () => {
    const onAttach = vi.fn();
    render(<ChatInput onSend={vi.fn()} onAttach={onAttach} />);
    const textarea = screen.getByPlaceholderText("Ask Droplet anything…");

    fireEvent.paste(textarea, {
      clipboardData: { files: [], getData: () => "plain text" },
    });
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("hides the mic when audio capture isn't available (jsdom default)", () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: /dictate a message/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the mic when the browser can capture audio", () => {
    vi.stubGlobal("AudioContext", class {});
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });
    try {
      render(<ChatInput onSend={vi.fn()} />);
      expect(
        screen.getByRole("button", { name: /dictate a message/i }),
      ).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
      // @ts-expect-error — cleanup of the test-injected property
      delete navigator.mediaDevices;
    }
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
