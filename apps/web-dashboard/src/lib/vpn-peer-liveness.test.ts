/**
 * WARP-1763 — the "enrolled vs provisioned vs connected" decision.
 *
 * The bug these lock down is a category error, not an off-by-one: the Home
 * widget counted active peer ROWS and called them "connected devices". A row
 * exists the moment a config is minted or a QR link is approved, so the count
 * was of devices that had been SET UP, and it would have read "1 connected
 * device" for a phone that had never once handshaken.
 */
import { describe, it, expect } from "vitest";
import {
  HANDSHAKE_FRESH_MS,
  countConnectedNow,
  isConnectedNow,
  peerConnectionCopy,
} from "./vpn-peer-liveness";
import type { VpnPeerInfo } from "./types";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function peer(over: Partial<VpnPeerInfo> = {}): VpnPeerInfo {
  return {
    id: "peer-1",
    userId: "overlay",
    deviceLabel: "Alice's iPhone",
    publicKey: "pk-1",
    assignedIp: "10.66.0.5",
    status: "active",
    createdAt: "2026-08-10T00:00:00.000Z",
    kind: "overlay",
    provisioned: true,
    ...over,
  };
}

function agoMs(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe("isConnectedNow", () => {
  it("is true only inside the freshness window", () => {
    expect(
      isConnectedNow(peer({ lastHandshakeAt: agoMs(30_000) }), true, NOW),
    ).toBe(true);
    expect(
      isConnectedNow(
        peer({ lastHandshakeAt: agoMs(HANDSHAKE_FRESH_MS + 1_000) }),
        true,
        NOW,
      ),
    ).toBe(false);
  });

  it("is false for a peer that has never handshaken", () => {
    // The whole point: approved and provisioned is NOT connected.
    expect(isConnectedNow(peer({ lastHandshakeAt: null }), true, NOW)).toBe(
      false,
    );
  });

  it("is false when the interface could not be read", () => {
    // A count cannot include what was never observed. Prose callers use
    // peerConnectionCopy, which says "unavailable" rather than "not connected".
    expect(
      isConnectedNow(peer({ lastHandshakeAt: agoMs(1_000) }), false, NOW),
    ).toBe(false);
  });

  it("is false for a revoked peer even with a recent handshake", () => {
    expect(
      isConnectedNow(
        peer({ status: "revoked", lastHandshakeAt: agoMs(1_000) }),
        true,
        NOW,
      ),
    ).toBe(false);
  });
});

describe("countConnectedNow", () => {
  it("counts handshakes, not rows — the WARP-1763 regression", () => {
    const peers = [
      peer({ id: "a", lastHandshakeAt: agoMs(10_000) }), // here
      peer({ id: "b", lastHandshakeAt: null }), // linked, never connected
      peer({ id: "c", lastHandshakeAt: agoMs(6 * 60 * 60 * 1000) }), // gone
    ];

    expect(peers.length).toBe(3);
    expect(countConnectedNow(peers, true, NOW)).toBe(1);
  });

  it("is zero when nothing was observed, so callers must withhold it", () => {
    const peers = [peer({ lastHandshakeAt: agoMs(1_000) })];
    expect(countConnectedNow(peers, false, NOW)).toBe(0);
  });
});

describe("peerConnectionCopy", () => {
  it("says the status is unavailable rather than inventing one", () => {
    expect(peerConnectionCopy(peer(), false, NOW)).toEqual({
      text: "Connection status unavailable",
      tone: "muted",
    });
  });

  it("flags a peer that never landed on the interface as needing re-approval", () => {
    // WARP-1757: the vouch succeeded but provisioning failed, so the row is
    // 'approved' with no usable peer. Re-approving is the documented recovery
    // and the copy has to point at it — the connect tick that would otherwise
    // self-heal ships disabled.
    expect(peerConnectionCopy(peer({ provisioned: false }), true, NOW)).toEqual({
      text: "Setup didn’t finish — approve it again",
      tone: "warn",
    });
  });

  it("separates never-connected from unknown", () => {
    const never = peerConnectionCopy(peer({ lastHandshakeAt: null }), true, NOW);
    // `lastHandshakeAt` absent entirely = the interface carried the peer but
    // did not report a handshake (an older routing build).
    const unknown = peerConnectionCopy(peer(), true, NOW);

    expect(never.text).toBe("Linked · not connected yet");
    expect(unknown.text).toBe("Linked");
    expect(never.text).not.toBe(unknown.text);
  });

  it("reports recency once the handshake is stale", () => {
    const copy = peerConnectionCopy(
      peer({ lastHandshakeAt: agoMs(2 * 60 * 60 * 1000) }),
      true,
      NOW,
    );
    expect(copy.tone).toBe("muted");
    expect(copy.text).toMatch(/^Last connected 2 hours ago$/);
  });

  it("treats a future handshake as clock skew, not as the future", () => {
    const copy = peerConnectionCopy(
      peer({ lastHandshakeAt: new Date(NOW.getTime() + 90_000).toISOString() }),
      true,
      NOW,
    );
    expect(copy).toEqual({ text: "Connected", tone: "ok" });
  });

  it("does not crash or claim presence on an unparseable timestamp", () => {
    const copy = peerConnectionCopy(
      peer({ lastHandshakeAt: "not-a-date" }),
      true,
      NOW,
    );
    expect(copy).toEqual({ text: "Linked", tone: "muted" });
  });
});
