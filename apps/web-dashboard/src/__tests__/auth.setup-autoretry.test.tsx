/**
 * WARP-667 — cold-boot auto-retry of the setup-state probe.
 *
 * On a freshly-booted box the orchestrator can still be warming when the
 * dashboard first loads, so `GET /api/setup/state` fails and AuthProvider
 * fail-closes (setupProbeError set, setupState null). Before WARP-667 the owner
 * had to manually refresh until the box was warm ("needs a refresh a bunch of
 * times before it comes through"). These tests pin the new contract:
 *   (a) a probe that fails then succeeds AUTO-recovers — setupState populates
 *       with no manual action, and `setupAutoRetrying` flips back to false;
 *   (b) the auto-retry is BOUNDED — after the backoff schedule is exhausted it
 *       stops calling the endpoint and surfaces the manual Retry
 *       (`setupAutoRetrying` false), with no infinite loop.
 *
 * Fake timers drive the backoff deterministically; the api module cycle is
 * stubbed (same as auth.init.test.tsx) so this exercises only the provider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  patchSetupReady: vi.fn(),
  patchTourCompleted: vi.fn(),
}));

import { AuthProvider, useAuth } from "@/lib/auth";

function Probe() {
  const { setupState, setupAutoRetrying, setupProbeError } = useAuth();
  return (
    <div>
      <span data-testid="appliance">
        {setupState ? setupState.appliance : "none"}
      </span>
      <span data-testid="retrying">
        {setupAutoRetrying ? "retrying" : "idle"}
      </span>
      <span data-testid="error">{setupProbeError ? "err" : "ok"}</span>
    </div>
  );
}

function okJson(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response);
}

/** Advance fake timers + flush the awaited probe microtasks inside act(). */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AuthProvider — cold-boot setup-state auto-retry (WARP-667)", () => {
  it("auto-recovers when the probe fails once then succeeds — no manual retry", async () => {
    let setupCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/api/setup/state")) {
          setupCalls += 1;
          // Cold on the first probe (init), warm on the auto-retry.
          if (setupCalls === 1) return Promise.reject(new Error("ECONNREFUSED"));
          return okJson({
            appliance: "unclaimed",
            setup_step: "account",
            user_tour_completed: false,
          });
        }
        // /api/auth/me — unauthenticated during cold boot.
        return Promise.reject(new Error("ECONNREFUSED"));
      }),
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // init() settles: first setup-state probe failed → auto-retry armed.
    await tick(0);
    expect(screen.getByTestId("appliance")).toHaveTextContent("none");
    expect(screen.getByTestId("retrying")).toHaveTextContent("retrying");

    // First backoff step (1.5s) fires → the probe now succeeds, with no manual
    // action from the user.
    await tick(1_500);
    expect(screen.getByTestId("appliance")).toHaveTextContent("unclaimed");
    expect(screen.getByTestId("retrying")).toHaveTextContent("idle");
    expect(setupCalls).toBe(2); // 1 init + 1 auto-retry, then it stops
  });

  it("stops after the bounded backoff and surfaces the manual retry", async () => {
    let setupCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/api/setup/state")) setupCalls += 1;
        // Box never comes up — every probe fails.
        return Promise.reject(new Error("ECONNREFUSED"));
      }),
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await tick(0);
    expect(screen.getByTestId("retrying")).toHaveTextContent("retrying");

    // Walk the backoff one step at a time — each failed attempt has to re-render
    // + re-arm the effect before the next timer exists, so we advance per step.
    await tick(1_500); // retry 1 fails → arms retry 2
    await tick(3_000); // retry 2 fails → arms retry 3
    await tick(6_000); // retry 3 fails → cap reached, loop stops

    // 1 init probe + exactly 3 bounded auto-retries, then it gives up.
    expect(setupCalls).toBe(4);
    expect(screen.getByTestId("retrying")).toHaveTextContent("idle");
    expect(screen.getByTestId("error")).toHaveTextContent("err");

    // No further attempts no matter how long we wait — no infinite loop.
    await tick(20_000);
    expect(setupCalls).toBe(4);
  });
});
