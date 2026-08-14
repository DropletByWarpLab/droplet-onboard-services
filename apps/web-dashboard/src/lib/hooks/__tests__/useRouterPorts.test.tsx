/**
 * useRouterPorts — the hook body itself (WARP-1907).
 *
 * 🔴 This file exists because the panel tests could not fail. Both
 * `RouterPortsPanel.test.tsx` and `RouterPortWrite.test.tsx` mock
 * `@/lib/hooks/useRouterPorts` wholesale, so every assertion about "the write"
 * was really an assertion about a `vi.fn()`. QA proved it: deleting `force`
 * from the hook, and deleting the entire Tier-2 confirm round-trip, both left
 * 40/40 green. The second mutant turns every write into a silent no-op that the
 * UI reports as success — the exact failure `DeviceWriteNotApplied` exists to
 * prevent on the server, with no equivalent on the client.
 *
 * So this file mocks one layer LOWER (`@/lib/api`) and drives the real hook.
 * What it pins:
 *   - `force` reaches the API verbatim, in both directions and by default;
 *   - a `requiresConfirmation` response is echoed back through
 *     `confirmNetworkCommand` with the token AND the operation the server
 *     named — a POST that mints a token and never confirms it applies nothing;
 *   - a write that did NOT require confirmation is not double-confirmed;
 *   - a rejected write propagates (the panel toasts it and ConfirmDialog stays
 *     open); it must not resolve as success.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

const routerSetPortEnabled = vi.fn();
const confirmNetworkCommand = vi.fn();

vi.mock("@/lib/api", () => ({
  routerSetPortEnabled: (...args: unknown[]) => routerSetPortEnabled(...args),
  confirmNetworkCommand: (...args: unknown[]) => confirmNetworkCommand(...args),
}));

// SWR's fetcher would try to hit the network on mount; the read is not what
// this file is about, so stub the transport and let SWR resolve to nothing.
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => null }),
}));

import { useRouterPorts } from "../useRouterPorts";

beforeEach(() => {
  vi.clearAllMocks();
  routerSetPortEnabled.mockResolvedValue({});
  confirmNetworkCommand.mockResolvedValue({ operationId: "op-1" });
});

/**
 * A fresh SWR cache per test with deduping off. Without both, the revalidation
 * this hook fires after a write is swallowed — SWR's 2s dedupe window and its
 * module-global cache would make "did the map re-read?" unobservable, and a
 * test that cannot observe the thing it names is the class of test this file
 * was written to replace.
 */
function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>
      {children}
    </SWRConfig>
  );
}

function hook() {
  return renderHook(() => useRouterPorts(), { wrapper }).result;
}

describe("setPortEnabled → the API call", () => {
  it("passes force:true through verbatim", async () => {
    const r = hook();
    await act(async () => {
      await r.current.setPortEnabled("p1", false, true);
    });
    expect(routerSetPortEnabled).toHaveBeenCalledWith("p1", false, true);
  });

  it("passes force:false through verbatim", async () => {
    const r = hook();
    await act(async () => {
      await r.current.setPortEnabled("p1", false, false);
    });
    expect(routerSetPortEnabled).toHaveBeenCalledWith("p1", false, false);
  });

  it("defaults force to FALSE when the caller omits it", async () => {
    /* The default is the whole guard. A hook that defaulted it to true would
       clear the routing service's WAN refusal for every write that reached it,
       and nothing downstream would notice. */
    const r = hook();
    await act(async () => {
      await r.current.setPortEnabled("p5", false);
    });
    expect(routerSetPortEnabled).toHaveBeenCalledWith("p5", false, false);
  });

  it("carries the direction through unchanged", async () => {
    const r = hook();
    await act(async () => {
      await r.current.setPortEnabled("p1", true, false);
    });
    expect(routerSetPortEnabled).toHaveBeenCalledWith("p1", true, false);
  });
});

describe("the Tier-2 confirm round-trip", () => {
  it("echoes the token AND the operation the server named", async () => {
    /* 🔴 The mutant that survived: skipping this call entirely. The POST only
       MINTS a token — nothing reaches the router until it is confirmed — so a
       hook that never confirms is a write that never happened, reported to the
       user as done. */
    routerSetPortEnabled.mockResolvedValue({
      requiresConfirmation: true,
      confirmationToken: "tok-abc",
      operation: "router_port_disable",
    });
    const r = hook();
    await act(async () => {
      await r.current.setPortEnabled("p5", false);
    });
    expect(confirmNetworkCommand).toHaveBeenCalledWith("tok-abc", "router_port_disable");
  });

  it("echoes the ENABLE operation when that is what the server minted", async () => {
    routerSetPortEnabled.mockResolvedValue({
      requiresConfirmation: true,
      confirmationToken: "tok-on",
      operation: "router_port_enable",
    });
    const r = hook();
    await act(async () => {
      await r.current.setPortEnabled("p1", true);
    });
    expect(confirmNetworkCommand).toHaveBeenCalledWith("tok-on", "router_port_enable");
  });

  it("does not confirm a response that never asked for confirmation", async () => {
    routerSetPortEnabled.mockResolvedValue({ status: "ok" });
    const r = hook();
    await act(async () => {
      await r.current.setPortEnabled("p5", false);
    });
    expect(confirmNetworkCommand).not.toHaveBeenCalled();
  });

  it("does not confirm when the server withheld a token", async () => {
    routerSetPortEnabled.mockResolvedValue({ requiresConfirmation: true, operation: "x" });
    const r = hook();
    await act(async () => {
      await r.current.setPortEnabled("p5", false);
    });
    expect(confirmNetworkCommand).not.toHaveBeenCalled();
  });
});

describe("failures propagate", () => {
  it("rejects when the POST rejects — never resolves as a silent success", async () => {
    routerSetPortEnabled.mockRejectedValue(new Error("409"));
    const r = hook();
    await expect(
      act(async () => {
        await r.current.setPortEnabled("p1", false);
      }),
    ).rejects.toThrow("409");
  });

  it("rejects when the CONFIRM rejects — the write is the confirm", async () => {
    routerSetPortEnabled.mockResolvedValue({
      requiresConfirmation: true,
      confirmationToken: "tok",
      operation: "router_port_disable",
    });
    confirmNetworkCommand.mockRejectedValue(new Error("token expired"));
    const r = hook();
    await expect(
      act(async () => {
        await r.current.setPortEnabled("p1", false);
      }),
    ).rejects.toThrow("token expired");
  });
});

describe("the map is re-read after a successful write", () => {
  it("revalidates so the panel reflects the new state without a manual refresh", async () => {
    const r = hook();
    await act(async () => {
      await r.current.setPortEnabled("p5", false);
    });
    // The SWR fetcher is the only observable signal that a revalidation ran.
    const { authFetch } = await import("@/lib/auth");
    await waitFor(() =>
      expect(vi.mocked(authFetch).mock.calls.length).toBeGreaterThan(1),
    );
  });
});
