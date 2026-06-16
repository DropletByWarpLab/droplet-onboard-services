/**
 * PR #486 review finding 2 (host-header trust, non-invite surfaces) —
 * `webdavBaseUrl` builds the WebDAV/server URL embedded in the pairing QR
 * (`droplet://pair?server=...`) and the pair-claim response. It previously
 * trusted `x-forwarded-host` / `host` verbatim, so a forged header poisoned the
 * server URL a native client is told to talk to.
 *
 * It now sources the host from the shared trusted-origin resolver. The box's
 * legitimate LAN hostnames (e.g. the mDNS `droplet.local`, which is in the TLS
 * cert SANs) are passed as extra allowed hosts so a real client reaching the
 * box over mDNS still gets a correct URL — only forged hosts are rejected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    WIREGUARD_ENDPOINT_HOST: "",
    ROUTING_MODE: "real",
    corsAllowedOrigins: ["https://droplet-ai.local"],
  },
}));

vi.mock("../services/openwrt.client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/openwrt.client.js")
  >("../services/openwrt.client.js");
  return {
    ...actual,
    fetchDuckDnsStatus: vi.fn(async () => ({ configured: false as const })),
  };
});

import { webdavBaseUrl } from "./device-clients.js";
import { config } from "../config.js";
import * as openwrt from "../services/openwrt.client.js";
import { _resetTrustedOriginCacheForTests } from "../lib/trusted-origin.js";

function fakeReq(opts: {
  host?: string;
  xForwardedHost?: string;
  xForwardedProto?: string;
  secure?: boolean;
}): import("express").Request {
  const headers: Record<string, string | undefined> = {};
  if (opts.host !== undefined) headers.host = opts.host;
  if (opts.xForwardedHost !== undefined)
    headers["x-forwarded-host"] = opts.xForwardedHost;
  if (opts.xForwardedProto !== undefined)
    headers["x-forwarded-proto"] = opts.xForwardedProto;
  return {
    headers,
    secure: opts.secure ?? false,
  } as unknown as import("express").Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetTrustedOriginCacheForTests();
  (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST = "";
  (config as { ROUTING_MODE: string }).ROUTING_MODE = "real";
  (config as { corsAllowedOrigins: string[] }).corsAllowedOrigins = [
    "https://droplet-ai.local",
  ];
  vi.mocked(openwrt.fetchDuckDnsStatus).mockResolvedValue({
    configured: false,
  });
});

describe("webdavBaseUrl (device-client WebDAV/server URL)", () => {
  it("excludes a forged X-Forwarded-Host from the WebDAV URL", async () => {
    const url = await webdavBaseUrl(
      fakeReq({
        host: "droplet-ai.local",
        xForwardedHost: "evil.example",
        xForwardedProto: "https",
      }),
    );
    expect(url).toBe("https://droplet-ai.local/nextcloud");
    expect(url).not.toContain("evil.example");
  });

  it("builds the WebDAV URL from the configured canonical origin", async () => {
    (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST =
      "studio.duckdns.org";
    const url = await webdavBaseUrl(
      fakeReq({ host: "droplet-ai.local", xForwardedProto: "https" }),
    );
    expect(url).toBe("https://studio.duckdns.org/nextcloud");
  });

  it("preserves the legitimate allowlisted dashboard host", async () => {
    const url = await webdavBaseUrl(
      fakeReq({ host: "droplet-ai.local", xForwardedProto: "https" }),
    );
    expect(url).toBe("https://droplet-ai.local/nextcloud");
  });

  it("preserves the legitimate mDNS host (droplet.local is a cert SAN)", async () => {
    // A native client reaching the box over mDNS at droplet.local must still
    // get a droplet.local WebDAV URL — it is a real served host, not a forgery.
    const url = await webdavBaseUrl(
      fakeReq({ host: "droplet.local", xForwardedProto: "https" }),
    );
    expect(url).toBe("https://droplet.local/nextcloud");
  });

  it("falls back to the safe default when the host is forged and no canonical origin", async () => {
    const url = await webdavBaseUrl(
      fakeReq({ host: "evil.example", xForwardedHost: "evil.example" }),
    );
    expect(url).toBe("https://droplet-ai.local/nextcloud");
    expect(url).not.toContain("evil.example");
  });

  it("the /nextcloud suffix strips cleanly for the pair-QR server value", async () => {
    // device-clients does webdavBaseUrl(req).replace(/\/nextcloud$/, "") to get
    // the bare server origin for the droplet://pair QR. Guard that contract.
    const url = await webdavBaseUrl(
      fakeReq({ host: "droplet-ai.local", xForwardedProto: "https" }),
    );
    expect(url.replace(/\/nextcloud$/, "")).toBe("https://droplet-ai.local");
  });
});
