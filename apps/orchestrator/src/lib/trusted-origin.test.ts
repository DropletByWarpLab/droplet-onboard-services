import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config BEFORE importing the helper so the env-validated `config` object
// is the test fixture, not the production zod-validated one. The allowlist is
// derived from `config.corsAllowedOrigins` (the box's own trusted LAN/dashboard
// origins) so a forged X-Forwarded-Host can never be honoured.
vi.mock("../config.js", () => ({
  config: {
    // ADR-023: top-priority canonical origin, above WIREGUARD_ENDPOINT_HOST.
    DROPLET_PUBLIC_FQDN: "",
    DROPLET_LAN_HOSTNAME: "",
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import {
  resolveTrustedOrigin,
  pickTrustedHost,
  trustedOriginUrl,
  _resetTrustedOriginCacheForTests,
} from "./trusted-origin.js";
import { config } from "../config.js";

/** Minimal Express-request stand-in: only the fields the helper reads. */
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
  Object.assign(config, { DROPLET_PUBLIC_FQDN: "" });
  (config as { DROPLET_LAN_HOSTNAME: string }).DROPLET_LAN_HOSTNAME = "";
  (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST = "";
  (config as { corsAllowedOrigins: string[] }).corsAllowedOrigins = [
    "https://droplet-ai.local",
  ];
});

// ── pickTrustedHost: the pure host-allowlist core (no async, no I/O) ──
describe("pickTrustedHost", () => {
  it("rejects a forged X-Forwarded-Host not on the allowlist", () => {
    const host = pickTrustedHost(
      fakeReq({
        host: "droplet-ai.local",
        xForwardedHost: "evil.example",
        xForwardedProto: "https",
      }),
      { canonicalHost: null, allowedHosts: new Set(["droplet-ai.local"]) },
    );
    // The forwarded host is the proxy's claim of the client-facing host; when
    // it is forged we do NOT silently fall through to the direct Host (the
    // request is already suspect). The picker returns null and the caller
    // applies the safe default.
    expect(host).toBeNull();
    expect(host).not.toBe("evil.example");
  });

  it("honours an allowlisted X-Forwarded-Host (legitimate nginx proxy)", () => {
    const host = pickTrustedHost(
      fakeReq({
        host: "127.0.0.1:3000",
        xForwardedHost: "droplet-ai.local",
        xForwardedProto: "https",
      }),
      { canonicalHost: null, allowedHosts: new Set(["droplet-ai.local"]) },
    );
    expect(host).toBe("droplet-ai.local");
  });

  it("honours an allowlisted plain Host header", () => {
    const host = pickTrustedHost(fakeReq({ host: "droplet-ai.local" }), {
      canonicalHost: null,
      allowedHosts: new Set(["droplet-ai.local"]),
    });
    expect(host).toBe("droplet-ai.local");
  });

  it("prefers the canonical host over any request header", () => {
    const host = pickTrustedHost(
      fakeReq({
        host: "droplet-ai.local",
        xForwardedHost: "droplet-ai.local",
      }),
      {
        canonicalHost: "studio.lan",
        allowedHosts: new Set(["studio.lan", "droplet-ai.local"]),
      },
    );
    expect(host).toBe("studio.lan");
  });

  it("falls back to the canonical host when the request host is forged", () => {
    const host = pickTrustedHost(
      fakeReq({ host: "evil.example", xForwardedHost: "also-evil.example" }),
      {
        canonicalHost: "studio.lan",
        allowedHosts: new Set(["studio.lan", "droplet-ai.local"]),
      },
    );
    expect(host).toBe("studio.lan");
  });

  it("host-header port is normalised against a bare allowlist host", () => {
    // Allowlist holds the bare host; an inbound :443 / :80 must still match.
    const host = pickTrustedHost(
      fakeReq({ host: "droplet-ai.local:443", xForwardedProto: "https" }),
      { canonicalHost: null, allowedHosts: new Set(["droplet-ai.local"]) },
    );
    expect(host).toBe("droplet-ai.local");
  });

  it("matches the allowlist case-insensitively (DNS hosts are case-insensitive)", () => {
    const host = pickTrustedHost(
      fakeReq({ xForwardedHost: "Droplet-AI.Local", xForwardedProto: "https" }),
      { canonicalHost: null, allowedHosts: new Set(["droplet-ai.local"]) },
    );
    expect(host).toBe("droplet-ai.local");
  });

  it("returns null when nothing is trustworthy (no canonical, forged host)", () => {
    const host = pickTrustedHost(fakeReq({ host: "evil.example" }), {
      canonicalHost: null,
      allowedHosts: new Set(["droplet-ai.local"]),
    });
    expect(host).toBeNull();
  });
});

// ── resolveTrustedOrigin: internal canonical-origin resolution ──
describe("resolveTrustedOrigin", () => {
  it("uses internal DNS even when stale fleet and UDP endpoint values exist", async () => {
    Object.assign(config, {
      DROPLET_LAN_HOSTNAME: "office.lan",
      DROPLET_PUBLIC_FQDN: "old.devices.warp-lab.ai",
      WIREGUARD_ENDPOINT_HOST: "vpn.example.com",
    });
    const { canonicalHost, allowedHosts } = await resolveTrustedOrigin();
    expect(canonicalHost).toBe("office.lan");
    expect(allowedHosts.has("office.lan")).toBe(true);
    expect(allowedHosts.has("old.devices.warp-lab.ai")).toBe(false);
    expect(allowedHosts.has("vpn.example.com")).toBe(false);
    expect(await trustedOriginUrl(fakeReq({ host: "evil.example" }), "/api/auth/callback"))
      .toBe("https://office.lan/api/auth/callback");
  });

  it("does not use a UDP endpoint or fleet name as a web origin", async () => {
    Object.assign(config, { DROPLET_PUBLIC_FQDN: "old.devices.warp-lab.ai", WIREGUARD_ENDPOINT_HOST: "vpn.example.com" });
    expect((await resolveTrustedOrigin()).canonicalHost).toBeNull();
  });

  it("uses the configured internal hostname as the canonical host", async () => {
    (config as { DROPLET_LAN_HOSTNAME: string }).DROPLET_LAN_HOSTNAME =
      "studio.lan";
    const { canonicalHost } = await resolveTrustedOrigin();
    expect(canonicalHost).toBe("studio.lan");
  });

  it("has no canonical host when the internal hostname is not set", async () => {
    const { canonicalHost } = await resolveTrustedOrigin();
    expect(canonicalHost).toBeNull();
  });

  it("always includes the box's own trusted origins in the allowlist", async () => {
    const { allowedHosts } = await resolveTrustedOrigin();
    expect(allowedHosts.has("droplet-ai.local")).toBe(true);
  });

  it("adds the canonical host to the allowlist", async () => {
    (config as { DROPLET_LAN_HOSTNAME: string }).DROPLET_LAN_HOSTNAME =
      "studio.lan";
    const { allowedHosts } = await resolveTrustedOrigin();
    expect(allowedHosts.has("studio.lan")).toBe(true);
    expect(allowedHosts.has("droplet-ai.local")).toBe(true);
  });
});

// ── trustedOriginUrl: end-to-end origin + path assembly ──
describe("trustedOriginUrl", () => {
  it("excludes a forged X-Forwarded-Host from the issued URL", async () => {
    const url = await trustedOriginUrl(
      fakeReq({
        host: "droplet-ai.local",
        xForwardedHost: "evil.example",
        xForwardedProto: "https",
      }),
      "/api/auth/callback",
    );
    expect(url).toBe("https://droplet-ai.local/api/auth/callback");
    expect(url).not.toContain("evil.example");
  });

  it("builds the URL from the configured canonical origin", async () => {
    (config as { DROPLET_LAN_HOSTNAME: string }).DROPLET_LAN_HOSTNAME =
      "studio.lan";
    const url = await trustedOriginUrl(
      fakeReq({ host: "droplet-ai.local", xForwardedProto: "https" }),
      "/api/auth/callback",
    );
    expect(url).toBe("https://studio.lan/api/auth/callback");
  });

  it("preserves a legitimate allowlisted request host", async () => {
    const url = await trustedOriginUrl(
      fakeReq({ host: "droplet-ai.local", xForwardedProto: "https" }),
      "/api/auth/callback",
    );
    expect(url).toBe("https://droplet-ai.local/api/auth/callback");
  });

  it("falls back to the safe default origin when host is forged and no canonical", async () => {
    const url = await trustedOriginUrl(
      fakeReq({ host: "evil.example", xForwardedHost: "evil.example" }),
      "/api/auth/callback",
    );
    expect(url).toBe("https://droplet-ai.local/api/auth/callback");
    expect(url).not.toContain("evil.example");
  });

  it("normalises a path that is missing its leading slash", async () => {
    const url = await trustedOriginUrl(
      fakeReq({ host: "droplet-ai.local" }),
      "api/auth/callback",
    );
    expect(url).toBe("https://droplet-ai.local/api/auth/callback");
  });

  it("a canonical https origin forces https even on a plain-http request", async () => {
    (config as { DROPLET_LAN_HOSTNAME: string }).DROPLET_LAN_HOSTNAME =
      "studio.lan";
    const url = await trustedOriginUrl(
      fakeReq({ host: "droplet-ai.local", secure: false }),
      "/api/auth/callback",
    );
    expect(url.startsWith("https://")).toBe(true);
  });
});
