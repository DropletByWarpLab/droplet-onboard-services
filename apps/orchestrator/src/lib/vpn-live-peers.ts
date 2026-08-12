/**
 * WARP-1763 — live peer facts, read from the running WireGuard interface.
 *
 * `GET /api/vpn/peers` answers from Postgres, which knows what was *intended*:
 * who enrolled, when they were approved, what address they were allocated. It
 * cannot know whether the tunnel ever came up. Those are different questions
 * and the dashboard had been answering the second with the first.
 *
 * The distinction this module exists to preserve is between **never** and
 * **unknown**, which is the WARP-1389 lesson repeated in a new place. There,
 * routing emitted `latest_handshake: 0` for both "this peer has never
 * handshaken" and "we couldn't read the interface", and the punch telemetry
 * duly reported a fabricated 0% success rate. Here the same collapse would
 * paint every linked device as dead whenever the routing sidecar is
 * restarting.
 *
 * So a fact is only ever reported when it was actually observed:
 *
 *   * routing unreachable        → `available: false`, no per-peer facts at all
 *   * peer absent from the wire  → `provisioned: false` (installed nowhere)
 *   * `latest_handshake` absent  → provisioned, but handshake UNKNOWN (older
 *                                  routing build) — the field is omitted
 *   * `latest_handshake === 0`   → provisioned, never handshaken → `null`
 *   * `latest_handshake > 0`     → an ISO timestamp
 *
 * `undefined` and `null` carry different meanings on purpose, and `res.json`
 * drops `undefined` keys — so "unknown" reaches the client as an absent field
 * rather than as a value it might compare against.
 */

/** What the routing service reports per peer. Structural on purpose so this
 *  unit-tests without importing the router client. */
export interface LiveVpnPeerWire {
  public_key: string;
  /** Epoch SECONDS of the last handshake; 0 = never. Absent on older routing
   *  builds, which is a different fact from 0 and is kept distinct. */
  latest_handshake?: number;
}

export interface LivePeerFacts {
  /** The running interface carries this key — i.e. the router-side install
   *  succeeded. A DB row marked active with `provisioned: false` is the
   *  WARP-1757 `tunnel_ready: false` case: approved, but the peer never made
   *  it onto wg0, and re-approving is the recovery. */
  provisioned?: boolean;
  /** ISO-8601 of the last handshake, or `null` when the interface reports a
   *  peer that has never handshaken. Absent when unobserved. */
  lastHandshakeAt?: string | null;
}

export interface LivePeerState {
  /** False when the routing service could not be read. Every `forPeer` is
   *  empty in that case — callers must surface "unavailable", not "never". */
  available: boolean;
  forPeer(publicKey: string): LivePeerFacts;
}

const UNAVAILABLE: LivePeerState = {
  available: false,
  forPeer: () => ({}),
};

/** Epoch seconds → ISO, or `undefined` when the value is not a usable
 *  observation. A negative or non-finite epoch is a malformed reading, not a
 *  handshake at the dawn of time — treat it as unknown. */
function handshakeAt(latest: number | undefined): string | null | undefined {
  if (latest === undefined) return undefined;
  if (!Number.isFinite(latest) || latest < 0) return undefined;
  if (latest === 0) return null;
  return new Date(latest * 1000).toISOString();
}

export function buildLivePeerState(wire: LiveVpnPeerWire[]): LivePeerState {
  const facts = new Map<string, LivePeerFacts>();
  for (const p of wire) {
    if (typeof p.public_key !== "string" || p.public_key === "") continue;
    const at = handshakeAt(p.latest_handshake);
    facts.set(p.public_key, {
      provisioned: true,
      // Spread rather than assign: an explicit `lastHandshakeAt: undefined`
      // would still be an own property, and a caller spreading these facts
      // into a DTO would then shadow nothing — but `Object.keys` and any
      // structural assertion would see a key that is supposed to be absent.
      ...(at === undefined ? {} : { lastHandshakeAt: at }),
    });
  }
  return {
    available: true,
    forPeer: (publicKey: string) => facts.get(publicKey) ?? { provisioned: false },
  };
}

/**
 * Read the interface, degrading to "unavailable" on any failure.
 *
 * Deliberately swallowing: the device list is how an owner REVOKES a device,
 * so a routing sidecar that is down must not take the list down with it. That
 * is the failure mode where being able to cut a device off matters most.
 */
export async function readLivePeerState(
  read: () => Promise<LiveVpnPeerWire[]>,
  onError: (err: unknown) => void,
): Promise<LivePeerState> {
  try {
    return buildLivePeerState(await read());
  } catch (err) {
    onError(err);
    return UNAVAILABLE;
  }
}
