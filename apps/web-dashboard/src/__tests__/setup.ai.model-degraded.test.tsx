/**
 * WARP-1284 — AI step: degraded models signal.
 *
 * `GET /api/llm/models` returns an empty list for three indistinguishable
 * reasons: (1) orchestrator can't reach the ai-gateway, (2) the gateway's
 * Ollama provider errored during listing, (3) genuinely no model pulled yet
 * (first boot). The wizard used to show the WARP-849 "still downloading"
 * copy for all three — dishonest for the first two. The orchestrator now
 * stamps `degraded: true` on cases 1–2, and the step renders a distinct
 * "can't reach your AI service" note instead. Validates:
 *
 *   1. degraded + empty list → the `model-degraded` note renders (and the
 *      `model-downloading` note does NOT); Skip stays available.
 *   2. non-degraded empty list → the existing WARP-849 downloading note,
 *      exactly as before (and no degraded note).
 *   3. The 8 s re-poll keeps running in the degraded state, and the step
 *      self-heals: when a model appears the note clears and the model is
 *      selected.
 *   4. Defense-in-depth: `isLocalModel` treats gpt-oss as local even when
 *      the provider field is missing (mirrors router.py's documented
 *      gpt-oss/gpt prefix collision), so the local model can never be
 *      filed under "Cloud (uses internet)".
 *
 * Renders <AiStep> in isolation — same choreography as
 * setup.ai.model-downloading.test.tsx (StepShell supports mounting outside
 * the wizard nav provider).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import type { ModelInfo } from "@/lib/types";

const fetchModelsMock = vi.fn();
const sendChatMock = vi.fn();

vi.mock("@/lib/api", () => ({
  checkSetupRequired: vi.fn(async () => "required"),
  checkClaimGateEnabled: vi.fn(async () => false),
  fetchModels: () => fetchModelsMock(),
  sendChat: (req: unknown) => sendChatMock(req),
}));

import { AiStep, isLocalModel } from "@/components/setup/steps/AiStep";

const LOCAL_MODEL = {
  id: "gpt-oss:20b",
  provider: "ollama",
  name: "Gpt Oss 20B",
  context_window: null,
};

/** Flush the pending microtask queue inside act() so the fetchModels
 *  promise chain settles without advancing fake timers. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup AI step — degraded models signal (WARP-1284)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchModelsMock.mockReset();
    sendChatMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows the degraded note (not the downloading copy) when the response is degraded and empty", async () => {
    fetchModelsMock.mockResolvedValue({ models: [], degraded: true });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    const note = screen.getByTestId("model-degraded");
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(
      /can(?:'|’)t reach your ai service right now/i,
    );
    expect(note.textContent).toMatch(/we(?:'|’)ll keep checking/i);
    // UX note (skip-clause parity with the downloading note): the degraded
    // note must end with the same escape hatch.
    expect(note.textContent).toMatch(
      /or you can skip and come back from the chat page later/i,
    );
    expect(screen.queryByTestId("model-downloading")).not.toBeInTheDocument();
    // UX note: the select placeholder must not read download-flavored under
    // the degraded note.
    expect(
      screen.getByRole("option", { name: /models unavailable right now/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /no models available yet/i }),
    ).not.toBeInTheDocument();
    // Skip must stay available — the wizard never blocks on AI.
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeInTheDocument();
  });

  it("keeps the exact WARP-849 downloading copy for a non-degraded empty list", async () => {
    fetchModelsMock.mockResolvedValue({ models: [] });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    expect(screen.getByTestId("model-downloading")).toBeInTheDocument();
    expect(
      screen.getByText(/your ai model is still downloading/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("model-degraded")).not.toBeInTheDocument();
    // Placeholder keeps its existing copy when the empty list is honest.
    expect(
      screen.getByRole("option", { name: /no models available yet/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /models unavailable right now/i }),
    ).not.toBeInTheDocument();
  });

  it("asks-without-model error is degraded-aware (no false warming-up framing)", async () => {
    // UX note: clicking "Ask the AI" with an empty degraded picker used to
    // surface "…your AI is still warming up — give it a moment and try
    // again", reintroducing the exact false framing this ticket removes.
    fetchModelsMock.mockResolvedValue({ models: [], degraded: true });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
    expect(
      screen.getByText(/skip this step and try from the chat page later/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/still warming up/i)).not.toBeInTheDocument();
  });

  it("keeps the existing pick-a-model error copy when not degraded", async () => {
    fetchModelsMock.mockResolvedValue({ models: [] });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
    expect(screen.getByText(/pick a model first/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/skip this step and try from the chat page later/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the 8 s re-poll running while degraded and self-heals when a model appears", async () => {
    fetchModelsMock.mockResolvedValue({ models: [], degraded: true });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);

    // First poll tick — still degraded.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("model-degraded")).toBeInTheDocument();

    // Gateway recovers — the next tick finds the model and the note clears.
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("model-degraded")).not.toBeInTheDocument();
    expect(screen.queryByTestId("model-downloading")).not.toBeInTheDocument();
    const select = screen.getByLabelText(/model/i) as HTMLSelectElement;
    expect(select.value).toBe(LOCAL_MODEL.id);
  });

  it("switches from downloading to degraded copy when a later poll reports degraded", async () => {
    fetchModelsMock.mockResolvedValue({ models: [] });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();
    expect(screen.getByTestId("model-downloading")).toBeInTheDocument();

    fetchModelsMock.mockResolvedValue({ models: [], degraded: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(screen.getByTestId("model-degraded")).toBeInTheDocument();
    expect(screen.queryByTestId("model-downloading")).not.toBeInTheDocument();
  });
});

describe("isLocalModel — gpt-oss defense-in-depth (WARP-1284)", () => {
  it("treats gpt-oss as local when the provider field is missing", () => {
    // Mirrors router.py's documented gpt-oss/gpt prefix collision: OpenAI's
    // open-weights family is served locally by Ollama, so a missing provider
    // field must never file it under "Cloud (uses internet)".
    expect(isLocalModel({ id: "gpt-oss:20b" } as ModelInfo)).toBe(true);
    expect(isLocalModel({ id: "gpt-oss:120b" } as ModelInfo)).toBe(true);
  });

  it("still routes explicit cloud providers to cloud regardless of name", () => {
    expect(
      isLocalModel({
        id: "gpt-oss:20b",
        provider: "openai",
        name: "gpt-oss:20b",
        context_window: null,
      }),
    ).toBe(false);
  });

  it("keeps genuine cloud model names (no provider field) non-local", () => {
    expect(isLocalModel({ id: "gpt-4o" } as ModelInfo)).toBe(false);
    expect(isLocalModel({ id: "o1-preview" } as ModelInfo)).toBe(false);
  });
});
