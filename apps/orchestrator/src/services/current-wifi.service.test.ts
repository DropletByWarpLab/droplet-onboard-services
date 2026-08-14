/**
 * WARP-1714 — resolving the household Wi-Fi across deployment shapes.
 *
 * Verified against the live lab box on 2026-08-04: the Pi edge router reports
 * `radio0` with `interfaces: []` and its uci carries only a DISABLED
 * `ssid='OpenWrt'` placeholder with no key, so the router simply does not know
 * the household Wi-Fi on that shape — the AP does. These tests pin that, and
 * pin the thing that makes the card honest: a blank answer always says why.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./openwrt.client.js", () => ({ getApWireless: vi.fn() }));

import { getCurrentWifi, findRouterWifi } from "./current-wifi.service.js";
import { getApWireless } from "./openwrt.client.js";

const ROUTER_HOSTING = {
  radio0: {
    interfaces: [
      {
        section: "default_radio0",
        config: { mode: "ap", ssid: "Droplet", key: "droplethome2026", network: ["lan"] },
      },
    ],
  },
};

/** Exactly what the live Pi edge router returns. */
const EDGE_ROUTER_NO_AP = {
  radio0: {
    up: true,
    config: { type: "mac80211", band: "5g", channel: "34" },
    interfaces: [],
  },
};

function prismaWith(aps: Array<{ mac: string; displayName: string | null }>) {
  return { apDevice: { findMany: vi.fn().mockResolvedValue(aps) } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findRouterWifi", () => {
  it("reads ssid + key off a router that hosts the household AP", () => {
    expect(findRouterWifi(ROUTER_HOSTING)).toMatchObject({
      radio: "radio0",
      section: "default_radio0",
      ssid: "Droplet",
      key: "droplethome2026",
    });
  });

  it("returns null for the edge-router shape (radio present, no interfaces)", () => {
    expect(findRouterWifi(EDGE_ROUTER_NO_AP)).toBeNull();
  });

  it("never returns the guest network as the household Wi-Fi", () => {
    const withGuest = {
      radio0: {
        interfaces: [
          {
            section: "cfg_guest",
            config: { mode: "ap", ssid: "Guests", key: "guestpw12", network: ["guest"] },
          },
          ...ROUTER_HOSTING.radio0.interfaces,
        ],
      },
    };
    expect(findRouterWifi(withGuest)?.ssid).toBe("Droplet");
  });

  it("prefers the write target over another radio's AP", () => {
    const dual = {
      radio1: {
        interfaces: [
          { section: "default_radio1", config: { mode: "ap", ssid: "2G", key: "k", network: ["lan"] } },
        ],
      },
      radio0: ROUTER_HOSTING.radio0,
    };
    expect(findRouterWifi(dual)?.section).toBe("default_radio0");
  });

  it("ignores non-AP interfaces and survives degenerate shapes", () => {
    expect(findRouterWifi({ radio0: { interfaces: [{ config: { mode: "sta", ssid: "Up" } }] } })).toBeNull();
    expect(findRouterWifi(null)).toBeNull();
    expect(findRouterWifi("radio0")).toBeNull();
    expect(findRouterWifi({ radio0: { interfaces: "nope" } })).toBeNull();
    expect(findRouterWifi({ radio0: { interfaces: [{ config: { mode: "ap" } }] } })).toBeNull();
  });
});

describe("getCurrentWifi", () => {
  it("uses the router when it hosts the AP, without asking any AP", async () => {
    const res = await getCurrentWifi(prismaWith([]), ROUTER_HOSTING);
    expect(res).toMatchObject({ ssid: "Droplet", key: "droplethome2026", source: "router" });
    expect(getApWireless).not.toHaveBeenCalled();
  });

  it("falls back to the AP on the edge-router shape", async () => {
    vi.mocked(getApWireless).mockResolvedValue({
      supported: true,
      ssid: "Studio Fotonia",
      key: "apside12345",
      primary_section: "wifinet1",
      radios: [],
    });
    const res = await getCurrentWifi(
      prismaWith([{ mac: "B8:27:EB:AA:BB:CC", displayName: "Living-room AP" }]),
      EDGE_ROUTER_NO_AP,
    );
    expect(res).toMatchObject({ ssid: "Studio Fotonia", key: "apside12345", source: "ap" });
    expect(res.detail).toContain("Living-room AP");
  });

  it("names the credential gap when the AP can't be read — the lab box's state", async () => {
    // docker/secrets/ap_openwrt_password is 0 bytes on the box, so routing
    // answers supported:false. Blank fields alone would read as "no Wi-Fi set".
    vi.mocked(getApWireless).mockResolvedValue({ supported: false, radios: [] });
    const res = await getCurrentWifi(
      prismaWith([{ mac: "B8:27:EB:AA:BB:CC", displayName: "Living-room AP" }]),
      EDGE_ROUTER_NO_AP,
    );
    expect(res.source).toBeNull();
    expect(res.ssid).toBeNull();
    expect(res.detail).toMatch(/no access-point credential/i);
    expect(res.detail).toMatch(/sync-secrets/);
  });

  it("distinguishes an unreachable AP from a missing credential", async () => {
    vi.mocked(getApWireless).mockResolvedValue({ supported: true, ssid: null, radios: [] });
    const res = await getCurrentWifi(
      prismaWith([{ mac: "B8:27:EB:AA:BB:CC", displayName: "AP" }]),
      EDGE_ROUTER_NO_AP,
    );
    expect(res.source).toBeNull();
    expect(res.detail).toMatch(/may be offline/i);
    expect(res.detail).not.toMatch(/credential/i);
  });

  it("says no Wi-Fi is broadcast when there is no router AP and no approved AP", async () => {
    const res = await getCurrentWifi(prismaWith([]), EDGE_ROUTER_NO_AP);
    expect(res.source).toBeNull();
    expect(res.detail).toMatch(/no access point has been approved/i);
    expect(getApWireless).not.toHaveBeenCalled();
  });

  it("keeps going past an AP that throws rather than failing the card", async () => {
    vi.mocked(getApWireless)
      .mockRejectedValueOnce(new Error("unreachable"))
      .mockResolvedValueOnce({
        supported: true,
        ssid: "Second AP",
        key: "pw12345678",
        primary_section: "w",
        radios: [],
      });
    const res = await getCurrentWifi(
      prismaWith([
        { mac: "AA:AA:AA:AA:AA:AA", displayName: "Dead AP" },
        { mac: "BB:BB:BB:BB:BB:BB", displayName: "Live AP" },
      ]),
      EDGE_ROUTER_NO_AP,
    );
    expect(res).toMatchObject({ ssid: "Second AP", source: "ap" });
  });

  it("degrades honestly when the router read itself failed (null status)", async () => {
    const res = await getCurrentWifi(prismaWith([]), null);
    expect(res.source).toBeNull();
    expect(res.ssid).toBeNull();
  });

  it("reports an open AP network with a null key rather than an empty string", async () => {
    vi.mocked(getApWireless).mockResolvedValue({
      supported: true,
      ssid: "OpenNet",
      key: "",
      primary_section: "w",
      radios: [],
    });
    const res = await getCurrentWifi(prismaWith([{ mac: "AA", displayName: null }]), EDGE_ROUTER_NO_AP);
    expect(res).toMatchObject({ ssid: "OpenNet", key: null, source: "ap" });
    expect(res.detail).toContain("the access point");
  });
});
