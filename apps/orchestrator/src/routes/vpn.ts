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
import pino from "pino";
import { config } from "../config.js";
import {
  vpnSetup,
  vpnStatus,
  createVpnPeer,
  deleteVpnPeer,
  RouterError,
} from "../services/openwrt.client.js";
import {
  allocatePeerIp,
  parseVpnSubnet,
  renderPeerConf,
  VpnConfigError,
  VpnIpExhaustedError,
} from "../services/vpn.service.js";
import { notePeerCreated } from "../services/screen-qr.service.js";

const logger = pino({ name: "vpn-route" });

const createPeerSchema = z.object({
  deviceLabel: z.string().trim().min(1).max(64),
});

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
  router.get("/vpn/status", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await vpnStatus();
      const endpointConfigured = config.WIREGUARD_ENDPOINT_HOST.trim() !== "";
      if (!status) {
        return res.json({
          configured: false,
          endpointConfigured,
          message: "VPN not yet bootstrapped — POST /api/vpn/peers to start.",
        });
      }
      res.json({
        configured: true,
        endpointConfigured,
        endpointHost: config.WIREGUARD_ENDPOINT_HOST || null,
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
  router.post("/vpn/peers", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createPeerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          details: parsed.error.flatten(),
        });
      }
      const user = getUser(req);
      const endpointHost = config.WIREGUARD_ENDPOINT_HOST.trim();
      if (!endpointHost) {
        return res.status(503).json({
          error:
            "Set WIREGUARD_ENDPOINT_HOST in .env (DuckDNS subdomain or your router's public IP) before issuing peer configs.",
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

      // 2. Allocate next free IP. We allocate then mint then persist; if
      //    persist fails we delete the routing-side peer to avoid orphans.
      const peerIp = await allocatePeerIp(prisma, config.WIREGUARD_VPN_SUBNET);

      // 3. Ask routing to mint a keypair + install the peer.
      const minted = await createVpnPeer({
        description: parsed.data.deviceLabel,
        allowedIps: [`${peerIp}/32`],
      });

      // 4. Persist. On failure, tear down the routing-side peer so we
      //    don't leak silent peers that nobody owns from the orchestrator's POV.
      let saved;
      try {
        saved = await prisma.vpnPeer.create({
          data: {
            userId: user.username,
            deviceLabel: parsed.data.deviceLabel,
            publicKey: minted.public_key,
            assignedIp: peerIp,
          },
        });
      } catch (persistErr) {
        logger.error(
          { err: persistErr, publicKey: minted.public_key },
          "vpn: persist failed after routing mint — rolling back routing-side peer",
        );
        try {
          await deleteVpnPeer({ publicKey: minted.public_key });
        } catch (rollbackErr) {
          logger.error(
            { err: rollbackErr, publicKey: minted.public_key },
            "vpn: rollback delete failed — orphan peer on router; admin must clean up manually",
          );
        }
        throw persistErr;
      }

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

      // PyPortal screen QR — surface this peer for ~60 s so a phone
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
  });

  // ── DELETE /api/vpn/peers/:id ──
  // Removes the peer from the router AND marks the DB row revoked. We keep
  // the row (status="revoked", revokedAt set) so the dashboard can show a
  // brief "removed just now" state and so we have an audit trail.
  router.delete("/vpn/peers/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const id = req.params.id;
      const peer = await prisma.vpnPeer.findUnique({ where: { id } });
      if (!peer) {
        return res.status(404).json({ error: "Peer not found" });
      }
      if (peer.userId !== user.username && !isAdmin(req)) {
        return res.status(403).json({ error: "Not your peer" });
      }
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
  });

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
