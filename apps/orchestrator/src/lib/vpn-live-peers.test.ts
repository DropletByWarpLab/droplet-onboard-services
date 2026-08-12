import { describe, it, expect, vi } from "vitest";
import {
  buildLivePeerState,
  readLivePeerState,
  type LiveVpnPeerWire,
} from "./vpn-live-peers.js";

const KEY_A = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=";
const KEY_B = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";

describe("buildLivePeerState", () => {
  it("reports a handshake the interface actually observed", () => {
    const state = buildLivePeerState([
      { public_key: KEY_A, latest_handshake: 1_754_000_000 },
    ]);

    expect(state.available).toBe(true);
    expect(state.forPeer(KEY_A)).toEqual({
      provisioned: true,
      lastHandshakeAt: new Date(1_754_000_000_000).toISOString(),
    });
  });

  it("distinguishes NEVER from UNKNOWN — the WARP-1389 collapse", () => {
    // Same peer shape, one difference: whether routing reported the field.
    // These must NOT produce the same DTO, or a routing build that predates
    // the enrichment renders every device as never-connected.
    const never = buildLivePeerState([
      { public_key: KEY_A, latest_handshake: 0 },
    ]).forPeer(KEY_A);
    const unknown = buildLivePeerState([{ public_key: KEY_A }]).forPeer(KEY_A);

    expect(never).toEqual({ provisioned: true, lastHandshakeAt: null });
    expect(unknown).toEqual({ provisioned: true });
    // Not just `undefined` — the KEY has to be absent, because the route
    // spreads these facts into the peer DTO and `res.json` only drops keys
    // whose value is undefined if the key is genuinely missing from the
    // object it serializes.
    expect(Object.keys(unknown)).not.toContain("lastHandshakeAt");
  });

  it("treats a malformed epoch as unobserved rather than as a 1970 handshake", () => {
    for (const latest of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const facts = buildLivePeerState([
        { public_key: KEY_A, latest_handshake: latest },
      ]).forPeer(KEY_A);
      expect(facts).toEqual({ provisioned: true });
    }
  });

  it("marks a peer the interface does not carry as not provisioned", () => {
    // The WARP-1757 `tunnel_ready: false` shape: the DB row exists and is
    // active, but the router-side install never landed. The owner needs to see
    // that as its own state — re-approving is the documented recovery.
    const state = buildLivePeerState([
      { public_key: KEY_A, latest_handshake: 1_754_000_000 },
    ]);

    expect(state.forPeer(KEY_B)).toEqual({ provisioned: false });
    expect(Object.keys(state.forPeer(KEY_B))).not.toContain("lastHandshakeAt");
  });

  it("ignores wire entries with no usable key rather than indexing on empty string", () => {
    const state = buildLivePeerState([
      { public_key: "", latest_handshake: 5 },
      { public_key: KEY_A, latest_handshake: 5 },
    ] as LiveVpnPeerWire[]);

    expect(state.forPeer("")).toEqual({ provisioned: false });
    expect(state.forPeer(KEY_A).provisioned).toBe(true);
  });
});

describe("readLivePeerState", () => {
  it("degrades to unavailable — and reports NOTHING per peer — when routing throws", async () => {
    const onError = vi.fn();
    const boom = new Error("routing sidecar unreachable");

    const state = await readLivePeerState(() => Promise.reject(boom), onError);

    expect(state.available).toBe(false);
    // The critical assertion: an unreachable sidecar must not answer
    // "provisioned: false" for every device. That would read as "your linked
    // phone is gone" during a routine restart.
    expect(state.forPeer(KEY_A)).toEqual({});
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("does not swallow the reader's result on the happy path", async () => {
    const onError = vi.fn();

    const state = await readLivePeerState(
      async () => [{ public_key: KEY_A, latest_handshake: 0 }],
      onError,
    );

    expect(state.available).toBe(true);
    expect(state.forPeer(KEY_A)).toEqual({
      provisioned: true,
      lastHandshakeAt: null,
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
