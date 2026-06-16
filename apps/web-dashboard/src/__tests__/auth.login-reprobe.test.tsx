/**
 * WARP-867 — login() must route off the AUTHORITATIVE lifecycle state, not a
 * locally-faked one.
 *
 * The previous behaviour force-flipped the in-memory appliance to "ready" on
 * every successful sign-in ("so AuthGate doesn't bounce the user into the
 * wizard before the next state fetch"). On a genuinely unclaimed box — the
 * owner signing back in mid-setup after a reboot, exactly the account step's
 * resume path — that lie parked them on the dashboard of a half-configured
 * box; the next cold load re-probed the truth and (pre-fix) entered the
 * /setup ⇄ / redirect loop. login() now re-fetches `/api/setup/state` before
 * exposing the user, so AuthGate routes off the real answer in both
 * directions (wizard while unclaimed, dashboard once ready).
 *
 * Conventions mirror auth.init.test.tsx: stubbed global fetch, AuthProvider +
 * a tiny context probe, @/lib/api stubbed against the module cycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  patchSetupReady: vi.fn(),
  patchTourCompleted: vi.fn(),
}));

import { AuthProvider, useAuth } from "@/lib/auth";

function LoginProbe() {
  const { user, setupState, login } = useAuth();
  return (
    <div>
      <span data-testid="user">{user ? user.username : "anon"}</span>
      <span data-testid="appliance">{setupState?.appliance ?? "null"}</span>
      <span data-testid="step">{setupState?.setupStep ?? "null"}</span>
      <button
        type="button"
        onClick={() => {
          void login("scruceru@warp-lab.ai", "Warp123!@#xy");
        }}
      >
        do-login
      </button>
    </div>
  );
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Fetch stub: /api/setup/state answers from a mutable holder (so the test can
 * flip what the SERVER says between init and post-login), /api/auth/me 401s
 * (cold load, no session yet), /api/auth/login succeeds.
 */
function stubFetch(stateHolder: { value: Record<string, unknown> }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u}`);
      if (u.includes("/api/setup/state")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(stateHolder.value),
        } as Response);
      }
      if (u.includes("/api/auth/login")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              user: { id: "u1", username: "scruceru", displayName: "Stefan", role: "owner" },
            }),
        } as Response);
      }
      // /api/auth/me (and the refresh it triggers) — no session on cold load.
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "unauthenticated" }),
      } as Response);
    }),
  );
  return calls;
}

describe("AuthProvider.login() — authoritative state re-probe (WARP-867)", () => {
  it("leaves an unclaimed box UNCLAIMED after sign-in (no fake-ready flip) and re-probes the step", async () => {
    const stateHolder = {
      value: {
        appliance: "unclaimed",
        setup_step: "internet",
        user_tour_completed: false,
      },
    };
    const calls = stubFetch(stateHolder);

    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("appliance")).toHaveTextContent("unclaimed"),
    );
    const initStateCalls = calls.filter((c) => c.includes("/api/setup/state")).length;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "do-login" }));
    });

    await waitFor(() =>
      expect(screen.getByTestId("user")).toHaveTextContent("scruceru"),
    );
    // The appliance is STILL unclaimed — login never fakes "ready", so
    // AuthGate keeps the signed-in owner in the wizard at the real step.
    expect(screen.getByTestId("appliance")).toHaveTextContent("unclaimed");
    expect(screen.getByTestId("step")).toHaveTextContent("internet");
    // And that answer came from a fresh probe, not a stale init read.
    expect(
      calls.filter((c) => c.includes("/api/setup/state")).length,
    ).toBeGreaterThan(initStateCalls);
  });

  it("reflects a READY box after sign-in via the same re-probe", async () => {
    const stateHolder = {
      value: {
        appliance: "ready",
        setup_step: "done",
        user_tour_completed: true,
      },
    };
    stubFetch(stateHolder);

    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("appliance")).toHaveTextContent("ready"),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "do-login" }));
    });

    await waitFor(() =>
      expect(screen.getByTestId("user")).toHaveTextContent("scruceru"),
    );
    expect(screen.getByTestId("appliance")).toHaveTextContent("ready");
  });
});
