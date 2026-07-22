/**
 * WARP-808 — setWifiSsid / setWifiPassword must branch on DROPLET_AP_MODE.
 *
 * On the single-box (hostapd) shape the AP is a raw host hostapd, NOT a UCI
 * router, so a UCI write 500s (ubus NOT_FOUND). These two writes must instead
 * route through the device-bridge (hostapd-bridge.service):
 *   - setWifiSsid  → STAGE the SSID only (no AP reload — hostapd needs the PSK
 *                    too; the wizard sends the password next).
 *   - setWifiPassword → APPLY staged SSID + this PSK in ONE bridge call
 *                    (exactly one AP reload per submit).
 *
 * On every other shape (uci / multi-box — the default) the behavior is LITERALLY
 * UNCHANGED: both calls hit the openwrt.client UCI path exactly as before. This
 * file is the regression guard for AC2.
 *
 * We mock both collaborators (openwrt.client + hostapd-bridge.service) and the
 * cache, and flip config.DROPLET_AP_MODE per-describe to prove the routing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

// Mutable config mock so each describe block can set DROPLET_AP_MODE. Built via
// vi.hoisted so it's initialized before the hoisted vi.mock factories run.
const { configMock } = vi.hoisted(() => ({
  configMock: {
    DROPLET_AP_MODE: "uci" as "uci" | "hostapd" | "auto",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));
vi.mock("../config.js", () => ({ config: configMock }));

// Cache is a no-op in these tests (invalidateNetworkCache calls cacheDel).
vi.mock("./cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

// The UCI client (multi-box path) + the hostapd bridge (single-box path) spies.
// Hoisted so the vi.mock factories can close over them.
const {
  setWirelessSsid,
  setWirelessPassword,
  stageSsid,
  applyWifi,
  fetchGuestWifi,
  createGuestNetwork,
  removeGuestNetwork,
  bridgeApplyGuest,
  bridgeRemoveGuest,
  bridgeGuestStatus,
  fetchSystemControls,
  fetchRadioInfo,
} = vi.hoisted(() => ({
  setWirelessSsid: vi.fn(),
  setWirelessPassword: vi.fn(),
  stageSsid: vi.fn(),
  applyWifi: vi.fn(),
  fetchGuestWifi: vi.fn(),
  createGuestNetwork: vi.fn(),
  removeGuestNetwork: vi.fn(),
  bridgeApplyGuest: vi.fn(),
  bridgeRemoveGuest: vi.fn(),
  bridgeGuestStatus: vi.fn(),
  fetchSystemControls: vi.fn(),
  fetchRadioInfo: vi.fn(),
}));

vi.mock("./openwrt.client.js", async () => {
  const actual = await vi.importActual<any>("./openwrt.client.js");
  return {
    ...actual,
    setWirelessSsid: (...a: unknown[]) => setWirelessSsid(...a),
    setWirelessPassword: (...a: unknown[]) => setWirelessPassword(...a),
    fetchGuestWifi: (...a: unknown[]) => fetchGuestWifi(...a),
    createGuestNetwork: (...a: unknown[]) => createGuestNetwork(...a),
    removeGuestNetwork: (...a: unknown[]) => removeGuestNetwork(...a),
    fetchSystemControls: (...a: unknown[]) => fetchSystemControls(...a),
    fetchRadioInfo: (...a: unknown[]) => fetchRadioInfo(...a),
  };
});

vi.mock("./hostapd-bridge.service.js", () => ({
  stageSsid: (...a: unknown[]) => stageSsid(...a),
  applyWifi: (...a: unknown[]) => applyWifi(...a),
  applyGuestWifi: (...a: unknown[]) => bridgeApplyGuest(...a),
  removeGuestWifi: (...a: unknown[]) => bridgeRemoveGuest(...a),
  guestStatusFromBridge: (...a: unknown[]) => bridgeGuestStatus(...a),
}));

import {
  setWifiSsid,
  setWifiPassword,
  getGuestWifi,
  setGuestWifi,
  removeGuestWifi,
  getSystemControls,
  getRadioDetail,
} from "./network.service.js";

beforeEach(() => {
  vi.clearAllMocks();
  applyWifi.mockResolvedValue({ operationId: null });
  setWirelessSsid.mockResolvedValue({ operationId: "op-ssid" });
  setWirelessPassword.mockResolvedValue({ operationId: "op-pw" });
  fetchGuestWifi.mockResolvedValue({
    configured: true,
    enabled: true,
    ssid: "Guests",
    password: "letmein8",
  });
  createGuestNetwork.mockResolvedValue({ operationId: "op-guest-uci" });
  removeGuestNetwork.mockResolvedValue({ operationId: "op-guest-rm-uci" });
  bridgeApplyGuest.mockResolvedValue({ operationId: null });
  bridgeRemoveGuest.mockResolvedValue({ operationId: null });
  bridgeGuestStatus.mockResolvedValue({
    configured: true,
    enabled: true,
    ssid: "Visitors",
    password: "guestpass1",
    supported: true,
  });
  fetchSystemControls.mockResolvedValue({
    hostname: "droplet-rack-01",
    ntpEnabled: true,
    // The raw box read reports these as "live" — the service must override.
    statusLed: { supported: true, enabled: true },
    country: { value: "US", editable: true },
  });
  fetchRadioInfo.mockResolvedValue({
    channel: 6,
    htmode: "HT20",
    txpower: 20,
    country: "US",
    mode: "Master",
  });
});

describe("uci mode (multi-box, default) — UNCHANGED", () => {
  beforeEach(() => {
    configMock.DROPLET_AP_MODE = "uci";
  });

  it("setWifiSsid calls the UCI client and never the hostapd bridge", async () => {
    const res = await setWifiSsid("radio0", "default_radio0", "HomeNet");
    expect(setWirelessSsid).toHaveBeenCalledWith("radio0", "default_radio0", "HomeNet");
    expect(stageSsid).not.toHaveBeenCalled();
    expect(applyWifi).not.toHaveBeenCalled();
    expect(res).toEqual({ operationId: "op-ssid" });
  });

  it("setWifiPassword calls the UCI client and never the hostapd bridge", async () => {
    const res = await setWifiPassword("default_radio0", "supersecret1");
    expect(setWirelessPassword).toHaveBeenCalledWith("default_radio0", "supersecret1");
    expect(applyWifi).not.toHaveBeenCalled();
    expect(res).toEqual({ operationId: "op-pw" });
  });
});

describe("hostapd mode (single-box) — routes through the device-bridge", () => {
  beforeEach(() => {
    configMock.DROPLET_AP_MODE = "hostapd";
  });

  it("setWifiSsid STAGES the SSID and does NOT hit UCI or reload the AP", async () => {
    const res = await setWifiSsid("radio0", "default_radio0", "HomeNet");
    // WARP-808 review #2: staged keyed by userId (undefined here → anon key).
    expect(stageSsid).toHaveBeenCalledWith("HomeNet", undefined);
    // No UCI write, no bridge apply (the password call does the single reload).
    expect(setWirelessSsid).not.toHaveBeenCalled();
    expect(applyWifi).not.toHaveBeenCalled();
    // A stage is not an operation record — no operationId.
    expect(res).toEqual({ operationId: null });
  });

  it("setWifiPassword APPLIES via the bridge (one reload) and not via UCI", async () => {
    await setWifiSsid("radio0", "default_radio0", "HomeNet");
    const res = await setWifiPassword("default_radio0", "supersecret1");
    expect(applyWifi).toHaveBeenCalledTimes(1);
    expect(applyWifi).toHaveBeenCalledWith("supersecret1", undefined);
    expect(setWirelessPassword).not.toHaveBeenCalled();
    expect(res).toEqual({ operationId: null });
  });

  it("a full submit (SSID then password) triggers exactly ONE bridge apply", async () => {
    await setWifiSsid("radio0", "default_radio0", "HomeNet");
    await setWifiPassword("default_radio0", "supersecret1");
    expect(stageSsid).toHaveBeenCalledTimes(1);
    expect(applyWifi).toHaveBeenCalledTimes(1);
    // And UCI is never touched on this shape.
    expect(setWirelessSsid).not.toHaveBeenCalled();
    expect(setWirelessPassword).not.toHaveBeenCalled();
  });

  it("threads the userId through to BOTH stage and apply (review #2 per-user key)", async () => {
    // The SSID and password writes are separate HTTP requests; the same
    // authenticated userId keys the stage and its consumption so concurrent
    // wizard sessions can't clobber each other's staged SSID.
    await setWifiSsid("radio0", "default_radio0", "HomeNet", "user-abc");
    await setWifiPassword("default_radio0", "supersecret1", "user-abc");
    expect(stageSsid).toHaveBeenCalledWith("HomeNet", "user-abc");
    expect(applyWifi).toHaveBeenCalledWith("supersecret1", "user-abc");
  });
});

// Guest Wi-Fi is now REAL on the single-box hostapd shape: a second BSS the
// host script stands up via the device-bridge. getGuestWifi reads the live
// state from the bridge (supported:true), setGuestWifi/removeGuestWifi route
// through the bridge — never the UCI client — and a transient bridge read
// failure degrades to "supported but not configured" so the card never errors.
describe("guest Wi-Fi — hostapd mode routes through the device-bridge", () => {
  beforeEach(() => {
    configMock.DROPLET_AP_MODE = "hostapd";
  });

  it("getGuestWifi passes through the bridge status incl. radio-derived supported, never the UCI read", async () => {
    const res = await getGuestWifi();
    expect(bridgeGuestStatus).toHaveBeenCalledOnce();
    expect(fetchGuestWifi).not.toHaveBeenCalled();
    expect(res).toEqual({
      configured: true,
      enabled: true,
      ssid: "Visitors",
      password: "guestpass1",
      supported: true,
    });
  });

  it("getGuestWifi reports supported:false when the radio can't host a second BSS (AX210)", async () => {
    bridgeGuestStatus.mockResolvedValueOnce({
      configured: false,
      enabled: false,
      ssid: null,
      password: null,
      supported: false,
    });
    const res = await getGuestWifi();
    expect(res.supported).toBe(false);
  });

  it("getGuestWifi degrades to unavailable (supported:false) when the bridge read fails", async () => {
    bridgeGuestStatus.mockRejectedValueOnce(new Error("device-bridge not reachable"));
    const res = await getGuestWifi();
    expect(res).toEqual({
      configured: false,
      enabled: false,
      ssid: null,
      password: null,
      supported: false,
    });
    expect(fetchGuestWifi).not.toHaveBeenCalled();
  });

  it("setGuestWifi applies via the bridge (ssid + psk), not the UCI client", async () => {
    const res = await setGuestWifi("radio3", "Visitors", "guestpass1", "guest");
    expect(bridgeApplyGuest).toHaveBeenCalledWith("Visitors", "guestpass1");
    expect(createGuestNetwork).not.toHaveBeenCalled();
    expect(res).toEqual({ operationId: null });
  });

  it("removeGuestWifi tears down via the bridge, not the UCI client", async () => {
    const res = await removeGuestWifi();
    expect(bridgeRemoveGuest).toHaveBeenCalledOnce();
    expect(removeGuestNetwork).not.toHaveBeenCalled();
    expect(res).toEqual({ operationId: null });
  });
});

describe("guest Wi-Fi — uci mode (multi-box) UNCHANGED", () => {
  beforeEach(() => {
    configMock.DROPLET_AP_MODE = "uci";
  });

  it("getGuestWifi reflects the real routing read (supported:true)", async () => {
    const res = await getGuestWifi();
    expect(fetchGuestWifi).toHaveBeenCalledOnce();
    expect(bridgeGuestStatus).not.toHaveBeenCalled();
    expect(res).toMatchObject({ configured: true, ssid: "Guests", supported: true });
  });

  it("setGuestWifi creates the UCI guest network, never the bridge", async () => {
    const res = await setGuestWifi("radio3", "Guests", "letmein8", "guest");
    expect(createGuestNetwork).toHaveBeenCalledWith("radio3", "Guests", "letmein8", "guest");
    expect(bridgeApplyGuest).not.toHaveBeenCalled();
    expect(res).toEqual({ operationId: "op-guest-uci" });
  });

  it("removeGuestWifi removes the UCI guest network, never the bridge", async () => {
    const res = await removeGuestWifi();
    expect(removeGuestNetwork).toHaveBeenCalledOnce();
    expect(bridgeRemoveGuest).not.toHaveBeenCalled();
    expect(res).toEqual({ operationId: "op-guest-rm-uci" });
  });
});

// Status-LED + regulatory-domain can't be driven on the single-box hostapd
// shape (no system.led ubus surface; host-hostapd country is pinned). The
// authoritative gate lives in the service: it forces statusLed.supported and
// country.editable to false there regardless of what the box read reports, so
// the UI shows an honest "not available" state — same posture as guest-wifi.
describe("getSystemControls honesty gate", () => {
  it("hostapd mode → statusLed/country gated false; hostname + NTP pass through", async () => {
    configMock.DROPLET_AP_MODE = "hostapd";
    const res = await getSystemControls();
    expect(res.statusLed.supported).toBe(false);
    expect(res.country.editable).toBe(false);
    // The live country VALUE is still surfaced read-only; the real controls pass.
    expect(res.country.value).toBe("US");
    expect(res.hostname).toBe("droplet-rack-01");
    expect(res.ntpEnabled).toBe(true);
  });

  it("uci mode → passes the box read through unchanged (multi-box can edit)", async () => {
    configMock.DROPLET_AP_MODE = "uci";
    const res = await getSystemControls();
    expect(res.statusLed.supported).toBe(true);
    expect(res.country.editable).toBe(true);
  });
});

// Radio detail is read-only. On the single-box hostapd shape it returns the
// honesty envelope (supported:false/hostRadio:true — one combined radio that
// can't be toggled independently) and surfaces ONLY the iwinfo fields read;
// `broadcasting` is derived from the real iwinfo mode, never hardcoded.
describe("getRadioDetail honesty envelope", () => {
  it("hostapd mode → supported:false/hostRadio:true, broadcasting from iwinfo mode", async () => {
    configMock.DROPLET_AP_MODE = "hostapd";
    const res = await getRadioDetail();
    expect(res.supported).toBe(false);
    expect(res.hostRadio).toBe(true);
    expect(res.broadcasting).toBe(true); // mode "Master"
    expect(res.channel).toBe(6);
    expect(res.country).toBe("US");
  });

  it("reports null (not a fabricated value) for fields iwinfo omits", async () => {
    configMock.DROPLET_AP_MODE = "hostapd";
    fetchRadioInfo.mockResolvedValueOnce({ channel: 6 }); // htmode/txpower/country absent
    const res = await getRadioDetail();
    expect(res.htmode).toBeNull();
    expect(res.txpower).toBeNull();
    expect(res.country).toBeNull();
    expect(res.mode).toBeNull();
    // mode absent → not broadcasting (never assumed true).
    expect(res.broadcasting).toBe(false);
  });

  it("uci mode → supported:true (a real radio host can manage it)", async () => {
    configMock.DROPLET_AP_MODE = "uci";
    const res = await getRadioDetail();
    expect(res.supported).toBe(true);
    expect(res.hostRadio).toBe(false);
  });
});
