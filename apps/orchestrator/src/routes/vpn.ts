/**
 * Remote Access (WireGuard VPN) routes.
 *
 * Each peer is owned by a Nextcloud user (req.user.username). Non-admin
 * users can only see/manage their own peers; the `owner` role can see all.
 *
 * The interesting endpoint is POST /api/vpn/peers — it composes the four
 * pieces:
 *   1. Ensure the wg0 interface exists on the router (auto-runs setup).
 *   2. Allocate the next free IP from WIREGUARD_VPN_SUBNET.
 *   3. Ask the routing service to mint a peer (server-side keygen).
 *   4. Persist a VpnPeer row + render a .conf for the dashboard's QR.
 *
 * The peer's private key is in the response ONCE and never stored. If a
 * write fails after the routing service has minted the peer, we attempt
 * to roll back the routing-side state so we don't leak orphan peers.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import {
  vpnSetup,
  vpnStatus,
  createVpnPeer,
  deleteVpnPeer,
  listVpnPeers,
  RouterError,
} from "../services/openwrt.client.js";
import {
  allocateMintAndPersistPeer,
  renderPeerConf,
  serverAddressFromSubnet,
  VpnConfigError,
  VpnIpExhaustedError,
  type VpnPeerMode,
} from "../services/vpn.service.js";
import {
  pickHomeEndpoint,
  fetchBridgeUplinkIp,
} from "../lib/vpn-home-endpoint.js";
import {
  readNetworkSummary,
  resolveVpnLanRouting,
  type NetworkSummaryRead,
} from "../lib/vpn-lan.js";
import { notePeerCreated } from "../services/screen-qr.service.js";
import { recordAccessDenied, requireRole } from "../middleware/auth.js";
import { decidePeerRevoke } from "../lib/vpn-revoke-policy.js";
import { computeOffLanReachable } from "../lib/remote-access.js";
import { readLivePeerState } from "../lib/vpn-live-peers.js";
import { createLogger } from "../lib/logger.js";
import {
  defaultOverlayRevoke,
  revokeVpnPeer,
  type OverlayRevokeFn,
} from "../services/vpn-peer-revoke.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { isOwnerOrAdmin } from "../middleware/admin-tier.js";

const logger = createLogger("vpn-route");

const createPeerSchema = z.object({
  deviceLabel: z.string().trim().min(1).max(64),
  // How this device reaches the box (hybrid remote-access P1). Defaults to
  // "away" so an omitted field mints the pre-hybrid AWAY-mode conf byte-for-
  // byte — nothing about existing clients changes.
  //   "away" — dials the explicit direct WireGuard endpoint from outside the
  //            office network.
  //   "home" — dials the box DIRECTLY at its home-facing LAN IP (split-tunnel to
  //            the box, no public inbound). The Endpoint is the discovered LAN
  //            IP, DNS is the split-horizon resolver.
  mode: z.enum(["home", "away"]).default("away"),
});

/**
 * Resolve the box's home-network-facing LAN IP — the address a HOME-mode peer
 * dials directly. DHCP, so it is DISCOVERED (never hardcoded). Precedence:
 *
 *   1. WIREGUARD_HOME_ENDPOINT_HOST env / routing-summary WAN IP
 *      (pickHomeEndpointFromSummary — #897 semantics, unchanged).
 *   2. Else the single-box host-uplink probe: the host device-bridge's
 *      GET /host/uplink-ip (VPN home-mode P1.5). On single-box the WAN is
 *      HOST-owned so the summary reports wan.present:false — the bridge, which
 *      sees the host default route, supplies the egress source IP the summary
 *      can't. WARP-2183: this step is reached ONLY when the summary was read
 *      successfully and affirmatively showed no WAN. If the summary could not
 *      be read at all the shape is UNKNOWN, and the box's own uplink is not a
 *      safe guess: behind an edge router it is a router-LAN address that no
 *      home-mode peer can dial.
 *   3. Else null — surfaced honestly rather than minting a conf pointed at a
 *      wrong guess.
 *
 * Both the routing-service and device-bridge probes are best-effort — a fault in
 * either swallows to null there: status still renders, and a home-mode mint with
 * a null result fails with a clear 503. The bridge is only probed when the
 * summary/env didn't already yield an IP, so the multi-box path adds no call.
 * Away mode never calls this.
 */
async function resolveHomeEndpointHost(read?: NetworkSummaryRead): Promise<string | null> {
  const envFallback = (config.WIREGUARD_HOME_ENDPOINT_HOST ?? "").trim();
  // One summary read per request: a caller that also derives the LAN facts
  // (WARP-2692) passes its read in rather than paying the sidecar round-trip
  // twice.
  const { summary, ok: summaryOk } = read ?? (await readNetworkSummary());
  // Only reach for the bridge when env + summary came up empty (single-box).
  const fromSummary = pickHomeEndpoint({ envFallback, summary, bridgeIp: null, summaryOk });
  if (fromSummary) return fromSummary;
  // WARP-2183: the bridge answers with the BOX's own uplink IP, which is only a
  // usable endpoint when the box itself owns the WAN. Behind a real edge router
  // that address sits on the router's LAN (e.g. 192.168.9.195) and is
  // unreachable from the household network a home-mode peer actually dials — so
  // minting it would hand the user a conf that silently never handshakes.
  //
  // The distinction is "the summary says there is no WAN" (single-box: the
  // uplink is host-owned, so the bridge is right) versus "the summary could not
  // be read at all" (shape UNKNOWN). The old code conflated them, because a
  // throw and a genuine present:false both arrive here as `summary === null`.
  // A transient routing fault on an edge-router box therefore minted a conf
  // pointed at an unreachable address; now it returns the same honest null the
  // no-discovery path already does, and the route surfaces its 503.
  if (!summaryOk) {
    logger.warn(
      "vpn: skipping host-uplink fallback — network summary unreadable, so the box's own uplink cannot be confirmed as the WAN edge",
    );
    return null;
  }
  const bridgeIp = await fetchBridgeUplinkIp();
  return pickHomeEndpoint({ envFallback, summary, bridgeIp, summaryOk });
}

/** Direct UDP endpoint for away configs; internal web DNS is separate. */
async function resolveEndpointHost(): Promise<string> {
  return (config.WIREGUARD_ENDPOINT_HOST ?? "").trim();
}

// Test-only: retained as a no-op so existing specs that reset per-test
// state keep a stable import. There is no longer any in-process cache to
// clear now that resolveEndpointHost() reads the env var directly.
export function _resetEndpointCacheForTests(): void {}

/**
 * WARP-1283: RouterError codes that mean "the routing sidecar is unavailable
 * right now" — unreachable, timed out, or intentionally disabled. All three
 * carry HTTP 503 per WARP-807, and this set mirrors the dashboard's
 * ROUTER_UNREACHABLE_CODES so both sides classify identically. RouterError
 * already carries this typed signal, so we branch on `code` here; the
 * message-shape classifier in lib/upstream-unavailable.ts exists for clients
 * WITHOUT typed errors (Nextcloud/Frigate/matter throw plain Errors) and would
 * miss TIMEOUT ("… timed out") and DISABLED ("Router supervision is disabled").
 */
const ROUTING_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "UNREACHABLE",
  "TIMEOUT",
  "DISABLED",
]);

function getUser(req: Request): { username: string; role: string } {
  return {
    username: req.user?.username ?? "dev",
    role: req.user?.role ?? "family",
  };
}

// Legacy overlay peer revocations retain their signed audit trail.
export interface OverlayAuditEntry {
  /** lowercase overlay_<verb> — reuses the existing activity taxonomy. */
  event: string;
  method: string;
  route: string;
  status: number;
  /** owner user id, or `ip:<addr>` for the unauthenticated by-token path. */
  clientId: string;
  refs?: Record<string, unknown>;
}
export type OverlayAuditFn = (entry: OverlayAuditEntry) => void;

/** Default audit sink — one signed ActivityRow per entry under the EXISTING
 *  `network` kind (no new ActivityKind; ADR-014). recordActivity is a no-op that
 *  returns null before the recorder is wired, so importing this in tests is
 *  side-effect-free. */
function defaultOverlayAudit(entry: OverlayAuditEntry): void {
  const isOwner = !!entry.clientId && !entry.clientId.startsWith("ip:");
  void recordActivity({
    kind: "network",
    severity: entry.status >= 400 ? "warn" : "ok",
    sourceIcon: "shield",
    what: `Overlay ${entry.event}`,
    sub: `${entry.method} ${entry.route} → ${entry.status}`,
    actor: isOwner ? { type: "user", id: entry.clientId } : { type: "anonymous" },
    refs: {
      event: entry.event,
      method: entry.method,
      route: entry.route,
      status: entry.status,
      clientId: entry.clientId,
      ...(entry.refs ?? {}),
    },
  });
}

export function createVpnRouter(
  prisma: PrismaClient,
  opts: {
    overlayRevoke?: OverlayRevokeFn;
    recordOverlayAudit?: OverlayAuditFn;
  } = {},
): Router {
  const router = Router();
  const overlayRevoke = opts.overlayRevoke ?? defaultOverlayRevoke;
  const audit = opts.recordOverlayAudit ?? defaultOverlayAudit;
  // ── GET /api/vpn/status ──
  // Public-ish info for the dashboard: server pubkey, listen port, peer
  // count, and whether the endpoint host is configured. No private data
  // returned. Available to any authenticated user — they need to know
  // whether Remote Access is on before they hit "Add device".
  //
  // The full `endpointHost` (i.e. the public hostname that resolves
  // to the device's public IP) is admin-only: it comes from the
  // operator-set WIREGUARD_ENDPOINT_HOST env var and would leak the
  // device's public reachability to every authenticated account if
  // exposed broadly. Family users still get `endpointConfigured: boolean`
  // so the "Add device" button can light up at the right time without
  // leaking the hostname itself.
  //
  // WARP-3156: external guests are refused (they have no remote access — they
  // can't enroll or mint — and the answer is reconnaissance about the company
  // network: the LAN address and how many staff devices tunnel in). Every web
  // and iOS surface a guest can reach treats a failed status read as "no
  // signal". Members see only their OWN device count; the box-wide live count
  // is owner/admin.
  router.get(
    "/vpn/status",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await vpnStatus();
      // Resolve the operator-set endpoint host. Same helper used in
      // POST /vpn/peers so the dashboard's "Add device" button enables
      // the moment WIREGUARD_ENDPOINT_HOST is configured.
      const endpointHost = await resolveEndpointHost();
      const admin = isOwnerOrAdmin(req);
      const exposeEndpointHost = admin;
      // Reachability describes the explicit direct WireGuard endpoint.
      const offLanReachable = computeOffLanReachable();
      // Hybrid P1: the box's home-facing LAN IP a HOME-mode peer dials directly.
      // Discovered dynamically (DHCP — never hardcoded); null when it can't be
      // discovered and no fallback is set. Unlike endpointHost this is a private
      // LAN address every employee on the office network already sees, so it
      // is not admin-gated among members; external guests never reach this
      // handler (WARP-3156). The web widget and iOS gate the home-mode toggle
      // on it.
      const homeEndpointHost = await resolveHomeEndpointHost();
      // Local WireGuard must not depend on fleet certificate issuance. The
      // internal DNS name is registered by setup_router_dns, not learned from HQ.
      const internalHostname = config.DROPLET_LAN_HOSTNAME || null;
      const endpointConfigured = endpointHost !== "" || homeEndpointHost !== null;
      if (!status) {
        return res.json({
          configured: false,
          endpointConfigured,
          offLanReachable,
          homeEndpointHost,
          internalHostname,
          message: "VPN not yet bootstrapped — POST /api/vpn/peers to start.",
        });
      }
      res.json({
        configured: true,
        endpointConfigured,
        offLanReachable,
        endpointHost: exposeEndpointHost ? (endpointHost || null) : null,
        homeEndpointHost,
        internalHostname,
        listenPort: status.listen_port,
        serverPublicKey: status.public_key,
        addresses: status.addresses,
        peerCount: admin
          ? status.peer_count
          : await prisma.vpnPeer.count({
              where: { userId: getUser(req).username, status: "active" },
            }),
        // WARP-2689 — kernel truth beside the uci intent. `configured: true`
        // above only says the router HOLDS a wg0 section; on a router flashed
        // without WireGuard (every field RB5009 before edge 4aa8a39) that
        // section exists, `ip link show wg0` says the device does not, and
        // nothing on this page used to say so. `false` is an observation the
        // dashboard must act on (no conf minted here can handshake); `null`
        // means the router could not say and changes nothing.
        interfaceLive: status.interface_live ?? null,
        livePeerCount: admin ? (status.live_peer_count ?? null) : null,
      });
    } catch (err) {
      // WARP-1283: every other input to this handler already degrades to null,
      // but vpnStatus() throws when the routing sidecar can't be reached —
      // which used to fall through to next(err) and land the setup wizard's
      // Remote Access precheck on its generic ("this usually clears on its
      // own") error page. The sidecar being down is a known, recoverable
      // condition — answer with a stable code + customer-safe copy (ADR-002)
      // so the wizard can say what's actually happening. Genuine unexpected
      // errors (and real RouterErrors like AUTH) still go to next(err).
      if (err instanceof RouterError && ROUTING_UNAVAILABLE_CODES.has(err.code)) {
        logger.warn(
          { err, code: err.code },
          "vpn: routing service unavailable during status check",
        );
        return res.status(503).json({
          error:
            "The box's network service isn't responding right now. Try again in a minute.",
          code: "ROUTING_UNAVAILABLE",
        });
      }
      next(err);
    }
    },
  );

  // ── GET /api/vpn/peers ──
  // Lists peers visible to the caller. Family users see their own; admins
  // see all. Includes status (active/revoked) so the dashboard can render
  // a tombstoned row briefly after revoke for context.
  //
  // WARP-1763 — this DTO also carries what an owner needs to MANAGE a device
  // they linked by QR, which until now it did not:
  //
  //   * `kind` + the link-token provenance, so a QR-linked phone is
  //     distinguishable from a legacy static peer. Overlay peers are written
  //     with the synthetic `userId: "overlay"`, which matches no real
  //     username — so without `kind` the dashboard had nothing to key on.
  //   * `provisioned` and `lastHandshakeAt`, read from the ROUTER rather than
  //     from our own rows, so the UI can separate *enrolled* from
  //     *provisioned* from *actually connected*.
  //
  // On that last point, deliberately NOT `lastSessionAt`: the ticket suggested
  // it, but `provisionOverlayPeer` stamps it at APPROVAL time (it is the
  // idle-expiry clock — a NULL there would make the sweep skip the row
  // forever). Handing it to the UI as liveness would render every
  // just-approved device "connected" before it has ever handshaken, which is
  // the exact lie this ticket exists to remove. The only honest source of
  // handshake recency is the running interface, so that is what we read —
  // `latest_handshake` comes from a ubus `network.interface.wg0 status` read.
  // `provisioned` does NOT: it comes from the interface's UCI configuration.
  // See the `vpn-live-peers.ts` header before treating the two as one fact.
  router.get("/vpn/peers", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      // WARP-1443: the MCP service principal (`_service:mcp`, same id+role
      // pin as requireRoleOrMcpService) gets the admin (full-list) view on
      // this GET/list path ONLY — list_vpn_peers is a Tier-1 read and the
      // row selection carries no key material (peer PUBLIC keys only;
      // private keys are never stored). The tool enforces the human's
      // forwarded role before dispatching. VPN write routes stay
      // human-only (deliberate policy exclusion, WARP-1444).
      const isMcpService =
        req.user?.id === "_service:mcp" && req.user.role === "service";
      const where =
        isOwnerOrAdmin(req) || isMcpService ? {} : { userId: user.username };
      const peers = await prisma.vpnPeer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          userId: true,
          deviceLabel: true,
          publicKey: true,
          assignedIp: true,
          status: true,
          mode: true,
          kind: true,
          createdAt: true,
          revokedAt: true,
          linkTokenLabel: true,
          linkTokenEnrolledBy: true,
          enrolledAt: true,
        },
      });

      const live = await readLivePeerState(
        () => listVpnPeers(),
        (err) =>
          logger.warn(
            { err },
            "vpn: routing unavailable while listing peers — reporting live state as unknown",
          ),
      );
      res.json({
        peers: peers.map((p) => ({ ...p, ...live.forPeer(p.publicKey) })),
        // Explicit, because "no handshake" and "we couldn't ask" must not
        // render the same. False → the UI says the network service isn't
        // answering instead of showing every device as never-connected.
        liveStateAvailable: live.available,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/vpn/peers ──
  // Mint a peer for the calling user. Body: { deviceLabel }.
  // Response carries the rendered `.conf` (and the peer record); the
  // dashboard renders the .conf as a QR. The private key is in the .conf
  // text and is NEVER returned again — if the user loses it they revoke
  // and re-mint.
  //
  // Admin-gated: minting a VPN peer punches a route into the LAN with
  // full network-layer access. Self-service enrolment isn't the intended
  // policy — family users should ask an admin to add their device.
  // Network-wide config is admin-only. The wizard's VPN step now also
  // surfaces this in copy.
  // WARP-171: per-route guard. owner + admin only — replaces the
  // pre-WARP-171 inline `isAdmin(req)` check. The intent is unchanged
  // (see comment above) — the guard is just hoisted to middleware so
  // a reviewer can see the policy at route registration.
  router.post(
    "/vpn/peers",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createPeerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          details: parsed.error.flatten(),
        });
      }
      const user = getUser(req);
      const mode = parsed.data.mode;
      // Resolve the .conf's Endpoint per mode BEFORE minting anything, so a
      // box that can't yet produce a usable endpoint fails fast without leaking
      // a router-side peer nobody can dial.
      //   away — the operator's direct WireGuard endpoint (resolveEndpointHost).
      //   home — the box's discovered home-facing LAN IP (resolveHomeEndpointHost).
      // One routing-summary read serves the home endpoint and the LAN facts.
      const netRead = await readNetworkSummary();
      let confEndpointHost: string;
      if (mode === "home") {
        const homeHost = await resolveHomeEndpointHost(netRead);
        if (!homeHost) {
          return res.status(503).json({
            error:
              "The box couldn't determine its LAN-facing IP for a direct (on-site) connection. It's assigned by your router (DHCP), so it can't be guessed — retry once the box is fully online, or set WIREGUARD_HOME_ENDPOINT_HOST in .env to pin it.",
          });
        }
        confEndpointHost = homeHost;
      } else {
        // Away mode requires an explicit direct UDP endpoint.
        const endpointHost = await resolveEndpointHost();
        if (!endpointHost) {
          return res.status(503).json({
            error:
              "A direct WireGuard endpoint is not configured for away access. Set WIREGUARD_ENDPOINT_HOST to a reachable host and allow the WireGuard UDP port, or use home mode on the office network.",
          });
        }
        confEndpointHost = endpointHost;
      }

      // 1. Idempotently ensure server-side wg0 exists. /vpn/setup is a
      //    no-op when it already does, so we always call it on the first
      //    peer creation rather than tracking "ever set up" state in the DB.
      const setup = await vpnSetup({
        listenPort: config.WIREGUARD_LISTEN_PORT,
        // First-time only; ignored when the interface already exists.
        address: serverAddressFromSubnet(config.WIREGUARD_VPN_SUBNET),
      });
      // WARP-2689 — a 200 from setup is a uci write-back; `interface_live` is
      // what the kernel says. On a router with no WireGuard support the
      // section exists and the device does not, and a conf minted now is a QR
      // the customer scans into a tunnel that can never handshake. Refuse
      // before allocating an address or minting a router-side key, and say
      // what is actually wrong. `null` (router cannot say) does not refuse —
      // that is the common case on older images and the mint worked there.
      if (setup.interface_live === false) {
        return res.status(503).json({
          error:
            "Your router doesn’t have WireGuard support yet, so a remote-access device can’t be added. Update the router’s software, then try again.",
          code: "ROUTER_WIREGUARD_UNSUPPORTED",
        });
      }
      // WARP-2692 — the LAN the conf routes is the ROUTER's LAN, read live.
      // The env pins describe one deployment shape and are written back on
      // every provision, so a box behind an edge router used to hand out a
      // conf that handshook and reached nothing.
      const lan = await resolveVpnLanRouting(netRead);

      // 2-4. Allocate next free IP, mint the router-side peer with it, and
      //    persist — as one retryable unit. WARP-565: the allocate-then-persist
      //    sequence is a read-then-write race (two concurrent setup calls can
      //    pick the same "free" IP). The partial unique index on (assignedIp)
      //    WHERE status = 'active' makes the loser's INSERT fail P2002, which
      //    allocateMintAndPersistPeer catches and re-allocates around (re-minting
      //    the router peer with the new IP). Any failed attempt's router peer is
      //    rolled back so we never leak an orphan peer pinned to an unkept IP.
      const { peerIp, minted, saved } = await allocateMintAndPersistPeer(
        prisma,
        config.WIREGUARD_VPN_SUBNET,
        {
          userId: user.username,
          deviceLabel: parsed.data.deviceLabel,
          mode,
          mint: (ip) =>
            createVpnPeer({
              description: parsed.data.deviceLabel,
              allowedIps: [`${ip}/32`],
            }),
          rollbackMint: async (m, terminal) => {
            // A retryable active-IP race that re-allocates and succeeds is the
            // normal happy-path under concurrent setup calls — logging it at
            // error would false-page any alerting keyed on logger.error (up to
            // maxRetries-1 spurious errors per successful POST). Only a terminal
            // rollback (genuine final failure) keeps error severity (WARP-565).
            const rollbackLog = terminal ? logger.error.bind(logger) : logger.warn.bind(logger);
            rollbackLog(
              { publicKey: m.public_key, terminal },
              terminal
                ? "vpn: persist failed after routing mint — rolling back routing-side peer"
                : "vpn: active-IP race after routing mint — rolling back and retrying",
            );
            try {
              await deleteVpnPeer({ publicKey: m.public_key });
            } catch (rollbackErr) {
              // A failed rollback delete always leaves an orphan peer needing
              // manual cleanup, regardless of whether the parent attempt was
              // retryable — so this stays at error level.
              logger.error(
                { err: rollbackErr, publicKey: m.public_key },
                "vpn: rollback delete failed — orphan peer on router; admin must clean up manually",
              );
            }
          },
        },
      );

      const conf = renderPeerConf({
        privateKey: minted.private_key,
        peerIp,
        // Home mode points DNS at the split-horizon resolver so the per-device
        // FQDN resolves over the tunnel (ADR-023 §3.4); away mode keeps the
        // LAN DNS.
        dns: mode === "home" ? lan.homeDns : lan.dns,
        serverPublicKey: setup.public_key,
        endpointHost: confEndpointHost,
        listenPort: config.WIREGUARD_LISTEN_PORT,
        lanCidr: lan.lanCidr,
        vpnSubnet: config.WIREGUARD_VPN_SUBNET,
        mode,
        // Split-tunnel box subnet(s) for home mode; ignored by away mode.
        homeAllowedIps: lan.homeAllowedIps,
      });

      // Status display screen QR — surface this peer for ~60 s so a phone
      // next to the box can scan it directly without the dashboard
      // browser. Best-effort: notePeerCreated() never throws (catches
      // any push failure internally), so the API response stays clean.
      notePeerCreated(conf, saved.deviceLabel ?? undefined);

      res.status(201).json({
        peer: {
          id: saved.id,
          userId: saved.userId,
          deviceLabel: saved.deviceLabel,
          publicKey: saved.publicKey,
          assignedIp: saved.assignedIp,
          status: saved.status,
          mode: saved.mode,
          createdAt: saved.createdAt,
        },
        // Plain text — dashboard renders as QR, mobile WireGuard scans.
        // Returned ONCE. Subsequent GETs do not include `conf` or any priv key.
        conf,
        // WARP-993: same honest reachability signal as GET /vpn/status, so the
        // QR step can gate its "from anywhere" copy without a second fetch.
        offLanReachable: mode === "away" && computeOffLanReachable(),
      });
    } catch (err) {
      // VpnIpExhaustedError → 507 (Insufficient Storage is the closest semantic)
      if (err instanceof VpnIpExhaustedError) {
        return res.status(507).json({ error: err.message });
      }
      if (err instanceof VpnConfigError) {
        return res.status(500).json({ error: `VPN configuration error: ${err.message}` });
      }
      // Routing service unavailable → 503 with a helpful hint.
      if (err instanceof RouterError && err.code === "DISABLED") {
        return res.status(503).json({ error: "Routing service is disabled in this environment" });
      }
      next(err);
    }
    },
  );

  // ── DELETE /api/vpn/peers/:id ──
  // Removes the peer from the router AND marks the DB row revoked. We keep
  // the row (status="revoked", revokedAt set) so the dashboard can show a
  // brief "removed just now" state and so we have an audit trail.
  //
  // Who may revoke — lib/vpn-revoke-policy.ts is the rule (also driven by the
  // RBAC matrix):
  //   • owner/admin — any peer (WARP-171, ADR-004 §3).
  //   • member / guest — only an OVERLAY device they enrolled themselves
  //     (WARP-3121). Signing in is the enrollment (WARP-1882), so signing out
  //     of — or losing — that device has to be undoable by the same person;
  //     otherwise a forgotten or stolen laptop keeps a route into the office
  //     LAN until an admin happens to notice. "Themselves" is the row's
  //     `userId`, which the sign-in enroll stamps with the caller's username
  //     (and which GET /vpn/peers already uses to scope a member's list).
  //     Static peers stay admin-only: a member can't mint one, so they don't
  //     revoke one either (WARP-171's original reasoning still holds there).
  router.delete(
    "/vpn/peers/:id",
    async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const clientId = req.user?.id ?? "unknown";
      // Parity with the requireRole guard this route used to have: a caller
      // who could not revoke even a device of their OWN (no session, a service
      // principal, an unknown role) is refused before the row is looked up.
      const couldOwnAny = decidePeerRevoke(req.user, {
        kind: "overlay",
        userId: req.user?.username ?? "",
      });
      if (couldOwnAny === "no-role" || couldOwnAny === "not-yours") {
        recordAccessDenied(req, couldOwnAny === "no-role" ? "no-role" : "role-not-permitted");
        return res.status(403).json({
          error:
            couldOwnAny === "no-role"
              ? "Forbidden: no role on session"
              : "Forbidden: role not permitted",
        });
      }
      const peer = await prisma.vpnPeer.findUnique({ where: { id } });
      if (!peer) {
        return res.status(404).json({ error: "Peer not found" });
      }
      const decision = decidePeerRevoke(req.user, peer);
      const admin = decision === "admin";
      if (decision !== "admin" && decision !== "own") {
        recordAccessDenied(req, "not-own-device");
        audit({
          event: "overlay_revoke_refused",
          method: req.method,
          route: "/vpn/peers/:id",
          status: 403,
          clientId,
          refs: { peer_id: id },
        });
        return res.status(403).json({
          code: "NOT_YOUR_DEVICE",
          error: "You can only remove your own devices. Ask an owner or admin to remove this one.",
        });
      }
      if (peer.status === "revoked") {
        // Already gone in our world; treat as idempotent success.
        return res.json({ status: "revoked", id });
      }

      // Confirm local removal before revoking the row. Legacy HQ cleanup may
      // remain pending; the retired fleet flow cannot reinstall a local peer.
      const outcome = await revokeVpnPeer({ prisma, overlayRevoke }, peer);
      if (outcome === "REVOKE_STAGED") {
        audit({
          event: "overlay_revoke_failed",
          method: req.method,
          route: "/vpn/peers/:id",
          status: 502,
          clientId,
          refs: { peer_id: id, outcome, device_owner: peer.userId },
        });
        return res.status(502).json({
          code: outcome,
          error: "We removed this device from the router's configuration, but the change didn't take effect — the device is still connected. Try revoking it again in a moment.",
          id,
        });
      }

      // WARP-3121 — every revoke leaves a signed trace naming who did it.
      audit({
        event: admin ? "overlay_revoke" : "overlay_revoke_own",
        method: req.method,
        route: "/vpn/peers/:id",
        status: 200,
        clientId,
        refs: {
          peer_id: id, kind: peer.kind, device_owner: peer.userId, label: peer.deviceLabel,
          outcome, hq_revoke_pending: outcome === "REVOKED_HQ_PENDING",
        },
      });

      res.json({ status: "revoked", id, hqRevokePending: outcome === "REVOKED_HQ_PENDING" });
    } catch (err) {
      next(err);
    }
    },
  );

  return router;
}
