import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// CitationChip wraps next/link — the global mock in setup.ts returns a
// raw string template rather than a real element, which makes the chip
// render as text. Override here so the chip renders an <a>.
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => {
    const React = require("react");
    return React.createElement("a", props, children);
  },
}));

import { ChatMessage } from "@/components/ChatMessage";
import type {
  ChatMessage as ChatMessageType,
  ChatToolCall,
} from "@/lib/types";

describe("ChatMessage", () => {
  it("renders user message content", () => {
    render(
      <ChatMessage
        message={{ id: "1", role: "user", content: "Hello!" }}
      />
    );
    expect(screen.getByText("Hello!")).toBeInTheDocument();
  });

  it("renders assistant message content", () => {
    render(
      <ChatMessage
        message={{ id: "2", role: "assistant", content: "Hi there!" }}
      />
    );
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
  });

  it("shows streaming cursor for assistant messages when streaming", () => {
    const { container } = render(
      <ChatMessage
        message={{ id: "3", role: "assistant", content: "Thinking..." }}
        isStreaming={true}
      />
    );
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).toBeInTheDocument();
  });

  it("does not show streaming cursor for user messages", () => {
    const { container } = render(
      <ChatMessage
        message={{ id: "4", role: "user", content: "Hello" }}
        isStreaming={true}
      />
    );
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).not.toBeInTheDocument();
  });

  it("does not show cursor when not streaming", () => {
    const { container } = render(
      <ChatMessage
        message={{ id: "5", role: "assistant", content: "Done" }}
        isStreaming={false}
      />
    );
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).not.toBeInTheDocument();
  });

  // WARP-104 reviewer follow-up: lock the polarity-bug fix at the
  // visual layer too. The hook test in `useChat.test.tsx` asserts the
  // wire shape; these tests assert what the chip ACTUALLY renders.
  describe("tool-call chip rendering — confirmation flow", () => {
    function withToolCall(partial: Partial<ChatToolCall>): ChatMessageType {
      return {
        id: "asst-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "block_network_device",
            args: { mac: "AA:BB:CC:DD:EE:FF" },
            ...partial,
          },
        ],
      };
    }

    it("renders the amber confirmation_required chip with data-tool-status='confirmation_required'", () => {
      // Wire shape per spec §7.1 + §8.2: ok=true, status='confirmation_required'.
      // The chip discriminator MUST be `status`, NOT `ok` — a regression to
      // the WARP-104 polarity bug would render the green ✓ "completed" chip
      // here, which is exactly the silent safety regression UX flagged.
      const { container } = render(
        <ChatMessage
          message={withToolCall({
            ok: true,
            status: "confirmation_required",
            message: "Open the dashboard to approve",
          })}
        />,
      );

      const chip = container.querySelector(
        '[data-tool-call-id="call-1"]',
      ) as HTMLElement | null;
      expect(chip).not.toBeNull();
      expect(chip!.dataset.toolStatus).toBe("confirmation_required");
      expect(chip!.dataset.toolName).toBe("block_network_device");
      // Amber tone — the design-token utility class. If the future bug
      // re-introduces non-existent `system-amber-subtle`, this assertion
      // fails because the class name won't be present.
      expect(chip!.className).toContain("bg-system-orange/15");
      expect(chip!.className).toContain("text-system-orange");
      // aria-label tells SR users the state explicitly — not "completed",
      // not "failed".
      expect(chip!.getAttribute("aria-label")).toMatch(/needs your approval/i);
    });

    it("surfaces the confirmation message inline (visible text), not just in title=", () => {
      render(
        <ChatMessage
          message={withToolCall({
            ok: true,
            status: "confirmation_required",
            message: "Open the dashboard to approve",
          })}
        />,
      );
      // The message must be visible in the DOM, not just hover-only.
      const visible = screen.getByText("Open the dashboard to approve");
      expect(visible).toBeInTheDocument();
      // It carries role="alert" so SR users get the urgency cue, plus
      // the data hook the future Tier-2 modal can latch onto.
      const alert = visible.closest('[role="alert"]') as HTMLElement | null;
      expect(alert).not.toBeNull();
      expect(alert!.dataset.confirmMessageFor).toBe("call-1");
    });

    it("falls back to a persona-appropriate copy when no message is provided", () => {
      render(
        <ChatMessage
          message={withToolCall({
            ok: true,
            status: "confirmation_required",
            // no message field
          })}
        />,
      );
      // Generic but on-tone fallback — not "undefined", not raw status.
      expect(
        screen.getByText(/needs your approval in the Droplet dashboard/i),
      ).toBeInTheDocument();
    });

    it("ok=true success (no status) still renders the green completed chip", () => {
      const { container } = render(
        <ChatMessage
          message={withToolCall({
            ok: true,
            data: { devices: [] },
          })}
        />,
      );
      const chip = container.querySelector(
        '[data-tool-call-id="call-1"]',
      ) as HTMLElement | null;
      expect(chip).not.toBeNull();
      expect(chip!.dataset.toolStatus).toBe("ok");
      expect(chip!.className).toContain("bg-system-green/15");
      expect(chip!.getAttribute("aria-label")).toMatch(/completed/i);
    });

    it("ok=false (genuine error, no status) renders the red failed chip", () => {
      const { container } = render(
        <ChatMessage
          message={withToolCall({
            ok: false,
            data: { error: { code: "ROUTING_UNAVAILABLE", message: "503" } },
          })}
        />,
      );
      const chip = container.querySelector(
        '[data-tool-call-id="call-1"]',
      ) as HTMLElement | null;
      expect(chip).not.toBeNull();
      expect(chip!.dataset.toolStatus).toBe("error");
      expect(chip!.className).toContain("bg-system-red/15");
      expect(chip!.getAttribute("aria-label")).toMatch(/failed/i);
    });

    it("pending chip (no ok yet) shows the spinner with running state", () => {
      const { container } = render(
        <ChatMessage
          message={withToolCall({
            // No ok / no status — still pending.
          })}
        />,
      );
      const chip = container.querySelector(
        '[data-tool-call-id="call-1"]',
      ) as HTMLElement | null;
      expect(chip).not.toBeNull();
      expect(chip!.dataset.toolStatus).toBe("pending");
      expect(chip!.getAttribute("aria-label")).toMatch(/running/i);
      // Spinner has the animate-spin class.
      expect(chip!.querySelector(".animate-spin")).not.toBeNull();
    });
  });

  describe("error state + retry affordance", () => {
    it("renders the friendly error message and a Try again button when onRetry is supplied", () => {
      const onRetry = vi.fn();
      render(
        <ChatMessage
          message={{
            id: "asst-err",
            role: "assistant",
            content: "",
            error: {
              message: "I can't reach the Droplet right now.",
              retryPrompt: "show devices",
            },
          }}
          onRetry={onRetry}
        />,
      );
      expect(
        screen.getByText("I can't reach the Droplet right now."),
      ).toBeInTheDocument();
      const retry = screen.getByRole("button", {
        name: /try sending this message again/i,
      });
      expect(retry).toBeInTheDocument();
      retry.click();
      expect(onRetry).toHaveBeenCalledWith("asst-err");
    });

    it("does not render the retry button when onRetry is omitted", () => {
      render(
        <ChatMessage
          message={{
            id: "asst-err",
            role: "assistant",
            content: "",
            error: {
              message: "Something went wrong.",
              retryPrompt: "x",
            },
          }}
        />,
      );
      expect(
        screen.queryByRole("button", { name: /try sending this message again/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe("message-actions toolbar (WARP-295)", () => {
    function assistantMsg(): ChatMessageType {
      return {
        id: "asst-1",
        role: "assistant",
        content: "Two plus two is four.",
      };
    }

    it("renders Copy / Quote / Regenerate buttons on the last assistant turn with aria-labels", () => {
      render(
        <ChatMessage
          message={assistantMsg()}
          isLastAssistant
          onCopy={vi.fn()}
          onQuote={vi.fn()}
          onRegenerate={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("button", { name: /copy message/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /quote message/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /regenerate response/i }),
      ).toBeInTheDocument();
    });

    it("hides Regenerate on non-last assistant turns (Copy + Quote still shown)", () => {
      render(
        <ChatMessage
          message={assistantMsg()}
          isLastAssistant={false}
          onCopy={vi.fn()}
          onQuote={vi.fn()}
          onRegenerate={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: /copy message/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /quote message/i })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /regenerate response/i }),
      ).not.toBeInTheDocument();
    });

    it("does not render the toolbar on user messages", () => {
      render(
        <ChatMessage
          message={{ id: "u1", role: "user", content: "Hi" }}
          onCopy={vi.fn()}
          onQuote={vi.fn()}
          onRegenerate={vi.fn()}
          isLastAssistant
        />,
      );
      expect(screen.queryByRole("button", { name: /copy message/i })).not.toBeInTheDocument();
    });

    it("Copy button calls onCopy with the assistant message text and shows a transient 'Copied' state", async () => {
      const onCopy = vi.fn().mockResolvedValue(undefined);
      render(
        <ChatMessage
          message={assistantMsg()}
          isLastAssistant
          onCopy={onCopy}
        />,
      );
      const btn = screen.getByRole("button", { name: /copy message/i });
      btn.click();
      expect(onCopy).toHaveBeenCalledWith("Two plus two is four.");
      // After the async copy promise resolves, the button flips to a
      // "Copied" affordance. Use findByRole so we wait for the microtask
      // chain to finish before asserting.
      const copied = await screen.findByRole("button", { name: /copied/i });
      expect(copied).toBeInTheDocument();
    });

    it("Quote button calls onQuote with the assistant message text", () => {
      const onQuote = vi.fn();
      render(
        <ChatMessage
          message={assistantMsg()}
          isLastAssistant
          onQuote={onQuote}
        />,
      );
      screen.getByRole("button", { name: /quote message/i }).click();
      expect(onQuote).toHaveBeenCalledWith("Two plus two is four.");
    });

    it("Regenerate button calls onRegenerate with the message id", () => {
      const onRegenerate = vi.fn();
      render(
        <ChatMessage
          message={assistantMsg()}
          isLastAssistant
          onRegenerate={onRegenerate}
        />,
      );
      screen.getByRole("button", { name: /regenerate response/i }).click();
      expect(onRegenerate).toHaveBeenCalledWith("asst-1");
    });

    it("toolbar buttons exist for an assistant message with neither error nor streaming state", () => {
      // Regression guard: pre-WARP-295 the only buttons on the message
      // were the failed-turn retry. Make sure the toolbar isn't hidden
      // behind some `hasError` discriminator.
      render(
        <ChatMessage
          message={assistantMsg()}
          isLastAssistant
          onCopy={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("button", { name: /copy message/i }),
      ).toBeInTheDocument();
    });
  });

  describe("citation chips (WARP-295)", () => {
    it("renders a row of <CitationChip> chips below assistant messages with citations", () => {
      const { container } = render(
        <ChatMessage
          message={{
            id: "asst-c",
            role: "assistant",
            content: "Here's what I found.",
            citations: [
              {
                source: "brain",
                path: "wireguard-cheatsheet.md",
                pageNumber: 3,
                score: 0.81,
                brainItemId: "bmi-42",
                snippet: "wg genkey ...",
              },
              {
                source: "nextcloud",
                path: "/Docs/vpn-setup.md",
                score: 0.93,
                snippet: "wg-quick up wg0",
              },
            ],
          }}
        />,
      );

      const row = screen.getByTestId("chat-citations");
      expect(row).toBeInTheDocument();
      // Both chips render through the shared component.
      const chips = container.querySelectorAll("[data-citation-path]");
      expect(chips).toHaveLength(2);
      expect(chips[0].getAttribute("data-citation-source")).toBe("brain");
      expect(chips[1].getAttribute("data-citation-source")).toBe("nextcloud");
    });

    it("renders no citation row when the assistant message has no citations", () => {
      render(
        <ChatMessage
          message={{
            id: "asst-no-c",
            role: "assistant",
            content: "Nothing to cite.",
          }}
        />,
      );
      expect(screen.queryByTestId("chat-citations")).not.toBeInTheDocument();
    });

    it("does not render citations on a user bubble (defensive — the type allows it)", () => {
      render(
        <ChatMessage
          message={{
            id: "user-c",
            role: "user",
            content: "Question",
            // Type allows it through ChatMessageType — but the component
            // must render zero chips because user turns never carry RAG hits.
            citations: [
              { source: "brain", path: "x.md" },
            ],
          }}
        />,
      );
      expect(screen.queryByTestId("chat-citations")).not.toBeInTheDocument();
    });
  });

  describe("stopped marker (WARP-295)", () => {
    it("renders a 'Stopped by you' tag on an assistant message with stopped=true", () => {
      render(
        <ChatMessage
          message={{
            id: "asst-stop",
            role: "assistant",
            content: "Partial answer",
            stopped: true,
          }}
        />,
      );
      expect(screen.getByText(/stopped by you/i)).toBeInTheDocument();
      // The partial content is preserved.
      expect(screen.getByText(/partial answer/i)).toBeInTheDocument();
    });

    it("no stopped tag when the flag is unset", () => {
      render(
        <ChatMessage
          message={{
            id: "asst-ok",
            role: "assistant",
            content: "Full answer",
          }}
        />,
      );
      expect(screen.queryByText(/stopped by you/i)).not.toBeInTheDocument();
    });
  });

  describe("ARIA on streaming bubble", () => {
    it("sets role='status' + aria-live='polite' on streaming assistant bubble", () => {
      const { container } = render(
        <ChatMessage
          message={{ id: "asst-stream", role: "assistant", content: "Hello" }}
          isStreaming={true}
        />,
      );
      const status = container.querySelector('[role="status"]');
      expect(status).not.toBeNull();
      expect(status!.getAttribute("aria-live")).toBe("polite");
    });

    it("does NOT set role='status' on already-rendered (non-streaming) assistant bubble", () => {
      const { container } = render(
        <ChatMessage
          message={{ id: "asst-done", role: "assistant", content: "Hello" }}
          isStreaming={false}
        />,
      );
      // No role='status' on the bubble — avoids alert spam on every
      // historical message.
      const status = container.querySelector('[role="status"]');
      expect(status).toBeNull();
    });

    it("does NOT set role='status' on user bubble even when isStreaming", () => {
      const { container } = render(
        <ChatMessage
          message={{ id: "user-1", role: "user", content: "Hi" }}
          isStreaming={true}
        />,
      );
      const status = container.querySelector('[role="status"]');
      expect(status).toBeNull();
    });
  });
});
