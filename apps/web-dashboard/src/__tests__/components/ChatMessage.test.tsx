import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
