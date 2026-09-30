/**
 * WARP-2981 (ADR-059 P6, D11) — the Security wall behind the REAL module route
 * guard, in AuthGate's real wall branch, left running.
 *
 * When Security goes off, the guard's card replaces the wall — which unmounts
 * the wall and every read it holds. The nav gate's own /api/modules read then
 * decides alone, and it stops polling after a single error
 * (`shouldRetryOnError: false`; a TV never fires focus). So one failed poll
 * while the card is up (an orchestrator restart) would leave the TV on the
 * card for good. What brings it back is the wall's modules keeper, mounted
 * BESIDE the guard: it keeps the wall's own read polling on the wall's backoff
 * and mirrors each answer into the guard's key. Only `authFetch` is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({ authFetch: vi.fn(), role: "family" as string }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/security/wall",
}));
vi.mock("@/lib/auth", () => ({
  authFetch: h.authFetch,
  useAuth: () => ({
    user: { id: "u1", username: "ada", displayName: "Ada", role: h.role },
    isLoading: false,
    setupState: { appliance: "ready", setupStep: "done", userTourCompleted: true },
    setupProbeError: null,
    setupAutoRetrying: false,
    retrySetupProbe: vi.fn(),
  }),
}));
// Never rendered on the wall's branch; stubbed so AuthGate's imports stay light.
vi.mock("@/lib/nav-layout", () => ({ useNavLayout: () => ({ layout: "sidebar", setLayout: vi.fn() }) }));
vi.mock("@/components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/workspace/WorkspaceShell", () => ({ WorkspaceShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/help/HelpLauncher", () => ({ HelpLauncher: () => null }));

import { AuthGate } from "@/components/AuthGate";
import SecurityWallPage from "@/app/security/wall/page";
import { WALL_COPY } from "@/components/security/wall-status";

const ON = { modules: [{ id: "security", effective: true }, { id: "cameras", effective: true }] };
const OFF = { modules: [{ id: "security", effective: false }, { id: "cameras", effective: true }] };

/** What /api/modules answers right now. */
let modules: { status: number; body: unknown };

function reply(path: string): { status: number; body: unknown } {
  switch (path) {
    case "/api/modules":
      return modules;
    case "/api/security/incidents/summary":
      return { status: 200, body: { openAlerts: 0, openNotices: 1 } };
    case "/api/security/health":
      return { status: 200, body: { sources: [{ id: "camera_ingest", state: "ok", detail: "x", lastSeenAt: null }] } };
    case "/api/security/mode":
      return {
        status: 200,
        body: { mode: "open", source: "schedule", manualEnd: "none", until: null, setBy: null, setAt: null, hours: { state: "not_set" }, displayTimezone: "Europe/London", stale: false, version: 1 },
      };
    case "/api/auth/me":
      return { status: 200, body: { id: "u1", session: null } };
    default:
      return { status: 200, body: {} };
  }
}

/** The nav gate's own read: `authFetch("/api/modules")` with no init (the wall's goes through securityFetch). */
const navGateReads = () => (h.authFetch.mock.calls as Array<[string, RequestInit | undefined]>).filter(([url, init]) => url === "/api/modules" && init === undefined).length;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  h.role = "family";
  modules = { status: 200, body: ON };
  h.authFetch.mockReset().mockImplementation(async (url: string) => {
    const r = reply(url.split("?")[0]!);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, headers: new Headers() };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const wallShown = () => screen.queryByRole("region", { name: WALL_COPY.stripLabel }) !== null;
const blocked = () => screen.queryByTestId("module-route-blocked") !== null;

describe("the wall behind the module guard (D11)", () => {
  it("blocked, then one failed nav-gate poll, then Security back on: the wall comes back by itself within 2 minutes", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <AuthGate>
          <SecurityWallPage />
        </AuthGate>
      </SWRConfig>,
    );
    await advance(1_000);
    expect(wallShown()).toBe(true);

    // The owner switches Security off: within one 2-min poll the guard's card replaces the wall.
    modules = { status: 200, body: OFF };
    await advance(125_000);
    expect(blocked()).toBe(true);
    expect(wallShown()).toBe(false);

    // The orchestrator restarts: the nav gate's next poll fails, and SWR stops polling that key.
    modules = { status: 502, body: { error: { code: "BAD_GATEWAY", message: "x" } } };
    const before = navGateReads();
    await advance(125_000);
    expect(navGateReads()).toBeGreaterThan(before);
    expect(blocked()).toBe(true);

    // Back up, Security on again: the keeper's read lets the TV back in, with nobody touching it.
    modules = { status: 200, body: ON };
    await advance(120_000);
    expect(blocked()).toBe(false);
    expect(wallShown()).toBe(true);
  });
});

describe("D6: only a Member session runs the wall (Stefan: \"Member wall, own cameras\")", () => {
  it.each([
    ["owner", WALL_COPY.refusedTitle],
    ["admin", WALL_COPY.refusedTitle],
    ["guest", WALL_COPY.refusedGuestTitle],
  ])("a %s on the TV: the refusal, and not one request from AuthGate's subtree in 10 minutes — no modules, no Security, no cameras", async (role, title) => {
    h.role = role;
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <AuthGate>
          <SecurityWallPage />
        </AuthGate>
      </SWRConfig>,
    );
    await advance(10 * 60_000);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(wallShown()).toBe(false);
    expect(h.authFetch).not.toHaveBeenCalled();
  });
});
