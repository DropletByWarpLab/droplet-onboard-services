import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * WARP-577 — Setup-detection must fail CLOSED, not into the first-run wizard,
 * on transient orchestrator errors.
 *
 * Two layers under test:
 *  1. checkSetupRequired() in lib/api.ts — must return a tri-state
 *     ('required' | 'complete' | 'unknown') and map every non-2xx, network
 *     error, and timeout to 'unknown'.
 *  2. AuthGate — must NOT redirect to /setup on 'unknown' (renders a
 *     connecting interstitial instead); 'complete' renders the app;
 *     'required' redirects to /setup.
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
    // Simulate the AbortController timeout firing: fetch rejects with an
    // AbortError once its signal aborts.
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
    const checkSetupRequired = await importCheck();
    // Real timers: the internal ~5s timeout should abort and resolve 'unknown'.
    await expect(checkSetupRequired()).resolves.toBe("unknown");
  }, 10000);
});

// --- 2. AuthGate gating on tri-state ---

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

let mockAuthValue: {
  user: unknown;
  isLoading: boolean;
  setupRequired: boolean | null;
  setupStatus: "required" | "complete" | "unknown";
  retrySetupCheck: () => void;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  completeSetup: () => void;
};

vi.mock("@/lib/auth", () => ({
  useAuth: () => mockAuthValue,
}));

describe("AuthGate tri-state gating (WARP-577)", () => {
  beforeEach(() => {
    mockReplace = vi.fn();
    mockPush = vi.fn();
    mockPathname = "/";
  });

  it("'unknown' renders the connecting interstitial and does NOT redirect", async () => {
    mockAuthValue = {
      user: null,
      isLoading: false,
      setupRequired: null,
      setupStatus: "unknown",
      retrySetupCheck: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      completeSetup: vi.fn(),
    };
    const { AuthGate } = await import("../components/AuthGate");
    render(
      <AuthGate>
        <div>protected content</div>
      </AuthGate>,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/connecting to your droplet/i),
      ).toBeInTheDocument();
    });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });

  it("'unknown' interstitial exposes a manual Retry that calls retrySetupCheck", async () => {
    const retry = vi.fn();
    mockAuthValue = {
      user: null,
      isLoading: false,
      setupRequired: null,
      setupStatus: "unknown",
      retrySetupCheck: retry,
      login: vi.fn(),
      logout: vi.fn(),
      completeSetup: vi.fn(),
    };
    const { AuthGate } = await import("../components/AuthGate");
    render(
      <AuthGate>
        <div>protected content</div>
      </AuthGate>,
    );
    const btn = await screen.findByRole("button", { name: /retry/i });
    await userEvent.click(btn);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("'complete' + user present renders the app, no redirect to /setup", async () => {
    mockAuthValue = {
      user: { id: "1", username: "admin", displayName: "Admin", role: "admin" },
      isLoading: false,
      setupRequired: false,
      setupStatus: "complete",
      retrySetupCheck: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      completeSetup: vi.fn(),
    };
    const { AuthGate } = await import("../components/AuthGate");
    render(
      <AuthGate>
        <div>protected content</div>
      </AuthGate>,
    );
    await waitFor(() => {
      expect(screen.getByText("protected content")).toBeInTheDocument();
    });
    expect(mockReplace).not.toHaveBeenCalledWith("/setup");
  });

  it("'required' redirects to /setup", async () => {
    mockAuthValue = {
      user: null,
      isLoading: false,
      setupRequired: true,
      setupStatus: "required",
      retrySetupCheck: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      completeSetup: vi.fn(),
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
