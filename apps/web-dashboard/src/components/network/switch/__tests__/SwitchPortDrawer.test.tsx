/**
 * SwitchPortDrawer — the §6 camera-safe gate, the protected uplink, the
 * Write safety chip, and the RBAC action-hiding all live here.
 *
 * Reuses the shared <Dialog placement="right"> primitive; framer-motion's
 * reduced-motion gate is stubbed so the drawer mounts synchronously.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SwitchPort } from "@/lib/types/switch";
import { SwitchPortDrawer } from "../SwitchPortDrawer";

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

const camera: SwitchPort = {
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
  device: { mac: "00:c0:f2:00:00:07", ip: "192.168.20.47", name: "Garage cam" },
};

const ap: SwitchPort = {
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
};

const uplink: SwitchPort = {
  port: 9,
  label: "1/9",
  name: "Uplink · rack-1",
  role: "uplink",
  link_up: true,
  speed: "10 Gb",
  is_sfp: true,
  vlan: 1,
  vlan_name: "trunk",
  poe: null,
  status: "online",
};

function noop() {}

const baseProps = {
  profile: "flat-lan" as const,
  canWrite: true,
  protectedPort: 9,
  onClose: noop,
  onAction: noop,
};

describe("SwitchPortDrawer — camera-safe gate (§6)", () => {
  it("disables Change VLAN for a camera in flat-lan with the explanatory sub-copy", () => {
    render(<SwitchPortDrawer port={camera} {...baseProps} />);
    const changeVlan = screen.getByRole("button", { name: /change vlan/i });
    expect(changeVlan).toBeDisabled();
    expect(screen.getByText(/isolation available after router setup/i)).toBeInTheDocument();
  });

  it("enables Change VLAN for a camera once segmented", () => {
    render(<SwitchPortDrawer port={{ ...camera, vlan: 100, vlan_name: "Cameras" }} {...baseProps} profile="segmented" />);
    expect(screen.getByRole("button", { name: /change vlan/i })).toBeEnabled();
  });

  it("enables Change VLAN for a non-camera port in flat-lan", () => {
    render(<SwitchPortDrawer port={ap} {...baseProps} />);
    expect(screen.getByRole("button", { name: /change vlan/i })).toBeEnabled();
  });
});

describe("SwitchPortDrawer — protected uplink", () => {
  it("shows no actions and the locked note for the protected port", () => {
    render(<SwitchPortDrawer port={uplink} {...baseProps} />);
    expect(screen.queryByRole("button", { name: /change vlan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /poe/i })).not.toBeInTheDocument();
    expect(screen.getByText(/port edits are blocked to keep the appliance reachable/i)).toBeInTheDocument();
  });
});

describe("SwitchPortDrawer — RBAC", () => {
  it("hides the action list for a member (non-owner/admin) but keeps the facts", () => {
    render(<SwitchPortDrawer port={ap} {...baseProps} canWrite={false} />);
    expect(screen.queryByRole("button", { name: /change vlan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /poe/i })).not.toBeInTheDocument();
    // Facts still render — reads are for everyone.
    expect(screen.getByText("Living-room AP")).toBeInTheDocument();
  });

  it("shows the action list for an owner/admin", () => {
    render(<SwitchPortDrawer port={ap} {...baseProps} canWrite />);
    expect(screen.getByRole("button", { name: /change vlan/i })).toBeInTheDocument();
  });
});

describe("SwitchPortDrawer — Write safety chip + footer", () => {
  it("renders a Write safety chip on each admin action", () => {
    render(<SwitchPortDrawer port={ap} {...baseProps} />);
    const chips = screen.getAllByText("Write");
    // Change VLAN · PoE · enable/disable → three chips.
    expect(chips.length).toBe(3);
  });

  it("renders the reads-stay-on-LAN footer", () => {
    render(<SwitchPortDrawer port={ap} {...baseProps} />);
    expect(screen.getByText(/reads stay on lan · every write is logged to activity/i)).toBeInTheDocument();
  });
});

describe("SwitchPortDrawer — action dispatch", () => {
  it("fires onAction with the vlan kind + target vlan when Change VLAN is clicked", () => {
    const onAction = vi.fn();
    render(<SwitchPortDrawer port={ap} {...baseProps} onAction={onAction} />);
    screen.getByRole("button", { name: /change vlan/i }).click();
    expect(onAction).toHaveBeenCalledTimes(1);
    const arg = onAction.mock.calls[0][0];
    expect(arg.kind).toBe("vlan");
    expect(arg.port.port).toBe(4);
    // flat-lan AP on VLAN 1 → moving to 100.
    expect(arg.vlanId).toBe(100);
  });
});
