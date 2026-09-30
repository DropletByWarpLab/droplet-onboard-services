/**
 * PR #377 (WARP-___) — WebAuthn RP config derivation.
 *
 * rpID + origin are derived FROM THE REQUEST, not from a hardcoded host and
 * not from a new env var (architecture-guard: no new MATTER_*; reuse the
 * existing config posture). This mirrors how auth.ts already builds
 * `getRedirectUri` / `buildInviteUrl` from `req.headers.host` +
 * `x-forwarded-proto`. Deriving from the request is what makes passkeys work
 * on the LAN with the WAN down: the rpID/origin reflect whatever host the
 * browser actually used to reach the box (`droplet.local`, an IP, etc.).
 *
 * Contract:
 *   - origin = `${proto}://${host}` (host includes the port if present).
 *   - rpID   = the hostname ONLY (no scheme, no port) — WebAuthn requires the
 *     RP ID to be a registrable domain suffix of the origin's host.
 *   - proto prefers `x-forwarded-proto` (nginx gateway), then `req.secure`.
 *   - host is the `Host` header ONLY. nginx forwards the client's Host header
 *     and never sets `X-Forwarded-Host`, so that header can only have come
 *     from the client and must not choose the RP (WARP-3229). The one
 *     exception is a developer stack, where `next dev` puts the browser's
 *     address there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request } from "express";
import { deriveWebAuthnRp } from "./webauthn-config.js";

// Every test starts in a shipped box's posture (nothing sets NODE_ENV there,
// setup.sh writes DROPLET_ENV=production), so the result does not depend on
// the shell the suite runs in. The developer-stack block overrides it.
beforeEach(() => {
  vi.stubEnv("NODE_ENV", undefined);
  vi.stubEnv("DROPLET_ENV", "production");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeReq(opts: {
  host?: string;
  xfHost?: string;
  xfProto?: string;
  secure?: boolean;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.host) headers.host = opts.host;
  if (opts.xfHost) headers["x-forwarded-host"] = opts.xfHost;
  if (opts.xfProto) headers["x-forwarded-proto"] = opts.xfProto;
  return {
    headers,
    secure: opts.secure ?? false,
  } as unknown as Request;
}

describe("deriveWebAuthnRp — rpID/origin from the request (LAN + air-gap safe)", () => {
  it("derives rpID = hostname and origin = proto://host for a .local LAN host", () => {
    const rp = deriveWebAuthnRp(fakeReq({ host: "droplet.local", secure: false }));
    expect(rp.rpID).toBe("droplet.local");
    expect(rp.origin).toBe("http://droplet.local");
  });

  it("strips the port from rpID but keeps it in origin", () => {
    const rp = deriveWebAuthnRp(fakeReq({ host: "droplet.local:3000", secure: false }));
    expect(rp.rpID).toBe("droplet.local");
    expect(rp.origin).toBe("http://droplet.local:3000");
  });

  it("honours x-forwarded-proto=https from the gateway", () => {
    const rp = deriveWebAuthnRp(
      fakeReq({ host: "droplet-ai.local", xfProto: "https", secure: false }),
    );
    expect(rp.origin).toBe("https://droplet-ai.local");
    expect(rp.rpID).toBe("droplet-ai.local");
  });

  it("ignores a client-supplied x-forwarded-host (nginx never sets it)", () => {
    const rp = deriveWebAuthnRp(
      fakeReq({ host: "droplet-ai.local", xfHost: "evil.example", xfProto: "https" }),
    );
    expect(rp.rpID).toBe("droplet-ai.local");
    expect(rp.origin).toBe("https://droplet-ai.local");
  });

  it("cannot be steered onto an IP by x-forwarded-host, nor off one", async () => {
    const { isIpRpId } = await import("./webauthn-config.js");
    const named = deriveWebAuthnRp(fakeReq({ host: "droplet-ai.local", xfHost: "192.168.9.195" }));
    expect(isIpRpId(named.rpID)).toBe(false);
    // The IP refusal still keys on the real Host.
    const ip = deriveWebAuthnRp(fakeReq({ host: "192.168.9.195", xfHost: "droplet-ai.local" }));
    expect(ip.rpID).toBe("192.168.9.195");
    expect(isIpRpId(ip.rpID)).toBe(true);
  });

  it("works for a bare LAN IP (no domain) — air-gap path", () => {
    const rp = deriveWebAuthnRp(fakeReq({ host: "192.168.1.87:3000", secure: false }));
    expect(rp.rpID).toBe("192.168.1.87");
    expect(rp.origin).toBe("http://192.168.1.87:3000");
  });

  it("uses req.secure when no x-forwarded-proto is present", () => {
    const rp = deriveWebAuthnRp(fakeReq({ host: "droplet.local", secure: true }));
    expect(rp.origin).toBe("https://droplet.local");
  });

  it("carries a stable, human RP name for the authenticator prompt", () => {
    const rp = deriveWebAuthnRp(fakeReq({ host: "droplet.local" }));
    expect(typeof rp.rpName).toBe("string");
    expect(rp.rpName.length).toBeGreaterThan(0);
  });
});

// WARP-3229 — the one place X-Forwarded-Host is still read. The `next dev`
// rewrite proxy sets Host to the orchestrator's own address and carries the
// address the browser used in X-Forwarded-Host.
describe("deriveWebAuthnRp — developer stack behind the next dev rewrite", () => {
  // What apps/web-dashboard/next.config.js sends in docker/docker-compose.dev.yml.
  const nextDevRequest = () =>
    fakeReq({ host: "orchestrator:3000", xfHost: "localhost:3001" });

  it("honours x-forwarded-host when NODE_ENV=development off a shipped box", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DROPLET_ENV", undefined);
    const rp = deriveWebAuthnRp(nextDevRequest());
    expect(rp.rpID).toBe("localhost");
    expect(rp.origin).toBe("http://localhost:3001");
  });

  it.each<[string, string | undefined, string | undefined]>([
    ["NODE_ENV unset, as on every box (WARP-2551)", undefined, undefined],
    ["NODE_ENV=production", "production", undefined],
    ["NODE_ENV=test", "test", undefined],
    ["NODE_ENV=development on a shipped box (DROPLET_ENV=production)", "development", "production"],
  ])("ignores it with %s", (_label, nodeEnv, dropletEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("DROPLET_ENV", dropletEnv);
    const rp = deriveWebAuthnRp(nextDevRequest());
    expect(rp.rpID).toBe("orchestrator");
    expect(rp.origin).toBe("http://orchestrator:3000");
  });
});

describe("isIpRpId (WARP-1157)", () => {
  it("flags IPv4 and IPv6 literals, not hostnames", async () => {
    const { isIpRpId } = await import("./webauthn-config.js");
    expect(isIpRpId("192.168.9.195")).toBe(true);
    expect(isIpRpId("fe80::1")).toBe(true);
    expect(isIpRpId("droplet-ai.local")).toBe(false);
    expect(isIpRpId("d-b5839920cb1b0d09.droplet-us.com")).toBe(false);
    expect(isIpRpId("localhost")).toBe(false);
  });
});
