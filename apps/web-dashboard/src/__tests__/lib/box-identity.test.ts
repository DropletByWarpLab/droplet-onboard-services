/**
 * WARP-992 — canonical box display identity (client half).
 *
 * The regression: the orchestrator's self-registered Device row used to hold
 * `os.hostname()` — the docker CONTAINER ID — and the Home header rendered
 * "5639146fdc76 · Status unavailable" as the appliance identity. The server
 * now registers the canonical name, but stale rows survive upgrades (and the
 * devices:list cache holds them for 60s), so the client resolver must mask
 * anything that still looks like a bare container id.
 */
import { describe, it, expect } from "vitest";
import { boxDisplayHost, LAN_FALLBACK_HOST } from "@/lib/box-identity";

describe("boxDisplayHost", () => {
  it("passes a real owner-chosen name through untouched", () => {
    expect(boxDisplayHost("aurora-loft")).toBe("aurora-loft");
  });

  it("passes a per-device FQDN through untouched", () => {
    expect(boxDisplayHost("d-0123456789abcdef.droplet-us.com")).toBe(
      "d-0123456789abcdef.droplet-us.com",
    );
  });

  it("passes the LAN name and an IP through untouched", () => {
    expect(boxDisplayHost("droplet.local")).toBe("droplet.local");
    expect(boxDisplayHost("192.168.1.87")).toBe("192.168.1.87");
  });

  it("masks a short docker container id (the WARP-992 leak) to the LAN name", () => {
    expect(boxDisplayHost("5639146fdc76")).toBe(LAN_FALLBACK_HOST);
  });

  it("masks a full-length container id too", () => {
    expect(boxDisplayHost("a".repeat(64))).toBe(LAN_FALLBACK_HOST);
    expect(boxDisplayHost("0123456789abcdef".repeat(4))).toBe(LAN_FALLBACK_HOST);
  });

  it("falls back to the LAN name while the device row hasn't loaded", () => {
    expect(boxDisplayHost(undefined)).toBe(LAN_FALLBACK_HOST);
    expect(boxDisplayHost(null)).toBe(LAN_FALLBACK_HOST);
    expect(boxDisplayHost("")).toBe(LAN_FALLBACK_HOST);
    expect(boxDisplayHost("   ")).toBe(LAN_FALLBACK_HOST);
  });

  it("does not mask hex-looking values outside the container-id length band", () => {
    // 11 hex chars (too short) and 65 (too long) are not container ids.
    expect(boxDisplayHost("abcdef01234")).toBe("abcdef01234");
    expect(boxDisplayHost("a".repeat(65))).toBe("a".repeat(65));
  });
});
