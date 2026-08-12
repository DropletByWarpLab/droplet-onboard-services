/**
 * WARP-1763 — turning observed peer facts into copy a box can stand behind.
 *
 * Two surfaces render a device's connection state (the Remote Access list and
 * the Home bento widget) and they used to disagree, because each invented its
 * own answer from whatever it happened to have. The widget counted active peer
 * ROWS and called them "connected"; the list showed nothing at all. A peer row
 * exists from the moment a config is minted or a QR link is approved — it says
 * a device was set up, never that it is here.
 *
 * The orchestrator now reports what it actually observed on the router. This
 * module is the single place that decides what those observations MEAN, so the
 * two surfaces cannot drift apart again.
 *
 * Only the handshake is a runtime reading. `provisioned` comes from the
 * interface's UCI CONFIGURATION, so it answers "configured on the interface",
 * not "loaded in the running interface" — which is why nothing below promotes
 * `provisioned: true` on its own to a presence claim. Presence is always
 * decided by a fresh `lastHandshakeAt`.
 *
 * The rule that shapes everything below: an absent observation is not a
 * negative one. `lastHandshakeAt === null` means the interface reported a peer
 * that has never handshaken; `lastHandshakeAt === undefined` means nobody
 * looked, or the answer wasn't available. Collapsing those renders a routing
 * sidecar restart as a household of dead phones.
 */

import type { VpnPeerInfo } from "./types";
import { formatRelativeTime } from "./relative-time";

/**
 * How recent a handshake has to be for "connected" to be true right now.
 *
 * WireGuard is connectionless — there is no session to be in, only evidence of
 * recent traffic. Peers are installed with `persistent_keepalive: 25`, so a
 * live device re-handshakes well inside this window; three intervals plus
 * slack absorbs a missed keepalive and a little clock skew without ever
 * claiming presence for a device that left.
 */
export const HANDSHAKE_FRESH_MS = 3 * 60 * 1000;

export type PeerConnectionTone = "ok" | "warn" | "muted";

export interface PeerConnectionCopy {
  text: string;
  /** Maps 1:1 onto the shell's `.badge` modifiers. */
  tone: PeerConnectionTone;
}

/** Milliseconds since this peer's last observed handshake, or `null` when
 *  there is no observation to measure. */
function handshakeAgeMs(
  peer: VpnPeerInfo,
  liveStateAvailable: boolean,
  now: Date,
): number | null {
  if (!liveStateAvailable) return null;
  if (typeof peer.lastHandshakeAt !== "string") return null;
  const at = new Date(peer.lastHandshakeAt).getTime();
  if (Number.isNaN(at)) return null;
  return now.getTime() - at;
}

/**
 * Is this device carrying traffic right now?
 *
 * False for every peer when the live state is unavailable — which is correct
 * for a COUNT (we cannot count what we did not observe), and is why callers
 * that render prose must use {@link peerConnectionCopy} instead, so an
 * unobserved device reads as "unavailable" rather than "not connected".
 */
export function isConnectedNow(
  peer: VpnPeerInfo,
  liveStateAvailable: boolean,
  now: Date = new Date(),
): boolean {
  if (peer.status !== "active") return false;
  const age = handshakeAgeMs(peer, liveStateAvailable, now);
  return age !== null && age >= 0 && age <= HANDSHAKE_FRESH_MS;
}

/** How many of these devices are demonstrably connected right now. Zero when
 *  nothing was observed — pair it with the `liveStateAvailable` flag so the UI
 *  can withhold the number entirely rather than publish a misleading zero. */
export function countConnectedNow(
  peers: VpnPeerInfo[],
  liveStateAvailable: boolean,
  now: Date = new Date(),
): number {
  return peers.filter((p) => isConnectedNow(p, liveStateAvailable, now)).length;
}

/**
 * What to say about one device's connection.
 *
 * Five states, because collapsing any two produces a claim the box cannot
 * support:
 *
 *   unavailable  the interface could not be read — say that, don't guess
 *   pending      approved, but the peer was never written to the interface's
 *                config (WARP-1757's `tunnel_ready: false`); re-approving is
 *                the recovery
 *   waiting      configured, has never handshaken — the normal state right
 *                after linking, until the device actually connects
 *   connected    a handshake inside {@link HANDSHAKE_FRESH_MS}
 *   last seen    a handshake, but not a recent one — recency is the only
 *                honest claim left
 */
export function peerConnectionCopy(
  peer: VpnPeerInfo,
  liveStateAvailable: boolean,
  now: Date = new Date(),
): PeerConnectionCopy {
  if (!liveStateAvailable) {
    return { text: "Connection status unavailable", tone: "muted" };
  }
  if (peer.provisioned === false) {
    return { text: "Setup didn’t finish — approve it again", tone: "warn" };
  }
  if (peer.lastHandshakeAt === null) {
    return { text: "Linked · not connected yet", tone: "muted" };
  }
  const age = handshakeAgeMs(peer, liveStateAvailable, now);
  if (age === null) {
    // Configured on the interface, but the handshake wasn't reported (an
    // older routing build). Claiming either "connected" or "never" would be
    // inventing the observation we just failed to make.
    return { text: "Linked", tone: "muted" };
  }
  // A handshake in the future is clock skew, not the future. Treat it as fresh
  // rather than rendering "last connected in 3 hours".
  if (age < 0 || age <= HANDSHAKE_FRESH_MS) {
    return { text: "Connected", tone: "ok" };
  }
  return {
    text: `Last connected ${formatRelativeTime(peer.lastHandshakeAt as string, now)}`,
    tone: "muted",
  };
}
