/**
 * WARP-992 — ShellPage status chip: appliance identity rendering.
 *
 * The chip (`<host> · <health label>`) named the box from the raw
 * `device.hostname`, which on a real box held the orchestrator CONTAINER ID
 * ("5639146fdc76 · Status unavailable"). The chip must resolve through
 * `boxDisplayHost`: real names render verbatim; a container-id hostname
 * (stale Device row from a pre-fix orchestrator) and the not-yet-loaded
 * state both render the stable LAN name instead.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import type { DeviceInfo } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  // The chip's health readout — not under test here; resolve a stable value.
  fetchSystemHealth: () => Promise.resolve({ status: "ok" }),
}));

const useDeviceMock = vi.fn();
vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => useDeviceMock(),
}));

import { ShellPage } from "@/components/shell/ShellPage";

function mockDevice(hostname: string | null): void {
  const device = hostname
    ? ({
        id: "1",
        deviceId: `droplet-${hostname}`,
        hostname,
        hardwareRev: "linux/x64",
        networkMode: "dhcp",
        ip: "192.168.1.87",
        lastSeen: new Date().toISOString(),
      } as DeviceInfo)
    : null;
  useDeviceMock.mockReturnValue({
    device,
    devices: device ? [device] : [],
    health: null,
    isLoading: false,
    error: null,
  });
}

function renderShell() {
  return render(
    <ShellPage label="Files" ambient={false}>
      <div />
    </ShellPage>,
  );
}

afterEach(() => {
  cleanup();
  useDeviceMock.mockReset();
});

describe("ShellPage status chip (WARP-992)", () => {
  it("renders the canonical box name verbatim", () => {
    mockDevice("aurora-loft");
    renderShell();
    expect(screen.getByText("aurora-loft")).toBeInTheDocument();
  });

  it("masks a leaked container-id hostname to the LAN name", () => {
    mockDevice("5639146fdc76");
    renderShell();
    expect(screen.queryByText("5639146fdc76")).not.toBeInTheDocument();
    expect(screen.getByText("droplet.local")).toBeInTheDocument();
  });

  it("falls back to the LAN name while the device row hasn't loaded", () => {
    mockDevice(null);
    renderShell();
    expect(screen.getByText("droplet.local")).toBeInTheDocument();
  });
});
