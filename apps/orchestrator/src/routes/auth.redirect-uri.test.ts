/**
 * PR #486 review finding 2 (host-header trust, non-invite surfaces) —
 * `getRedirectUri` builds the OAuth2 callback `redirect_uri` handed to the
 * IdP (the box's own Nextcloud). It previously trusted `req.headers.host`
 * verbatim, so a forged Host/X-Forwarded-Host poisoned the issued redirect_uri.
 *
 * It now sources the host from the shared trusted-origin resolver (canonical
 * origin -> allowlisted request host -> safe default). Because the OAuth2
 * authorize-time and token-exchange-time redirect_uri must be byte-identical,
 * BOTH call sites use this one helper — so hardening it also closes a latent
 * mismatch where the two requests could compute different hosts.
 *
 * Focused harness: imports `getRedirectUri` directly (no router/prisma) and
 * mocks config + the routing client the resolver reads.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { getRedirectUri } from "./auth.js";
import { config } from "../config.js";
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
  (config as { corsAllowedOrigins: string[] }).corsAllowedOrigins = [
    "https://droplet-ai.local",
  ];
});

describe("getRedirectUri (OAuth2 callback redirect_uri)", () => {
  it("excludes a forged X-Forwarded-Host from the redirect_uri", async () => {
    const uri = await getRedirectUri(
      fakeReq({
        host: "droplet-ai.local",
        xForwardedHost: "evil.example",
        xForwardedProto: "https",
      }),
    );
    expect(uri).toBe("https://droplet-ai.local/api/auth/callback");
    expect(uri).not.toContain("evil.example");
  });

  it("builds the redirect_uri from the configured canonical origin", async () => {
    (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST =
      "studio.example.com";
    const uri = await getRedirectUri(
      fakeReq({ host: "droplet-ai.local", xForwardedProto: "https" }),
    );
    expect(uri).toBe("https://studio.example.com/api/auth/callback");
  });

  it("preserves the legitimate allowlisted request host (happy path)", async () => {
    const uri = await getRedirectUri(
      fakeReq({ host: "droplet-ai.local", xForwardedProto: "https" }),
    );
    expect(uri).toBe("https://droplet-ai.local/api/auth/callback");
  });

  it("falls back to the safe default when the host is forged and no canonical origin", async () => {
    const uri = await getRedirectUri(
      fakeReq({ host: "evil.example", xForwardedHost: "evil.example" }),
    );
    expect(uri).toBe("https://droplet-ai.local/api/auth/callback");
    expect(uri).not.toContain("evil.example");
  });

  it("authorize-time and callback-time calls produce a byte-identical redirect_uri", async () => {
    // The OAuth2 round-trip requires the two redirect_uri values to match.
    // Even if the proxy presents different request hosts, the canonical origin
    // pins them to the same value.
    (config as { WIREGUARD_ENDPOINT_HOST: string }).WIREGUARD_ENDPOINT_HOST =
      "studio.example.com";
    const authorize = await getRedirectUri(
      fakeReq({ host: "droplet-ai.local", xForwardedProto: "https" }),
    );
    const callback = await getRedirectUri(
      fakeReq({ host: "127.0.0.1:3000", xForwardedProto: "https" }),
    );
    expect(authorize).toBe(callback);
  });
});
