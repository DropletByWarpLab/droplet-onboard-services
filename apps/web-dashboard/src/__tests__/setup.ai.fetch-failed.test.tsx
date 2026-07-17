/**
 * WARP-1287 — AI step: fetchModels() rejection must not render the
 * "still downloading" copy.
 *
 * `load()` catches a rejected fetchModels() (orchestrator down, 5xx, auth
 * blip) and used to swallow it entirely: `degraded` kept its prior value
 * (false on first load), so the empty picker fell through to the WARP-849
 * "Your AI model is still downloading" note even though the backend never
 * answered. The server can't stamp `degraded` on a response it never sent
 * (WARP-1284 covers only answered-but-degraded), so the client now tracks
 * fetch failure itself: a rejected fetchModels() sets `fetchFailed`, and an
 * empty list + failed last fetch renders an honest "can't reach your
 * Droplet" note instead. Validates:
 *
 *   1. first-load rejection + empty list → the `model-fetch-failed` note
 *      renders (and neither `model-downloading` nor `model-degraded` does);
 *      the select placeholder is not download-flavored; Skip stays
 *      available.
 *   2. "Ask the AI" with an empty picker after a failed fetch gets the
 *      honest skip-and-retry-later error, not "still warming up".
 *   3. The 8 s re-poll keeps running after a rejection and the step
 *      self-heals: when a fetch succeeds with a model the note clears and
 *      the model is selected.
 *   4. A successful-but-empty response after a rejection returns to the
 *      honest downloading copy (fetchFailed clears on any settled fetch).
 *   5. Downloading → later poll rejects → switches to the fetch-failed
 *      note; a later poll answering `degraded: true` switches to the
 *      WARP-1284 degraded note (last settled fetch wins).
 *
 * Renders <AiStep> in isolation — same choreography as
 * setup.ai.model-degraded.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

const fetchModelsMock = vi.fn();
const sendChatMock = vi.fn();

vi.mock("@/lib/api", () => ({
  checkSetupRequired: vi.fn(async () => "required"),
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

/** Flush the pending microtask queue inside act() so the fetchModels
 *  promise chain settles without advancing fake timers. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup AI step — fetchModels rejection (WARP-1287)", () => {
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

  it("shows the fetch-failed note (not the downloading copy) when the first load rejects", async () => {
    fetchModelsMock.mockRejectedValue(new Error("network down"));
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    const note = screen.getByTestId("model-fetch-failed");
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(
      /can(?:'|’)t reach your droplet right now/i,
    );
    expect(note.textContent).toMatch(/we(?:'|’)ll keep trying/i);
    // Skip-clause parity with the WARP-849/WARP-1284 notes: same escape hatch.
    expect(note.textContent).toMatch(
      /or you can skip and come back from the chat page later/i,
    );
    expect(screen.queryByTestId("model-downloading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("model-degraded")).not.toBeInTheDocument();
    // The select placeholder must not read download-flavored either.
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

  it("asks-without-model error is honest after a failed fetch (no false warming-up framing)", async () => {
    fetchModelsMock.mockRejectedValue(new Error("HTTP 502"));
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
    expect(
      screen.getByText(/skip this step and try from the chat page later/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/still warming up/i)).not.toBeInTheDocument();
  });

  it("keeps the 8 s re-poll running after a rejection and self-heals when a model appears", async () => {
    fetchModelsMock.mockRejectedValue(new Error("network down"));
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();
    expect(fetchModelsMock).toHaveBeenCalledTimes(1);

    // First poll tick — still rejecting.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("model-fetch-failed")).toBeInTheDocument();

    // Backend recovers — the next tick finds the model and the note clears.
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchModelsMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("model-fetch-failed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("model-downloading")).not.toBeInTheDocument();
    const select = screen.getByLabelText(/model/i) as HTMLSelectElement;
    expect(select.value).toBe(LOCAL_MODEL.id);
  });

  it("returns to the honest downloading copy when a later fetch succeeds but the list is still empty", async () => {
    fetchModelsMock.mockRejectedValue(new Error("network down"));
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();
    expect(screen.getByTestId("model-fetch-failed")).toBeInTheDocument();

    // Backend answers again — genuinely no model yet (first-boot pull).
    fetchModelsMock.mockResolvedValue({ models: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(screen.getByTestId("model-downloading")).toBeInTheDocument();
    expect(screen.queryByTestId("model-fetch-failed")).not.toBeInTheDocument();
  });

  it("switches from downloading to fetch-failed, and to degraded when the server answers degraded", async () => {
    fetchModelsMock.mockResolvedValue({ models: [] });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();
    expect(screen.getByTestId("model-downloading")).toBeInTheDocument();

    // A poll tick rejects — the last settled fetch wins.
    fetchModelsMock.mockRejectedValue(new Error("network down"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(screen.getByTestId("model-fetch-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("model-downloading")).not.toBeInTheDocument();

    // The server answers again but flags itself degraded (WARP-1284): the
    // degraded note takes over from the fetch-failed one.
    fetchModelsMock.mockResolvedValue({ models: [], degraded: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(screen.getByTestId("model-degraded")).toBeInTheDocument();
    expect(screen.queryByTestId("model-fetch-failed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("model-downloading")).not.toBeInTheDocument();
  });
});
