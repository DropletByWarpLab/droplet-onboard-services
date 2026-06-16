/**
 * WARP-849 (AC1) — AI step: first-boot model-pull state.
 *
 * After a factory reset the configured model re-pulls on first boot
 * (13 GB — minutes, not seconds). A customer reaching the Private AI
 * step mid-pull used to hit a dead end: `fetchModels()` returned empty,
 * the picker said "No models available yet", and the once-only load
 * never re-fetched. Validates:
 *
 *   1. Empty registry → an explicit "model is still downloading" state
 *      renders (not a bare empty picker), and Skip stays available.
 *   2. The step polls fetchModels on a bounded interval (setInterval,
 *      React-idiomatic cleanup — no while-true).
 *   3. When a model appears, the downloading state clears, the model is
 *      selected, and polling STOPS.
 *   4. Unmount clears the interval (no timer leak).
 *
 * Renders <AiStep> in isolation — StepShell explicitly supports being
 * mounted outside the wizard nav provider (static rail, no Back
 * button), which keeps the fake-timer choreography tractable. The
 * full-wizard flow is covered by setup.ai.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import React from "react";

const fetchModelsMock = vi.fn();
const sendChatMock = vi.fn();

vi.mock("@/lib/api", () => ({
  // WARP-867 — AccountStep probes setup status on mount to pick its mode;
  // "required" keeps these walks on the normal create form.
  checkSetupRequired: vi.fn(async () => "required"),
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

/** Flush the pending microtask queue inside act() so the fetchModels
 *  promise chain settles without advancing fake timers. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup AI step — model still downloading (WARP-849 AC1)", () => {
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

  it("shows the downloading state (with Skip still available) when the registry is empty", async () => {
    fetchModelsMock.mockResolvedValue({ models: [] });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    expect(screen.getByTestId("model-downloading")).toBeInTheDocument();
    expect(
      screen.getByText(/your ai model is still downloading/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeInTheDocument();
  });

  it("polls fetchModels until a model appears, then stops and selects it", async () => {
    fetchModelsMock.mockResolvedValue({ models: [] });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);

    // First poll tick — still empty.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("model-downloading")).toBeInTheDocument();

    // Pull finishes — the next tick finds the model.
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("model-downloading")).not.toBeInTheDocument();
    const select = screen.getByLabelText(/model/i) as HTMLSelectElement;
    expect(select.value).toBe(LOCAL_MODEL.id);

    // Polling stopped — a long quiet stretch triggers no more fetches.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(3);
  });

  it("keeps polling while fetchModels rejects (gateway still warming up)", async () => {
    fetchModelsMock.mockRejectedValue(new Error("502"));
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("model-downloading")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(2);
  });

  it("clears the poll interval on unmount", async () => {
    fetchModelsMock.mockResolvedValue({ models: [] });
    const { unmount } = render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);
  });

  it("does not show the downloading state when models are available", async () => {
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    expect(screen.queryByTestId("model-downloading")).not.toBeInTheDocument();
    // And no polling either.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);
  });
});
