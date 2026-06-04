import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config BEFORE importing the helper so the env-validated `config` object
// is the test fixture, not the production zod-validated one. The allowlist is
// derived from `config.corsAllowedOrigins` (the box's own trusted LAN/dashboard
// origins) so a forged X-Forwarded-Host can never be honoured.
vi.mock("../config.js", () => ({
  config: {
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
  },
}));

// DuckDNS is the second canonical-origin source after the env override. Default
// each test to "not configured"; the DuckDNS-fallback branch is exercised
// explicitly where needed.
vi.mock("../services/openwrt.client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/openwrt.client.js")
  >("../services/openwrt.client.js");
  return {
    ...actual,
    fetchDuckDnsStatus: vi.fn(async () => ({ configured: false as const })),
  };
});

import {
  buildInviteUrl,
  resolveInviteOrigin,
  pickInviteHost,
  _resetInviteOriginCacheForTests,
} from "./invite-url.js";
import { config } from "../config.js";
import * as openwrt from "../services/openwrt.client.js";

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

const TOKEN = "abc123token";

beforeEach(() => {
  _resetInviteOriginCacheForTests();
  (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST = "";
  (config as { corsAllowedOrigins: string[] }).corsAllowedOrigins = [
    "https://droplet-ai.local",
  ];
  vi.mocked(openwrt.fetchDuckDnsStatus).mockResolvedValue({
    configured: false,
  });
});

// ── pickInviteHost: the pure host-allowlist core (no async, no I/O) ──
describe("pickInviteHost", () => {
  it("rejects a forged X-Forwarded-Host not on the allowlist", () => {
    const host = pickInviteHost(
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
    // applies the safe default — see buildInviteUrl's forged-header test.
    expect(host).toBeNull();
    expect(host).not.toBe("evil.example");
  });

  it("honours an allowlisted X-Forwarded-Host (legitimate nginx proxy)", () => {
    const host = pickInviteHost(
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
    const host = pickInviteHost(fakeReq({ host: "droplet-ai.local" }), {
      canonicalHost: null,
      allowedHosts: new Set(["droplet-ai.local"]),
    });
    expect(host).toBe("droplet-ai.local");
  });

  it("prefers the canonical host over any request header", () => {
    const host = pickInviteHost(
      fakeReq({
        host: "droplet-ai.local",
        xForwardedHost: "droplet-ai.local",
      }),
      {
        canonicalHost: "studio.duckdns.org",
        allowedHosts: new Set(["studio.duckdns.org", "droplet-ai.local"]),
      },
    );
    expect(host).toBe("studio.duckdns.org");
  });

  it("falls back to the canonical host when the request host is forged", () => {
    const host = pickInviteHost(
      fakeReq({ host: "evil.example", xForwardedHost: "also-evil.example" }),
      {
        canonicalHost: "studio.duckdns.org",
        allowedHosts: new Set(["studio.duckdns.org", "droplet-ai.local"]),
      },
    );
    expect(host).toBe("studio.duckdns.org");
  });

  it("host-header port is normalised against a bare allowlist host", () => {
    // Allowlist holds the bare host; an inbound :443 / :80 must still match.
    const host = pickInviteHost(
      fakeReq({ host: "droplet-ai.local:443", xForwardedProto: "https" }),
      { canonicalHost: null, allowedHosts: new Set(["droplet-ai.local"]) },
    );
    expect(host).toBe("droplet-ai.local");
  });

  it("matches the allowlist case-insensitively (DNS hosts are case-insensitive)", () => {
    const host = pickInviteHost(
      fakeReq({ xForwardedHost: "Droplet-AI.Local", xForwardedProto: "https" }),
      { canonicalHost: null, allowedHosts: new Set(["droplet-ai.local"]) },
    );
    expect(host).toBe("droplet-ai.local");
  });

  it("returns null when nothing is trustworthy (no canonical, forged host)", () => {
    const host = pickInviteHost(fakeReq({ host: "evil.example" }), {
      canonicalHost: null,
      allowedHosts: new Set(["droplet-ai.local"]),
    });
    expect(host).toBeNull();
  });
});

// ── resolveInviteOrigin: canonical-origin resolution (env → DuckDNS) ──
describe("resolveInviteOrigin", () => {
  it("uses WIREGUARD_ENDPOINT_HOST verbatim as the canonical host", async () => {
    (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST =
      "studio.duckdns.org";
    const { canonicalHost } = await resolveInviteOrigin();
    expect(canonicalHost).toBe("studio.duckdns.org");
    // Env override wins without ever touching the routing service.
    expect(openwrt.fetchDuckDnsStatus).not.toHaveBeenCalled();
  });

  it("derives the canonical host from an enabled DuckDNS config", async () => {
    vi.mocked(openwrt.fetchDuckDnsStatus).mockResolvedValue({
      configured: true,
      subdomain: "studio",
      fullDomain: "studio.duckdns.org",
      enabled: true,
      tokenSet: true,
    });
    const { canonicalHost } = await resolveInviteOrigin();
    expect(canonicalHost).toBe("studio.duckdns.org");
  });

  it("ignores a DuckDNS config that is configured but not enabled", async () => {
    vi.mocked(openwrt.fetchDuckDnsStatus).mockResolvedValue({
      configured: true,
      subdomain: "studio",
      fullDomain: "studio.duckdns.org",
      enabled: false,
      tokenSet: true,
    });
    const { canonicalHost } = await resolveInviteOrigin();
    expect(canonicalHost).toBeNull();
  });

  it("treats a routing-service failure as no canonical host (non-fatal)", async () => {
    vi.mocked(openwrt.fetchDuckDnsStatus).mockRejectedValue(
      new Error("routing down"),
    );
    const { canonicalHost } = await resolveInviteOrigin();
    expect(canonicalHost).toBeNull();
  });

  it("always includes the box's own trusted origins in the allowlist", async () => {
    const { allowedHosts } = await resolveInviteOrigin();
    expect(allowedHosts.has("droplet-ai.local")).toBe(true);
  });

  it("adds the canonical host to the allowlist", async () => {
    (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST =
      "studio.duckdns.org";
    const { allowedHosts } = await resolveInviteOrigin();
    expect(allowedHosts.has("studio.duckdns.org")).toBe(true);
    expect(allowedHosts.has("droplet-ai.local")).toBe(true);
  });
});

// ── buildInviteUrl: end-to-end URL assembly ──
describe("buildInviteUrl", () => {
  it("excludes a forged X-Forwarded-Host from the issued URL", async () => {
    const url = await buildInviteUrl(
      fakeReq({
        host: "droplet-ai.local",
        xForwardedHost: "evil.example",
        xForwardedProto: "https",
      }),
      TOKEN,
    );
    expect(url).toBe(`https://droplet-ai.local/invite/${TOKEN}`);
    expect(url).not.toContain("evil.example");
  });

  it("builds the link from the configured canonical origin", async () => {
    (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST =
      "studio.duckdns.org";
    const url = await buildInviteUrl(
      fakeReq({ host: "droplet-ai.local", xForwardedProto: "https" }),
      TOKEN,
    );
    expect(url).toBe(`https://studio.duckdns.org/invite/${TOKEN}`);
  });

  it("preserves the legitimate nginx-proxy host (https + allowlisted Host)", async () => {
    const url = await buildInviteUrl(
      fakeReq({ host: "droplet-ai.local", xForwardedProto: "https" }),
      TOKEN,
    );
    expect(url).toBe(`https://droplet-ai.local/invite/${TOKEN}`);
  });

  it("falls back to the canonical origin when the request host is forged", async () => {
    (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST =
      "studio.duckdns.org";
    const url = await buildInviteUrl(
      fakeReq({ host: "evil.example", xForwardedHost: "evil.example" }),
      TOKEN,
    );
    expect(url).toBe(`https://studio.duckdns.org/invite/${TOKEN}`);
  });

  it("falls back to the safe default origin when there is no canonical origin and the host is forged", async () => {
    const url = await buildInviteUrl(
      fakeReq({ host: "evil.example", xForwardedHost: "evil.example" }),
      TOKEN,
    );
    // Safe, box-owned default — never the attacker's host.
    expect(url).toBe(`https://droplet-ai.local/invite/${TOKEN}`);
    expect(url).not.toContain("evil.example");
  });

  it("a canonical https origin forces https even on a plain-http request", async () => {
    (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST =
      "studio.duckdns.org";
    const url = await buildInviteUrl(
      fakeReq({ host: "droplet-ai.local", secure: false }),
      TOKEN,
    );
    expect(url.startsWith("https://")).toBe(true);
  });
});
