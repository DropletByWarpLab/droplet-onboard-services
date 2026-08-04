/**
 * WARP-1714 — picking the household Wi-Fi out of the netifd status blob.
 *
 * The card must resolve the SAME interface the Save button writes to
 * (radio0 / default_radio0 by orchestrator default), must never surface the
 * guest PSK as the household password, and must return null rather than guess
 * when the box exposes no AP-mode interface.
 */
import { describe, it, expect } from "vitest";
import { findPrimaryWifi } from "../primary-wifi";

/** A realistic single-radio netifd `network.wireless status` payload. */
const singleRadio = {
  radio0: {
    up: true,
    pending: false,
    config: { channel: "36", band: "5g", htmode: "HE80" },
    interfaces: [
      {
        section: "default_radio0",
        ifname: "phy0-ap0",
        config: {
          mode: "ap",
          ssid: "Droplet",
          encryption: "psk2",
          key: "droplethome2026",
          network: ["lan"],
        },
      },
    ],
  },
};

describe("findPrimaryWifi", () => {
  it("reads the SSID and key off the household interface", () => {
    expect(findPrimaryWifi(singleRadio)).toEqual({
      radio: "radio0",
      section: "default_radio0",
      ssid: "Droplet",
      key: "droplethome2026",
    });
  });

  it("never returns the guest network as the household Wi-Fi", () => {
    const withGuest = {
      radio0: {
        interfaces: [
          {
            section: "cfg_guest",
            config: {
              mode: "ap",
              ssid: "Droplet Guests",
              key: "guestpass1",
              network: ["guest"],
            },
          },
          singleRadio.radio0.interfaces[0],
        ],
      },
    };
    const found = findPrimaryWifi(withGuest);
    expect(found?.ssid).toBe("Droplet");
    expect(found?.key).toBe("droplethome2026");
  });

  it("excludes a guest iface whose network came back as a bare string", () => {
    const stringNetwork = {
      radio0: {
        interfaces: [
          { section: "cfg_guest", config: { mode: "ap", ssid: "G", key: "k", network: "guest" } },
        ],
      },
    };
    expect(findPrimaryWifi(stringNetwork)).toBeNull();
  });

  it("prefers the write target (default_radio0) over another radio's AP", () => {
    const dualRadio = {
      radio1: {
        interfaces: [
          {
            section: "default_radio1",
            config: { mode: "ap", ssid: "Droplet-2G", key: "twoghz123", network: ["lan"] },
          },
        ],
      },
      radio0: singleRadio.radio0,
    };
    // Object order puts radio1 first; the write target must still win.
    expect(findPrimaryWifi(dualRadio)?.section).toBe("default_radio0");
  });

  it("falls back to an enabled AP when no section is named default_radio0", () => {
    const renamed = {
      radio0: {
        interfaces: [
          {
            section: "wifinet2",
            config: { mode: "ap", ssid: "Renamed", key: "pw12345678", network: ["lan"], disabled: true },
          },
          {
            section: "wifinet3",
            config: { mode: "ap", ssid: "Live", key: "pw87654321", network: ["lan"] },
          },
        ],
      },
    };
    expect(findPrimaryWifi(renamed)?.ssid).toBe("Live");
  });

  it("ignores non-AP interfaces (a station/mesh leg is not the household Wi-Fi)", () => {
    const staOnly = {
      radio0: {
        interfaces: [
          { section: "wwan", config: { mode: "sta", ssid: "Upstream", key: "uplink123" } },
        ],
      },
    };
    expect(findPrimaryWifi(staOnly)).toBeNull();
  });

  it("returns an empty key for an open network rather than inventing one", () => {
    const open = {
      radio0: {
        interfaces: [
          { section: "default_radio0", config: { mode: "ap", ssid: "OpenNet", encryption: "none" } },
        ],
      },
    };
    expect(findPrimaryWifi(open)).toEqual({
      radio: "radio0",
      section: "default_radio0",
      ssid: "OpenNet",
      key: "",
    });
  });

  it("survives every degenerate shape the router can hand back", () => {
    expect(findPrimaryWifi(undefined)).toBeNull();
    expect(findPrimaryWifi(null)).toBeNull();
    expect(findPrimaryWifi({})).toBeNull();
    expect(findPrimaryWifi("radio0")).toBeNull();
    expect(findPrimaryWifi([])).toBeNull();
    expect(findPrimaryWifi({ radio0: null })).toBeNull();
    expect(findPrimaryWifi({ radio0: { interfaces: "nope" } })).toBeNull();
    expect(findPrimaryWifi({ radio0: { interfaces: [null, 3] } })).toBeNull();
    // An AP-mode iface with no SSID isn't something a user can be shown.
    expect(findPrimaryWifi({ radio0: { interfaces: [{ config: { mode: "ap" } }] } })).toBeNull();
  });
});
