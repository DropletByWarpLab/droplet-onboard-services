/**
 * UpnpCard — the "no fake toggle" honesty contract.
 *
 * Pins the available/unavailable fork: when miniupnpd isn't on the box the card
 * shows an inert "Off" pill + the calm "not available" line and NO toggle; when
 * it is available it shows a real toggle, and when also enabled the port-exposure
 * warning. (Mirror of the routing UPNP_UNAVAILABLE 422 path.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/lib/api", () => ({
  fetchUpnp: vi.fn(),
  setUpnp: vi.fn(),
  confirmNetworkCommand: vi.fn(),
  fetchNetworkOperation: vi.fn(),
}));

import { fetchUpnp } from "@/lib/api";
import { UpnpCard } from "../UpnpCard";

function renderCard() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <UpnpCard />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("UpnpCard reflects the box's real state", () => {
  it("unavailable → no toggle, honest copy, no warning", async () => {
    (fetchUpnp as ReturnType<typeof vi.fn>).mockResolvedValue({ available: false, enabled: false });
    renderCard();
    await waitFor(() =>
      expect(screen.getByText(/not available on this droplet/i)).toBeTruthy(),
    );
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.queryByText(/expose devices/i)).toBeNull();
  });

  it("available + disabled → real toggle, no warning", async () => {
    (fetchUpnp as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true, enabled: false });
    renderCard();
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/expose devices/i)).toBeNull();
  });

  it("available + enabled → toggle on + port-exposure warning", async () => {
    (fetchUpnp as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true, enabled: true });
    renderCard();
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByText(/expose devices on your network to the internet/i),
    ).toBeTruthy();
  });
});
