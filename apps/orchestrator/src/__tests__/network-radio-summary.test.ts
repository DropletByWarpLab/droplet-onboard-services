/**
 * Whole-fabric Wi-Fi radio rollup — the fix for a Network Overview tile that
 * reported "0 radio(s)" over a live, broadcasting network.
 *
 * The tile summarised `NetworkOverview.wireless`, which is the ROUTER's own
 * netifd wireless status and nothing else. On the shipping fabric the router
 * hosts no Wi-Fi at all — the RB5009 edge router has no radio hardware, and
 * the household SSID is broadcast by the Droplet access point — so that map is
 * `{}` and the count was structurally always zero, no matter how healthy the
 * Wi-Fi was. These pin the replacement:
 *
 *   * radios are counted wherever they LIVE (router + access points), so the
 *     count is a property of the household, not of one box;
 *   * "on the air" is read off the radios' own link state, so a configured
 *     radio that is down is never counted as broadcasting;
 *   * an access point that doesn't answer is reported as NOT REPORTING, not as
 *     zero radios — those are different facts and only one is an outage;
 *   * a broken AP read degrades the ROLLUP, never the whole overview: the
 *     router's summary must still render when an extender is mid-reboot;
 *   * the rollup carries counts ONLY. `GET /network/status` is open to every
 *     authenticated principal, unlike the owner/admin AP Wi-Fi read whose body
 *     carries the live passphrase.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { getApWirelessMock, cache } = vi.hoisted(() => ({
  getApWirelessMock: vi.fn(),
  cache: new Map<string, unknown>(),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(async (key: string) => cache.get(key)),
  cacheSet: vi.fn(async (key: string, value: unknown) => {
    cache.set(key, value);
  }),
  cacheDel: vi.fn(async (key: string) => {
    cache.delete(key);
  }),
}));

// Partial mock: only the AP wireless dial is stubbed, so every other export
// (and the backend handlers built from the UniFi / EasyMesh clients at module
// load) stays real.
vi.mock("../services/openwrt.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/openwrt.client.js")>(
    "../services/openwrt.client.js",
  );
  return { ...actual, getApWireless: getApWirelessMock };
});

import { getApRadioSummary } from "../services/ap-onboard.service.js";
import { getNetworkOverview, summariseRadios } from "../services/network.service.js";
import * as openwrt from "../services/openwrt.client.js";

/** A `radios[]` entry as the routing service reports it. */
function radio(over: Partial<Record<string, unknown>> = {}) {
  return {
    section: "default_radio0",
    radio: "radio0",
    band: "2g",
    ssid: "Warp",
    encryption: "psk2+ccmp",
    channel: "6",
    htmode: "HE20",
    disabled: false,
    primary: true,
    ifname: "phy00-0",
    up: true,
    live_channel: 6,
    live_htmode: "HE20",
    clients: 0,
    ...over,
  };
}

function prismaWith(macs: string[]): PrismaClient {
  return {
    apDevice: { findMany: vi.fn().mockResolvedValue(macs.map((mac) => ({ mac }))) },
  } as unknown as PrismaClient;
}

describe("getApRadioSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts the access point's radios — the live two-radio shape the tile called zero", async () => {
    getApWirelessMock.mockResolvedValue({
      supported: true,
      radios: [radio(), radio({ section: "default_radio1", radio: "radio1", band: "5g" })],
    });

    expect(await getApRadioSummary(prismaWith(["80:EA:0B:39:AE:23"]))).toEqual({
      apCount: 1,
      reporting: 1,
      radioCount: 2,
      activeRadioCount: 2,
    });
  });

  it("does not count a disabled or down radio as on the air", async () => {
    getApWirelessMock.mockResolvedValue({
      supported: true,
      radios: [
        radio(),
        radio({ section: "b", disabled: true }),
        radio({ section: "c", up: false }),
      ],
    });

    const summary = await getApRadioSummary(prismaWith(["AA:BB:CC:DD:EE:FF"]));
    expect(summary.radioCount).toBe(3);
    expect(summary.activeRadioCount).toBe(1);
  });

  it("treats an unreported link state as on the air when uci has not disabled it", async () => {
    // `up: null` is an AP image that doesn't report link state. Reading a
    // missing field as "off" would be a guess, and would blank a live radio.
    getApWirelessMock.mockResolvedValue({
      supported: true,
      radios: [radio({ up: null })],
    });

    expect((await getApRadioSummary(prismaWith(["AA:BB:CC:DD:EE:FF"]))).activeRadioCount).toBe(1);
  });

  it("sums across access points and reports a silent one rather than zeroing the rest", async () => {
    getApWirelessMock
      .mockResolvedValueOnce({ supported: true, radios: [radio(), radio({ section: "b" })] })
      .mockRejectedValueOnce(new Error("AP unreachable"));

    const summary = await getApRadioSummary(prismaWith(["AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:02"]));
    // The reachable AP's radios survive its neighbour's failure — this is the
    // whole point of settling each read independently.
    expect(summary).toEqual({
      apCount: 2,
      reporting: 1,
      radioCount: 2,
      activeRadioCount: 2,
    });
  });

  it("counts an AP that answers `supported: false` as not reporting, not as zero radios", async () => {
    getApWirelessMock.mockResolvedValue({ supported: false, radios: [] });

    const summary = await getApRadioSummary(prismaWith(["AA:BB:CC:DD:EE:FF"]));
    expect(summary.apCount).toBe(1);
    expect(summary.reporting).toBe(0);
    expect(summary.radioCount).toBe(0);
  });

  it("never throws — a database failure degrades to empty counts", async () => {
    const prisma = {
      apDevice: { findMany: vi.fn().mockRejectedValue(new Error("db down")) },
    } as unknown as PrismaClient;

    await expect(getApRadioSummary(prisma)).resolves.toEqual({
      apCount: 0,
      reporting: 0,
      radioCount: 0,
      activeRadioCount: 0,
    });
  });

  it("does not dial anything when no access point is online", async () => {
    await expect(getApRadioSummary(prismaWith([]))).resolves.toMatchObject({ apCount: 0 });
    expect(getApWirelessMock).not.toHaveBeenCalled();
  });

  it("carries counts only — never the network name or passphrase", async () => {
    getApWirelessMock.mockResolvedValue({
      supported: true,
      ssid: "Warp",
      key: "Warp123!",
      radios: [radio()],
    });

    const summary = await getApRadioSummary(prismaWith(["AA:BB:CC:DD:EE:FF"]));
    // `GET /network/status` is open to every authenticated principal; the AP
    // Wi-Fi read that carries the PSK is owner/admin for a reason.
    expect(JSON.stringify(summary)).not.toContain("Warp123!");
    expect(Object.keys(summary).sort()).toEqual([
      "activeRadioCount",
      "apCount",
      "radioCount",
      "reporting",
    ]);
  });
});

describe("summariseRadios", () => {
  const upRadio = { up: true } as never;
  const downRadio = { up: false } as never;

  it("counts the access point's radios when the router hosts none — the RB5009 shape", () => {
    expect(
      summariseRadios({}, { apCount: 1, reporting: 1, radioCount: 2, activeRadioCount: 2 }),
    ).toEqual({ router: 0, ap: 2, total: 2, active: 2, apsNotReporting: 0 });
  });

  it("adds the router's own radios on a shape that has them", () => {
    expect(
      summariseRadios(
        { radio0: upRadio, radio1: downRadio },
        { apCount: 1, reporting: 1, radioCount: 2, activeRadioCount: 1 },
      ),
    ).toEqual({ router: 2, ap: 2, total: 4, active: 2, apsNotReporting: 0 });
  });

  it("reports outstanding access points so the count reads as a floor", () => {
    expect(
      summariseRadios({}, { apCount: 3, reporting: 1, radioCount: 2, activeRadioCount: 2 }),
    ).toMatchObject({ total: 2, apsNotReporting: 2 });
  });

  it("claims nothing outstanding when the AP read itself failed", () => {
    // No answer at all is different from "I asked 3 and 1 replied" — with no
    // AP data there is no known population to be missing from.
    expect(summariseRadios({ radio0: upRadio }, undefined)).toEqual({
      router: 1,
      ap: 0,
      total: 1,
      active: 1,
      apsNotReporting: 0,
    });
  });

  it("does not count a router radio that netifd reports as down", () => {
    expect(summariseRadios({ radio0: downRadio }, undefined)).toMatchObject({
      router: 1,
      active: 0,
    });
  });

  it("survives a missing wireless map", () => {
    expect(summariseRadios(undefined, undefined)).toEqual({
      router: 0,
      ap: 0,
      total: 0,
      active: 0,
      apsNotReporting: 0,
    });
  });
});

describe("getNetworkOverview — the AP rollup on the overview hot path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cache.clear();
    vi.spyOn(openwrt, "fetchInterfaces").mockResolvedValue({} as never);
    vi.spyOn(openwrt, "fetchWirelessStatus").mockResolvedValue({});
    vi.spyOn(openwrt, "fetchSystemInfo").mockResolvedValue({} as never);
    vi.spyOn(openwrt, "fetchDhcpLeases").mockResolvedValue([]);
    vi.spyOn(openwrt, "healthCheck").mockResolvedValue(true);
  });

  const AP = { apCount: 1, reporting: 1, radioCount: 2, activeRadioCount: 2 };

  it("carries the access point's radios into the summary the tile reads", async () => {
    const result = await getNetworkOverview(async () => AP);

    expect(result.ok).toBe(true);
    // `wireless` stays what it always was — the RB5009 router's own (empty)
    // netifd status — and the rollup is what the count now comes from.
    if (result.ok) {
      expect(result.value.wireless).toEqual({});
      expect(result.value.wirelessRadios).toEqual({
        router: 0,
        ap: 2,
        total: 2,
        active: 2,
        apsNotReporting: 0,
      });
    }
  });

  it("does not re-dial the access points on the next overview read", async () => {
    // The dashboard polls /api/network/status every 10s against a 10s overview
    // TTL, so nearly every poll misses that cache. The AP rollup's own longer
    // TTL is what keeps a small embedded AP off a 6-dials-a-minute treadmill.
    const source = vi.fn().mockResolvedValue(AP);
    await getNetworkOverview(source);
    cache.delete("network:overview");
    await getNetworkOverview(source);

    expect(source).toHaveBeenCalledTimes(1);
  });

  it("still returns the router's overview when the AP rollup throws", async () => {
    const result = await getNetworkOverview(async () => {
      throw new Error("routing service down");
    });

    expect(result.ok).toBe(true);
    // Unknown, not zero: a failed AP read must never render as "no Wi-Fi".
    if (result.ok) expect(result.value.wirelessRadios?.total).toBe(0);
    if (result.ok) expect(result.value.wirelessRadios?.apsNotReporting).toBe(0);
  });

  it("omits nothing when called without an AP source", async () => {
    const result = await getNetworkOverview();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.wirelessRadios).toEqual({
      router: 0,
      ap: 0,
      total: 0,
      active: 0,
      apsNotReporting: 0,
    });
  });
});
