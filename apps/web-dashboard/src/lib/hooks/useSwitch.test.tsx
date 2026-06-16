/**
 * useSwitch — §7 contract binding (ADDON-network-switch-management.md §7).
 *
 * PR-B (dashboard). The backend (PR-A) lands in parallel, so every fetch is
 * mocked here against the frozen §7 shapes. These tests pin:
 *   - the three reads (status / ports / vlans) mapped to the §7 JSON exactly,
 *   - `connected` derived from status.connected,
 *   - the four write actions going through the Tier-2 confirm dance
 *     (202 → confirmationToken → confirmNetworkCommand).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { useSwitch } from "@/lib/hooks/useSwitch";

// authFetch is the single network boundary for the reads. The write helpers
// live in @/lib/api and are mocked as a unit (same pattern as the network
// surface tests, which mock @/lib/api wholesale).
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  switchSetPortVlan: vi.fn(),
  switchSetPortPoe: vi.fn(),
  switchSetPortEnabled: vi.fn(),
  switchProvision: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));

import { authFetch } from "@/lib/auth";
import {
  switchSetPortVlan,
  switchSetPortPoe,
  switchSetPortEnabled,
  switchProvision,
  confirmNetworkCommand,
} from "@/lib/api";

const STATUS = {
  connected: true,
  model: "SM8TAT2SA",
  firmware: "v1.04.0079",
  auto_managed: true,
  vlan_profile: "flat-lan",
  last_provisioned_at: "2026-06-03T23:40:00Z",
  protected_port: 9,
  poe_budget_w: 130,
  poe_used_w: 13.2,
  poe_ports_active: 2,
};

const PORTS = [
  {
    port: 4,
    label: "1/4",
    name: "Living-room AP",
    role: "ap",
    link_up: true,
    speed: "1 Gb",
    is_sfp: false,
    vlan: 1,
    vlan_name: "LAN",
    poe: { delivering: true, power_w: 5.2, class: 4, max_power_w: 30 },
    status: "online",
    device: { mac: "00:c0:f2:00:00:01", ip: "192.168.20.41", name: "Living-room AP" },
  },
];

const VLANS = [
  { vlan_id: 1, name: "LAN", isolated: false, ports: [1, 2, 3, 4] },
  { vlan_id: 100, name: "Cameras", isolated: true, ports: [7, 9] },
];

function wrapper({ children }: { children: ReactNode }) {
  // Fresh cache per render so one test's data can't leak into the next.
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function mockReads() {
  (authFetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    const body =
      url.endsWith("/status") ? STATUS : url.endsWith("/ports") ? PORTS : VLANS;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSwitch — §7 reads", () => {
  it("maps GET /status, /ports, /vlans to the §7 shapes", async () => {
    mockReads();
    const { result } = renderHook(() => useSwitch(), { wrapper });

    await waitFor(() => expect(result.current.status).not.toBeNull());

    expect(result.current.status?.vlan_profile).toBe("flat-lan");
    expect(result.current.status?.protected_port).toBe(9);
    expect(result.current.status?.poe_budget_w).toBe(130);
    expect(result.current.connected).toBe(true);

    await waitFor(() => expect(result.current.ports.length).toBe(1));
    expect(result.current.ports[0].name).toBe("Living-room AP");
    expect(result.current.ports[0].poe?.power_w).toBe(5.2);
    expect(result.current.ports[0].device?.ip).toBe("192.168.20.41");

    await waitFor(() => expect(result.current.vlans.length).toBe(2));
    expect(result.current.vlans[1].isolated).toBe(true);
  });

  it("derives connected=false from status.connected (empty state)", async () => {
    (authFetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      const body = url.endsWith("/status") ? { ...STATUS, connected: false } : [];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    });
    const { result } = renderHook(() => useSwitch(), { wrapper });
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.connected).toBe(false);
  });

  it("surfaces a read error and connected=false when status fails", async () => {
    (authFetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith("/status"))
        return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    });
    const { result } = renderHook(() => useSwitch(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.connected).toBe(false);
  });
});

describe("useSwitch — Tier-2 write dance", () => {
  beforeEach(() => {
    mockReads();
    // Every write helper returns a 202 confirm token; confirm resolves with an op id.
    (switchSetPortVlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "pending",
      requiresConfirmation: true,
      confirmationToken: "tok-vlan",
      operation: "switch.port.vlan",
    });
    (switchSetPortPoe as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "pending",
      requiresConfirmation: true,
      confirmationToken: "tok-poe",
      operation: "switch.port.poe",
    });
    (switchSetPortEnabled as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "pending",
      requiresConfirmation: true,
      confirmationToken: "tok-en",
      operation: "switch.port.enable",
    });
    (switchProvision as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "pending",
      requiresConfirmation: true,
      confirmationToken: "tok-prov",
      operation: "switch.provision",
    });
    (confirmNetworkCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ operationId: "op-1" });
  });

  it("changeVlan posts then confirms with the issued token + operation", async () => {
    const { result } = renderHook(() => useSwitch(), { wrapper });
    await act(async () => {
      await result.current.changeVlan(4, 100);
    });
    expect(switchSetPortVlan).toHaveBeenCalledWith(4, 100);
    expect(confirmNetworkCommand).toHaveBeenCalledWith("tok-vlan", "switch.port.vlan");
  });

  it("togglePoe posts then confirms", async () => {
    const { result } = renderHook(() => useSwitch(), { wrapper });
    await act(async () => {
      await result.current.togglePoe(4, false);
    });
    expect(switchSetPortPoe).toHaveBeenCalledWith(4, false);
    expect(confirmNetworkCommand).toHaveBeenCalledWith("tok-poe", "switch.port.poe");
  });

  it("setPortEnabled posts then confirms", async () => {
    const { result } = renderHook(() => useSwitch(), { wrapper });
    await act(async () => {
      await result.current.setPortEnabled(6, true);
    });
    expect(switchSetPortEnabled).toHaveBeenCalledWith(6, true);
    expect(confirmNetworkCommand).toHaveBeenCalledWith("tok-en", "switch.port.enable");
  });

  it("reapplyConfig posts then confirms", async () => {
    const { result } = renderHook(() => useSwitch(), { wrapper });
    await act(async () => {
      await result.current.reapplyConfig();
    });
    expect(switchProvision).toHaveBeenCalledTimes(1);
    expect(confirmNetworkCommand).toHaveBeenCalledWith("tok-prov", "switch.provision");
  });

  it("does not call confirm when the server did not request confirmation", async () => {
    (switchSetPortPoe as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "ok" });
    const { result } = renderHook(() => useSwitch(), { wrapper });
    await act(async () => {
      await result.current.togglePoe(4, true);
    });
    expect(confirmNetworkCommand).not.toHaveBeenCalled();
  });
});
