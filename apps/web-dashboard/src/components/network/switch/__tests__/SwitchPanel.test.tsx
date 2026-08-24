/**
 * SwitchPanel — container behaviour: states (loading/empty/error/connected),
 * the interactive layout toggle, the READ-ONLY profile reflection, RBAC
 * (Re-apply hidden for members), and the confirm-on-write flow.
 *
 * useSwitch + useAuth are mocked so the panel renders against deterministic
 * §7 data. framer-motion's reduced-motion gate is stubbed so the
 * ConfirmDialog mounts synchronously after a write action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { UseSwitchResult } from "@/lib/hooks/useSwitch";
import type { SwitchPort, SwitchStatus, SwitchVlan } from "@/lib/types/switch";

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

const useSwitchMock = vi.fn();
vi.mock("@/lib/hooks/useSwitch", () => ({
  useSwitch: () => useSwitchMock(),
}));

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => useAuthMock(),
}));

const toastMock = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { SwitchPanel } from "../SwitchPanel";

const STATUS: SwitchStatus = {
  connected: true,
  model: "SM8TAT2SA",
  firmware: "v1.04.0079",
  auto_managed: true,
  vlan_profile: "flat-lan",
  last_provisioned_at: "2026-06-03T23:40:00Z",
  protected_port: 9,
  poe_budget_w: 130,
  poe_used_w: 19.7,
  poe_ports_active: 4,
};

const PORTS: SwitchPort[] = [
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
  },
  {
    port: 7,
    label: "1/7",
    name: "Garage cam",
    role: "camera",
    link_up: true,
    speed: "1 Gb",
    is_sfp: false,
    vlan: 1,
    vlan_name: "LAN",
    poe: { delivering: true, power_w: 4.0, class: 4, max_power_w: 30 },
    status: "warn",
  },
];

const VLANS: SwitchVlan[] = [
  { vlan_id: 1, name: "LAN", isolated: false, ports: [4, 7] },
  { vlan_id: 100, name: "Cameras", isolated: false, ports: [] },
];

function makeHook(over: Partial<UseSwitchResult> = {}): UseSwitchResult {
  return {
    status: STATUS,
    ports: PORTS,
    vlans: VLANS,
    isLoading: false,
    error: undefined,
    connected: true,
    refresh: vi.fn(),
    changeVlan: vi.fn().mockResolvedValue(undefined),
    togglePoe: vi.fn().mockResolvedValue(undefined),
    setPortEnabled: vi.fn().mockResolvedValue(undefined),
    reapplyConfig: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthMock.mockReturnValue({ user: { id: "u1", username: "ada", displayName: "Ada", role: "owner" } });
  useSwitchMock.mockReturnValue(makeHook());
});

describe("SwitchPanel — states", () => {
  it("renders the calm empty line when not connected", () => {
    useSwitchMock.mockReturnValue(makeHook({ connected: false, status: { ...STATUS, connected: false } }));
    render(<SwitchPanel />);
    expect(screen.getByText(/no managed switch detected/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /re-apply config/i })).not.toBeInTheDocument();
  });

  it("renders a skeleton while loading", () => {
    useSwitchMock.mockReturnValue(makeHook({ isLoading: true, status: null, connected: false }));
    render(<SwitchPanel />);
    expect(screen.getByTestId("switch-skeleton")).toBeInTheDocument();
  });

  it("renders the unreachable error card on a read error", () => {
    useSwitchMock.mockReturnValue(
      makeHook({ error: new Error("Switch status: 502"), status: null, connected: false }),
    );
    render(<SwitchPanel />);
    expect(screen.getByText(/can't reach the switch/i)).toBeInTheDocument();
  });

  it("renders header model + Auto-managed badge + PoE meter when connected", () => {
    render(<SwitchPanel />);
    expect(screen.getByText(/SM8TAT2SA/)).toBeInTheDocument();
    expect(screen.getByText(/auto-managed/i)).toBeInTheDocument();
    expect(screen.getByText("19.7 W")).toBeInTheDocument();
    // WARP-2165: the model line counts the ports the switch reports. This
    // fixture is two copper ports and no optical bank, so it must not claim
    // the "8-port + 2 SFP" GS1900-10HP layout that used to be hardcoded here.
    expect(screen.getByText(/2-port · firmware/)).toBeInTheDocument();
    expect(screen.queryByText(/\+ \d+ SFP/)).not.toBeInTheDocument();
  });
});

describe("SwitchPanel — layout toggle (interactive)", () => {
  it("defaults to the faceplate and swaps to the port table", () => {
    render(<SwitchPanel />);
    // WARP-2165: the legend describes the ports actually present. This
    // fixture is ports 4 and 7, both copper — it used to assert
    // "copper 1-8 - SFP 9-10" purely because that string was hardcoded,
    // which meant the assertion held no matter what the data said.
    // (Bank-by-bank legend cases live in Faceplate.test.tsx — a bare /SFP/
    // query here also matches the panel header's model line.)
    expect(screen.getByText(/copper 4–7/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /port table/i }));
    // table header column appears; faceplate legend gone
    expect(screen.queryByText(/copper 4–7/)).not.toBeInTheDocument();
  });
});

describe("SwitchPanel — read-only profile reflection (§6)", () => {
  it("reflects flat-lan and does NOT let the user flip the profile", () => {
    render(<SwitchPanel />);
    // The Flat LAN | Segmented control is a reflection, rendered as static
    // status — not interactive buttons.
    const flat = screen.getByText("Flat LAN");
    expect(flat.tagName).not.toBe("BUTTON");
    expect(flat.closest("button")).toBeNull();
    // The blue pending pill is shown in the VLAN view for flat-lan.
    expect(screen.getByText(/isolation pending router setup/i)).toBeInTheDocument();
  });

  it("reflects segmented when the backend reports it", () => {
    useSwitchMock.mockReturnValue(
      makeHook({
        status: { ...STATUS, vlan_profile: "segmented" },
        vlans: [
          { vlan_id: 1, name: "LAN", isolated: false, ports: [4] },
          { vlan_id: 100, name: "Cameras", isolated: true, ports: [7] },
        ],
      }),
    );
    render(<SwitchPanel />);
    expect(screen.getByText("isolated")).toBeInTheDocument();
    expect(screen.queryByText(/isolation pending router setup/i)).not.toBeInTheDocument();
  });
});

describe("SwitchPanel — RBAC", () => {
  it("hides the Re-apply button for a member (non-owner/admin)", () => {
    useAuthMock.mockReturnValue({ user: { id: "u2", username: "bob", displayName: "Bob", role: "family" } });
    render(<SwitchPanel />);
    expect(screen.queryByRole("button", { name: /re-apply config/i })).not.toBeInTheDocument();
  });

  it("shows the Re-apply button for an admin", () => {
    useAuthMock.mockReturnValue({ user: { id: "u3", username: "cara", displayName: "Cara", role: "admin" } });
    render(<SwitchPanel />);
    expect(screen.getByRole("button", { name: /re-apply config/i })).toBeInTheDocument();
  });
});

describe("SwitchPanel — confirm-on-write flow", () => {
  it("opens a port drawer, fires an action, confirms, and calls the matching write", async () => {
    const togglePoe = vi.fn().mockResolvedValue(undefined);
    useSwitchMock.mockReturnValue(makeHook({ togglePoe }));
    render(<SwitchPanel />);

    // Open the drawer for the AP via the faceplate cell.
    fireEvent.click(screen.getByTitle("Living-room AP"));
    // Cut PoE action.
    const cutPoe = await screen.findByRole("button", { name: /cut poe power/i });
    fireEvent.click(cutPoe);

    // Confirm dialog with blast radius + the orange Write chip + Confirm & apply.
    const confirm = await screen.findByRole("button", { name: /confirm & apply/i });
    expect(screen.getByText(/powered over this port/i)).toBeInTheDocument();
    expect(screen.getByText(/write · confirm to apply/i)).toBeInTheDocument();
    fireEvent.click(confirm);

    await waitFor(() => expect(togglePoe).toHaveBeenCalledWith(4, false));
  });

  it("surfaces an error toast when a write fails — never silent", async () => {
    const togglePoe = vi.fn().mockRejectedValue(new Error("Switch poe: 500"));
    useSwitchMock.mockReturnValue(makeHook({ togglePoe }));
    render(<SwitchPanel />);

    fireEvent.click(screen.getByTitle("Living-room AP"));
    fireEvent.click(await screen.findByRole("button", { name: /cut poe power/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm & apply/i }));

    await waitFor(() => expect(togglePoe).toHaveBeenCalledWith(4, false));
    // The failure is surfaced as a friendly error toast (the gap UX flagged),
    // not swallowed silently.
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.any(String), "error"));
  });

  it("re-apply config opens a confirm and calls reapplyConfig", async () => {
    const reapplyConfig = vi.fn().mockResolvedValue(undefined);
    useSwitchMock.mockReturnValue(makeHook({ reapplyConfig }));
    render(<SwitchPanel />);
    fireEvent.click(screen.getByRole("button", { name: /re-apply config/i }));
    const confirm = await screen.findByRole("button", { name: /confirm & apply/i });
    fireEvent.click(confirm);
    await waitFor(() => expect(reapplyConfig).toHaveBeenCalledTimes(1));
  });
});

describe("SwitchPanel — group label", () => {
  it("wraps the panel in a Switch-labelled net-group", () => {
    render(<SwitchPanel />);
    expect(screen.getByRole("heading", { name: "Switch", level: 4 })).toBeInTheDocument();
  });
});
