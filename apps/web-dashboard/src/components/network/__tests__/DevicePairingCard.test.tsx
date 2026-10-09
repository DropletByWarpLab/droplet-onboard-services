/**
 * DevicePairingCard — the switch and AP roles (ADR-071 slice C).
 *
 * The router role is pinned in RouterPairingCard.test.tsx (it is a wrapper over
 * this card). Here: the ADR §2.2 copy with the device role substituted, which
 * read / write each role calls (an AP per MAC), that an AP is offered Pair on an
 * open window alone while the switch needs AUTH + open, and that the card
 * degrades to nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({ useAuth: () => useAuthMock() }));

const api = {
  fetchRouterPairing: vi.fn(),
  pairRouter: vi.fn(),
  persistRouterPairing: vi.fn(),
  fetchSwitchPairing: vi.fn(),
  pairSwitch: vi.fn(),
  persistSwitchPairing: vi.fn(),
  fetchApPairing: vi.fn(),
  pairAp: vi.fn(),
  persistApPairing: vi.fn(),
};
vi.mock("@/lib/api", () => ({
  fetchRouterPairing: (...a: unknown[]) => api.fetchRouterPairing(...a),
  pairRouter: (...a: unknown[]) => api.pairRouter(...a),
  persistRouterPairing: (...a: unknown[]) => api.persistRouterPairing(...a),
  fetchSwitchPairing: (...a: unknown[]) => api.fetchSwitchPairing(...a),
  pairSwitch: (...a: unknown[]) => api.pairSwitch(...a),
  persistSwitchPairing: (...a: unknown[]) => api.persistSwitchPairing(...a),
  fetchApPairing: (...a: unknown[]) => api.fetchApPairing(...a),
  pairAp: (...a: unknown[]) => api.pairAp(...a),
  persistApPairing: (...a: unknown[]) => api.persistApPairing(...a),
}));

import { DevicePairingCard, type DevicePairingCardProps } from "../DevicePairingCard";
import type { DevicePairingView } from "@/lib/api";

const BOX = "0123456789abcdef" + "f".repeat(48);
const MAC = "AA:BB:CC:DD:EE:01";

const view = (over: Partial<DevicePairingView> = {}): DevicePairingView => ({
  available: true,
  state: "open",
  windowEndsAt: "2026-10-07T00:00:00Z",
  pairedBox: null,
  pairedElsewhere: false,
  pendingPersist: false,
  routerErrorCode: "AUTH",
  host: "192.168.9.2",
  model: "GS1900-10HP",
  ...over,
});

function renderCard(props: DevicePairingCardProps) {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DevicePairingCard {...props} />
    </SWRConfig>,
  );
}

async function confirmPair() {
  fireEvent.click(await screen.findByRole("button", { name: "Pair" }));
  const confirm = (await screen.findAllByRole("button", { name: "Pair" })).find((b) => b.closest('[role="dialog"]'))!;
  fireEvent.click(confirm);
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthMock.mockReturnValue({ user: { role: "owner" } });
});

describe("switch role", () => {
  it("offers Pair / Not now with the switch copy when its own read says AUTH + open", async () => {
    api.fetchSwitchPairing.mockResolvedValue(view());
    renderCard({ role: "switch" });
    expect(await screen.findByText(/Switch GS1900-10HP at 192\.168\.9\.2 is ready to pair\./)).toBeTruthy();
    expect(screen.getByText(/gives this Droplet control of the switch's network settings/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pair" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    expect(api.fetchRouterPairing).not.toHaveBeenCalled();
    expect(api.fetchApPairing).not.toHaveBeenCalled();
  });

  it("Pair confirms first, then calls the SWITCH write (never the router's)", async () => {
    api.fetchSwitchPairing.mockResolvedValue(view());
    api.pairSwitch.mockResolvedValue({ ok: true, persisted: true, host: "192.168.9.2" });
    const onChanged = vi.fn();
    renderCard({ role: "switch", onChanged });
    fireEvent.click(await screen.findByRole("button", { name: "Pair" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Pair this switch?")).toBeTruthy();
    expect(api.pairSwitch).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Pair" }).find((b) => b.closest('[role="dialog"]'))!);
    await waitFor(() => expect(api.pairSwitch).toHaveBeenCalledTimes(1));
    expect(api.pairRouter).not.toHaveBeenCalled();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("a refused claim keeps the dialog open and shows the switch's reason", async () => {
    api.fetchSwitchPairing.mockResolvedValue(view());
    api.pairSwitch.mockResolvedValue({
      ok: false,
      persisted: false,
      code: "PAIR_WINDOW_CLOSED",
      error: "The switch is not accepting a pairing right now. Press the switch's button, then try again.",
    });
    renderCard({ role: "switch" });
    await confirmPair();
    expect(await screen.findByText(/The switch is not accepting a pairing right now/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("is not offered while the switch is healthy, even with a window open", async () => {
    api.fetchSwitchPairing.mockResolvedValue(view({ routerErrorCode: null }));
    renderCard({ role: "switch" });
    await waitFor(() => expect(api.fetchSwitchPairing).toHaveBeenCalled());
    expect(screen.queryByText(/ready to pair/)).toBeNull();
  });

  it("is not offered when the window is closed", async () => {
    api.fetchSwitchPairing.mockResolvedValue(view({ state: "closed" }));
    renderCard({ role: "switch" });
    await waitFor(() => expect(api.fetchSwitchPairing).toHaveBeenCalled());
    expect(screen.queryByText(/ready to pair/)).toBeNull();
  });

  it("paired elsewhere: the first 16 hex and the switch's button, with no action", async () => {
    api.fetchSwitchPairing.mockResolvedValue(
      view({ state: "paired", pairedBox: BOX, pairedElsewhere: true, routerErrorCode: "PAIRED_ELSEWHERE" }),
    );
    renderCard({ role: "switch" });
    const node = await screen.findByTestId("switch-pairing-elsewhere");
    expect(node.textContent).toContain("This switch is paired to another device");
    expect(node.textContent).toContain("0123456789abcdef…");
    expect(node.textContent).not.toContain(BOX);
    expect(node.textContent).toContain("Press the switch's button to re-pair.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("retry: 'paired but not saved' re-runs only the switch save", async () => {
    api.fetchSwitchPairing.mockResolvedValue(view({ pendingPersist: true, routerErrorCode: null, state: "paired" }));
    api.persistSwitchPairing.mockResolvedValue({ ok: true, persisted: true });
    renderCard({ role: "switch" });
    expect(await screen.findByTestId("switch-pairing-retry")).toBeTruthy();
    expect(screen.getByText(/The switch is connected now\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.persistSwitchPairing).toHaveBeenCalledTimes(1));
    expect(api.pairSwitch).not.toHaveBeenCalled();
    expect(api.persistRouterPairing).not.toHaveBeenCalled();
  });

  it("a family member sees the offer with no write button", async () => {
    useAuthMock.mockReturnValue({ user: { role: "family" } });
    api.fetchSwitchPairing.mockResolvedValue(view());
    renderCard({ role: "switch" });
    expect(await screen.findByText(/is ready to pair/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pair" })).toBeNull();
  });

  it("renders nothing when the switch service has no pairing surface or the read fails", async () => {
    api.fetchSwitchPairing.mockResolvedValue(view({ available: false, state: null }));
    renderCard({ role: "switch" });
    await waitFor(() => expect(api.fetchSwitchPairing).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("inline variant drops the card chrome", async () => {
    api.fetchSwitchPairing.mockResolvedValue(view());
    renderCard({ role: "switch", variant: "inline" });
    const node = await screen.findByTestId("switch-pairing-offer");
    expect(node.className).not.toContain("card");
  });
});

describe("ap role", () => {
  const apView = (over: Partial<DevicePairingView> = {}) =>
    view({ routerErrorCode: null, host: "192.168.9.42", model: null, ...over });

  it("reads THAT AP and offers Pair on an open window alone, naming the model from the list row", async () => {
    api.fetchApPairing.mockResolvedValue(apView());
    renderCard({ role: "ap", mac: MAC, model: "Zyxel NWA50BE" });
    expect(await screen.findByText(/Access point Zyxel NWA50BE at 192\.168\.9\.42 is ready to pair\./)).toBeTruthy();
    expect(screen.getByText(/control of the access point's network settings/i)).toBeTruthy();
    expect(api.fetchApPairing).toHaveBeenCalledWith(MAC);
  });

  it("falls back to a model-less title when nobody knows the model", async () => {
    api.fetchApPairing.mockResolvedValue(apView());
    renderCard({ role: "ap", mac: MAC });
    expect(await screen.findByText(/Access point at 192\.168\.9\.42 is ready to pair\./)).toBeTruthy();
  });

  it("Pair confirms first and then pairs THAT mac", async () => {
    api.fetchApPairing.mockResolvedValue(apView());
    api.pairAp.mockResolvedValue({ ok: true, persisted: true, host: "192.168.9.42" });
    renderCard({ role: "ap", mac: MAC });
    fireEvent.click(await screen.findByRole("button", { name: "Pair" }));
    expect(await screen.findByText("Pair this access point?")).toBeTruthy();
    expect(api.pairAp).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Pair" }).find((b) => b.closest('[role="dialog"]'))!);
    await waitFor(() => expect(api.pairAp).toHaveBeenCalledWith(MAC));
  });

  it("claimed but not saved flips the card to Retry, which re-runs only the AP save", async () => {
    api.fetchApPairing.mockResolvedValue(apView());
    api.pairAp.mockResolvedValue({ ok: true, persisted: false, host: "192.168.9.42" });
    api.persistApPairing.mockResolvedValue({ ok: true, persisted: true });
    renderCard({ role: "ap", mac: MAC });
    await confirmPair();
    expect(await screen.findByText(/Paired, but the password could not be saved — it will be lost on the next restart/)).toBeTruthy();
    expect(screen.getByText(/The access point is connected now\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.persistApPairing).toHaveBeenCalledWith(MAC));
  });

  it.each(["closed", "paired", "unknown"] as const)("is not offered when the AP's window is %s", async (state) => {
    api.fetchApPairing.mockResolvedValue(apView({ state }));
    renderCard({ role: "ap", mac: MAC });
    await waitFor(() => expect(api.fetchApPairing).toHaveBeenCalled());
    expect(screen.queryByText(/ready to pair/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("paired elsewhere names the access point and offers no action", async () => {
    api.fetchApPairing.mockResolvedValue(
      apView({ state: "paired", pairedBox: BOX, pairedElsewhere: true, routerErrorCode: "PAIRED_ELSEWHERE" }),
    );
    renderCard({ role: "ap", mac: MAC });
    const node = await screen.findByTestId("ap-pairing-elsewhere");
    expect(node.textContent).toContain("This access point is paired to another device");
    expect(node.textContent).toContain("Press the access point's button to re-pair.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("two APs poll their own keys, so one AP's offer never shows on the other", async () => {
    api.fetchApPairing.mockImplementation(async (mac: string) =>
      mac === MAC ? apView() : apView({ state: "closed" }),
    );
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DevicePairingCard role="ap" mac={MAC} />
        <DevicePairingCard role="ap" mac="AA:BB:CC:DD:EE:02" />
      </SWRConfig>,
    );
    await waitFor(() => expect(api.fetchApPairing).toHaveBeenCalledWith("AA:BB:CC:DD:EE:02"));
    expect(await screen.findAllByText(/is ready to pair/)).toHaveLength(1);
  });
});

describe("router role through the generic card", () => {
  it("an explicit errorCode wins over the card's own read (the page knows best)", async () => {
    api.fetchRouterPairing.mockResolvedValue(view({ routerErrorCode: null, host: "192.168.9.1", model: "RB5009" }));
    renderCard({ role: "router", errorCode: "AUTH" });
    expect(await screen.findByText(/Router RB5009 at 192\.168\.9\.1 is ready to pair\./)).toBeTruthy();
  });
});
