/**
 * MaintenanceCards — honest, owner-only informational cards for Firmware +
 * Factory reset on the single-box shape.
 *
 * The shipping single-box runs OpenWrt in a container: there is no separate
 * router firmware to flash (sysupgrade has no target) and a container UCI
 * factory-reset would desync the host hostapd AP. So these cards are PURELY
 * INFORMATIONAL — they carry no interactive write, no toggle, no button that
 * mutates the box. They point the owner at the appliance-wide flows instead.
 *
 * Contract pinned here:
 *  - owner sees both cards with the honest copy;
 *  - non-owners see nothing (the whole maintenance surface is owner-scoped,
 *    matching RouterRebootCard);
 *  - there is NO interactive control (no button/switch/role=button) anywhere
 *    in the rendered output — a fabricated "Flash firmware" / "Factory reset"
 *    action would be exactly the no-fake-controls violation we're avoiding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => useAuthMock(),
}));

import { MaintenanceCards } from "../MaintenanceCards";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MaintenanceCards owner-only honest informational surface", () => {
  it("owner sees firmware + factory-reset cards with honest copy", () => {
    useAuthMock.mockReturnValue({ user: { role: "owner" } });
    render(<MaintenanceCards />);
    expect(screen.getByText("Firmware")).toBeTruthy();
    // WARP-1676 (ADR-033): the copy must stay true on BOTH shapes — appliance
    // updates on the all-in-one, external router tooling on edge-router.
    expect(
      screen.getByText(/ships with appliance updates/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/isn't managed from this page/i),
    ).toBeTruthy();
    expect(screen.getByText("Factory reset")).toBeTruthy();
    expect(
      screen.getByText(/Settings.*factory reset for the whole appliance/i),
    ).toBeTruthy();
  });

  it("renders NO interactive control — these are informational, not fake actions", () => {
    useAuthMock.mockReturnValue({ user: { role: "owner" } });
    render(<MaintenanceCards />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("admin (not owner) sees nothing — the surface is owner-scoped", () => {
    useAuthMock.mockReturnValue({ user: { role: "admin" } });
    const { container } = render(<MaintenanceCards />);
    expect(container.firstChild).toBeNull();
  });

  it("family member sees nothing", () => {
    useAuthMock.mockReturnValue({ user: { role: "family" } });
    const { container } = render(<MaintenanceCards />);
    expect(container.firstChild).toBeNull();
  });
});
