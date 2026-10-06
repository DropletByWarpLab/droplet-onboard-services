/**
 * SwitchPanel x DevicePairingCard (ADR-071 slice C): a switch that was reflashed
 * answers but refuses our credential, so the panel's own read fails and shows the
 * unreachable state. Its pairing card, when the switch has a window open, is the
 * way back; it renders nothing at all when there is nothing to offer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

const useSwitchMock = vi.fn();
vi.mock("@/lib/hooks/useSwitch", () => ({ useSwitch: () => useSwitchMock() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: "owner" } }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const fetchSwitchPairing = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchSwitchPairing: (...a: unknown[]) => fetchSwitchPairing(...a),
  pairSwitch: vi.fn(),
  persistSwitchPairing: vi.fn(),
}));

import { SwitchPanel } from "../SwitchPanel";

const hook = (over: Record<string, unknown> = {}) => ({
  status: null,
  ports: [],
  vlans: [],
  isLoading: false,
  error: undefined,
  connected: false,
  refresh: vi.fn(),
  changeVlan: vi.fn(),
  togglePoe: vi.fn(),
  setPortEnabled: vi.fn(),
  reapplyConfig: vi.fn(),
  ...over,
});

const view = (over: Record<string, unknown> = {}) => ({
  available: true,
  state: "open",
  windowEndsAt: "2026-10-07T00:00:00Z",
  pairedBox: null,
  pairedElsewhere: false,
  pendingPersist: false,
  routerErrorCode: "AUTH",
  host: "192.168.9.2",
  model: "GS1900-10HP",
  ...over,
});

function renderPanel() {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SwitchPanel />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SwitchPanel pairing", () => {
  it("offers Pair under the unreachable state when the switch refused our credential and its window is open", async () => {
    useSwitchMock.mockReturnValue(hook({ error: new Error("Switch status: 502") }));
    fetchSwitchPairing.mockResolvedValue(view());
    renderPanel();
    expect(screen.getByText(/can't reach the switch/i)).toBeInTheDocument();
    expect(await screen.findByText(/Switch GS1900-10HP at 192\.168\.9\.2 is ready to pair\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pair" })).toBeInTheDocument();
  });

  it("offers Pair in the 'no managed switch detected' state too", async () => {
    useSwitchMock.mockReturnValue(hook());
    fetchSwitchPairing.mockResolvedValue(view());
    renderPanel();
    expect(screen.getByText(/no managed switch detected/i)).toBeInTheDocument();
    expect(await screen.findByText(/is ready to pair\./)).toBeInTheDocument();
  });

  it("shows nothing extra when the switch has no pairing to offer", async () => {
    useSwitchMock.mockReturnValue(hook());
    fetchSwitchPairing.mockResolvedValue(view({ available: false, state: null, routerErrorCode: null }));
    renderPanel();
    await waitFor(() => expect(fetchSwitchPairing).toHaveBeenCalled());
    expect(screen.queryByText(/ready to pair/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Pair" })).toBeNull();
  });

  it("a connected switch with an unsaved password gets the Retry state above the header", async () => {
    useSwitchMock.mockReturnValue(
      hook({
        connected: true,
        status: {
          connected: true,
          model: "GS1900-10HP",
          firmware: "24.10",
          auto_managed: true,
          vlan_profile: "flat-lan",
          last_provisioned_at: null,
          protected_port: 0,
          poe_budget_w: 77,
          poe_used_w: 0,
          poe_ports_active: 0,
        },
      }),
    );
    fetchSwitchPairing.mockResolvedValue(view({ pendingPersist: true, routerErrorCode: null, state: "paired" }));
    renderPanel();
    expect(await screen.findByTestId("switch-pairing-retry")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
