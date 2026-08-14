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

function renderCard(props: Parameters<typeof ApWifiCard>[0] = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ApWifiCard {...props} />
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

  /**
   * QA note 3 (WARP-1723 second pass) — `supported` defaults to false, so
   * before the read lands the card ASSERTS "not available" about an access
   * point that is fine. Since WARP-1723 this card mounts only after
   * /api/network/wifi/current resolves, so its own read starts late and an
   * edge-router user sees that flash on every first visit to the Wi-Fi tab.
   */
  it.each(["workspace", "secondary"] as const)(
    "does NOT claim 'not available' while the read is still in flight (%s slot)",
    async (slot) => {
      // A read that never settles — SWR stays isLoading with no data.
      mockFetch.mockReturnValue(new Promise(() => {}));
      renderCard({ slot });

      await waitFor(() =>
        expect(screen.getByText(/checking with your access point/i)).toBeTruthy(),
      );
      expect(
        screen.queryByText(/needs an approved droplet access point/i),
      ).toBeNull();
      // Calm placeholder, not a fake form.
      expect(screen.queryByLabelText(/network name/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /save wi-fi settings/i })).toBeNull();
    },
  );

  /**
   * CHARACTERIZATION — documents CURRENT behaviour, not desired behaviour.
   *
   * In the WORKSPACE slot a resolved `supported: false` is a dead end: the
   * edge-router shape puts the workspace SSID on the access point and nowhere
   * else, so when that AP is a third-party one (or offline), the tab's only
   * workspace editor answers "not available" with no next step and no other
   * surface to send the user to. There is no honest state for a third-party
   * AP today — that is a filed product decision, WARP-1738, which will replace
   * this copy. Pinned so the swap is deliberate and visible in the diff rather
   * than a silent copy change; do NOT "fix" the behaviour here.
   */
  it("workspace slot, resolved supported:false — documents today's dead end (WARP-1738)", async () => {
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
    renderCard({ slot: "workspace" });

    // It keeps the workspace headline — this IS the workspace slot — and then
    // says the workspace Wi-Fi can't be edited at all.
    await waitFor(() => expect(screen.getByText("Wi-Fi settings")).toBeTruthy());
    expect(
      screen.getByText(/needs an approved droplet access point/i),
    ).toBeTruthy();
    // No form, and (today) no route onward for a third-party AP.
    expect(screen.queryByLabelText(/network name/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /save wi-fi settings/i })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("reserves the workspace form's height while resolving (WARP-1726 shrink)", async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const { container } = renderCard({ slot: "workspace" });

    await waitFor(() =>
      expect(screen.getByText(/checking with your access point/i)).toBeTruthy(),
    );
    const card = container.querySelector(".card") as HTMLElement;
    expect(card.style.minHeight).toBe("300px");
  });
});

/**
 * UX blocker 1 (WARP-1723 second pass) — this card occupies two very different
 * slots. In the workspace slot it IS the home network (the edge-router shape
 * hosts the workspace SSID nowhere else), so describing itself as a "coverage
 * extender" told a workspace admin their Wi-Fi wasn't editable here.
 */
describe("slot copy", () => {
  it("workspace slot: names the home network, never a coverage extender", async () => {
    renderCard({ slot: "workspace" });
    await waitFor(() => expect(ssidInput()).toBeTruthy());

    expect(screen.getByText("Wi-Fi settings")).toBeTruthy();
    expect(screen.queryByText("Access point Wi-Fi")).toBeNull();
    expect(screen.getByText(/the network your devices join/i)).toBeTruthy();
    expect(screen.queryByText(/coverage extender/i)).toBeNull();
    // Still honest about which radio restarts.
    expect(screen.getByText(/restarts that radio/i)).toBeTruthy();
  });

  it("default (secondary) slot keeps the original strings verbatim", async () => {
    renderCard();
    await waitFor(() => expect(ssidInput()).toBeTruthy());

    expect(screen.getByText("Access point Wi-Fi")).toBeTruthy();
    expect(screen.queryByText("Wi-Fi settings")).toBeNull();
    expect(
      screen.getByText(
        "The network name and password your coverage extender broadcasts. Saving restarts its radios, so devices on it reconnect.",
      ),
    ).toBeTruthy();
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

  it("still allows a rename when the AP reports no passphrase at all", async () => {
    // An open network (or an image that keys its radios another way) must not
    // leave Save permanently blocked behind a rule for a field it never filled.
    mockFetch.mockResolvedValue({ ...SUPPORTED, key: null });
    renderCard();
    await waitFor(() => expect(ssidInput()).toBeTruthy());
    fireEvent.change(ssidInput(), { target: { value: "Renamed" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockSet).toHaveBeenCalledWith({ ssid: "Renamed" }));
  });

  it("still refuses to shorten an EXISTING passphrase", async () => {
    renderCard();
    await waitFor(() => expect(pwInput().value).toBe("per-unit-psk"));
    fireEvent.change(pwInput(), { target: { value: "" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
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

/**
 * WARP-1733 UX review — this card is the other half of both cross-cutting
 * polish items, because on the edge-router shape it IS the workspace form and
 * therefore mounts in Simple mode too.
 */
describe("WARP-1733 UX polish", () => {
  /**
   * Item B. ShellPage owns the `<h1>`. In the Advanced Wi-Fi tab this card is
   * a subsection (`h3`); in Simple mode the workspace mount is a SIBLING of
   * the `<h2>Internet</h2>` hero, so `h3` there would claim the Wi-Fi card is
   * part of that hero. The level belongs to the mount, not to the card.
   */
  it("takes its heading level from the mount context", async () => {
    const { unmount } = renderCard({ slot: "workspace" });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Wi-Fi settings", level: 3 }),
      ).toBeTruthy(),
    );
    unmount();

    renderCard({ slot: "workspace", headingLevel: "h2" });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Wi-Fi settings", level: 2 }),
      ).toBeTruthy(),
    );
  });

  it("keeps the secondary slot at h3 — it is a subsection of the Wi-Fi tab", async () => {
    renderCard();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Access point Wi-Fi", level: 3 }),
      ).toBeTruthy(),
    );
  });

  /**
   * Item D. The reveal button wrapped a 16px icon with no padding, so its hit
   * area was ~16×16 — under WCAG 2.2 SC 2.5.8's 24px floor, and on the
   * edge-router shape this card IS the workspace form. `p-2` grows the target
   * to 32×32.
   *
   * The margin that gives the space back has to be HORIZONTAL ONLY — see the
   * twin test in WifiSettingsForm.test.tsx for the measured numbers. Short
   * version: the button is absolutely positioned and centred with
   * `top-1/2 -translate-y-1/2`, that translate resolves against the element's
   * own border box, and `p-2` doubles it — so padding re-centres itself and a
   * negative TOP margin pulls the icon 8px above the Lock icon on the same
   * input.
   *
   * jsdom computes no layout, so this pins the mechanism rather than a rect —
   * and pins the part that actually broke: no negative VERTICAL margin.
   */
  it("gives the password reveal a target that clears the 24px floor", async () => {
    renderCard();
    await waitFor(() => expect(ssidInput()).toBeTruthy());

    const reveal = screen.getByRole("button", { name: /show wi-fi password/i });
    expect(reveal.className).toMatch(/(^|\s)p-2(\s|$)/);
    expect(reveal.className).toMatch(/(^|\s)-mr-2(\s|$)/);
    // The regression guard: `-m-2`/`-my-2`/`-mt-2` all break the centring.
    expect(reveal.className).not.toMatch(/(^|\s)-m[ytb]?-\d/);
  });
});
