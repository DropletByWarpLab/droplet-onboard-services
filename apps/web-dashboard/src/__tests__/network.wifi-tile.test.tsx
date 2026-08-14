/**
 * Network → Overview, Wi-Fi tile.
 *
 * The tile used to be three inline expressions over `overview.wireless` — the
 * ROUTER's own netifd status. On the shipping fabric the router hosts no Wi-Fi
 * (the RB5009 edge router has no radio hardware; the household SSID is
 * broadcast by the Droplet access point), so that map is `{}` and the tile read
 * "Active · 0 radio(s)" in warning orange over a network live on two radios —
 * simultaneously wrong about the count, wrong about the colour, and internally
 * contradictory, because `{}` is truthy so "Active" was never derived from
 * anything.
 *
 * These pin the replacement's contract: the count is whole-fabric, "Active" is
 * derived from radios ON THE AIR, and the states it cannot know are named as
 * unknown rather than asserted as zero.
 */

import { describe, it, expect } from "vitest";
import { describeWifi } from "@/components/network/wifi-tile-copy";
import type { WirelessRadioSummary } from "@/lib/types";

function summary(over: Partial<WirelessRadioSummary> = {}): WirelessRadioSummary {
  return { router: 0, ap: 0, total: 0, active: 0, apsNotReporting: 0, ...over };
}

describe("describeWifi", () => {
  it("counts the access point's radios and reads Active — the shape that used to say 0", () => {
    // The live lab fabric: RB5009 router (no radios) + one Droplet AP on 2.4
    // and 5 GHz.
    const wifi = describeWifi(summary({ router: 0, ap: 2, total: 2, active: 2 }));

    expect(wifi.value).toBe("Active");
    expect(wifi.status).toBe("ok");
    expect(wifi.subtitle).toBe("2 radios · access point");
    // The old bug, pinned: never report zero over a broadcasting network.
    expect(wifi.subtitle).not.toContain("0 radio");
  });

  it("names both sources when the router hosts radios too", () => {
    const wifi = describeWifi(summary({ router: 1, ap: 2, total: 3, active: 3 }));

    expect(wifi.subtitle).toBe("3 radios · router + access point");
    expect(wifi.value).toBe("Active");
  });

  it("names the router alone on a shape with no access point", () => {
    expect(describeWifi(summary({ router: 1, total: 1, active: 1 })).subtitle).toBe(
      "1 radio · router",
    );
  });

  it("says how many are on the air when some radios are down", () => {
    const wifi = describeWifi(summary({ ap: 2, total: 2, active: 1 }));

    expect(wifi.subtitle).toBe("1 of 2 radios on the air · access point");
    // One live radio is still a working network — green, not orange.
    expect(wifi.value).toBe("Active");
    expect(wifi.status).toBe("ok");
  });

  it("reads Inactive when radios exist but none are broadcasting", () => {
    // Configured is not the same as on the air, and this is the one case where
    // "Inactive" is an earned assertion rather than a default.
    const wifi = describeWifi(summary({ ap: 2, total: 2, active: 0 }));

    expect(wifi.value).toBe("Inactive");
    expect(wifi.status).toBe("warning");
    expect(wifi.subtitle).toBe("0 of 2 radios on the air · access point");
  });

  it("flags the count as a floor when an access point is silent", () => {
    const wifi = describeWifi(summary({ ap: 2, total: 2, active: 2, apsNotReporting: 1 }));

    expect(wifi.subtitle).toBe("2 radios · access point · 1 not reporting");
    expect(wifi.value).toBe("Active");
  });

  it("says Unknown — not Inactive — when the only access point went silent", () => {
    // Zero radios BECAUSE nothing answered is a different fact from zero
    // radios because there are none, and only one of them is an outage.
    const wifi = describeWifi(summary({ apsNotReporting: 1 }));

    expect(wifi.value).toBe("Unknown");
    expect(wifi.status).toBe("warning");
    expect(wifi.subtitle).toBe("Your access point isn't reporting its radios");
  });

  it("pluralises the silent-access-point copy", () => {
    expect(describeWifi(summary({ apsNotReporting: 3 })).subtitle).toBe(
      "3 access points aren't reporting their radios",
    );
  });

  it("reads Inactive only when the fabric genuinely has no radios", () => {
    const wifi = describeWifi(summary());

    expect(wifi.value).toBe("Inactive");
    expect(wifi.subtitle).toBe("No radios found");
    expect(wifi.status).toBe("warning");
  });

  it("asserts nothing while the rollup is still unknown", () => {
    // `undefined` = the read hasn't landed, or the orchestrator predates the
    // rollup. Both are "we don't know yet" — the old code's failure was
    // asserting a state it had never read, and an orange chip here would be
    // the same mistake pointing the other way.
    const wifi = describeWifi(undefined);

    expect(wifi.value).toBe("—");
    expect(wifi.subtitle).toBe("Checking radios…");
    expect(wifi.status).toBe("ok");
  });
});
