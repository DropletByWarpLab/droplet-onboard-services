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
  RouterError,
} from "../services/openwrt.client.js";
import {
  allocateMintAndPersistPeer,
  parseVpnSubnet,
  renderPeerConf,
  VpnConfigError,
  VpnIpExhaustedError,
} from "../services/vpn.service.js";
import { notePeerCreated } from "../services/screen-qr.service.js";
import { requireRole } from "../middleware/auth.js";
import { computeOffLanReachable } from "../lib/remote-access.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("vpn-route");

const createPeerSchema = z.object({
  deviceLabel: z.string().trim().min(1).max(64),
});

/**
 * Resolve the WireGuard endpoint host for peer configs. Priority order mirrors
 * `lib/trusted-origin.ts` (FQDN first) so every surface agrees on the box's
 * address:
 *
 *   1. `config.DROPLET_PUBLIC_FQDN` — the per-device `<name>.droplet-us.com`
 *      publicly-trusted address the box learns AUTOMATICALLY from HQ (ADR-023).
 *      It's the single name that resolves at home and over the relay tunnel, so
 *      it's the endpoint host by default — no operator action needed.
 *   2. Else `config.WIREGUARD_ENDPOINT_HOST` — an explicit operator override.
 *   3. Else empty string — caller surfaces "not configured yet" to the dashboard.
 *
 * WARP-974: the inbound public hostname is no longer auto-derived from DuckDNS.
 * Remote access rides an outbound Cloudflare Tunnel relay + the named FQDN
 * (ADR-023/ADR-025); the FQDN doubles as the endpoint host so `endpointConfigured`
 * flips true on its own once the box has issued its cert — which is exactly what
 * the wizard/help/tour copy promises ("turns on automatically").
 */
async function resolveEndpointHost(): Promise<string> {
  const fqdn = (config.DROPLET_PUBLIC_FQDN ?? "").trim();
  if (fqdn) return fqdn;
  return (config.WIREGUARD_ENDPOINT_HOST ?? "").trim();
}

// Test-only: retained as a no-op so existing specs that reset per-test
// state keep a stable import. There is no longer any in-process cache to
// clear now that resolveEndpointHost() reads the env var directly.
export function _resetEndpointCacheForTests(): void {}

function getUser(req: Request): { username: string; role: string } {
  return {
    username: req.user?.username ?? "dev",
    role: req.user?.role ?? "family",
  };
}

function isAdmin(req: Request): boolean {
  const role = req.user?.role;
  return role === "owner" || role === "admin";
}

export function createVpnRouter(prisma: PrismaClient): Router {
  const router = Router();

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
  router.get("/vpn/status", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await vpnStatus();
      // Resolve the operator-set endpoint host. Same helper used in
      // POST /vpn/peers so the dashboard's "Add device" button enables
      // the moment WIREGUARD_ENDPOINT_HOST is configured.
      const endpointHost = await resolveEndpointHost();
      const endpointConfigured = endpointHost !== "";
      const exposeEndpointHost = isAdmin(req);
      // ADR-023 (C4): the publicly-trusted per-device FQDN. Unlike endpointHost
      // (which can leak the box's public reachability), the FQDN is already
      // published to Certificate Transparency for everyone — it carries no PII
      // and no A record — so it is safe to surface to any authenticated user so
      // the Remote Access page can show the one address that works at home AND
      // over the tunnel. Empty until the box learns it from HQ.
      const publicFqdn = config.DROPLET_PUBLIC_FQDN || null;
      // WARP-993: is the minted conf actually reachable from OUTSIDE the home
      // LAN? FQDN-only is split-horizon (no public A record) → false until the
      // ADR-025 relay lands. Deterministic env inspection — no DNS lookups.
      // Every "from anywhere" surface in the dashboard gates on this.
      const offLanReachable = computeOffLanReachable();
      if (!status) {
        return res.json({
          configured: false,
          endpointConfigured,
          offLanReachable,
          publicFqdn,
          message: "VPN not yet bootstrapped — POST /api/vpn/peers to start.",
        });
      }
      res.json({
        configured: true,
        endpointConfigured,
        offLanReachable,
        endpointHost: exposeEndpointHost ? (endpointHost || null) : null,
        publicFqdn,
        listenPort: status.listen_port,
        serverPublicKey: status.public_key,
        addresses: status.addresses,
        peerCount: status.peer_count,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/vpn/peers ──
  // Lists peers visible to the caller. Family users see their own; admins
  // see all. Includes status (active/revoked) so the dashboard can render
  // a tombstoned row briefly after revoke for context.
  router.get("/vpn/peers", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const where = isAdmin(req) ? {} : { userId: user.username };
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
          createdAt: true,
          revokedAt: true,
        },
      });
      res.json({ peers });
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
      // FQDN-first endpoint resolution. See resolveEndpointHost above.
      const endpointHost = await resolveEndpointHost();
      if (!endpointHost) {
        return res.status(503).json({
          error:
            "The box hasn't learned its web address yet — remote access turns on automatically once it does. (Operators can set WIREGUARD_ENDPOINT_HOST in .env to override.)",
        });
      }

      // 1. Idempotently ensure server-side wg0 exists. /vpn/setup is a
      //    no-op when it already does, so we always call it on the first
      //    peer creation rather than tracking "ever set up" state in the DB.
      const setup = await vpnSetup({
        listenPort: config.WIREGUARD_LISTEN_PORT,
        // First-time only; ignored when the interface already exists.
        address: serverAddressFromSubnet(config.WIREGUARD_VPN_SUBNET),
      });

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
        dns: config.WIREGUARD_DNS,
        serverPublicKey: setup.public_key,
        endpointHost,
        listenPort: config.WIREGUARD_LISTEN_PORT,
        lanCidr: config.WIREGUARD_LAN_CIDR,
        vpnSubnet: config.WIREGUARD_VPN_SUBNET,
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
          createdAt: saved.createdAt,
        },
        // Plain text — dashboard renders as QR, mobile WireGuard scans.
        // Returned ONCE. Subsequent GETs do not include `conf` or any priv key.
        conf,
        // WARP-993: same honest reachability signal as GET /vpn/status, so the
        // QR step can gate its "from anywhere" copy without a second fetch.
        offLanReachable: computeOffLanReachable(),
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
  // WARP-171: per-route guard. owner + admin only — matches the
  // matrix in ADR-004 §3. This is a behavior change from
  // pre-WARP-171: previously a family-tier user could delete their
  // OWN peer (peer.userId === user.username escape hatch). Now they
  // must ask an admin. The intent is consistency with POST: if a
  // family user can't mint a peer self-service, they shouldn't be
  // able to revoke one self-service either.
  router.delete(
    "/vpn/peers/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const peer = await prisma.vpnPeer.findUnique({ where: { id } });
      if (!peer) {
        return res.status(404).json({ error: "Peer not found" });
      }
      // WARP-171: per-resource ownership check used to live here
      // (`peer.userId !== user.username && !isAdmin(req)` returning 403).
      // After requireRole("owner", "admin") was added at the route guard
      // above, the branch became unreachable: family-tier callers never
      // pass the guard, and owner/admin always do. Removing the dead code
      // so future readers don't think family users can still hit this
      // handler. Behavior is unchanged — see the comment above the route
      // for the WARP-171 family-tier deletion semantics.
      if (peer.status === "revoked") {
        // Already gone in our world; treat as idempotent success.
        return res.json({ status: "revoked", id });
      }

      // Delete on the router first. If that fails we leave the DB row
      // intact so the user can retry. If it returns 404 (peer already gone
      // on the router side) we still mark our row revoked.
      try {
        await deleteVpnPeer({ publicKey: peer.publicKey });
      } catch (err) {
        if (!(err instanceof RouterError && err.status === 404)) {
          throw err;
        }
        logger.warn(
          { peerId: id, publicKey: peer.publicKey },
          "vpn: peer already gone on router — marking row revoked anyway",
        );
      }

      await prisma.vpnPeer.update({
        where: { id },
        data: { status: "revoked", revokedAt: new Date() },
      });

      res.json({ status: "revoked", id });
    } catch (err) {
      next(err);
    }
    },
  );

  return router;
}

/**
 * Compute the server's CIDR address inside a VPN subnet, e.g.
 * "10.13.13.0/24" -> "10.13.13.1/24". Used on first-time /vpn/setup;
 * idempotent calls don't reach this path.
 */
function serverAddressFromSubnet(subnet: string): string {
  const parsed = parseVpnSubnet(subnet);
  const mask = subnet.split("/")[1] ?? "24";
  return `${parsed.serverIp}/${mask}`;
}
