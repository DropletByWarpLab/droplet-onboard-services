/**
 * WARP-3505 — the "Stream address" hint hardcoded `…/stream1`, which is wrong
 * for the cameras that most need the hint (a Hanwha answers /stream1 with a 400;
 * its stream lives at /profile2/media.smp). The example must follow the detected
 * manufacturer, and for an unknown one must not imply any particular path.
 */
import { describe, it, expect } from "vitest";
import { exampleStreamUrl, streamPathFor, vendorHintFor } from "./camera-stream-hints";

describe("streamPathFor", () => {
  it.each([
    ["Hanwha", "/profile2/media.smp"],
    ["Hanwha Techwin", "/profile2/media.smp"],
    ["Samsung Techwin", "/profile2/media.smp"],
    ["Wisenet", "/profile2/media.smp"],
    ["Hikvision", "/Streaming/Channels/101"],
    ["Dahua", "/cam/realmonitor?channel=1&subtype=0"],
    ["Amcrest", "/cam/realmonitor?channel=1&subtype=0"],
    ["Reolink", "/h264Preview_01_main"],
    ["  hanwha  ", "/profile2/media.smp"],
  ])("%s -> %s", (maker, path) => {
    expect(streamPathFor(maker)).toBe(path);
  });

  it.each([[null], [undefined], [""], ["Acme Optics"]])("returns null for %j", (maker) => {
    expect(streamPathFor(maker as string | null | undefined)).toBeNull();
  });
});

describe("exampleStreamUrl", () => {
  it("uses the vendor's real path with the camera's own address", () => {
    expect(exampleStreamUrl("Hanwha", "192.168.9.219")).toBe(
      "rtsp://192.168.9.219:554/profile2/media.smp",
    );
  });

  it("never implies /stream1 for an unknown manufacturer", () => {
    const url = exampleStreamUrl("Acme Optics", "192.168.9.50");
    expect(url).not.toMatch(/stream1/);
    expect(url.startsWith("rtsp://192.168.9.50:554/")).toBe(true);
  });

  it("falls back to a placeholder address when none is known and still avoids /stream1", () => {
    expect(exampleStreamUrl(null, null)).not.toMatch(/stream1/);
    expect(exampleStreamUrl(null, null)).toMatch(/^rtsp:\/\//);
  });

  it("never contains a username or password placeholder", () => {
    expect(exampleStreamUrl("Hanwha", "10.0.0.2")).not.toMatch(/@|password/i);
  });
});

describe("vendorHintFor (WARP-3505 F14)", () => {
  it("names the MATCHED vendor, not the raw ONVIF manufacturer string", () => {
    expect(vendorHintFor("Hanwha Techwin Co., Ltd.")).toEqual({
      label: "Hanwha",
      path: "/profile2/media.smp",
    });
    expect(vendorHintFor("HANWHA VISION")?.label).toBe("Hanwha");
    expect(vendorHintFor("AMCREST TECHNOLOGIES")).toEqual({
      label: "Amcrest",
      path: "/cam/realmonitor?channel=1&subtype=0",
    });
    expect(vendorHintFor("Hikvision Digital Technology")?.label).toBe("Hikvision");
  });

  it("is null when there is no proven path for the manufacturer", () => {
    for (const m of [null, undefined, "", "Acme Optics"]) {
      expect(vendorHintFor(m as string | null | undefined)).toBeNull();
    }
  });
});
