/**
 * ApWifiCard — the access point's own network name + password (WARP-1712).
 *
 * Pins the four things that make this card trustworthy:
 *   * the honesty fork — no approved Droplet AP online means calm read-only
 *     copy and NO form, never a fake one (the UpnpCard / BandSteeringCard
 *     contract);
 *   * the form seeds from the AP's LIVE values, including the per-unit
 *     passphrase, which is revealable rather than ssh-only;
 *   * validation refuses what the AP's hostapd would refuse, before any write;
 *   * the tier flow — a name-only save applies immediately (Tier 1), a save
 *     carrying a password goes through the 202 + confirm arm (Tier 2), and
 *     only what actually CHANGED is sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/lib/api", () => ({
  fetchApWifi: vi.fn(),
  setApWifi: vi.fn(),
  fetchNetworkOperation: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));

import {
  fetchApWifi,
  setApWifi,
  fetchNetworkOperation,
  confirmNetworkCommand,
} from "@/lib/api";
import { ApWifiCard } from "../ApWifiCard";

const mockFetch = fetchApWifi as ReturnType<typeof vi.fn>;
const mockSet = setApWifi as ReturnType<typeof vi.fn>;
const mockOp = fetchNetworkOperation as ReturnType<typeof vi.fn>;
const mockConfirm = confirmNetworkCommand as ReturnType<typeof vi.fn>;

const SUPPORTED = {
  supported: true,
  ssid: "Droplet",
  fiveGhzSsid: "Droplet",
  key: "per-unit-psk",
  encryption: "psk2+ccmp",
  bandSteering: true,
  apCount: 1,
  inSync: true,
};

function renderCard() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ApWifiCard />
    </SWRConfig>,
  );
}

const ssidInput = () => screen.getByLabelText(/network name/i) as HTMLInputElement;
const pwInput = () => screen.getByLabelText("Wi-Fi password") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: /save wi-fi settings/i });

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ...SUPPORTED });
  mockSet.mockResolvedValue({ status: "ok", operationId: null, ssid: "Droplet" });
  mockOp.mockResolvedValue({ state: "applied" });
});

describe("honesty fork", () => {
  it("shows calm read-only copy and NO form when no AP is online", async () => {
    mockFetch.mockResolvedValue({
      supported: false,
      ssid: null,
      fiveGhzSsid: null,
      key: null,
      encryption: null,
      bandSteering: null,
      apCount: 0,
      inSync: true,
    });
    renderCard();
    await waitFor(() =>
      expect(
        screen.getByText(/needs an approved droplet access point/i),
      ).toBeTruthy(),
    );
    expect(screen.queryByLabelText(/network name/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /save wi-fi settings/i })).toBeNull();
  });

  it("renders the form once an AP is online", async () => {
    renderCard();
    await waitFor(() => expect(ssidInput()).toBeTruthy());
    expect(saveButton()).toBeTruthy();
  });
});

describe("live values from the AP", () => {
  it("seeds the form from the AP rather than a stored copy", async () => {
    mockFetch.mockResolvedValue({ ...SUPPORTED, ssid: "Living Room" });
    renderCard();
    await waitFor(() => expect(ssidInput().value).toBe("Living Room"));
    expect(pwInput().value).toBe("per-unit-psk");
  });

  it("keeps the passphrase masked until it is revealed", async () => {
    renderCard();
    await waitFor(() => expect(pwInput()).toBeTruthy());
    expect(pwInput().type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: /show wi-fi password/i }));
    expect(pwInput().type).toBe("text");
    // The value was there all along — an operator never needs ssh for it.
    expect(pwInput().value).toBe("per-unit-psk");
  });

  it("names the 5 GHz network when band steering has split it", async () => {
    mockFetch.mockResolvedValue({
      ...SUPPORTED,
      ssid: "Droplet",
      fiveGhzSsid: "Droplet-5g",
      bandSteering: false,
    });
    renderCard();
    await waitFor(() => expect(screen.getByText("Droplet-5g")).toBeTruthy());
  });

  it("warns — rather than silently picking one — when APs disagree", async () => {
    mockFetch.mockResolvedValue({
      ...SUPPORTED,
      ssid: null,
      apCount: 2,
      inSync: false,
    });
    renderCard();
    await waitFor(() =>
      expect(
        screen.getByText(/aren't all broadcasting the same network name/i),
      ).toBeTruthy(),
    );
  });

  it("does not clobber what the operator is typing on a background refresh", async () => {
    renderCard();
    await waitFor(() => expect(ssidInput().value).toBe("Droplet"));
    fireEvent.change(ssidInput(), { target: { value: "Half-typed" } });
    mockFetch.mockResolvedValue({ ...SUPPORTED, ssid: "Changed Elsewhere" });
    // The seeding effect must stay out of the way while the form is dirty.
    await new Promise((r) => setTimeout(r, 20));
    expect(ssidInput().value).toBe("Half-typed");
  });
});

describe("validation refuses what the AP would refuse", () => {
  it("rejects an empty name and writes nothing", async () => {
    renderCard();
    await waitFor(() => expect(ssidInput()).toBeTruthy());
    fireEvent.change(ssidInput(), { target: { value: "   " } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/enter a network name/i);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects a too-short passphrase and writes nothing", async () => {
    renderCard();
    await waitFor(() => expect(pwInput()).toBeTruthy());
    fireEvent.change(pwInput(), { target: { value: "short" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/at least 8 characters/i);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects a name that is 32 characters but over 32 BYTES", async () => {
    renderCard();
    await waitFor(() => expect(ssidInput()).toBeTruthy());
    // 17 accented characters = 34 UTF-8 octets; the 802.11 element is 32.
    fireEvent.change(ssidInput(), { target: { value: "é".repeat(17) } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("save flow", () => {
  it("sends ONLY the changed name — keeping it Tier 1", async () => {
    renderCard();
    await waitFor(() => expect(ssidInput().value).toBe("Droplet"));
    fireEvent.change(ssidInput(), { target: { value: "Living Room" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockSet).toHaveBeenCalled());
    // The unchanged passphrase must NOT ride along — re-sending it would drag
    // a rename into the Tier-2 confirm arm for no reason.
    expect(mockSet).toHaveBeenCalledWith({ ssid: "Living Room" });
  });

  it("sends only the passphrase when only it changed", async () => {
    renderCard();
    await waitFor(() => expect(pwInput().value).toBe("per-unit-psk"));
    fireEvent.change(pwInput(), { target: { value: "brand-new-psk" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockSet).toHaveBeenCalled());
    expect(mockSet).toHaveBeenCalledWith({ key: "brand-new-psk" });
  });

  it("auto-confirms the Tier-2 arm and polls the operation", async () => {
    mockSet.mockResolvedValue({
      status: "confirmation_required",
      operation: "set_ap_wifi_password",
      confirmationToken: "tok-1",
    });
    mockConfirm.mockResolvedValue({ operationId: "op-9" });

    renderCard();
    await waitFor(() => expect(pwInput().value).toBe("per-unit-psk"));
    fireEvent.change(pwInput(), { target: { value: "brand-new-psk" } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(mockConfirm).toHaveBeenCalledWith("tok-1", "set_ap_wifi_password"),
    );
    await waitFor(() => expect(mockOp).toHaveBeenCalledWith("op-9"));
  });

  it("confirms success and tells the operator what to rejoin", async () => {
    mockSet.mockResolvedValue({
      status: "ok",
      operationId: "op-1",
      ssid: "Split",
      fiveGhzSsid: "Split-5g",
    });
    renderCard();
    await waitFor(() => expect(ssidInput()).toBeTruthy());
    fireEvent.change(ssidInput(), { target: { value: "Split" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/Split/);
    expect(text).toMatch(/Split-5g/);
  });

  it("surfaces a rollback as an alert rather than a silent success", async () => {
    mockSet.mockResolvedValue({ status: "ok", operationId: "op-2" });
    mockOp.mockResolvedValue({
      state: "rolled_back",
      reason: "The access point reverted the change.",
    });
    renderCard();
    await waitFor(() => expect(ssidInput()).toBeTruthy());
    fireEvent.change(ssidInput(), { target: { value: "Nope" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/reverted/i);
  });

  it("surfaces a write failure as an alert", async () => {
    mockSet.mockRejectedValue(new Error("No access point is online."));
    renderCard();
    await waitFor(() => expect(ssidInput()).toBeTruthy());
    fireEvent.change(ssidInput(), { target: { value: "Nope" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/no access point is online/i);
  });
});
