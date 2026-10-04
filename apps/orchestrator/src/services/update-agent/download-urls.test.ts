/**
 * WARP-3430 — the anonymous OTA download URLs (download-urls.ts). Pure string
 * builders: what a box asks for, and that a value read from a document can
 * never add a path segment or a query.
 */
import { describe, it, expect } from "vitest";
import { channelPointerUrl, releaseAssetDownloadUrl } from "./download-urls.js";

const BASE = "https://github.com/DropletByWarpLab/droplet-onboard-services/releases/download";

describe("channelPointerUrl", () => {
  it("is <base>/ota-index/channel-<channel>.json", () => {
    expect(channelPointerUrl(BASE, "stage")).toBe(`${BASE}/ota-index/channel-stage.json`);
    expect(channelPointerUrl(BASE, "stable")).toBe(`${BASE}/ota-index/channel-stable.json`);
  });

  it("ignores trailing slashes on the base", () => {
    expect(channelPointerUrl(`${BASE}//`, "stage")).toBe(`${BASE}/ota-index/channel-stage.json`);
  });

  it("encodes the channel, which is operator-settable text", () => {
    expect(channelPointerUrl(BASE, "../x?y")).toBe(`${BASE}/ota-index/channel-..%2Fx%3Fy.json`);
  });
});

describe("releaseAssetDownloadUrl", () => {
  it("is <base>/<tag>/<name> — the release's own tag, never `latest`", () => {
    expect(releaseAssetDownloadUrl(BASE, "ota-stage-404-g3c71b82", "configs.tar.gz")).toBe(
      `${BASE}/ota-stage-404-g3c71b82/configs.tar.gz`,
    );
    expect(releaseAssetDownloadUrl(BASE, "ota-stage-404-g3c71b82", "Droplet-0.2.0.dmg")).not.toContain(
      "latest",
    );
  });

  it("ignores trailing slashes on the base", () => {
    expect(releaseAssetDownloadUrl(`${BASE}/`, "ota-stable-1-gabcdef0", "release.json")).toBe(
      `${BASE}/ota-stable-1-gabcdef0/release.json`,
    );
  });

  it("encodes the tag and the name, so neither can add a path segment or a query", () => {
    expect(releaseAssetDownloadUrl(BASE, "ota-stage-1-gabcdef0", "../../evil?x=1")).toBe(
      `${BASE}/ota-stage-1-gabcdef0/..%2F..%2Fevil%3Fx%3D1`,
    );
    expect(releaseAssetDownloadUrl(BASE, "a/b", "c")).toBe(`${BASE}/a%2Fb/c`);
  });
});
