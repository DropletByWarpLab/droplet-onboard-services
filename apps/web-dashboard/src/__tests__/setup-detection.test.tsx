import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

/**
 * WARP-577 — Setup-detection must fail CLOSED, not into the first-run wizard,
 * on transient orchestrator errors.
 *
 * Two layers under test:
 *  1. checkSetupRequired() in lib/api.ts — must return a tri-state
 *     ('required' | 'complete' | 'unknown') and map every non-2xx, network
 *     error, and timeout to 'unknown'. (API-level unit tests — unchanged by
 *     PR #372; checkSetupRequired() still exists and still tri-states.)
 *  2. AuthGate fail-closed gating — PR #372 replaced the legacy boolean
 *     `setupRequired` / tri-state `setupStatus` AuthGate mechanism (and the
 *     "Connecting to your Droplet…" interstitial) with routing off the
 *     explicit `setupState.appliance` lifecycle. The WARP-577 GUARANTEE is
 *     unchanged and re-expressed against that contract here: a transient,
 *     unresolved setup state (`setupState === null`) must NEVER be mistaken
 *     for "unclaimed", so it must NOT false-redirect a user into the wizard;
 *     a probe FAILURE surfaces an explicit error + Retry instead of guessing.
 *     (The happy-path `unclaimed → /setup` and `ready → dashboard` routes are
 *     covered by auth-gate.routing.test.tsx; this block guards the
 *     fail-closed edge WARP-577 originally introduced.)
 */

// --- 1. checkSetupRequired() tri-state unit tests ---

describe("checkSetupRequired() tri-state (WARP-577)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function importCheck() {
    const mod = await import("../lib/api");
    return mod.checkSetupRequired;
  }

  it("maps 200 + setupRequired:true -> 'required'", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ setupRequired: true }),
    } as Response);
    const checkSetupRequired = await importCheck();
    await expect(checkSetupRequired()).resolves.toBe("required");
  });

  it("maps 200 + setupRequired:false -> 'complete'", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ setupRequired: false }),
    } as Response);
    const checkSetupRequired = await importCheck();
    await expect(checkSetupRequired()).resolves.toBe("complete");
  });

  it("maps a 2xx body that omits setupRequired -> 'unknown' (no guessing)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);
    const checkSetupRequired = await importCheck();
    await expect(checkSetupRequired()).resolves.toBe("unknown");
  });

  it("maps a 500 response -> 'unknown' (does NOT fail open into setup)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);
    const checkSetupRequired = await importCheck();
    await expect(checkSetupRequired()).resolves.toBe("unknown");
  });

  it("maps a 502 gateway response with a non-JSON body -> 'unknown'", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    const checkSetupRequired = await importCheck();
    await expect(checkSetupRequired()).resolves.toBe("unknown");
  });

  it("maps a thrown fetch/network error -> 'unknown'", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const checkSetupRequired = await importCheck();
    await expect(checkSetupRequired()).resolves.toBe("unknown");
  });

  it("maps an aborted/timed-out request -> 'unknown'", async () => {
    // The fetch never resolves on its own; it only rejects with an AbortError
    // once the internal AbortController timeout fires its signal. We drive that
    // timeout deterministically with fake timers (no real 5s wall-clock wait,
    // which flakes under full-suite parallelism).
    const checkSetupRequired = await importCheck();
    vi.useFakeTimers();
    global.fetch = vi.fn().mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }
        }),
    );
    const pending = checkSetupRequired();
    // Fast-forward past the ~5s probe timeout so the controller aborts.
    await vi.advanceTimersByTimeAsync(6000);
    await expect(pending).resolves.toBe("unknown");
    vi.useRealTimers();
  });
});

// --- 2. AuthGate fail-closed gating on the explicit setup state (PR #372) ---

let mockReplace: ReturnType<typeof vi.fn>;
let mockPush: ReturnType<typeof vi.fn>;
let mockPathname: string;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => mockPathname,
}));

// Stub out the Sidebar so the AuthGate "app shell" branch renders without
// pulling the full nav (and its hooks) into the test.
vi.mock("@/components/Sidebar", () => ({
  Sidebar: () => null,
}));

// PR #372 — AuthGate reads `setupState` (the explicit lifecycle) plus the
// probe error/retry affordances. The legacy `setupStatus` / `retrySetupCheck`
// fields are gone. We type the mock to exactly what AuthGate destructures so a
// future field rename trips tsc here rather than passing a stale shape.
type MockAuthValue = {
  user: unknown;
  isLoading: boolean;
  setupState: {
    appliance: "unclaimed" | "ready";
    setupStep: string;
    userTourCompleted: boolean;
  } | null;
  setupProbeError: string | null;
  retrySetupProbe: () => Promise<void>;
};

let mockAuthValue: MockAuthValue;

vi.mock("@/lib/auth", () => ({
  useAuth: () => mockAuthValue,
}));

describe("AuthGate fail-closed gating (WARP-577, re-expressed for PR #372)", () => {
  beforeEach(() => {
    mockReplace = vi.fn();
    mockPush = vi.fn();
    mockPathname = "/";
  });

  it("does NOT false-redirect to /setup when the setup state is unresolved (null) — transient state is never read as 'unclaimed'", async () => {
    // The WARP-577 guarantee in #372 vocabulary: a transient/unresolved
    // `setupState` must not be mistaken for an unclaimed appliance, so it must
    // not trap the user in the first-run wizard. (No probe error recorded, so
    // this is the "still resolving" path, not the explicit-error path below.)
    mockAuthValue = {
      user: null,
      isLoading: false,
      setupState: null,
      setupProbeError: null,
      retrySetupProbe: vi.fn().mockResolvedValue(undefined),
    };
    const { AuthGate } = await import("../components/AuthGate");
    render(
      <AuthGate>
        <div>protected content</div>
      </AuthGate>,
    );
    // Give the routing effect a tick to (not) fire.
    await waitFor(() => {
      expect(mockReplace).not.toHaveBeenCalledWith("/setup");
    });
    // Fail-closed: protected content is withheld while unauthenticated.
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("renders an explicit error + Retry (no guess-redirect) when the lifecycle probe failed with no state", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    mockAuthValue = {
      user: null,
      isLoading: false,
      // Probe failed AND no state resolved, on a protected page → AuthGate
      // surfaces the explicit error instead of routing off a guess.
      setupState: null,
      setupProbeError: "Couldn't reach the appliance to read setup state.",
      retrySetupProbe: retry,
    };
    const { AuthGate } = await import("../components/AuthGate");
    render(
      <AuthGate>
        <div>protected content</div>
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByText(/can't reach your appliance/i)).toBeInTheDocument();
    });
    // The recorded probe reason is shown to the user…
    expect(
      screen.getByText(/couldn't reach the appliance to read setup state/i),
    ).toBeInTheDocument();
    // …and the gate did NOT silently bounce off a guessed state.
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();

    // The Retry affordance re-runs the lifecycle probe.
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("routes an unclaimed appliance into the wizard (/setup)", async () => {
    // The positive control for the fail-closed cases above: a genuinely
    // resolved "unclaimed" state DOES route to the wizard.
    mockAuthValue = {
      user: null,
      isLoading: false,
      setupState: {
        appliance: "unclaimed",
        setupStep: "welcome",
        userTourCompleted: false,
      },
      setupProbeError: null,
      retrySetupProbe: vi.fn().mockResolvedValue(undefined),
    };
    const { AuthGate } = await import("../components/AuthGate");
    render(
      <AuthGate>
        <div>protected content</div>
      </AuthGate>,
    );
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/setup");
    });
  });
});
