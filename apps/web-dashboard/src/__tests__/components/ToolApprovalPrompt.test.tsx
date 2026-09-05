/**
 * WARP-2469 — the in-chat approval prompt.
 *
 * The prompt is the only place a user ever sees what they are approving,
 * and it is rendered into a persisted chat transcript. So the assertions
 * that matter most are the negative ones: what a seeded email, name or
 * record number must NOT do.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ToolApprovalPrompt } from "@/components/chat/ToolApprovalPrompt";
import { ChatMessage } from "@/components/ChatMessage";
import type { ChatToolCall, ChatMessage as ChatMessageType } from "@/lib/types";

const SEEDED_EMAIL = "camille.moreau@example-clinic.test";
const SEEDED_NAME = "Camille Moreau";
const NOW = Date.now();

function challengedCall(over: Partial<ChatToolCall> = {}): ChatToolCall {
  return {
    id: "tc-1",
    name: "email_send",
    // The RAW arguments the model produced. They reach the chip because
    // the `tool_call` event carries them — which is exactly why the
    // PROMPT must be built from the server's summary and never from these.
    args: { to: SEEDED_EMAIL, subject: `Chart for ${SEEDED_NAME}` },
    status: "confirmation_required",
    confirmation: {
      kind: "tool_confirmation",
      challengeId: "chal-abc",
      tool: "email_send",
      status: "pending",
      expiresAt: NOW + 60_000,
      summary: {
        tool: "email_send",
        fields: [
          { key: "subject", kind: "string", detail: "20 characters" },
          { key: "to", kind: "string", detail: "34 characters" },
          { key: "urgent", kind: "boolean", detail: "yes", value: true },
        ],
        truncatedFields: 0,
      },
    },
    ...over,
  };
}

describe("ToolApprovalPrompt — the rendered prompt is PHI-free", () => {
  it("never renders a seeded email or name, even though the args carry both", () => {
    const { container } = render(
      <ToolApprovalPrompt call={challengedCall()} now={NOW} />,
    );
    const prompt = container.querySelector('[data-testid="tool-approval-prompt"]')!;
    // MUTATION (render `call.args` instead of `confirmation.summary`):
    // both of these go red.
    expect(JSON.stringify(prompt.innerHTML)).not.toContain(SEEDED_EMAIL);
    expect(JSON.stringify(prompt.innerHTML)).not.toContain(SEEDED_NAME);
    expect(prompt.innerHTML).not.toContain("Moreau");
  });

  it("still tells the user what is being asked, by key and shape", () => {
    render(<ToolApprovalPrompt call={challengedCall()} now={NOW} />);
    expect(screen.getByText(/email_send needs your approval/)).toBeInTheDocument();
    expect(screen.getByText("to: 34 characters")).toBeInTheDocument();
    // Booleans are the one kind rendered verbatim — two values, no
    // information beyond the key.
    expect(screen.getByText("urgent: yes")).toBeInTheDocument();
  });

  it("reports omitted fields rather than silently truncating", () => {
    const call = challengedCall();
    call.confirmation!.summary!.truncatedFields = 7;
    render(<ToolApprovalPrompt call={call} now={NOW} />);
    expect(screen.getByText("…and 7 more")).toBeInTheDocument();
  });
});

describe("ToolApprovalPrompt — decisions", () => {
  it("reports approve with the challenge id, never a token", () => {
    const onDecision = vi.fn();
    render(
      <ToolApprovalPrompt call={challengedCall()} now={NOW} onDecision={onDecision} />,
    );
    fireEvent.click(screen.getByTestId("approval-approve"));
    expect(onDecision).toHaveBeenCalledWith("chal-abc", "approve");
  });

  it("reports deny", () => {
    const onDecision = vi.fn();
    render(
      <ToolApprovalPrompt call={challengedCall()} now={NOW} onDecision={onDecision} />,
    );
    fireEvent.click(screen.getByTestId("approval-deny"));
    expect(onDecision).toHaveBeenCalledWith("chal-abc", "deny");
  });

  it("ignores a second click while a decision is in flight", () => {
    const onDecision = vi.fn();
    render(
      <ToolApprovalPrompt call={challengedCall()} now={NOW} onDecision={onDecision} />,
    );
    const approve = screen.getByTestId("approval-approve");
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(onDecision).toHaveBeenCalledTimes(1);
  });

  it("renders a declined prompt as declined, with no buttons to press again", () => {
    render(
      <ToolApprovalPrompt
        call={challengedCall({ confirmState: "denied" })}
        now={NOW}
        onDecision={vi.fn()}
      />,
    );
    expect(screen.getByText(/You declined email_send/)).toBeInTheDocument();
    expect(screen.queryByTestId("approval-approve")).toBeNull();
    expect(screen.queryByTestId("approval-deny")).toBeNull();
  });

  it("renders nothing at all without a challenge id — there is nothing to approve", () => {
    const call = challengedCall();
    delete call.confirmation!.challengeId;
    const { container } = render(<ToolApprovalPrompt call={call} now={NOW} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("ToolApprovalPrompt — expiry is visible and re-requestable", () => {
  it("renders expired past the TTL and offers a fresh ask, not a dead button", () => {
    const onDecision = vi.fn();
    const onRerequest = vi.fn();
    render(
      <ToolApprovalPrompt
        call={challengedCall()}
        // one millisecond past `expiresAt`
        now={NOW + 60_001}
        onDecision={onDecision}
        onRerequest={onRerequest}
      />,
    );
    // MUTATION (ignore `expiresAt` and always render the buttons): the
    // user is offered an approval that cannot succeed → red here.
    expect(screen.getByText(/expired/)).toBeInTheDocument();
    expect(screen.queryByTestId("approval-approve")).toBeNull();

    fireEvent.click(screen.getByTestId("approval-rerequest"));
    expect(onRerequest).toHaveBeenCalledTimes(1);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("trusts a server-decided expiry even when the local clock disagrees", () => {
    render(
      <ToolApprovalPrompt
        call={challengedCall({ confirmState: "expired" })}
        now={NOW}
        onRerequest={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tool-approval-prompt").dataset.state).toBe("expired");
  });
});

describe("ChatMessage — routing between the two confirmation mechanisms", () => {
  function assistantWith(call: ChatToolCall): ChatMessageType {
    return {
      id: "m1",
      role: "assistant",
      content: "One moment.",
      toolCalls: [call],
    };
  }

  it("renders the approval prompt for an interceptor challenge", () => {
    render(
      <ChatMessage
        message={assistantWith(challengedCall())}
        onToolDecision={vi.fn()}
        onRerequestApproval={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tool-approval-prompt")).toBeInTheDocument();
  });

  it("passes the message id and tool-call id up with the decision", () => {
    const onToolDecision = vi.fn();
    render(
      <ChatMessage
        message={assistantWith(challengedCall())}
        onToolDecision={onToolDecision}
      />,
    );
    fireEvent.click(screen.getByTestId("approval-approve"));
    expect(onToolDecision).toHaveBeenCalledWith("m1", "tc-1", "approve");
  });

  it("leaves the WARP-640 scene_run block untouched", () => {
    const sceneCall: ChatToolCall = {
      id: "tc-2",
      name: "run_scene",
      args: {},
      status: "confirmation_required",
      message: "Running this scene needs your approval.",
      confirmation: {
        kind: "scene_run",
        sceneId: "s1",
        confirmationToken: "scene-token",
      },
    };
    render(
      <ChatMessage
        message={assistantWith(sceneCall)}
        onApproveScene={vi.fn()}
        onToolDecision={vi.fn()}
      />,
    );
    // MUTATION (route every confirmation through the new prompt): the
    // scene chip loses its "Approve & run" button → red.
    expect(screen.getByTestId("scene-approve-run")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-approval-prompt")).toBeNull();
  });
});
