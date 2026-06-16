/**
 * PR #486 review finding 2 (host-header trust, non-invite surfaces) —
 * the SSO callback handler reconstructs `currentUrl` (handed to
 * openid-client's authorizationCodeGrant) from `req.headers.host`. openid-client
 * extracts the authorization-response query params (code/state/iss) from it and
 * validates state/nonce/PKCE against the server-side row — the HOST portion is
 * NOT compared against the redirect_uri (that comes from the provider config),
 * so sourcing the host from the canonical origin is behaviour-preserving while
 * removing the forged-header reflection.
 *
 * The query string (where the validated params live) MUST be preserved exactly.
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

import { buildSsoCallbackUrl } from "./sso.js";
import { config } from "../config.js";
import * as openwrt from "../services/openwrt.client.js";
import { _resetTrustedOriginCacheForTests } from "../lib/trusted-origin.js";

function fakeReq(opts: {
  host?: string;
  xForwardedHost?: string;
  xForwardedProto?: string;
  secure?: boolean;
  originalUrl: string;
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
    originalUrl: opts.originalUrl,
  } as unknown as import("express").Request;
}

const CB = "/api/sso/oidc/callback?code=abc123&state=fixed-state";

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

describe("buildSsoCallbackUrl (currentUrl for openid-client)", () => {
  it("excludes a forged X-Forwarded-Host from the reconstructed URL", async () => {
    const url = await buildSsoCallbackUrl(
      fakeReq({
        host: "droplet-ai.local",
        xForwardedHost: "evil.example",
        xForwardedProto: "https",
        originalUrl: CB,
      }),
    );
    expect(url.host).toBe("droplet-ai.local");
    expect(url.href).not.toContain("evil.example");
  });

  it("preserves the authorization-response query params exactly", async () => {
    const url = await buildSsoCallbackUrl(
      fakeReq({
        host: "droplet-ai.local",
        xForwardedHost: "evil.example",
        xForwardedProto: "https",
        originalUrl: CB,
      }),
    );
    // The validated params (code/state) must survive the host swap untouched.
    expect(url.searchParams.get("code")).toBe("abc123");
    expect(url.searchParams.get("state")).toBe("fixed-state");
    expect(url.pathname).toBe("/api/sso/oidc/callback");
  });

  it("builds from the configured canonical origin", async () => {
    (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST =
      "studio.duckdns.org";
    const url = await buildSsoCallbackUrl(
      fakeReq({
        host: "droplet-ai.local",
        xForwardedProto: "https",
        originalUrl: CB,
      }),
    );
    expect(url.host).toBe("studio.duckdns.org");
    expect(url.searchParams.get("code")).toBe("abc123");
  });

  it("preserves the legitimate allowlisted request host", async () => {
    const url = await buildSsoCallbackUrl(
      fakeReq({
        host: "droplet-ai.local",
        xForwardedProto: "https",
        originalUrl: CB,
      }),
    );
    expect(url.href).toBe(`https://droplet-ai.local${CB}`);
  });

  it("falls back to the safe default when the host is forged and no canonical origin", async () => {
    const url = await buildSsoCallbackUrl(
      fakeReq({
        host: "evil.example",
        xForwardedHost: "evil.example",
        originalUrl: CB,
      }),
    );
    expect(url.host).toBe("droplet-ai.local");
    expect(url.href).not.toContain("evil.example");
  });
});
