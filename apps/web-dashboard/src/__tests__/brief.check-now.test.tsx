/**
 * WARP-2850 review — the two things `/brief`'s "check now" got wrong.
 *
 * 1. EVERY 409 THAT WAS NOT `disabled` READ AS CONTENTION. `claimPass` also
 *    answers `missing` (no row for this pass) and, since WARP-2837's shutdown
 *    latch, `shutting_down`; the trigger now also answers `no_model`. Told
 *    "Already running — give it a moment", an operator waits for a run that is
 *    never going to start. Each of those is a different sentence because each
 *    is a different thing to do next.
 *
 * 2. THE BUTTON NEVER CAME BACK. `runState` arrives with `/api/brain/coverage`,
 *    which was read once on mount and once immediately after the 202. The pass
 *    itself takes minutes, so the post-trigger snapshot said `running` and
 *    nothing ever looked again — the control stayed disabled on "running…"
 *    long after the box had finished, until somebody reloaded the page.
 *
 * The mapping cases go through the REAL `@/app/brief/api` against a mocked
 * `authFetch`: the collapse being pinned lives in `runBrainPass`, and a test
 * that mocked the module would pin nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import React from "react";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, children }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {children}
    </div>
  ),
}));

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", role: "owner" }, isLoading: false }),
  authFetch,
}));

import { runBrainPass } from "@/app/brief/api";
import BriefPage from "@/app/brief/page";

/** The shape `authFetch` hands back, with only what the api layer reads. */
function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// 🔴 BRACES, NOT AN EXPRESSION BODY. `mockReset()` returns the mock, and a
// `beforeEach` that returns a function has handed vitest a teardown hook — it
// duly called `authFetch()` with no arguments after every test in this file.
beforeEach(() => {
  authFetch.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("runBrainPass — a refusal is a sentence, not an error (WARP-2850 review)", () => {
  it("reports a MISSING pass row as itself, not as busy", async () => {
    // The row is seeded at boot for every key in `BRAIN_PASS_KEYS`, so this
    // means it was removed afterwards. Waiting will not bring it back, and
    // "already running" tells the operator to wait.
    authFetch.mockResolvedValueOnce(reply(409, { error: "missing" }));
    await expect(runBrainPass("detectors")).resolves.toEqual({ ok: false, reason: "missing" });
  });

  it("reports NO MODEL as itself", async () => {
    // `BRAIN_ENABLED` and `DEFAULT_MODEL` are independent, so "brain on, no
    // model" is a reachable box — and it is a setup step, not contention.
    authFetch.mockResolvedValueOnce(reply(409, { error: "no_model" }));
    await expect(runBrainPass("corpus.documents")).resolves.toEqual({
      ok: false,
      reason: "no_model",
    });
  });

  it("reports a shutting-down box as itself (WARP-2837's latch)", async () => {
    authFetch.mockResolvedValueOnce(reply(409, { error: "shutting_down" }));
    await expect(runBrainPass("detectors")).resolves.toEqual({
      ok: false,
      reason: "shutting_down",
    });
  });

  it("still reports DISABLED as itself", async () => {
    authFetch.mockResolvedValueOnce(reply(409, { error: "disabled" }));
    await expect(runBrainPass("detectors")).resolves.toEqual({ ok: false, reason: "disabled" });
  });

  it("falls back to BUSY for a reason this dashboard has never heard of", async () => {
    // Deliberate, and the only collapse left: an orchestrator newer than its
    // dashboard must degrade to "hold on" rather than to a blank card.
    authFetch.mockResolvedValueOnce(reply(409, { error: "a_future_reason" }));
    await expect(runBrainPass("detectors")).resolves.toEqual({ ok: false, reason: "busy" });
  });

  it("keeps 429, 503 and an unclassified failure apart", async () => {
    authFetch.mockResolvedValueOnce(reply(429, { retryAfterSeconds: 120 }));
    await expect(runBrainPass("corpus.documents")).resolves.toEqual({
      ok: false,
      reason: "too_soon",
      retryAfterSeconds: 120,
    });
    authFetch.mockResolvedValueOnce(reply(503, { error: "brain_disabled" }));
    await expect(runBrainPass("detectors")).resolves.toEqual({ ok: false, reason: "off" });
    authFetch.mockResolvedValueOnce(reply(500, {}));
    await expect(runBrainPass("detectors")).resolves.toEqual({ ok: false, reason: "failed" });
  });
});

/** Coverage payload with the detector pass in the given run state. */
function coverage(runState: "idle" | "running") {
  const pass = (passKey: string, state: "idle" | "running") => ({
    passKey,
    enabled: true,
    runState: state,
    runningSince: state === "running" ? "2033-06-10T12:00:00.000Z" : null,
    lastRunAt: null,
    lastSucceededAt: null,
    lastError: null,
    unitsSeen: 0,
    unitsDigested: 0,
    rowsWritten: 0,
  });
  return {
    enabled: true,
    passes: [pass("detectors", runState), pass("corpus.documents", "idle")],
    corpus: { documentsReady: 10, documentsDigested: 1 },
  };
}

/** Answers by URL, so findings and coverage can move independently. */
function routeTo(states: ("idle" | "running")[]) {
  let i = 0;
  authFetch.mockImplementation(async (url: string) => {
    // Guarded, because an arrow body that RETURNS `mockReset()` hands vitest a
    // function it then calls as a teardown hook — an `authFetch(undefined)`
    // that reads as a mystery request. Braces below; this catches a relapse.
    if (typeof url !== "string") throw new Error("authFetch called with " + String(url));
    if (url.startsWith("/api/brain/findings")) return reply(200, { findings: [], total: 0 });
    if (url.startsWith("/api/brain/coverage")) {
      const state = states[Math.min(i, states.length - 1)]!;
      i += 1;
      return reply(200, coverage(state));
    }
    return reply(404, {});
  });
}

describe("/brief re-reads coverage while a pass is running (WARP-2850 review)", () => {
  it("re-enables the button once the box says the pass finished", async () => {
    // First read: running — the control is correctly disabled. Second read,
    // which only happens if the page polls: idle. Before this fix there was no
    // second read at all, and "Check records now: running…" was terminal until
    // a manual reload.
    routeTo(["running", "idle"]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<BriefPage />);
      const button = await screen.findByRole("button", { name: /check records now: running/i });
      expect(button).toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /^check records now$/i })).toBeEnabled();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT poll when nothing is running", async () => {
    // The poll exists for the minutes a pass is actually working. An idle box
    // must not re-fetch two endpoints forever behind an open tab.
    routeTo(["idle"]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<BriefPage />);
      await screen.findByRole("button", { name: /^check records now$/i });
      const afterMount = authFetch.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(authFetch.mock.calls.length).toBe(afterMount);
    } finally {
      vi.useRealTimers();
    }
  });
});
