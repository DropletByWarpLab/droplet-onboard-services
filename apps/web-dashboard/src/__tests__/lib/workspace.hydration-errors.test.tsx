/**
 * WARP-875 — WorkspaceProvider hydrates the workspace type from
 * GET /api/settings/workspace. A 404 means "Phase 4a not deployed" and is an
 * expected silent no-op. But the old code (`if (!res.ok) return`) swallowed
 * EVERY non-OK response identically, so a real 500/502/503 was indistinguishable
 * from the benign 404 — the dashboard silently pinned to the cached value with
 * no signal. Now: 404 stays silent; other failures warn (value still kept).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "owner" }, isLoading: false }),
}));

import { WorkspaceProvider, useWorkspace } from "@/lib/workspace";

const STORAGE_KEY = "droplet-workspace-type";

function Probe() {
  const { workspaceType } = useWorkspace();
  return <div data-testid="ws">{workspaceType}</div>;
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockGet(status: number) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  });
}

// The provider reads `window.localStorage`, which this jsdom env doesn't attach
// (only a bare global `localStorage` exists). Give it a working in-memory store.
function installLocalStorage(seed: Record<string, string>) {
  const store: Record<string, string> = { ...seed };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    },
  });
}

beforeEach(() => {
  // Cached preference the hydration must preserve on error.
  installLocalStorage({ [STORAGE_KEY]: "business" });
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkspaceProvider hydration error handling (WARP-875)", () => {
  it("tolerates a 404 silently and keeps the cached value", async () => {
    mockGet(404);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(console.warn).not.toHaveBeenCalled();
    expect(screen.getByTestId("ws")).toHaveTextContent("business");
  });

  it("warns once on a non-404 failure and keeps the cached value", async () => {
    mockGet(500);
    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(console.warn).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("ws")).toHaveTextContent("business");
  });
});
