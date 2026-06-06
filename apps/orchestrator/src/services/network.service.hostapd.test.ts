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
  configMock: { DROPLET_AP_MODE: "uci" as "uci" | "hostapd" | "auto" },
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
const { setWirelessSsid, setWirelessPassword, stageSsid, applyWifi } =
  vi.hoisted(() => ({
    setWirelessSsid: vi.fn(),
    setWirelessPassword: vi.fn(),
    stageSsid: vi.fn(),
    applyWifi: vi.fn(),
  }));

vi.mock("./openwrt.client.js", async () => {
  const actual = await vi.importActual<any>("./openwrt.client.js");
  return {
    ...actual,
    setWirelessSsid: (...a: unknown[]) => setWirelessSsid(...a),
    setWirelessPassword: (...a: unknown[]) => setWirelessPassword(...a),
  };
});

vi.mock("./hostapd-bridge.service.js", () => ({
  stageSsid: (...a: unknown[]) => stageSsid(...a),
  applyWifi: (...a: unknown[]) => applyWifi(...a),
}));

import { setWifiSsid, setWifiPassword } from "./network.service.js";

beforeEach(() => {
  vi.clearAllMocks();
  applyWifi.mockResolvedValue({ operationId: null });
  setWirelessSsid.mockResolvedValue({ operationId: "op-ssid" });
  setWirelessPassword.mockResolvedValue({ operationId: "op-pw" });
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
