/**
 * BandSteeringCard — the "no fake toggle" honesty contract (WARP-1703).
 *
 * Pins the supported/unsupported fork: with no approved Droplet AP online the
 * card shows an inert "Off" pill + the calm "not available" line and NO
 * toggle; when supported it shows a real switch reflecting the AP's state.
 * (Mirror of the routing AP_BAND_STEERING_UNAVAILABLE 422 path — the UpnpCard
 * pattern.) A failed write surfaces as a role="alert" banner.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/lib/api", () => ({
  fetchBandSteering: vi.fn(),
  setBandSteering: vi.fn(),
  fetchNetworkOperation: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));

import {
  fetchBandSteering,
  setBandSteering,
  fetchNetworkOperation,
  confirmNetworkCommand,
} from "@/lib/api";
import { BandSteeringCard } from "../BandSteeringCard";

function renderCard() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <BandSteeringCard />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BandSteeringCard reflects the AP's real state", () => {
  it("unsupported → no toggle, honest copy, inert Off pill", async () => {
    (fetchBandSteering as ReturnType<typeof vi.fn>).mockResolvedValue({
      supported: false,
      enabled: false,
    });
    renderCard();
    await waitFor(() =>
      expect(
        screen.getByText(/needs an approved droplet access point/i),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Off")).toBeTruthy();
  });

  it("supported + off → real toggle, aria-checked false", async () => {
    (fetchBandSteering as ReturnType<typeof vi.fn>).mockResolvedValue({
      supported: true,
      enabled: false,
    });
    renderCard();
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByText(/devices stay on whichever band they first joined/i),
    ).toBeTruthy();
  });

  it("supported + on → toggle on + steering copy", async () => {
    (fetchBandSteering as ReturnType<typeof vi.fn>).mockResolvedValue({
      supported: true,
      enabled: true,
    });
    renderCard();
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByText(/steered to the best band automatically/i),
    ).toBeTruthy();
  });
});

describe("BandSteeringCard write path", () => {
  it("a failed write surfaces a role=alert error banner", async () => {
    (fetchBandSteering as ReturnType<typeof vi.fn>).mockResolvedValue({
      supported: true,
      enabled: false,
    });
    (setBandSteering as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("The access point didn't answer."),
    );
    renderCard();
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(
      /didn't answer/i,
    );
    expect(setBandSteering).toHaveBeenCalledWith(true);
  });

  // WARP-1703 review: the write is Tier 2 (flipping it renames the 5 GHz SSID
  // and drops every device on that band), so the orchestrator answers 202 and
  // the card must complete the two-step before anything reaches the APs.
  it("a Tier-2 write confirms the token, then polls the operation", async () => {
    (fetchBandSteering as ReturnType<typeof vi.fn>).mockResolvedValue({
      supported: true,
      enabled: false,
    });
    (setBandSteering as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "confirmation_required",
      operation: "set_ap_band_steering",
      tier: 2,
      confirmationToken: "tok-bs",
      expiresIn: 60,
    });
    (confirmNetworkCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      operationId: "op-bs",
    });
    (fetchNetworkOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "applied",
    });
    renderCard();
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() =>
      expect(confirmNetworkCommand).toHaveBeenCalledWith(
        "tok-bs",
        "set_ap_band_steering",
      ),
    );
    await waitFor(() =>
      expect(fetchNetworkOperation).toHaveBeenCalledWith("op-bs"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
