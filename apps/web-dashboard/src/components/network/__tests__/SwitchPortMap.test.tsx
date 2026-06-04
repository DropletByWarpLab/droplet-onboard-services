/**
 * ADR-018 item 9 — SwitchPortMap (read-only managed-switch surface).
 *
 * Renders the per-port link / VLAN / PoE state from the useSwitch hook into the
 * Network → System tab. Read-only: no write controls, so no safety-tier chip
 * (the 3-tier contract governs WRITE surfaces). Mutations stay on the
 * orchestrator Tier-2 confirmation path, not this panel.
 *
 * Mocks the useSwitch hook directly (same approach as the other network
 * panels mock @/lib/api) so the test asserts render behaviour against a known
 * data shape without a live switch service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SwitchPortMap } from "../SwitchPortMap";
import type { SwitchData } from "@/lib/hooks/useSwitch";

const mockUseSwitch = vi.fn();
vi.mock("@/lib/hooks/useSwitch", () => ({
  useSwitch: () => mockUseSwitch(),
}));

function makeState(over: Partial<ReturnType<typeof baseHook>> = {}) {
  return { ...baseHook(), ...over };
}

function baseHook() {
  const data: SwitchData = {
    ports: [
      { port: 1, name: "Port 1", enabled: true, link_up: true, speed: "1Gbps", duplex: "full", is_sfp: false, vlan: 1 },
      { port: 2, name: "Port 2", enabled: true, link_up: false, speed: null, duplex: null, is_sfp: false, vlan: 1 },
      { port: 9, name: "Port 9", enabled: true, link_up: true, speed: "10Gbps", duplex: "full", is_sfp: true, vlan: 1 },
    ],
    poe: [
      { port: 1, enabled: true, delivering: true, power_mw: 4200, class: "Class 3", max_power_mw: 30000 },
    ],
    vlans: [{ vlan_id: 1, name: "default", ports: [] }],
  };
  return {
    ports: data.ports,
    poe: data.poe,
    vlans: data.vlans,
    isLoading: false,
    error: undefined as Error | undefined,
    refresh: vi.fn(),
  };
}

beforeEach(() => {
  mockUseSwitch.mockReset();
});

describe("SwitchPortMap", () => {
  it("renders one tile per port with its number", () => {
    mockUseSwitch.mockReturnValue(makeState());
    render(<SwitchPortMap />);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
  });

  it("marks the link state of each port for assistive tech", () => {
    mockUseSwitch.mockReturnValue(makeState());
    render(<SwitchPortMap />);
    // Port 1 is up, port 2 is down — exposed via accessible labels.
    expect(screen.getByLabelText(/port 1.*up/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/port 2.*down/i)).toBeInTheDocument();
  });

  it("labels an SFP/uplink port distinctly from a copper access port", () => {
    mockUseSwitch.mockReturnValue(makeState());
    render(<SwitchPortMap />);
    expect(screen.getByLabelText(/port 9.*sfp/i)).toBeInTheDocument();
  });

  it("surfaces PoE delivery for a powered port", () => {
    mockUseSwitch.mockReturnValue(makeState());
    render(<SwitchPortMap />);
    // 4200 mW -> 4.2 W shown somewhere in the panel.
    expect(screen.getByText(/4\.2\s*W/i)).toBeInTheDocument();
  });

  it("shows a connected-empty state when the switch is reachable but has no ports", () => {
    mockUseSwitch.mockReturnValue(
      makeState({ ports: [], poe: [], vlans: [] }),
    );
    render(<SwitchPortMap />);
    expect(screen.getByText(/no managed switch/i)).toBeInTheDocument();
  });

  it("renders an error state (without crashing) when the hook errors", () => {
    mockUseSwitch.mockReturnValue(
      makeState({ ports: [], error: new Error("Switch ports: 503") }),
    );
    render(<SwitchPortMap />);
    expect(screen.getByRole("status")).toHaveTextContent(/switch/i);
  });

  it("renders a loading skeleton while the first fetch is in flight", () => {
    mockUseSwitch.mockReturnValue(
      makeState({ ports: [], isLoading: true }),
    );
    const { container } = render(<SwitchPortMap />);
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("summarises VLAN + PoE counts for a quick read", () => {
    mockUseSwitch.mockReturnValue(makeState());
    render(<SwitchPortMap />);
    // 1 VLAN, 1 PoE port delivering.
    expect(screen.getByText(/1 VLAN/i)).toBeInTheDocument();
  });
});
