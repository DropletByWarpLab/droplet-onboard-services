import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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
import { REASONING_STEP_SEPARATOR } from "@/components/chat/reasoning-trace";
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

  // WARP-640: a run_scene confirmation carries a single-use token, so the
  // approval block grows an "Approve & run" button that completes the action
  // in-chat. Confirmations WITHOUT a `confirmation` handle (firewall tools,
  // etc.) still resolve on their dedicated dashboard surface — no button.
  describe("scene-run approval button (WARP-640)", () => {
    function sceneConfirmMessage(
      partial: Partial<ChatToolCall> = {},
    ): ChatMessageType {
      return {
        id: "asst-9",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-scene",
            name: "run_scene",
            args: { scene: "Movie night" },
            ok: true,
            status: "confirmation_required",
            message: 'Running "Movie night" will run 2 device action(s).',
            confirmation: {
              kind: "scene_run",
              sceneId: "11111111-2222-3333-4444-555555555555",
              confirmationToken: "tok-abc123",
            },
            ...partial,
          },
        ],
      };
    }

    it("renders an 'Approve & run' button and calls onApproveScene with (messageId, toolCallId)", () => {
      const onApproveScene = vi.fn();
      render(
        <ChatMessage
          message={sceneConfirmMessage()}
          onApproveScene={onApproveScene}
        />,
      );
      const btn = screen.getByTestId("scene-approve-run");
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveAttribute("aria-label", "Approve and run this scene");
      fireEvent.click(btn);
      expect(onApproveScene).toHaveBeenCalledTimes(1);
      expect(onApproveScene).toHaveBeenCalledWith("asst-9", "call-scene");
    });

    it("does NOT render the button for a confirmation chip with no re-issue handle (firewall tool)", () => {
      const onApproveScene = vi.fn();
      render(
        <ChatMessage
          message={{
            id: "asst-fw",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-fw",
                name: "block_network_device",
                args: { mac: "AA:BB:CC:DD:EE:FF" },
                ok: true,
                status: "confirmation_required",
                message: "Open the dashboard to approve",
                // no `confirmation` handle
              },
            ],
          }}
          onApproveScene={onApproveScene}
        />,
      );
      expect(screen.queryByTestId("scene-approve-run")).not.toBeInTheDocument();
      // The inline message still surfaces.
      expect(screen.getByText("Open the dashboard to approve")).toBeInTheDocument();
    });

    it("does NOT render the button when onApproveScene is not wired", () => {
      render(<ChatMessage message={sceneConfirmMessage()} />);
      expect(screen.queryByTestId("scene-approve-run")).not.toBeInTheDocument();
    });

    it("disables the button and shows 'Running…' while confirmState is 'running'", () => {
      render(
        <ChatMessage
          message={sceneConfirmMessage({ confirmState: "running" })}
          onApproveScene={vi.fn()}
        />,
      );
      const btn = screen.getByTestId("scene-approve-run") as HTMLButtonElement;
      expect(btn).toBeDisabled();
      expect(btn.textContent).toMatch(/running/i);
    });

    it("shows a 'ask again to retry' note (no button) when confirmState is 'failed'", () => {
      render(
        <ChatMessage
          message={sceneConfirmMessage({ confirmState: "failed" })}
          onApproveScene={vi.fn()}
        />,
      );
      expect(screen.queryByTestId("scene-approve-run")).not.toBeInTheDocument();
      expect(screen.getByTestId("scene-approve-failed")).toBeInTheDocument();
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

    it("toolbar gets `mt-1` spacing when citations also render — breathing room between the two rows (UX fold-in)", () => {
      render(
        <ChatMessage
          message={{
            id: "asst-cite",
            role: "assistant",
            content: "Answered with sources.",
            citations: [{ source: "brain", path: "x.md" }],
          }}
          isLastAssistant
          onCopy={vi.fn()}
        />,
      );
      const toolbar = screen.getByTestId("message-actions");
      expect(toolbar.className).toMatch(/\bmt-1\b/);
    });

    // WARP-301 hit-target audit (WCAG 2.5.5 AA). The hover toolbar buttons
    // were `px-2 py-1` (~24 px). Bumped to `px-3 py-2` so the height
    // crosses the 32 px floor (≈ 36-40 px depending on icon + label) while
    // preserving the row's visual rhythm under the bubble.
    it("actions render as design-handoff msg-act buttons (WARP-855)", () => {
      // The Ask AI handoff replaces the px-3/py-2 Tailwind buttons with
      // 26 px-high `.msg-act` pills (chat-indigo.css) — above WCAG
      // 2.5.8 AA's 24 px minimum, matching the prototype's action row.
      render(
        <ChatMessage
          message={assistantMsg()}
          isLastAssistant
          onCopy={vi.fn()}
          onQuote={vi.fn()}
          onRegenerate={vi.fn()}
        />,
      );
      for (const name of [/copy message/i, /quote message/i, /regenerate response/i]) {
        const btn = screen.getByRole("button", { name });
        expect(btn.className).toMatch(/(^|\s)msg-act(\s|$)/);
      }
    });

    it("toolbar still reveals on hover/focus via the msg-actions contract", () => {
      // WARP-295's keyboard reachability now lives in chat-indigo.css:
      // `.msg:focus-within .msg-actions { opacity: 1 }`. jsdom can't
      // compute external stylesheets, so the structural contract is the
      // testable surface: the toolbar carries .msg-actions inside a .msg
      // row (the selector pair that drives the reveal).
      render(
        <ChatMessage
          message={assistantMsg()}
          isLastAssistant
          onCopy={vi.fn()}
        />,
      );
      const toolbar = screen.getByTestId("message-actions");
      expect(toolbar.className).toMatch(/(^|\s)msg-actions(\s|$)/);
      expect(toolbar.closest(".msg")).not.toBeNull();
    });

    it("toolbar does NOT add `mt-1` when there are no citations to crowd against", () => {
      render(
        <ChatMessage
          message={assistantMsg()}
          isLastAssistant
          onCopy={vi.fn()}
        />,
      );
      const toolbar = screen.getByTestId("message-actions");
      expect(toolbar.className).not.toMatch(/\bmt-1\b/);
    });

    // WARP-301 fold-in: at < ~345 px viewports (or when the assistant
    // column is narrow), 3 buttons at px-3 py-2 (~242 px combined) can
    // exceed the bubble's max-w-[70%] cap and push it wider. Adding
    // `flex-wrap` lets the toolbar stack gracefully instead of forcing
    // the bubble to grow.
    it("toolbar carries `flex-wrap` so it stacks on narrow viewports (WARP-301)", () => {
      render(
        <ChatMessage
          message={assistantMsg()}
          isLastAssistant
          onCopy={vi.fn()}
          onQuote={vi.fn()}
          onRegenerate={vi.fn()}
        />,
      );
      const toolbar = screen.getByTestId("message-actions");
      expect(toolbar.className).toMatch(/\bflex-wrap\b/);
    });
  });

  describe("markdown polish (WARP-295)", () => {
    it("wraps GFM tables in an overflow-x-auto container so wide tables don't blow out the bubble", () => {
      const { container } = render(
        <ChatMessage
          message={{
            id: "asst-tbl",
            role: "assistant",
            content:
              "| col1 | col2 | col3 |\n| --- | --- | --- |\n| a | b | c |\n",
          }}
        />,
      );
      const table = container.querySelector("table");
      expect(table).not.toBeNull();
      const wrapper = table!.parentElement;
      expect(wrapper?.className).toMatch(/overflow-x-auto/);
    });

    it("includes an SR-only Working… cue alongside the animated streaming cursor", () => {
      // The cursor itself is animate-pulse (motion-reduce:hidden) so
      // reduced-motion users see a visible ellipsis instead; the SR-only
      // span ensures both audiences get the streaming-state signal.
      const { container } = render(
        <ChatMessage
          message={{ id: "asst-s", role: "assistant", content: "..." }}
          isStreaming
        />,
      );
      const srOnly = container.querySelector(".sr-only");
      expect(srOnly).not.toBeNull();
      expect(srOnly!.textContent).toMatch(/working/i);
    });
  });

  describe("thumbs feedback (WARP-844)", () => {
    it("rates up, and clicking the active thumb clears", () => {
      const onFeedback = vi.fn();
      const { rerender } = render(
        <ChatMessage
          message={{ id: "a1", role: "assistant", content: "Answer" }}
          onFeedback={onFeedback}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Good response" }));
      expect(onFeedback).toHaveBeenCalledWith("a1", "up");

      rerender(
        <ChatMessage
          message={{
            id: "a1",
            role: "assistant",
            content: "Answer",
            feedback: "up",
          }}
          onFeedback={onFeedback}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Good response" }),
      ).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Good response" }));
      expect(onFeedback).toHaveBeenLastCalledWith("a1", null);
    });

    it("renders no thumbs on user rows", () => {
      render(
        <ChatMessage
          message={{ id: "u1", role: "user", content: "hi" }}
          onFeedback={vi.fn()}
        />,
      );
      expect(
        screen.queryByRole("button", { name: "Good response" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("edit & resend (WARP-844)", () => {
    it("shows an Edit pencil on user rows and submits the edited text", () => {
      const onEdit = vi.fn();
      render(
        <ChatMessage
          message={{ id: "u1", role: "user", content: "original" }}
          onEdit={onEdit}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
      const box = screen.getByRole("textbox", { name: "Edit message" });
      fireEvent.change(box, { target: { value: "edited text" } });
      fireEvent.click(screen.getByRole("button", { name: /save & resend/i }));
      expect(onEdit).toHaveBeenCalledWith("u1", "edited text");
    });

    it("cancel restores the bubble without calling onEdit", () => {
      const onEdit = vi.fn();
      render(
        <ChatMessage
          message={{ id: "u1", role: "user", content: "original" }}
          onEdit={onEdit}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
      expect(onEdit).not.toHaveBeenCalled();
      expect(screen.getByText("original")).toBeInTheDocument();
    });

    it("renders no pencil when onEdit is withheld or the row is assistant", () => {
      const { rerender } = render(
        <ChatMessage message={{ id: "u1", role: "user", content: "x" }} />,
      );
      expect(
        screen.queryByRole("button", { name: "Edit message" }),
      ).not.toBeInTheDocument();
      rerender(
        <ChatMessage
          message={{ id: "a1", role: "assistant", content: "x" }}
          onEdit={vi.fn()}
        />,
      );
      expect(
        screen.queryByRole("button", { name: "Edit message" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("reasoning disclosure (WARP-458)", () => {
    it("renders a collapsed 'Thought process' disclosure when reasoning is present", () => {
      render(
        <ChatMessage
          message={{
            id: "asst-r",
            role: "assistant",
            content: "Answer.",
            reasoning: "Step one.\n\nStep two.",
          }}
        />,
      );
      const toggle = screen.getByRole("button", { name: /thought process/i });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      // Collapsed: the trace text is not in the document yet.
      expect(screen.queryByText(/Step one\./)).not.toBeInTheDocument();

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText(/Step one\./)).toBeInTheDocument();
    });

    it("renders no disclosure when the message has no reasoning", () => {
      render(
        <ChatMessage
          message={{ id: "asst-n", role: "assistant", content: "Hi." }}
        />,
      );
      expect(
        screen.queryByRole("button", { name: /thought process/i }),
      ).not.toBeInTheDocument();
    });
  });

  /**
   * WARP-1605 — Romain: "make sure that 'new messages' are shown between
   * thinking and actual answers from the LLM."
   *
   * Before this, one bubble carried the collapsed trace AND the answer, with
   * nothing marking where the answer began. A turn that produced reasoning now
   * renders TWO rows off the SAME message record — thinking, then answer — so
   * the boundary exists live and on reload, with no wire or DB change.
   */
  describe("thinking / answer separation (WARP-1605)", () => {
    const TWO_STEPS = [
      "We need the invoice folder first.",
      "Now summarise what came back.",
    ].join(REASONING_STEP_SEPARATOR);

    const withReasoning = {
      id: "asst-1605",
      role: "assistant" as const,
      content: "Here are your invoices.",
      reasoning: TWO_STEPS,
    };

    it("splits the turn into a thinking row followed by the answer row", () => {
      const { container } = render(<ChatMessage message={withReasoning} />);
      const rows = container.querySelectorAll(".msg");
      expect(rows).toHaveLength(2);

      const [thinking, answer] = Array.from(rows);
      expect(thinking).toHaveAttribute("data-testid", "assistant-process");
      // The boundary is structural: the answer is in a bubble of its own and
      // no part of it bleeds into the thinking row.
      expect(thinking.querySelector(".msg-bubble")).toBeNull();
      expect(thinking.textContent).not.toContain("Here are your invoices.");
      expect(answer.querySelector(".msg-bubble")).not.toBeNull();
      expect(answer.textContent).toContain("Here are your invoices.");
      // …and the disclosure is NOT in the answer bubble any more.
      expect(
        answer.querySelector('[data-testid="reasoning-disclosure"]'),
      ).toBeNull();
    });

    it("keeps the trace collapsed by default and expands to per-step blocks", () => {
      render(<ChatMessage message={withReasoning} />);
      const toggle = screen.getByRole("button", { name: /thought process/i });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText(/invoice folder/)).not.toBeInTheDocument();

      fireEvent.click(toggle);
      const steps = screen.getAllByTestId("reasoning-step");
      expect(steps).toHaveLength(2);
      expect(steps[0].textContent).toContain("We need the invoice folder");
      expect(steps[1].textContent).toContain("Now summarise what came back");
    });

    it("moves the tool-call chips into the thinking row", () => {
      const { container } = render(
        <ChatMessage
          message={{
            ...withReasoning,
            toolCalls: [
              { id: "tc-1", name: "search_files", args: {}, ok: true },
            ],
          }}
        />,
      );
      const [thinking, answer] = Array.from(container.querySelectorAll(".msg"));
      // Tool calls are process, not answer.
      expect(thinking.querySelector('[data-tool-call-id="tc-1"]')).not.toBeNull();
      expect(answer.querySelector('[data-tool-call-id="tc-1"]')).toBeNull();
    });

    it("leaves a turn with NO reasoning exactly as it was — one row, chips in the bubble", () => {
      const { container } = render(
        <ChatMessage
          message={{
            id: "asst-plain",
            role: "assistant",
            content: "Hi.",
            toolCalls: [
              { id: "tc-2", name: "list_files", args: {}, ok: true },
            ],
          }}
        />,
      );
      const rows = container.querySelectorAll(".msg");
      expect(rows).toHaveLength(1);
      expect(
        container.querySelector('[data-testid="assistant-process"]'),
      ).toBeNull();
      expect(
        rows[0].querySelector(".msg-bubble [data-tool-call-id='tc-2']"),
      ).not.toBeNull();
    });

    it("renders a pre-WARP-1602 fused row as-is — no retro-split", () => {
      // Rows written before the leak fix have the analysis inside `content`
      // and a NULL reasoning column. There is nothing to separate, and
      // guessing where the answer starts would corrupt real answers.
      const fused =
        "We need to answer the user's question about invoices. " +
        "The invoices are in /Finance.";
      const { container } = render(
        <ChatMessage
          message={{ id: "asst-old", role: "assistant", content: fused }}
        />,
      );
      expect(container.querySelectorAll(".msg")).toHaveLength(1);
      expect(
        screen.queryByRole("button", { name: /thought process/i }),
      ).not.toBeInTheDocument();
      expect(container.textContent).toContain(fused);
    });

    it("shows the thinking row while the answer is still pending, then a new answer bubble", () => {
      // Live: reasoning has landed, the first answer token has not. The
      // thinking row is up and the answer's place is held by the indicator —
      // the thinking block never morphs into the answer.
      const { container, rerender } = render(
        <ChatMessage
          message={{
            id: "asst-live",
            role: "assistant",
            content: "",
            reasoning: TWO_STEPS,
          }}
          isStreaming
        />,
      );
      expect(
        container.querySelector('[data-testid="assistant-process"]'),
      ).not.toBeNull();
      expect(container.querySelector(".msg-bubble")).toBeNull();
      expect(container.querySelector(".ds-thinking")).not.toBeNull();

      // First answer token: the indicator becomes a real bubble BELOW the
      // (unchanged) thinking row.
      rerender(
        <ChatMessage
          message={{
            id: "asst-live",
            role: "assistant",
            content: "Here",
            reasoning: TWO_STEPS,
          }}
          isStreaming
        />,
      );
      expect(container.querySelector(".ds-thinking")).toBeNull();
      const rows = container.querySelectorAll(".msg");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveAttribute("data-testid", "assistant-process");
      expect(rows[1].textContent).toContain("Here");
    });

    it("still shows the cold-load copy under the thinking row", () => {
      // WARP-903's model_loading window is cleared by any later event, but a
      // turn that reaches it with reasoning already in hand must keep both.
      const { container } = render(
        <ChatMessage
          message={{
            id: "asst-cold",
            role: "assistant",
            content: "",
            reasoning: TWO_STEPS,
            modelLoading: { model: "gpt-oss:20b", sizeGb: 13.4 },
          }}
          isStreaming
        />,
      );
      expect(
        container.querySelector('[data-testid="assistant-process"]'),
      ).not.toBeNull();
      expect(screen.getByText(/Loading gpt-oss:20b \(13.4 GB\)/)).toBeInTheDocument();
    });

    it("never renders a thinking row for a user turn", () => {
      const { container } = render(
        <ChatMessage
          message={{
            id: "user-1",
            role: "user",
            content: "Where are my invoices?",
            // Defensive: the field is assistant-only, but a bad rehydrate
            // must not sprout an assistant-shaped row on a user message.
            reasoning: TWO_STEPS,
          }}
        />,
      );
      expect(container.querySelectorAll(".msg")).toHaveLength(1);
      expect(
        container.querySelector('[data-testid="assistant-process"]'),
      ).toBeNull();
    });
  });

  describe("code blocks — highlighting + copy (Claude parity)", () => {
    const CODE_MESSAGE = {
      id: "asst-code",
      role: "assistant" as const,
      content: "```js\nconst x = 1;\n```",
    };

    it("applies hljs token classes to fenced code blocks", () => {
      const { container } = render(<ChatMessage message={CODE_MESSAGE} />);
      // rehype-highlight tokenizes `const` as a keyword.
      const keyword = container.querySelector(".hljs-keyword");
      expect(keyword).not.toBeNull();
      expect(keyword!.textContent).toBe("const");
    });

    it("renders a copy button on the block that writes the code to the clipboard", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      render(<ChatMessage message={CODE_MESSAGE} />);
      const btn = screen.getByRole("button", { name: "Copy code" });
      fireEvent.click(btn);

      await screen.findByRole("button", { name: "Copied" });
      expect(writeText).toHaveBeenCalledWith("const x = 1;\n");
    });
  });

  describe("citation chips (WARP-295/WARP-287)", () => {
    it("renders a row of <CitationCard> chips below assistant messages with citations", () => {
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
      // WARP-287: chat citations carry no per-chunk anchor, so both project
      // into CitationHit with anchor: null and render via <FileCitation>
      // (data-testid="file-card") — the same chip the old <CitationChip>
      // rendered. The card shows the filename (last path segment).
      const chips = container.querySelectorAll('[data-testid="file-card"]');
      expect(chips).toHaveLength(2);
      expect(chips[0].textContent).toContain("wireguard-cheatsheet.md");
      expect(chips[1].textContent).toContain("vpn-setup.md");
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

  /**
   * WARP-1603 — the RENDERED percentage on a citation chip. Nothing
   * asserted the actual string before, which is how "every chip reads 0%"
   * survived a full test suite:
   *   - `relevancePct` only sigmoided scores > 1, so BGE-reranker-base's
   *     negative logits were read as bounded similarities and clamped to 0;
   *   - `ChatMessage` coerced a missing score with `?? 0`, defeating
   *     `FileCitation`'s `typeof hit.score === "number"` no-badge guard and
   *     printing a literal "0%".
   * These cases pin all three outcomes end-to-end (ChatCitation →
   * CitationHit → FileCitation).
   */
  describe("citation relevance badge (WARP-1603)", () => {
    function renderWithScore(score?: number): HTMLElement {
      const { container } = render(
        <ChatMessage
          message={{
            id: `asst-score-${String(score)}`,
            role: "assistant",
            content: "Answer.",
            citations: [
              {
                source: "nextcloud",
                path: "/Docs/vpn-setup.md",
                ...(score === undefined ? {} : { score }),
                snippet: "wg-quick up wg0",
              },
            ],
          }}
        />,
      );
      return container.querySelector(
        '[data-testid="file-card"]',
      ) as HTMLElement;
    }

    it("renders a high percent for a strong reranker logit", () => {
      // sigmoid(4.2) ≈ 0.985
      expect(renderWithScore(4.2).textContent).toContain("99%");
    });

    it("renders a small-but-nonzero percent for a negative logit", () => {
      // The bug case: sigmoid(-1) ≈ 0.269. Used to render "0%".
      const chip = renderWithScore(-1);
      expect(chip.textContent).toContain("27%");
      expect(chip.textContent).not.toContain("0%");
    });

    it("renders a normalized 0–1 relevance verbatim", () => {
      // What the mcp-server emits post-WARP-1603 (sigmoid applied at the
      // source), and what the cosine/RRF paths have always emitted.
      expect(renderWithScore(0.82).textContent).toContain("82%");
    });

    it("renders NO badge when the citation carries no score", () => {
      const chip = renderWithScore(undefined);
      // The chip itself still renders (filename + link); only the
      // relevance badge is withheld.
      expect(chip.textContent).toContain("vpn-setup.md");
      expect(chip.textContent).not.toContain("%");
    });
  });

  describe("stopped marker (WARP-295)", () => {
    it("renders the aborted FailureChip when message.stopped is set (live abort)", () => {
      render(
        <ChatMessage
          message={{
            id: "m1",
            role: "assistant",
            content: "partial",
            stopped: true,
          }}
          onRetry={() => undefined}
        />,
      );
      expect(screen.getByText("Stopped")).toBeInTheDocument();
      expect(screen.queryByText(/Stopped by you/)).not.toBeInTheDocument();
      // The bubble keeps the partial content.
      expect(screen.getByText("partial")).toBeInTheDocument();
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

describe("FailureChip", () => {
  const baseMsg = {
    id: "m1",
    role: "assistant" as const,
    content: "",
  };

  it.each([
    ["failed", "Something went wrong on this turn."],
    ["aborted", "Stopped"],
    ["interrupted", "Interrupted — the reply didn't finish."],
    ["missing", "No reply was saved for this turn."],
  ] as const)("renders the %s variant with the right copy", (kind, copy) => {
    render(
      <ChatMessage
        message={{ ...baseMsg, failureKind: kind }}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText(copy)).toBeInTheDocument();
    // The chip's root div carries data-failure-kind for testing.
    expect(document.querySelector(`[data-failure-kind="${kind}"]`)).toBeInTheDocument();
  });

  it("Try-again invokes onRetry with the message id", () => {
    const onRetry = vi.fn();
    render(
      <ChatMessage
        message={{ ...baseMsg, failureKind: "failed" }}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /try sending this message again/i }),
    );
    expect(onRetry).toHaveBeenCalledWith("m1");
  });

  it("preserves partial content when failureKind is interrupted", () => {
    render(
      <ChatMessage
        message={{ ...baseMsg, content: "halfway through", failureKind: "interrupted" }}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText("halfway through")).toBeInTheDocument();
    expect(document.querySelector('[data-failure-kind="interrupted"]')).toBeInTheDocument();
  });

  it("falls back to message.error.message for live-error copy", () => {
    render(
      <ChatMessage
        message={{
          ...baseMsg,
          error: { message: "Custom live error", retryPrompt: "x" },
        }}
        onRetry={() => undefined}
      />,
    );
    // failureKind is undefined; derivation should yield "failed" from
    // the error field, and the chip should use the custom copy.
    expect(screen.getByText("Custom live error")).toBeInTheDocument();
    expect(document.querySelector('[data-failure-kind="failed"]')).toBeInTheDocument();
  });
});
