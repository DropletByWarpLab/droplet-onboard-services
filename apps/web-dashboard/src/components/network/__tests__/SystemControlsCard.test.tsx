/**
 * SystemControlsCard — hostname (Tier 2) + NTP (Tier 1) are real, editable;
 * status-LED + regulatory-domain render honest "not available" rows on shapes
 * that can't drive them.
 *
 * Pins:
 *  - hydrates hostname + NTP + the read-only country value;
 *  - saving a hostname runs the Tier-2 confirm dance with the new value;
 *  - toggling NTP calls setNtp immediately (no confirm);
 *  - status-LED + country render an inert "not available" treatment (no live
 *    control) when supported/editable are false — no fake control.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/lib/api", () => ({
  fetchSystemControls: vi.fn(),
  setHostname: vi.fn(),
  setNtp: vi.fn(),
  confirmNetworkCommand: vi.fn(),
  fetchNetworkOperation: vi.fn(),
}));

import {
  fetchSystemControls,
  setHostname,
  setNtp,
  confirmNetworkCommand,
  fetchNetworkOperation,
} from "@/lib/api";
import { SystemControlsCard } from "../SystemControlsCard";

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function renderCard() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SystemControlsCard />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  asMock(fetchSystemControls).mockResolvedValue({
    hostname: "droplet-rack-01",
    ntpEnabled: true,
    statusLed: { supported: false, enabled: false },
    country: { value: "US", editable: false },
  });
});

describe("SystemControlsCard", () => {
  it("hydrates hostname, NTP state, and the read-only country value", async () => {
    renderCard();
    await waitFor(() =>
      expect((screen.getByLabelText(/hostname/i) as HTMLInputElement).value).toBe(
        "droplet-rack-01",
      ),
    );
    expect(screen.getByRole("switch", { name: /time sync|ntp/i }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText("US")).toBeTruthy();
  });

  it("saving a new hostname runs the Tier-2 confirm dance", async () => {
    asMock(setHostname).mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-1",
      operation: "set_hostname",
    });
    asMock(confirmNetworkCommand).mockResolvedValue({ operationId: "op-1" });
    asMock(fetchNetworkOperation).mockResolvedValue({ state: "applied" });

    renderCard();
    await waitFor(() =>
      expect((screen.getByLabelText(/hostname/i) as HTMLInputElement).value).toBe(
        "droplet-rack-01",
      ),
    );
    fireEvent.change(screen.getByLabelText(/hostname/i), {
      target: { value: "studio-droplet" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save hostname/i }));

    await waitFor(() => expect(setHostname).toHaveBeenCalledWith("studio-droplet"));
    await waitFor(() =>
      expect(confirmNetworkCommand).toHaveBeenCalledWith("tok-1", "set_hostname"),
    );
  });

  it("toggling NTP calls setNtp immediately (Tier 1, no confirm)", async () => {
    asMock(setNtp).mockResolvedValue({ status: "ok" });
    renderCard();
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /time sync|ntp/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("switch", { name: /time sync|ntp/i }));
    await waitFor(() => expect(setNtp).toHaveBeenCalledWith(false));
    expect(confirmNetworkCommand).not.toHaveBeenCalled();
  });

  it("status-LED + regulatory-domain render honest 'not available' rows", async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText("Status light")).toBeTruthy());
    // No live LED switch on the single-box shape (gated).
    expect(screen.queryByRole("switch", { name: /status light/i })).toBeNull();
    expect(screen.getAllByText(/not available on this appliance/i).length).toBeGreaterThan(0);
  });
});
