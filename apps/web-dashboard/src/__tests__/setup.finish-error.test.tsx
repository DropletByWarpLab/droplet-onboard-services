/**
 * M4 (PR #372 re-review) — the wizard-FINISH PATCH must not silently
 * diverge UI from server. Before the fix, `patchSetupReady` swallowed every
 * error and `completeSetup` left the in-memory appliance flipped to "ready"
 * even when the server stayed "unclaimed" — so the next refresh re-trapped
 * the owner with no signal.
 *
 * This drives the REAL `AuthProvider.completeSetup` + `lib/api.patchSetupReady`
 * over a stubbed `fetch`:
 *   - a FAILED finish PATCH ⇒ completeSetup() resolves false, the optimistic
 *     `ready` flip is ROLLED BACK to "unclaimed", and `completeSetupError`
 *     is surfaced;
 *   - a later successful retry ⇒ flips ready and clears the error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// A minimal in-memory localStorage so AuthProvider.init() doesn't throw in
// environments where jsdom hasn't wired one onto the global.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

import { AuthProvider, useAuth } from "@/lib/auth";

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/**
 * fetch stub:
 *   GET  /api/setup/state → unclaimed/welcome (probe)
 *   GET  /api/auth/me     → 401 (no live session in this harness)
 *   PATCH /api/setup/state with appliance:ready → outcome driven by `readyStatus`
 */
function makeFetch(readyStatusRef: { status: number }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/setup/state") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      if (body.appliance === "ready") {
        return readyStatusRef.status >= 400
          ? json(readyStatusRef.status, { error: "boom" })
          : json(200, {
              appliance: "ready",
              setup_step: "done",
              user_tour_completed: false,
            });
      }
    }
    if (url.includes("/api/setup/state")) {
      return json(200, {
        appliance: "unclaimed",
        setup_step: "welcome",
        user_tour_completed: false,
      });
    }
    if (url.includes("/api/auth/me")) return json(401, {});
    return json(200, {});
  });
}

describe("completeSetup — M4 failure surfacing + rollback", () => {
  it("rolls back the optimistic ready flip and surfaces an error when the PATCH fails", async () => {
    const readyStatus = { status: 500 };
    vi.stubGlobal("fetch", makeFetch(readyStatus));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    // Wait for init() to settle the probe (appliance unclaimed).
    await waitFor(() =>
      expect(result.current.setupState?.appliance).toBe("unclaimed"),
    );

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.completeSetup();
    });

    // Failed persist ⇒ false, rolled back to unclaimed, explicit error.
    expect(returned).toBe(false);
    expect(result.current.setupState?.appliance).toBe("unclaimed");
    expect(result.current.completeSetupError).toBeTruthy();
  });

  it("succeeds + clears the error on a subsequent retry", async () => {
    const readyStatus = { status: 500 };
    vi.stubGlobal("fetch", makeFetch(readyStatus));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() =>
      expect(result.current.setupState?.appliance).toBe("unclaimed"),
    );

    await act(async () => {
      await result.current.completeSetup();
    });
    expect(result.current.completeSetupError).toBeTruthy();

    // The server recovers; retry now succeeds.
    readyStatus.status = 200;
    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.completeSetup();
    });

    expect(returned).toBe(true);
    expect(result.current.setupState?.appliance).toBe("ready");
    expect(result.current.completeSetupError).toBeNull();
  });
});
