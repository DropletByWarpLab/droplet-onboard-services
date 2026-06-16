/**
 * fix/dashboard-shell-loading — AuthProvider.init() must not leave the app
 * stuck on "Loading…" when the first-run probes are cold, slow, or hung.
 *
 * Two reported symptoms shared one root cause: `isLoading` only flipped false
 * after TWO sequential, un-timed fetches in init() — `probeSetupState()`
 * (GET /api/setup/state) THEN `authFetch('/api/auth/me')`. A slow/hung first
 * response kept `isLoading` true, and AuthGate renders a full-screen spinner
 * for the whole app while `isLoading` is true (see auth-gate.public-loading
 * test). So login rendered blank "until N refreshes" and freshly-booted nav
 * showed no content until a refresh landed on warm probes.
 *
 * These tests pin the provider-side contract:
 *   (a) the two init fetches run CONCURRENTLY, not serialized;
 *   (b) a hung endpoint can't leave the app on "Loading…" forever — init
 *       resolves isLoading=false (to an unauthenticated/usable state) on a
 *       bounded timeout;
 *   (c) a probe FAILURE still resolves isLoading=false.
 *
 * Behavioural test: render AuthProvider, observe isLoading via a tiny probe
 * component that reads the context. next/navigation is mocked by the global
 * setup; api.ts (patchSetupReady/patchTourCompleted) is stubbed so the module
 * cycle doesn't pull the network layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  patchSetupReady: vi.fn(),
  patchTourCompleted: vi.fn(),
}));

import { AuthProvider, useAuth } from "@/lib/auth";

function LoadingProbe() {
  const { isLoading, user } = useAuth();
  return (
    <div>
      <span data-testid="loading">{isLoading ? "loading" : "ready"}</span>
      <span data-testid="user">{user ? user.username : "anon"}</span>
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

beforeEach(() => {
  vi.useRealTimers();
  // jsdom localStorage persists across tests in the same file.
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuthProvider.init() — concurrency + timeout (fix/dashboard-shell-loading)", () => {
  it("issues the setup-state and /api/auth/me probes CONCURRENTLY, not serialized", async () => {
    // Each fetch resolves only when we release it. If init() serializes, the
    // SECOND fetch is never even issued until the first resolves — so both
    // calls are NOT in flight at the same time. We assert both were issued
    // before either resolved.
    const releases: Array<() => void> = [];
    const issuedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        issuedUrls.push(String(url));
        return new Promise<Response>((resolve) => {
          releases.push(() =>
            resolve({
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve(
                  String(url).includes("/api/setup/state")
                    ? { appliance: "ready", setup_step: "done", user_tour_completed: true }
                    : { id: "u1", username: "ada", displayName: "Ada", role: "owner" },
                ),
            } as Response),
          );
        });
      }),
    );

    render(
      <AuthProvider>
        <LoadingProbe />
      </AuthProvider>,
    );

    // Both probes should be in flight before either has resolved.
    await waitFor(() => {
      expect(issuedUrls.some((u) => u.includes("/api/setup/state"))).toBe(true);
      expect(issuedUrls.some((u) => u.includes("/api/auth/me"))).toBe(true);
    });

    // Now release both; the app settles.
    await act(async () => {
      releases.forEach((r) => r());
    });
    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
    );
  });

  it("resolves isLoading=false on a bounded timeout when a probe HANGS forever", async () => {
    // Never-resolving fetch — models a cold/hung backend that the box owner
    // hits before the orchestrator is warm.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    render(
      <AuthProvider>
        <LoadingProbe />
      </AuthProvider>,
    );

    // Without a timeout this would spin forever. The fix bounds init() so it
    // settles into a usable (unauthenticated) state. Allow generous real time
    // (the production budget is a few seconds; the test just proves it's
    // finite and not infinite).
    await waitFor(
      () => expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
      { timeout: 9_000 },
    );
    // A hung session probe must NOT authenticate the user.
    expect(screen.getByTestId("user")).toHaveTextContent("anon");
  }, 12_000);

  it("resolves isLoading=false when the probes FAIL (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );

    render(
      <AuthProvider>
        <LoadingProbe />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("ready"),
    );
    expect(screen.getByTestId("user")).toHaveTextContent("anon");
  });
});
