/**
 * WARP-1757 — overlay tunnel profile: provisioning and issuance.
 *
 * The gap this closes. Before this, a QR-enrolled device could be approved and
 * still know nothing but its own keypair: no tunnel address, no server public
 * key, no AllowedIPs, no DNS, no port. Approval vouched the device to HQ and
 * installed nothing on wg0 — the router-side peer was created lazily by the
 * connect tick, which ships disabled. So the enrolled key was registered and
 * then never used by any tunnel, and cryptokey routing could not agree in
 * either direction.
 *
 * Two functions, matching the two halves of the fix:
 *
 *   - {@link provisionOverlayPeer} runs at APPROVE time. It ensures wg0 exists,
 *     allocates the device's tunnel IP, persists the VpnPeer row, and installs
 *     the router-side peer keyed on the client's OWN public key — the one it
 *     enrolled with. Approval is now the moment the box becomes ready to accept
 *     that device's handshake.
 *   - {@link buildOverlayProfile} answers the client's authenticated fetch with
 *     everything it needs to assemble a wg-quick conf.
 *
 * Deliberately NO endpoint is configured on the router-side peer. WireGuard
 * learns a peer's endpoint from its first authenticated handshake, so the box
 * needs one only when the BOX must initiate — which is the hole-punch path. For
 * a box on a public-IP edge WAN, behind a successful port map, or reached over
 * the LAN, the client initiates and the punch is not involved at all. Leaving
 * the endpoint unset is what lets those paths work with no HQ round trip; the
 * connect tick still overwrites it when a punch is genuinely needed.
 *
 * The private key never appears here. The client generated its own keypair at
 * enrollment and kept the private half; the box only ever sees the public one.
 * That is why this returns a *profile* and not a `.conf` — rendering a conf
 * server-side would imply a private key we must never hold.
 */

import type { VpnPeerMode } from "./vpn.service.js";

/** An endpoint a client may try to reach the box on, best first.
 *
 * WARP-1758 populates this properly from live WAN-placement detection (edge
 * router with a public IP vs. living in someone else's subnet, plus port
 * mapping and a real symmetric-NAT probe). This ships the SHAPE now so the
 * client contract doesn't have to change twice — every client parses an
 * ordered list from day one, and gaining better candidates later is a
 * server-side change only. */
export interface OverlayEndpointCandidate {
  /** `lan` — the box's LAN address, for a client already on the home network.
   *  `direct` — the box's own public WAN address; it IS the edge router.
   *  `mapped` — a stable mapping obtained via PCP/NAT-PMP/UPnP.
   *  `srflx` — a STUN-observed reflexive mapping; needs the punch.
   *  `relay` — a blind relay (WARP-1390), not yet implemented. */
  kind: "lan" | "direct" | "mapped" | "srflx" | "relay";
  host: string;
  port: number;
  /** Higher is tried first. */
  priority: number;
}

export interface OverlayProfile {
  /** The client's tunnel address, e.g. `10.66.0.5/32`. Must fall inside the
   *  AllowedIPs the box installed for this key, or every packet is dropped. */
  address: string;
  /** The box's WireGuard public key — the conf's `[Peer] PublicKey`. */
  server_public_key: string;
  /** What the client routes over the tunnel. */
  allowed_ips: string[];
  /** Resolver(s) so `<name>.droplet-us.com` resolves over the tunnel
   *  (ADR-023 split-horizon). */
  dns: string[];
  persistent_keepalive: number;
  /** Ordered best-first. A client tries these in turn and keeps the first that
   *  completes a handshake. */
  endpoint_candidates: OverlayEndpointCandidate[];
}

/** Structural surface of the router client — injected so this unit-tests
 *  without the routing sidecar. */
export interface OverlayProvisionRouter {
  setup(opts: { listenPort: number; address: string }): Promise<{
    public_key: string;
  }>;
  installPeer(opts: {
    interface: string;
    publicKey: string;
    allowedIps: string[];
    persistentKeepalive: number;
    description: string;
  }): Promise<unknown>;
}

export interface OverlayProvisionPrisma {
  vpnPeer: {
    findUnique(args: {
      where: { publicKey: string };
    }): Promise<{ id: string; assignedIp: string; status: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{
      id: string;
      assignedIp: string;
    }>;
    update(args: {
      where: { publicKey: string };
      data: Record<string, unknown>;
    }): Promise<{ id: string; assignedIp: string }>;
  };
}

export interface ProvisionOverlayPeerInput {
  wgPublicKey: string;
  label: string;
  /** Provenance stamped onto the peer row (who linked which QR). */
  linkTokenId: string;
  linkTokenEnrolledBy: string | null;
}

export interface ProvisionOverlayPeerDeps {
  prisma: OverlayProvisionPrisma;
  router: OverlayProvisionRouter;
  allocateIp: () => Promise<string>;
  config: {
    listenPort: number;
    /** wg0's own address, derived from the VPN subnet. */
    serverAddress: string;
    vpnInterface: string;
    keepaliveSeconds: number;
  };
  now?: () => Date;
}

export interface ProvisionedOverlayPeer {
  assignedIp: string;
  serverPublicKey: string;
}

/** The synthetic userId overlay peers share — they carry no per-user Nextcloud
 *  identity. Mirrors `OVERLAY_PEER_USER` in overlay-connect.service.ts. */
const OVERLAY_PEER_USER = "overlay";

/** Overlay peers are remote devices dialling the box from OUTSIDE the home LAN
 *  — always AWAY mode, exactly like the ones overlay-connect installs. Named so
 *  the peer row's `mode` and the profile's CIDR+DNS pair can never drift apart:
 *  {@link buildOverlayProfile} selects BOTH from a single mode, and this is the
 *  value the row is stamped with. */
export const OVERLAY_PEER_MODE: VpnPeerMode = "away";

/**
 * Make the box ready to accept this device's handshake, and return what the
 * client needs to know about the result.
 *
 * Ordering is deliberate. `setup()` runs FIRST and unconditionally: it is a
 * no-op when wg0 already exists, and without it the very first overlay peer on
 * a box that never minted a legacy static peer fails with "wg0 not configured"
 * — the new flow would otherwise silently depend on the old one having been
 * used at least once. The router-side install runs LAST, after the row is
 * durable, so a crash can leave a row without a router peer (self-heals on
 * re-provision) but never a router peer no row accounts for.
 */
export async function provisionOverlayPeer(
  deps: ProvisionOverlayPeerDeps,
  input: ProvisionOverlayPeerInput,
): Promise<ProvisionedOverlayPeer> {
  const { prisma, router, config } = deps;
  const now = deps.now?.() ?? new Date();

  const setup = await router.setup({
    listenPort: config.listenPort,
    address: config.serverAddress,
  });

  const existing = await prisma.vpnPeer.findUnique({
    where: { publicKey: input.wgPublicKey },
  });

  // Re-approving a device whose row survives (e.g. a previously revoked one)
  // reuses its address rather than burning another out of a /24.
  const assignedIp = existing ? existing.assignedIp : await deps.allocateIp();

  const provenance = {
    linkTokenId: input.linkTokenId,
    linkTokenLabel: input.label,
    linkTokenEnrolledBy: input.linkTokenEnrolledBy,
    enrolledAt: now,
  };

  if (existing) {
    await prisma.vpnPeer.update({
      where: { publicKey: input.wgPublicKey },
      data: {
        assignedIp,
        kind: "overlay",
        status: "active",
        mode: OVERLAY_PEER_MODE,
        deviceLabel: input.label,
        // Non-NULL for the same reason as the create branch below. A revived
        // row may carry a stale lastSessionAt from a previous life; re-approval
        // restarts its idle clock rather than leaving it instantly reapable.
        lastSessionAt: now,
        revokedAt: null,
        ...provenance,
      },
    });
  } else {
    await prisma.vpnPeer.create({
      data: {
        userId: OVERLAY_PEER_USER,
        deviceLabel: input.label,
        publicKey: input.wgPublicKey,
        assignedIp,
        status: "active",
        mode: OVERLAY_PEER_MODE,
        kind: "overlay",
        // INVARIANT (schema.prisma, repo rule 10): kind='overlay' implies a
        // non-NULL lastSessionAt. The idle-expiry sweep filters on
        // `kind='overlay' AND status='active' AND lastSessionAt < cutoff`, and
        // in Postgres `NULL < cutoff` is NULL — a row left NULL here would
        // never match the sweep, so the peer would live forever with no expiry
        // path, removable only by a manual DELETE /vpn/peers/:id. Approval is
        // the honest start of the idle clock: the device now has a full
        // OVERLAY_PEER_IDLE_EXPIRY_HOURS window to actually connect.
        lastSessionAt: now,
        ...provenance,
      },
    });
  }

  // No `endpoint`: the client initiates, and WireGuard learns the peer's
  // endpoint from the handshake. See the file header.
  await router.installPeer({
    interface: config.vpnInterface,
    publicKey: input.wgPublicKey,
    allowedIps: [`${assignedIp}/32`],
    persistentKeepalive: config.keepaliveSeconds,
    description: input.label,
  });

  return { assignedIp, serverPublicKey: setup.public_key };
}

export interface BuildOverlayProfileInput {
  assignedIp: string;
  serverPublicKey: string;
  /** Subnet(s) behind the box the client should route over the tunnel. */
  lanCidr: string;
  vpnSubnet: string;
  dns: string;
  keepaliveSeconds: number;
  endpointCandidates: OverlayEndpointCandidate[];
}

/**
 * Assemble the wire profile. Pure — every input is resolved by the caller, so
 * this is exhaustively testable and has no opinion about where the box lives.
 */
export function buildOverlayProfile(
  input: BuildOverlayProfileInput,
): OverlayProfile {
  return {
    address: `${input.assignedIp}/32`,
    server_public_key: input.serverPublicKey,
    // The box's LAN plus the overlay subnet — split-tunnel, matching the away
    // conf renderPeerConf produces. A default route is never issued here: home
    // mode is split-tunnel by definition and the Android client refuses a
    // full-tunnel conf outright.
    allowed_ips: [input.lanCidr, input.vpnSubnet],
    dns: input.dns
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean),
    persistent_keepalive: input.keepaliveSeconds,
    endpoint_candidates: [...input.endpointCandidates].sort(
      (a, b) => b.priority - a.priority,
    ),
  };
}
