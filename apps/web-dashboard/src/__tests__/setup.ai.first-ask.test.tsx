/**
 * WARP-1041 — AI step: fast, honest first ask.
 *
 * The wizard's sample probe used to advertise the FULL MCP tool registry
 * (~11k tokens of prefill) and hide the 30-90 s cold model load behind a
 * frozen "Thinking…" button. Validates the two dashboard-side fixes:
 *
 *   1. Payload: a CURATED sample prompt sends `allowed_tools: []` (zero
 *      tool schemas — the identity prompt answers all three samples), but
 *      a CUSTOM-typed question sends the payload exactly as before (no
 *      allowed_tools key at all), so "list my devices" still gets tools.
 *   2. Honest in-flight UI: after ~8 s without a response, the existing
 *      soft-notice pattern (WARP-849 styling) explains the wait — "Waking
 *      your AI…" — and clears the moment the request settles. The timer
 *      is cleaned up on settle AND unmount (StrictMode-safe).
 *
 * Renders <AiStep> in isolation, same as setup.ai.model-downloading.test.tsx —
 * StepShell explicitly supports being mounted outside the wizard nav
 * provider, which keeps the fake-timer choreography tractable. The
 * full-wizard flow is covered by setup.ai.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
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

const OK_RESPONSE = {
  ok: true,
  status: 200,
  json: async () => ({
    message: { role: "assistant", content: "Hello from your Droplet." },
  }),
};

/** Flush the pending microtask queue inside act() so promise chains settle
 *  without advancing fake timers. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup AI step — probe payload (WARP-1041)", () => {
  beforeEach(() => {
    fetchModelsMock.mockReset();
    sendChatMock.mockReset();
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("sends allowed_tools: [] for a curated sample prompt", async () => {
    sendChatMock.mockResolvedValue(OK_RESPONSE);
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    // First sample prompt is selected by default.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
    });
    await flushMicrotasks();

    expect(sendChatMock).toHaveBeenCalledTimes(1);
    const req = sendChatMock.mock.calls[0][0];
    expect(req.allowed_tools).toEqual([]);
    expect(req.messages[0].content).toBe(
      "What can you help me with on this Droplet?",
    );
  });

  it("sends NO allowed_tools key for a custom-typed question", async () => {
    sendChatMock.mockResolvedValue(OK_RESPONSE);
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    const custom = screen.getByPlaceholderText(/or type your own/i);
    fireEvent.focus(custom);
    fireEvent.change(custom, { target: { value: "List my devices" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
    });
    await flushMicrotasks();

    expect(sendChatMock).toHaveBeenCalledTimes(1);
    const req = sendChatMock.mock.calls[0][0];
    // The custom path must be byte-identical to today's payload: the key
    // must be ABSENT (undefined would still narrow tools server-side for
    // some roles; absence is the documented "role default" contract).
    expect("allowed_tools" in req).toBe(false);
    expect(req.messages[0].content).toBe("List my devices");
  });
});

describe("setup AI step — waking notice after 8 s in flight (WARP-1041)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchModelsMock.mockReset();
    sendChatMock.mockReset();
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function deferredChat() {
    let resolve!: (v: typeof OK_RESPONSE) => void;
    const promise = new Promise<typeof OK_RESPONSE>((r) => {
      resolve = r;
    });
    sendChatMock.mockReturnValue(promise);
    return { resolve };
  }

  it("shows the waking notice only after 8 s, and clears it when the answer lands", async () => {
    const { resolve } = deferredChat();
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
    });

    // 7.9 s in — still just the "Thinking…" button, no notice.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_900);
    });
    expect(screen.queryByTestId("ai-waking-notice")).not.toBeInTheDocument();

    // Cross the 8 s line.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByTestId("ai-waking-notice")).toBeInTheDocument();
    expect(screen.getByText(/waking your ai/i)).toBeInTheDocument();

    // The answer arrives — the notice clears, the response renders.
    await act(async () => {
      resolve(OK_RESPONSE);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("ai-waking-notice")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-response")).toBeInTheDocument();
  });

  it("never shows the notice when the answer lands under 8 s", async () => {
    const { resolve } = deferredChat();
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      resolve(OK_RESPONSE);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("ai-waking-notice")).not.toBeInTheDocument();
    // …and it doesn't appear late either (timer was cleared on settle).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.queryByTestId("ai-waking-notice")).not.toBeInTheDocument();
  });

  it("clears the notice on an error settle too", async () => {
    let reject!: (e: Error) => void;
    sendChatMock.mockReturnValue(
      new Promise((_r, rj) => {
        reject = rj;
      }),
    );
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.getByTestId("ai-waking-notice")).toBeInTheDocument();

    await act(async () => {
      reject(new Error("Request failed"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("ai-waking-notice")).not.toBeInTheDocument();
    expect(screen.getByText(/request failed/i)).toBeInTheDocument();
  });

  it("cleans the timer up on unmount (no late setState)", async () => {
    deferredChat();
    const { unmount } = render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // A leaked timeout would fire setState on the unmounted component and
    // React would log an error — the cleanup must prevent that.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
