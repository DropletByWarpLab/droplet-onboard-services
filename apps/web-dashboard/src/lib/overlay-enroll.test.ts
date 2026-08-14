/**
 * WARP-1475 — overlay QR-enroll pure helpers.
 *
 * `buildOverlayEnrollUri` encodes the owner-minted link token into the
 * `droplet://overlay-enroll` deep link the QR carries. Every param is
 * URL-encoded — the token is base64url (already URL-safe) but the box name
 * and server host can contain spaces / colons, so they must be escaped or
 * the mobile app parses a truncated URI.
 *
 * `overlayApproveErrorCopy` turns the orchestrator's typed approve failures
 * (the 409 codes + the 503 vouch-retry) into honest, customer-safe copy —
 * never a generic "something went wrong".
 */
import { describe, it, expect } from "vitest";
import { buildOverlayEnrollUri, overlayApproveErrorCopy } from "./overlay-enroll";

describe("buildOverlayEnrollUri", () => {
  it("builds the droplet:// deep link with all three params", () => {
    const uri = buildOverlayEnrollUri({
      server: "box.example",
      token: "abcABC-_0123",
      boxName: "Droplet",
    });
    expect(uri).toBe(
      "droplet://overlay-enroll?server=box.example&token=abcABC-_0123&box_name=Droplet",
    );
  });

  it("URL-encodes a box name that contains spaces (%20, never +)", () => {
    const uri = buildOverlayEnrollUri({
      server: "box.example",
      token: "t0ken",
      boxName: "Front Desk iPad",
    });
    expect(uri).toContain("box_name=Front%20Desk%20iPad");
    expect(uri).not.toContain("+");
  });

  // The encoder must handle a colon, but the example is deliberately NOT the
  // WireGuard port: WARP-1593: `server` is the HTTPS enroll API host, and the
  // orchestrator now refuses to mint a QR carrying a WG transport address.
  it("URL-encodes a server host with a port colon", () => {
    const uri = buildOverlayEnrollUri({
      server: "box.example:8443",
      token: "t0ken",
      boxName: "Droplet",
    });
    expect(uri).toContain("server=box.example%3A8443");
  });

  it("leaves a base64url token byte-for-byte intact (no %-escapes)", () => {
    const token = "aZ09-_aZ09-_aZ09";
    const uri = buildOverlayEnrollUri({ server: "s", token, boxName: "b" });
    expect(uri).toContain(`token=${token}`);
  });

  it("escapes an ampersand injected into a param so it cannot forge a new key", () => {
    const uri = buildOverlayEnrollUri({
      server: "s",
      token: "t",
      boxName: "evil&token=hijacked",
    });
    expect(uri).toContain("box_name=evil%26token%3Dhijacked");
    // Only ONE real token= key.
    expect(uri.match(/[?&]token=/g)).toHaveLength(1);
  });
});

describe("overlayApproveErrorCopy", () => {
  it("maps already_being_approved to a refresh-oriented message", () => {
    const copy = overlayApproveErrorCopy({ status: 409, code: "already_being_approved" });
    expect(copy).toMatch(/already/i);
    expect(copy).not.toMatch(/something went wrong/i);
  });

  it("maps wg_key_conflict to an honest key-collision message", () => {
    const copy = overlayApproveErrorCopy({ status: 409, code: "wg_key_conflict" });
    expect(copy).toMatch(/key/i);
  });

  it("maps overlay_device_cap_reached to a limit message", () => {
    const copy = overlayApproveErrorCopy({ status: 409, code: "overlay_device_cap_reached" });
    expect(copy).toMatch(/limit/i);
  });

  it("maps the 'cannot approve a <state> enrollment' guard to a refresh message", () => {
    const copy = overlayApproveErrorCopy({
      status: 409,
      code: "cannot approve a denied enrollment",
    });
    expect(copy).toMatch(/refresh|no longer/i);
  });

  it("surfaces the orchestrator's own honest 503 sentence for the vouch retry", () => {
    const serverCopy =
      "Couldn't reach the fleet directory to finish linking this device. It's back in your review queue — try approving again in a minute.";
    const copy = overlayApproveErrorCopy({ status: 503, code: serverCopy, message: serverCopy });
    expect(copy).toBe(serverCopy);
  });

  it("falls back to a safe generic message for an unknown code", () => {
    const copy = overlayApproveErrorCopy({ status: 500, code: undefined, message: undefined });
    expect(copy).toMatch(/couldn't|try again/i);
  });

  it("never leaks a raw browser/network error message to the owner", () => {
    // A network drop rejects with a TypeError carrying a technical message and
    // no status/code — it must NOT surface verbatim (WARP-294 rule).
    const copy = overlayApproveErrorCopy({ message: "Failed to fetch" });
    expect(copy).toBe("Couldn't approve this device. Try again.");
    expect(copy).not.toMatch(/failed to fetch/i);
  });

  it("never leaks an unmapped code or api.ts's technical fallback string", () => {
    // An unmapped 4xx code (api.ts sets code+message to it) must map to fixed
    // copy, not echo the raw snake_case code.
    const unmapped = overlayApproveErrorCopy({
      status: 400,
      code: "malformed_request",
      message: "malformed_request",
    });
    expect(unmapped).toBe("Couldn't approve this device. Try again.");
    expect(unmapped).not.toMatch(/malformed_request/);

    // A bare 5xx whose only message is api.ts's technical fallback.
    const bare500 = overlayApproveErrorCopy({
      status: 500,
      message: "Failed to approve enrollment: 500",
    });
    expect(bare500).not.toMatch(/Failed to approve enrollment/);
  });

  it("uses fixed 503 copy when the orchestrator supplied no sentence (bare 503)", () => {
    // No `code` => api.ts fell back to the technical message; don't surface it.
    const copy = overlayApproveErrorCopy({
      status: 503,
      message: "Failed to approve enrollment: 503",
    });
    expect(copy).not.toMatch(/Failed to approve enrollment/);
    expect(copy).toMatch(/fleet directory|review queue|try approving again/i);
  });
});
