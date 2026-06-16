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
 *   - host prefers `x-forwarded-host`, then `host`.
 */
import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { deriveWebAuthnRp } from "./webauthn-config.js";

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

  it("prefers x-forwarded-host over host", () => {
    const rp = deriveWebAuthnRp(
      fakeReq({ host: "internal:3000", xfHost: "droplet.local", xfProto: "https" }),
    );
    expect(rp.rpID).toBe("droplet.local");
    expect(rp.origin).toBe("https://droplet.local");
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
