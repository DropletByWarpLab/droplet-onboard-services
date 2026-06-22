/**
 * InterfacesTable — read-only enumeration of every configured interface.
 *
 * Pins:
 *  - a live interface renders its name/device/proto/address/zone + an "up" chip;
 *  - a present:false interface renders an honest "not on this box" state, NOT a
 *    fabricated "down" row;
 *  - a null zone/address renders a placeholder, never a made-up value;
 *  - the empty enumeration renders a calm empty state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/lib/api", () => ({
  fetchInterfaces: vi.fn(),
}));

import { fetchInterfaces } from "@/lib/api";
import { InterfacesTable } from "../InterfacesTable";

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function renderTable() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <InterfacesTable />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("InterfacesTable", () => {
  it("renders a live interface row with its real fields", async () => {
    asMock(fetchInterfaces).mockResolvedValue([
      { name: "lan0", device: "br-lan", proto: "static", address: "10.0.0.1/24", zone: "trusted", up: true, present: true },
    ]);
    renderTable();
    await waitFor(() => expect(screen.getByText("lan0")).toBeTruthy());
    expect(screen.getByText("br-lan")).toBeTruthy();
    expect(screen.getByText("10.0.0.1/24")).toBeTruthy();
    expect(screen.getByText("static")).toBeTruthy();
    expect(screen.getByText("trusted")).toBeTruthy();
    expect(screen.getByText("Up")).toBeTruthy();
  });

  it("renders a present:false interface as 'not on this box', not a fake down row", async () => {
    asMock(fetchInterfaces).mockResolvedValue([
      { name: "wan", device: "eth1", proto: "dhcp", address: null, zone: "external", up: false, present: false },
    ]);
    renderTable();
    await waitFor(() => expect(screen.getByText("wan")).toBeTruthy());
    expect(screen.getByText(/not on this box/i)).toBeTruthy();
  });

  it("renders a placeholder for a null zone, never a fabricated value", async () => {
    asMock(fetchInterfaces).mockResolvedValue([
      { name: "wg0", device: "wgdev", proto: "wireguard", address: "10.13.13.1/24", zone: null, up: true, present: true },
    ]);
    renderTable();
    await waitFor(() => expect(screen.getByText("wg0")).toBeTruthy());
    // a dash placeholder stands in for the unknown zone
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders a calm empty state when there are no interfaces", async () => {
    asMock(fetchInterfaces).mockResolvedValue([]);
    renderTable();
    await waitFor(() => expect(screen.getByText(/no interfaces reported/i)).toBeTruthy());
  });
});
