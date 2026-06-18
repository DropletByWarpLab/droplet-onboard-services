/**
 * WARP-849 (AC2) — AI step: reasoning-safe sample probe.
 *
 * The configured local model (gpt-oss:20b) is a REASONING model:
 * Ollama's OpenAI-compat response carries the thinking trace in a
 * separate `reasoning` field on the message, and when the completion
 * budget is exhausted mid-reasoning the user-visible `content` comes
 * back EMPTY. The old probe hard-failed on empty content with scary
 * copy ("Got an empty response…") on a perfectly healthy box.
 *
 * Validates:
 *   1. The probe sends a reasoning-sized completion budget
 *      (max_tokens ≥ 1500 — local inference, cost-free).
 *   2. Empty content + non-empty `reasoning` → a soft, retryable
 *      "warming up" notice (neutral styling, NOT the red error), and
 *      the raw reasoning text is NEVER rendered as the answer.
 *   3. Truly empty response (no content, no reasoning) → the existing
 *      hard error copy is kept.
 *   4. A normal response renders unchanged.
 *
 * Renders <AiStep> in isolation (same harness rationale as
 * setup.ai.model-downloading.test.tsx); the full-wizard flow lives in
 * setup.ai.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import React from "react";

const fetchModelsMock = vi.fn();
const sendChatMock = vi.fn();

vi.mock("@/lib/api", () => ({
  // WARP-867 — AccountStep probes setup status on mount to pick its mode;
  // "required" keeps these walks on the normal create form.
  checkSetupRequired: vi.fn(async () => "required"),
  // WARP-165 — AccountStep probes the claim gate on mount; false = un-gated.
  checkClaimGateEnabled: vi.fn(async () => false),
  fetchModels: () => fetchModelsMock(),
  sendChat: (req: unknown) => sendChatMock(req),
}));

import { AiStep } from "@/components/setup/steps/AiStep";

const LOCAL_MODEL = {
  id: "gpt-oss:20b",
  provider: "ollama",
  name: "Gpt Oss 20B",
  context_window: null,
};

const REASONING_TEXT =
  "The user asks what I can help with. I should enumerate the Droplet's local capabilities.";

async function renderStepAndAsk(chatBody: unknown) {
  fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
  sendChatMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => chatBody,
  });
  render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup AI step — reasoning-safe probe (WARP-849 AC2)", () => {
  beforeEach(() => {
    fetchModelsMock.mockReset();
    sendChatMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("sends a reasoning-sized completion budget on the sample prompt", async () => {
    await renderStepAndAsk({
      message: { role: "assistant", content: "I can help with files." },
    });

    expect(sendChatMock).toHaveBeenCalledTimes(1);
    const req = sendChatMock.mock.calls[0]![0] as { max_tokens?: number };
    expect(req.max_tokens).toBeGreaterThanOrEqual(1500);
  });

  it("treats empty content + reasoning as a soft retryable state, never rendering the reasoning", async () => {
    await renderStepAndAsk({
      message: { role: "assistant", content: "", reasoning: REASONING_TEXT },
    });

    // Soft notice, not the scary failure.
    expect(screen.getByTestId("ai-warming-up")).toBeInTheDocument();
    expect(
      screen.getByText(/still warming up its answer/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/got an empty response/i)).not.toBeInTheDocument();

    // No answer card, and the raw reasoning text never leaks into the UI.
    expect(screen.queryByTestId("ai-response")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/enumerate the droplet's local capabilities/i),
    ).not.toBeInTheDocument();

    // Still retryable — the primary CTA stays "Ask the AI".
    expect(
      screen.getByRole("button", { name: /ask the ai/i }),
    ).toBeInTheDocument();
  });

  it("keeps the hard error when the response is truly empty (no reasoning either)", async () => {
    await renderStepAndAsk({
      message: { role: "assistant", content: "" },
    });

    expect(screen.getByText(/got an empty response/i)).toBeInTheDocument();
    expect(screen.queryByTestId("ai-warming-up")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-response")).not.toBeInTheDocument();
  });

  it("renders a normal response unchanged (reasoning alongside content is fine)", async () => {
    await renderStepAndAsk({
      message: {
        role: "assistant",
        content: "I can help with files, cameras, and your network.",
        reasoning: REASONING_TEXT,
      },
    });

    expect(screen.getByTestId("ai-response")).toBeInTheDocument();
    expect(
      screen.getByText(/i can help with files, cameras/i),
    ).toBeInTheDocument();
    // The reasoning trace stays out of the answer card.
    expect(
      screen.queryByText(/enumerate the droplet's local capabilities/i),
    ).not.toBeInTheDocument();
    // No stale notice.
    expect(screen.queryByTestId("ai-warming-up")).not.toBeInTheDocument();
    // CTA flipped to Continue.
    expect(
      screen.getByRole("button", { name: /^continue$/i }),
    ).toBeInTheDocument();
  });

  it("clears the warming-up notice on a successful retry", async () => {
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    sendChatMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        message: { role: "assistant", content: "", reasoning: REASONING_TEXT },
      }),
    });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("ai-warming-up")).toBeInTheDocument();

    sendChatMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        message: { role: "assistant", content: "Second try answer." },
      }),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("ai-warming-up")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-response")).toBeInTheDocument();
    expect(screen.getByText(/second try answer/i)).toBeInTheDocument();
  });
});
