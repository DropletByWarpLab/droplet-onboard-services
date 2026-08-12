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
  isRevokeApplied,
  installOverlayVpnPeer,
  listVpnPeers,
  fetchNetworkSummary,
  RouterError,
} from "../services/openwrt.client.js";
import {
  allocateMintAndPersistPeer,
  allocatePeerIp,
  parseVpnSubnet,
  renderPeerConf,
  VpnConfigError,
  VpnIpExhaustedError,
  type VpnPeerMode,
} from "../services/vpn.service.js";
import {
  buildOverlayProfile,
  provisionOverlayPeer,
  OVERLAY_PEER_MODE,
  type OverlayEndpointCandidate,
  type OverlayProvisionRouter,
  type ProvisionedOverlayPeer,
} from "../services/overlay-profile.service.js";
import {
  pickHomeEndpoint,
  fetchBridgeUplinkIp,
  fetchBridgeStunProbe,
} from "../lib/vpn-home-endpoint.js";
import { observePlacement } from "../services/overlay-placement.service.js";
import { notePeerCreated } from "../services/screen-qr.service.js";
import { requireRole } from "../middleware/auth.js";
import { computeOffLanReachable } from "../lib/remote-access.js";
import { readLivePeerState } from "../lib/vpn-live-peers.js";
import { createLogger } from "../lib/logger.js";
import {
  enrollOverlayDevice,
  type OverlayEnrollInput,
} from "../services/overlay-connect.service.js";
import { createDeviceIdentityClient } from "../services/device-identity.client.js";
import { recordActivity } from "../services/activity.singleton.js";
import {
  FixedWindowRateLimiter,
  MAX_ACTIVE_QR_OVERLAY_DEVICES,
  OVERLAY_LINK_TOKEN_TTL_MS,
  WG_PUBLIC_KEY_RE,
  fingerprintShort,
  generateLinkToken,
  hashToken,
  overlayLabelSchema,
  parseP256Spki,
  signKeyFingerprint,
  verifyProfilePop,
  verifyStatusPop,
} from "../services/overlay-link.service.js";

const logger = createLogger("vpn-route");

const createPeerSchema = z.object({
  deviceLabel: z.string().trim().min(1).max(64),
  // How this device reaches the box (hybrid remote-access P1). Defaults to
  // "away" so an omitted field mints the pre-hybrid AWAY-mode conf byte-for-
  // byte — nothing about existing clients changes.
  //   "away" — dials the box from OUTSIDE the home LAN via the public FQDN /
  //            relay endpoint.
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
 *      can't.
 *   3. Else null — surfaced honestly rather than minting a conf pointed at a
 *      wrong guess.
 *
 * Both the routing-service and device-bridge probes are best-effort — a fault in
 * either swallows to null there: status still renders, and a home-mode mint with
 * a null result fails with a clear 503. The bridge is only probed when the
 * summary/env didn't already yield an IP, so the multi-box path adds no call.
 * Away mode never calls this.
 */
async function resolveHomeEndpointHost(): Promise<string | null> {
  const envFallback = (config.WIREGUARD_HOME_ENDPOINT_HOST ?? "").trim();
  let summary: Awaited<ReturnType<typeof fetchNetworkSummary>> | null = null;
  try {
    summary = await fetchNetworkSummary();
  } catch (err) {
    logger.warn({ err }, "vpn: network summary unavailable for home-endpoint discovery");
  }
  // Only reach for the bridge when env + summary came up empty (single-box).
  const fromSummary = pickHomeEndpoint({ envFallback, summary, bridgeIp: null });
  if (fromSummary) return fromSummary;
  const bridgeIp = await fetchBridgeUplinkIp();
  return pickHomeEndpoint({ envFallback, summary, bridgeIp });
}

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

/** WARP-1757 — keepalive for overlay peers, in seconds. Matches the value the
 *  connect agent installs (overlay-connect.service.ts) so a peer's keepalive
 *  doesn't change depending on which path last touched it. */
const OVERLAY_KEEPALIVE_SECONDS = 25;

/** WARP-1757 — the routing sidecar, behind the structural surface
 *  provisionOverlayPeer takes, so the service unit-tests without it. */
const overlayRouter: OverlayProvisionRouter = {
  setup: (opts) => vpnSetup(opts),
  installPeer: (opts) => installOverlayVpnPeer(opts),
};

/**
 * WARP-1758 — the endpoint candidates a client should try, best first.
 *
 * Re-observed on every call. There is no cached placement to invalidate, so a
 * DHCP renewal, a WAN failover, or the box being physically moved between an
 * edge WAN and someone else's subnet is picked up by the next profile fetch
 * with no redeploy and no owner action. That IS the auto-reconcile.
 *
 * Every candidate is an IP-literal transport address. The per-device
 * `<name>.droplet-us.com` is deliberately NOT among them: it is public-NXDOMAIN
 * under ADR-023's split-horizon, so off the home LAN it has no handshake target
 * — advertising it is the WARP-1391 dead-endpoint bug, and it is the box's
 * HTTPS/API address, not a WireGuard transport address.
 */
async function resolveOverlayEndpointCandidates(): Promise<
  OverlayEndpointCandidate[]
> {
  const snapshot = await observePlacement(
    {
      wanAddress: () => fetchBridgeUplinkIp(),
      stun: () => fetchBridgeStunProbe(),
      lanAddress: () => resolveHomeEndpointHost(),
      // No second STUN destination is available from the host bridge yet, so
      // NAT class stays `unknown` and `srflx` is still offered — we withhold it
      // only on a POSITIVE address-dependent finding, never on absence of
      // evidence. Wiring a second server is the remaining half of WARP-1758.
    },
    { listenPort: config.WIREGUARD_LISTEN_PORT },
  );
  if (snapshot.relayRequired) {
    logger.warn(
      { placement: snapshot.placement.placement, reason: snapshot.placement.reason },
      "overlay: no remotely dial-able endpoint candidate — this box needs a relay to be reachable off-LAN",
    );
  }
  return snapshot.candidates;
}

/**
 * WARP-1593 — resolve the host a QR-enrolling client should call the **HTTPS
 * enrollment API** on.
 *
 * This is deliberately NOT `resolveEndpointHost()`. That function answers a
 * different question — "where does WireGuard send UDP?" — and its second
 * priority, `WIREGUARD_ENDPOINT_HOST`, is a *transport* address that in
 * practice carries the WG port (`box.example:51820`). Minting an enroll QR
 * from it told the phone to POST an HTTPS request at the WireGuard UDP port,
 * which can never complete; the failure surfaced on the phone as a generic
 * connection error with nothing pointing at the real cause (an unconfigured
 * box). Clients must not have to know port policy to undo that — so the split
 * lives here.
 *
 * Priority — each source is honoured **only when it is a bare host**, because
 * a value carrying a port is a transport address and that is exactly the input
 * this function exists to reject. A set-but-unusable source refuses outright
 * rather than falling through: the box would otherwise silently mint a QR for
 * a DIFFERENT host than the one the operator configured.
 *   1. `DROPLET_PUBLIC_FQDN` — the per-device `<name>.droplet-us.com` name the
 *      box learns from HQ (ADR-023). Split-horizon: it resolves on the home
 *      LAN, which is where enrollment happens, and over the tunnel afterwards.
 *   2. `WIREGUARD_ENDPOINT_HOST` — an operator who set a plain hostname meant
 *      "this is the box's name".
 *   3. Empty — the caller refuses to mint and says so honestly.
 *
 * Returns a bare host (no scheme, no port); clients build `https://<host>`.
 */
export function resolveEnrollApiHost(): string {
  const fqdn = (config.DROPLET_PUBLIC_FQDN ?? "").trim();
  if (fqdn) return bareHostOrEmpty(stripSchemeAndSlash(fqdn));
  return bareHostOrEmpty(
    stripSchemeAndSlash((config.WIREGUARD_ENDPOINT_HOST ?? "").trim()),
  );
}

/**
 * Return `value` only if it is a BARE host, else empty so the caller refuses.
 *
 * WARP-1593 send-back: this guard was originally inline in the
 * `WIREGUARD_ENDPOINT_HOST` branch above, which meant the higher-priority
 * `DROPLET_PUBLIC_FQDN` returned BEFORE it ever ran — `box.example:51820` was
 * minted into a QR verbatim, exactly the transport address this function
 * exists to reject. `DROPLET_PUBLIC_FQDN` is not the closed HQ-only channel it
 * looks like either: config.ts declares it `z.string().default("")` with no
 * shape validation, and scripts/lib/secrets.sh seeds it into .env as an empty
 * key for an operator to fill in. Both branches now share ONE guard so they
 * cannot drift apart again.
 *
 *   - A port means a transport address, never an API host. Bracketed IPv6
 *     literals ("[::1]") are checked AFTER the brackets, so the colons in the
 *     address aren't mistaken for a port.
 *   - Anything past the host — path, query, fragment, userinfo — is not a host,
 *     and interior whitespace/newlines are the injection shape the shell side
 *     already hardened against for this very variable (WARP-988, WARP-994).
 */
function bareHostOrEmpty(value: string): string {
  const afterBracket = value.startsWith("[")
    ? value.slice(value.indexOf("]") + 1)
    : value;
  if (afterBracket.includes(":")) return "";
  if (/[\/?#@\s]/.test(value)) return "";
  return value;
}

/** Drop an accidental scheme prefix and any trailing slash from a host value. */
function stripSchemeAndSlash(value: string): string {
  return value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").replace(/\/+$/, "");
}

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

function isAdmin(req: Request): boolean {
  const role = req.user?.role;
  return role === "owner" || role === "admin";
}

/** WARP-1385 — the box→HQ vouching call. Injected so the route unit-tests
 *  without the gRPC device-identity sidecar; production wires it to
 *  enrollOverlayDevice + createDeviceIdentityClient below. */
export type OverlayEnrollFn = (input: OverlayEnrollInput) => Promise<unknown>;

function defaultOverlayEnroll(input: OverlayEnrollInput): Promise<unknown> {
  return enrollOverlayDevice(
    {
      config: {
        hqBaseUrl: config.HQ_ISSUANCE_URL,
        deviceId: config.DROPLET_DEVICE_ID,
      },
      identity: createDeviceIdentityClient(),
    },
    input,
  );
}

// WARP-1385 (Part D) — body for POST /api/vpn/overlay/devices. base64 wg key
// (43 chars + '='); a PEM public key; a human label.
const overlayEnrollSchema = z.object({
  wg_public_key: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, "must be a base64 WireGuard public key"),
  // NOT trimmed: the box vouches over EXACTLY the bytes it received (the enroll
  // grant embeds sha256(sign_public_key_pem)), so trimming here would desync the
  // box's fingerprint from what the client + HQ compute.
  sign_public_key_pem: z
    .string()
    .min(1)
    .includes("PUBLIC KEY", { message: "must be a PEM public key" }),
  label: z.string().trim().min(1).max(64),
});

// ── WARP-1474 — dashboard-QR overlay device linking ──
//
// A tamper-evident audit entry emitted for every overlay-enroll action AND for
// every 4xx on the two enroll routes (completeness). Injected so route tests
// capture rows deterministically; production wires it to the signed-activity
// recorder below.
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

/** DoS caps for the QR-link flow. GLOBAL + per-token are the real backstop; the
 *  per-owner / per-IP caps stop a single principal monopolising the budget. */
export interface OverlayRateLimits {
  windowMs: number;
  mintPerOwner: number;
  mintGlobal: number;
  byTokenPerIp: number;
  byTokenPerToken: number;
  byTokenGlobal: number;
  /** hard cap on concurrently-active QR-enrolled overlay devices. */
  maxActiveQrDevices: number;
}

const DEFAULT_OVERLAY_RATE_LIMITS: OverlayRateLimits = {
  windowMs: 60_000,
  mintPerOwner: 5,
  mintGlobal: 30,
  byTokenPerIp: 20,
  byTokenPerToken: 10,
  byTokenGlobal: 120,
  maxActiveQrDevices: MAX_ACTIVE_QR_OVERLAY_DEVICES,
};

// Body for POST /vpn/overlay/devices/by-token. The PEM is validated separately
// (parseP256Spki) so an oversized / wrong-curve key is a clean 400; zod covers
// the token, the WireGuard key shape, and the label charset here.
const byTokenSchema = z.object({
  token: z.string().min(1),
  wg_public_key: z
    .string()
    .regex(WG_PUBLIC_KEY_RE, "must be a base64 WireGuard public key"),
  sign_public_key_pem: z.string().min(1),
  label: overlayLabelSchema,
});

/** Pull HQ's device reference out of the enroll broker's opaque result. */
function extractDeviceId(result: unknown): string | null {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    for (const k of ["device_id", "device_ref", "deviceId", "id"]) {
      if (typeof r[k] === "string") return r[k] as string;
    }
  }
  return null;
}

export function createVpnRouter(
  prisma: PrismaClient,
  opts: {
    overlayEnroll?: OverlayEnrollFn;
    now?: () => Date;
    recordOverlayAudit?: OverlayAuditFn;
    overlayRateLimits?: Partial<OverlayRateLimits>;
  } = {},
): Router {
  const router = Router();
  const overlayEnroll = opts.overlayEnroll ?? defaultOverlayEnroll;
  const now = opts.now ?? (() => new Date());
  const audit = opts.recordOverlayAudit ?? defaultOverlayAudit;
  const limits: OverlayRateLimits = {
    ...DEFAULT_OVERLAY_RATE_LIMITS,
    ...(opts.overlayRateLimits ?? {}),
  };
  // One limiter instance per router; real-time clock (independent of the domain
  // `now` so a test that pins `now` doesn't freeze the rate windows).
  const rl = new FixedWindowRateLimiter();

  // Audit EVERY 4xx on the two enroll routes (mint + by-token). Hooks the
  // response `finish` so it fires whether the 4xx came from requireRole, the
  // rate limiter, boundary validation, or the handler.
  const clientIdForAudit = (req: Request): string =>
    req.user?.id ?? `ip:${req.ip ?? "unknown"}`;
  const auditEvery4xx =
    (route: string) =>
    (req: Request, res: Response, next: NextFunction): void => {
      res.on("finish", () => {
        if (res.statusCode >= 400 && res.statusCode < 500) {
          audit({
            event: "overlay_enroll_4xx",
            method: req.method,
            route,
            status: res.statusCode,
            clientId: clientIdForAudit(req),
          });
        }
      });
      next();
    };

  // Declared here rather than at its route because provisionApprovedPeer below
  // audits against it and both approve paths share that helper.
  const ROUTE_APPROVE = "/vpn/overlay/pending-enrollments/:id/approve";

  /**
   * WARP-1757 — make the box ready to accept an approved device's handshake.
   *
   * Shared by BOTH approve paths so they cannot drift: the first approval (just
   * after the HQ vouch) and a re-approval of an already-'approved' row, which
   * is a pure retry that never touches the vouch. Returns `null` on failure —
   * the caller reports `tunnel_ready:false` rather than throwing, because a
   * failed provision must never roll a vouched enrollment back.
   *
   * The routing sidecar is the only fallible collaborator here; every failure
   * mode is transient-ish (wg0 setup, IP allocation, peer install), which is
   * what makes a retry the right recovery instead of a rollback.
   */
  const provisionApprovedPeer = async (
    req: Request,
    pending: {
      id: string;
      wgPublicKey: string;
      label: string;
      linkTokenId: string;
    },
    provenance: {
      linkTokenEnrolledBy: string | null;
      /** Original approval time; omitted on a first provision. */
      enrolledAt?: Date;
      /** HQ device ref, for the failure audit. Absent on a retry. */
      deviceId?: string | null;
    },
  ): Promise<ProvisionedOverlayPeer | null> => {
    try {
      return await provisionOverlayPeer(
        {
          prisma,
          router: overlayRouter,
          allocateIp: () => allocatePeerIp(prisma, config.WIREGUARD_VPN_SUBNET),
          config: {
            listenPort: config.WIREGUARD_LISTEN_PORT,
            serverAddress: serverAddressFromSubnet(config.WIREGUARD_VPN_SUBNET),
            vpnInterface: "wg0",
            keepaliveSeconds: OVERLAY_KEEPALIVE_SECONDS,
          },
          now,
        },
        {
          wgPublicKey: pending.wgPublicKey,
          label: pending.label,
          linkTokenId: pending.linkTokenId,
          linkTokenEnrolledBy: provenance.linkTokenEnrolledBy,
          enrolledAt: provenance.enrolledAt,
        },
      );
    } catch (provisionErr) {
      logger.error(
        { err: provisionErr, pendingId: pending.id },
        "overlay approve: peer provisioning failed — device is approved but cannot connect yet",
      );
      audit({
        event: "overlay_enroll_provision_failed",
        method: req.method,
        route: ROUTE_APPROVE,
        status: 200,
        clientId: req.user?.id ?? "unknown",
        refs: { pending_id: pending.id, device_id: provenance.deviceId ?? null },
      });
      return null;
    }
  };

  // ── POST /api/vpn/overlay/devices ──
  // WARP-1385 (ADR-030) — enroll an owner device into the direct-punch overlay.
  // Owner/admin only: the box signs a grant over the client's key material and
  // vouches for it to HQ (the box→HQ bridge the Android client — WARP-1386 —
  // calls). HQ never owns user accounts; the box signature IS the vouch.
  // WARP-1882 — SIGNING IN IS THE ENROLLMENT.
  //
  // Remote access is not a feature you configure. A device whose user has just
  // proved who they are by signing in should not then be asked to mint a code,
  // scan it, and have a fingerprint approved — that is three deliberate acts
  // to authorise something already authorised.
  //
  // So this one authenticated call does the whole job: vouch to HQ, provision
  // the wg0 peer, and return the profile the client needs to bring a tunnel
  // up. Before this it did only the first of those and returned HQ's raw
  // result, which meant a bearer-enrolled device was registered and then had
  // no way to learn its own address, the box's key, its routes or its
  // resolvers. That is the "two halves never joined" shape the epic already
  // hit once, sitting in the path that should have been the primary one.
  //
  // Not owner/admin-gated. A family member enrolling THEIR OWN device is the
  // ordinary case, and the peer is scoped to them — which is what makes it
  // show up in their own device list and be revocable without an admin.
  //
  // Idempotent on the device's WireGuard public key: calling it again refreshes
  // and returns the same profile. That is deliberate and it is why there is no
  // separate re-fetch endpoint — a client that has lost its profile, or wants
  // freshly-observed endpoint candidates after moving networks, simply calls
  // this again on next launch.
  router.post(
    "/vpn/overlay/devices",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = overlayEnrollSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid request",
            details: parsed.error.flatten(),
          });
        }
        if (!config.HQ_ISSUANCE_URL) {
          return res.status(503).json({
            error:
              "The box hasn't linked to its fleet directory yet — remote-access enrollment turns on automatically once it does.",
          });
        }

        const user = getUser(req);
        const owner = req.user?.id ?? user.username;

        // The device's key may already belong to somebody else's peer. Refuse
        // rather than silently re-home it — a key collision is either a bug or
        // an attempt to hijack another member's tunnel address, and neither
        // should be resolved by whoever called last.
        const clash = await prisma.vpnPeer.findFirst({
          where: { publicKey: parsed.data.wg_public_key, status: "active" },
        });
        if (clash && clash.userId !== owner && clash.userId !== "overlay") {
          return res.status(409).json({
            error: "wg_key_conflict",
            message:
              "That device is already set up under a different account on this Droplet.",
          });
        }

        // The HQ vouch, byte-identical to the approve path's.
        const vouch = await overlayEnroll({
          wgPublicKey: parsed.data.wg_public_key,
          signPublicKeyPem: parsed.data.sign_public_key_pem,
          label: parsed.data.label,
        });

        // Provisioning failure does NOT roll the vouch back — it is not
        // idempotent and HQ already knows this device. The client is told the
        // tunnel isn't ready and retries by calling this again, which re-runs
        // provisioning against the same key and reuses the same address.
        let provisioned: ProvisionedOverlayPeer;
        try {
          provisioned = await provisionOverlayPeer(
            {
              prisma,
              router: overlayRouter,
              allocateIp: () => allocatePeerIp(prisma, config.WIREGUARD_VPN_SUBNET),
              config: {
                listenPort: config.WIREGUARD_LISTEN_PORT,
                serverAddress: serverAddressFromSubnet(config.WIREGUARD_VPN_SUBNET),
                vpnInterface: "wg0",
                keepaliveSeconds: OVERLAY_KEEPALIVE_SECONDS,
              },
              now,
            },
            {
              wgPublicKey: parsed.data.wg_public_key,
              label: parsed.data.label,
              userId: owner,
              // No token was involved. `linkTokenEnrolledBy` still records who
              // brought the device in — here, themselves — so the owner's
              // device list can attribute it (WARP-1763) instead of showing a
              // bare synthetic id.
              linkTokenId: null,
              linkTokenEnrolledBy: owner,
            },
          );
        } catch (provisionErr) {
          logger.error(
            { err: provisionErr, clientId: owner },
            "overlay sign-in enroll: peer provisioning failed — device is registered but cannot connect yet",
          );
          return res.status(503).json({
            error: "tunnel_not_ready",
            message:
              "Your Droplet registered this device but couldn't finish setting up its connection. Try again in a moment.",
          });
        }

        const profile = buildOverlayProfile({
          assignedIp: provisioned.assignedIp,
          serverPublicKey: provisioned.serverPublicKey,
          mode: OVERLAY_PEER_MODE,
          awayAllowedIps: config.WIREGUARD_LAN_CIDR,
          awayDns: config.WIREGUARD_DNS,
          homeAllowedIps: config.WIREGUARD_HOME_ALLOWED_IPS,
          homeDns: config.WIREGUARD_HOME_DNS,
          vpnSubnet: config.WIREGUARD_VPN_SUBNET,
          keepaliveSeconds: OVERLAY_KEEPALIVE_SECONDS,
          endpointCandidates: await resolveOverlayEndpointCandidates(),
        });

        // The owner should be able to see, after the fact, that a device
        // gained remote access — precisely BECAUSE nobody had to approve it.
        // Removing the approval step without leaving a trace would make the
        // flow silent in both directions.
        void recordActivity({
          kind: "network",
          severity: "ok",
          sourceIcon: "shield",
          what: `${parsed.data.label} set up remote access`,
          sub: `${owner} signed in on this device`,
          actor: { type: "user", id: owner },
          refs: { assigned_ip: provisioned.assignedIp },
        });

        // `device` carries HQ's response so an existing caller that only read
        // that keeps working; `profile` is the half that was missing.
        return res.status(200).json({ device: vouch, profile });
      } catch (err) {
        if (err instanceof RouterError && ROUTING_UNAVAILABLE_CODES.has(err.code)) {
          return res.status(503).json({
            error: "tunnel_not_ready",
            message:
              "The Droplet's network service isn't responding right now. Try again in a moment.",
          });
        }
        logger.warn({ err }, "overlay device enroll failed");
        return next(err);
      }
    },
  );

  // ══ WARP-1474 — dashboard-QR overlay device linking (ADR-030) ══════════════
  //
  // Flow: owner mints a QR (POST link-tokens) → phone scans + redeems it with NO
  // bearer (POST devices/by-token), which STAGES a PendingOverlayEnrollment and
  // performs NO HQ vouch and installs NO wg0 peer → the phone polls its coarse
  // state (GET …/status, PoP-guarded) → the owner reviews the pending list and
  // approves/denies. ONLY on approve does the box call the identical WARP-1385
  // enrollOverlayDevice broker to vouch the device to HQ.

  const ROUTE_MINT = "/vpn/overlay/link-tokens";
  const ROUTE_BY_TOKEN = "/vpn/overlay/devices/by-token";

  // ── POST /api/vpn/overlay/link-tokens ── (owner) mint a QR link token.
  router.post(
    ROUTE_MINT,
    auditEvery4xx(ROUTE_MINT),
    requireRole("owner", "admin"),
    (req: Request, res: Response, next: NextFunction) => {
      // Per-owner then global cap. Owner first so one owner hitting their cap
      // doesn't consume another owner's slice of the global budget.
      const ownerId = req.user?.id ?? "unknown";
      if (
        !rl.check(`mint:owner:${ownerId}`, limits.mintPerOwner, limits.windowMs) ||
        !rl.check("mint:global", limits.mintGlobal, limits.windowMs)
      ) {
        return res.status(429).json({ error: "rate_limited" });
      }
      return next();
    },
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const createdBy = req.user?.id ?? "unknown";
        // WARP-1593: resolve the API host BEFORE minting anything. A QR whose
        // `server` we can't fill honestly is worse than no QR — and the mint
        // transaction below expires the owner's current token, so failing
        // after it would cost them a working code to hand back an error.
        const server = resolveEnrollApiHost();
        if (!server) {
          audit({
            event: "overlay_link_mint_refused",
            method: req.method,
            route: ROUTE_MINT,
            status: 503,
            clientId: createdBy,
            refs: { reason: "remote_access_not_configured" },
          });
          return res.status(503).json({
            error: "remote_access_not_configured",
            message:
              "This Droplet doesn't have its internet address yet, so a linking code can't be created. Finish setting up remote access, then try again.",
          });
        }
        const { token, tokenHash } = generateLinkToken();
        const parsedLabel = overlayLabelSchema.safeParse(req.body?.label);
        const expiresAt = new Date(now().getTime() + OVERLAY_LINK_TOKEN_TTL_MS);
        // Single-active-per-owner: flip any prior AVAILABLE token for this owner
        // to expired, then create the new one — as ONE transaction (SEND-BACK
        // #5). Non-atomic, a crash between the two writes could leave the owner
        // with zero available tokens (old expired, new never created) or, if the
        // create landed but the supersession didn't, two available tokens.
        await prisma.$transaction([
          prisma.overlayLinkToken.updateMany({
            where: { createdBy, state: "available" },
            data: { state: "expired" },
          }),
          prisma.overlayLinkToken.create({
            data: {
              tokenHash, // ONLY the hash is persisted — never the plaintext token
              state: "available",
              expiresAt,
              createdBy,
              label: parsedLabel.success ? parsedLabel.data : null,
            },
          }),
        ]);
        const boxName =
          config.DROPLET_BOX_NAME || config.DROPLET_PUBLIC_FQDN || "Droplet";
        audit({
          event: "overlay_link_mint",
          method: req.method,
          route: ROUTE_MINT,
          status: 201,
          clientId: createdBy,
          refs: { tokenHash },
        });
        // Token returned ONCE, in plaintext, right here — never again.
        return res.status(201).json({
          token,
          server,
          box_name: boxName,
          expires_at: expiresAt.toISOString(),
        });
      } catch (err) {
        return next(err);
      }
    },
  );

  // ── POST /api/vpn/overlay/devices/by-token ── (NO bearer) redeem + stage.
  router.post(
    ROUTE_BY_TOKEN,
    auditEvery4xx(ROUTE_BY_TOKEN),
    (req: Request, res: Response, next: NextFunction) => {
      // Global then per-IP cap BEFORE any body work — the DoS backstop.
      if (
        !rl.check("bytoken:global", limits.byTokenGlobal, limits.windowMs) ||
        !rl.check(
          `bytoken:ip:${req.ip ?? "unknown"}`,
          limits.byTokenPerIp,
          limits.windowMs,
        )
      ) {
        return res.status(429).json({ error: "rate_limited" });
      }
      return next();
    },
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Boundary-validate BEFORE touching the token — a malformed body must
        // never consume a token or create a row.
        const parsed = byTokenSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "invalid_request",
            details: parsed.error.flatten(),
          });
        }
        // Keep the EXACT validated PEM bytes un-trimmed so sha256(pem) stays
        // byte-identical to the box vouch + HQ recompute.
        const pem = parsed.data.sign_public_key_pem;
        if (!parseP256Spki(pem).ok) {
          return res.status(400).json({ error: "invalid_sign_key" });
        }
        const tokenHash = hashToken(parsed.data.token);
        // Per-token cap — bounds redeem attempts against a single QR (hijack /
        // brute-force backstop).
        if (
          !rl.check(
            `bytoken:token:${tokenHash}`,
            limits.byTokenPerToken,
            limits.windowMs,
          )
        ) {
          return res.status(429).json({ error: "rate_limited" });
        }
        const fp = signKeyFingerprint(pem);
        const nowDate = now();

        // Atomic consume: exactly one AVAILABLE + unexpired row flips to
        // consumed, binding the first redeemer's fingerprint. count === 1 ⇒ we
        // won the redeem.
        const consumed = await prisma.overlayLinkToken.updateMany({
          where: { tokenHash, state: "available", expiresAt: { gt: nowDate } },
          data: { state: "consumed", consumedAt: nowDate, boundSignFp: fp },
        });
        if (consumed.count === 1) {
          const tokenRow = await prisma.overlayLinkToken.findUnique({
            where: { tokenHash },
          });
          const pending = await prisma.pendingOverlayEnrollment.create({
            data: {
              linkTokenId: tokenRow?.id ?? "",
              signKeyFingerprint: fp,
              signPublicKeyPem: pem,
              wgPublicKey: parsed.data.wg_public_key,
              label: parsed.data.label,
              presentedAt: nowDate,
              state: "pending",
            },
          });
          audit({
            event: "overlay_enroll_by_token_pending",
            method: req.method,
            route: ROUTE_BY_TOKEN,
            status: 202,
            clientId: clientIdForAudit(req),
            refs: { tokenHash, fingerprint: fp, label: parsed.data.label },
          });
          return res
            .status(202)
            .json({ state: "pending", pending_id: pending.id });
        }

        // count === 0 — classify against the fresh token state.
        const tokenRow = await prisma.overlayLinkToken.findUnique({
          where: { tokenHash },
        });
        if (!tokenRow) {
          return res.status(401).json({ error: "unknown_token" });
        }
        if (tokenRow.state === "consumed") {
          const existing = await prisma.pendingOverlayEnrollment.findFirst({
            where: { linkTokenId: tokenRow.id },
          });
          if (tokenRow.boundSignFp === fp) {
            // Same device re-redeeming — idempotent, return the same pending id.
            if (existing) {
              return res
                .status(202)
                .json({ state: "pending", pending_id: existing.id });
            }
            // SEND-BACK #6 (LOW, documented not fixed): a same-fingerprint retry
            // that races the winning redeem BETWEEN its atomic token-consume and
            // its pending-row create sees boundSignFp===fp but no `existing` row
            // yet, so it briefly 410s here instead of 202. This is a sub-request
            // window that SELF-HEALS on the client's next poll/redeem (the row
            // exists by then). Left as a documented low rather than adding a
            // re-read/retry loop: the client already retries the redeem, a spin
            // here would add latency to the common path, and a bounded re-read
            // still can't close the window deterministically. The winner is
            // unaffected; only the losing concurrent retry sees the transient.
            return res.status(410).json({ error: "gone" });
          }
          // A DIFFERENT device tried to redeem an already-bound token — flag the
          // owner-visible conflict on the pending row + audit + owner alert.
          if (existing && !existing.conflict) {
            await prisma.pendingOverlayEnrollment.update({
              where: { id: existing.id },
              data: { conflict: true },
            });
          }
          audit({
            event: "overlay_enroll_token_conflict",
            method: req.method,
            route: ROUTE_BY_TOKEN,
            status: 409,
            clientId: clientIdForAudit(req),
            refs: { tokenHash, fingerprint: fp, ownerAlert: true },
          });
          return res.status(409).json({ error: "token_conflict" });
        }
        // state 'expired' (superseded) OR 'available' but past TTL (findUnique
        // re-read fresh, so an 'available' row with count 0 is expired-by-time).
        audit({
          event: "overlay_enroll_expired",
          method: req.method,
          route: ROUTE_BY_TOKEN,
          status: 410,
          clientId: clientIdForAudit(req),
          refs: { tokenHash },
        });
        return res.status(410).json({ error: "expired" });
      } catch (err) {
        return next(err);
      }
    },
  );

  // ── GET /api/vpn/overlay/devices/by-token/:pending_id/status ── (NO bearer).
  // Client proves possession of the sign key with X-Overlay-PoP; reveals only
  // the coarse state. Unknown id AND bad PoP both 401 — no existence leak.
  const ROUTE_STATUS = "/vpn/overlay/devices/by-token/:pending_id/status";
  router.get(
    ROUTE_STATUS,
    // SEND-BACK #3 — this is an UNAUTHENTICATED endpoint that runs an ECDSA
    // verify per hit, so it needs the same audit-every-4xx + DoS backstop as the
    // redeem route. Reuse the by-token per-IP + global limiter keys so a flood
    // of polls shares the redeem budget (bounded on an always-on box).
    auditEvery4xx(ROUTE_STATUS),
    (req: Request, res: Response, next: NextFunction) => {
      if (
        !rl.check("bytoken:global", limits.byTokenGlobal, limits.windowMs) ||
        !rl.check(
          `bytoken:ip:${req.ip ?? "unknown"}`,
          limits.byTokenPerIp,
          limits.windowMs,
        )
      ) {
        return res.status(429).json({ error: "rate_limited" });
      }
      return next();
    },
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const pop = req.header("X-Overlay-PoP");
        if (!pop) {
          return res.status(401).json({ error: "pop_required" });
        }
        const pending = await prisma.pendingOverlayEnrollment.findUnique({
          where: { id: req.params.pending_id },
        });
        if (
          !pending ||
          !verifyStatusPop(pending.signPublicKeyPem, pending.id, pop)
        ) {
          return res.status(401).json({ error: "unauthorized" });
        }
        return res.status(200).json({ state: pending.state });
      } catch (err) {
        return next(err);
      }
    },
  );

  // ── GET /api/vpn/overlay/devices/by-token/:pending_id/profile ── (NO bearer).
  // WARP-1757 — the missing link. An APPROVED device fetches everything it
  // needs to assemble a wg-quick conf around the key it already holds.
  //
  // Same PoP shape as /status but over a DIFFERENT domain-prefixed message, so
  // a captured status signature can't be replayed to read the box's server key
  // and endpoint candidates. Unknown id and bad PoP both 401, identically to
  // /status — no existence leak.
  //
  // No private key is ever involved: the device generated its own keypair at
  // enrollment and kept the private half, which is exactly why this returns a
  // profile rather than a rendered .conf.
  const ROUTE_PROFILE = "/vpn/overlay/devices/by-token/:pending_id/profile";
  router.get(
    ROUTE_PROFILE,
    auditEvery4xx(ROUTE_PROFILE),
    (req: Request, res: Response, next: NextFunction) => {
      // Same unauthenticated-endpoint DoS backstop as redeem/status, sharing
      // their budget: an ECDSA verify per hit on an always-on box.
      if (
        !rl.check("bytoken:global", limits.byTokenGlobal, limits.windowMs) ||
        !rl.check(
          `bytoken:ip:${req.ip ?? "unknown"}`,
          limits.byTokenPerIp,
          limits.windowMs,
        )
      ) {
        return res.status(429).json({ error: "rate_limited" });
      }
      return next();
    },
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const pop = req.header("X-Overlay-PoP");
        if (!pop) {
          return res.status(401).json({ error: "pop_required" });
        }
        const pending = await prisma.pendingOverlayEnrollment.findUnique({
          where: { id: req.params.pending_id },
        });
        if (
          !pending ||
          !verifyProfilePop(pending.signPublicKeyPem, pending.id, pop)
        ) {
          return res.status(401).json({ error: "unauthorized" });
        }
        // Authenticated but not yet approved: say so plainly. The device polls
        // /status for this; answering 409 here keeps "not approved" and
        // "approved but not provisioned" distinguishable.
        if (pending.state !== "approved") {
          return res
            .status(409)
            .json({ error: "not_approved", state: pending.state });
        }
        // The peer row is the record of provisioning. Its absence means the
        // approve-time provisioning failed (or predates WARP-1757) — honest
        // 503 rather than a profile whose address nothing on wg0 would accept.
        const peer = await prisma.vpnPeer.findFirst({
          where: { publicKey: pending.wgPublicKey, status: "active" },
        });
        if (!peer) {
          // NOT a "wait and it'll sort itself out" state. Nothing retries this
          // on the device's behalf: approve-time provisioning already failed,
          // and the connect tick that could self-heal the peer is behind
          // OVERLAY_CONNECT_ENABLED — default false, and set in no deployment
          // artifact. The one thing that DOES fix it is the owner approving the
          // device again, which re-runs provisioning (and only provisioning).
          // Say that, rather than promising a retry that will never happen.
          return res.status(503).json({
            error: "tunnel_not_ready",
            message:
              "This device is approved, but the Droplet couldn't finish setting up its tunnel. Ask the Droplet's owner to approve this device again — that retries the setup.",
          });
        }
        // The server public key comes from the interface itself. vpnSetup is a
        // no-op when wg0 exists, so this both reads the key and repairs an
        // interface that vanished under us.
        const setup = await vpnSetup({
          listenPort: config.WIREGUARD_LISTEN_PORT,
          address: serverAddressFromSubnet(config.WIREGUARD_VPN_SUBNET),
        });
        // AllowedIPs and DNS come as a PAIR, selected by the peer row's own
        // mode — never one mode's subnet with the other's resolver. A resolver
        // outside every AllowedIPs entry leaves the tunnel up but sends DNS out
        // the client's default route, so the split-horizon FQDN (ADR-023 §3.4)
        // resolves to public NXDOMAIN. buildOverlayProfile owns the selection;
        // the route only supplies both pairs.
        const profile = buildOverlayProfile({
          assignedIp: peer.assignedIp,
          serverPublicKey: setup.public_key,
          mode: (peer.mode as VpnPeerMode | undefined) ?? OVERLAY_PEER_MODE,
          awayAllowedIps: config.WIREGUARD_LAN_CIDR,
          awayDns: config.WIREGUARD_DNS,
          homeAllowedIps: config.WIREGUARD_HOME_ALLOWED_IPS,
          homeDns: config.WIREGUARD_HOME_DNS,
          vpnSubnet: config.WIREGUARD_VPN_SUBNET,
          keepaliveSeconds: OVERLAY_KEEPALIVE_SECONDS,
          endpointCandidates: await resolveOverlayEndpointCandidates(),
        });
        audit({
          event: "overlay_profile_issued",
          method: req.method,
          route: ROUTE_PROFILE,
          status: 200,
          clientId: pending.id,
          refs: { pending_id: pending.id },
        });
        return res.status(200).json(profile);
      } catch (err) {
        if (err instanceof RouterError && ROUTING_UNAVAILABLE_CODES.has(err.code)) {
          return res.status(503).json({
            error: "tunnel_not_ready",
            message:
              "The Droplet's network service isn't responding right now. Try again in a moment.",
          });
        }
        return next(err);
      }
    },
  );

  // ── GET /api/vpn/overlay/pending-enrollments ── (owner) review queue.
  router.get(
    "/vpn/overlay/pending-enrollments",
    requireRole("owner", "admin"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const rows = await prisma.pendingOverlayEnrollment.findMany({
          orderBy: { presentedAt: "desc" },
        });
        return res.json(
          rows.map((r) => ({
            id: r.id,
            label: r.label,
            // first 8 hex of sha256(pem) — the owner eyeball-matches this.
            fingerprint_short: fingerprintShort(r.signPublicKeyPem),
            presented_at: r.presentedAt,
            state: r.state,
            conflict: r.conflict,
          })),
        );
      } catch (err) {
        return next(err);
      }
    },
  );

  // ── POST /api/vpn/overlay/pending-enrollments/:id/approve ── (owner).
  // ROUTE_APPROVE is declared above, next to provisionApprovedPeer.
  router.post(
    ROUTE_APPROVE,
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      const clientId = req.user?.id ?? "unknown";
      try {
        const pending = await prisma.pendingOverlayEnrollment.findUnique({
          where: { id: req.params.id },
        });
        if (!pending) {
          return res.status(404).json({ error: "not_found" });
        }
        if (pending.state === "approved") {
          // Idempotent re-approve — return the recorded HQ device ref.
          //
          // The vouch is NOT re-fired: it is not idempotent, HQ already knows
          // this device, and preventing a second one is the entire reason this
          // branch short-circuits ahead of the claim. Provisioning is a
          // different matter — it is idempotent by construction (setup() is a
          // no-op on an existing wg0, an existing row's address is reused, and
          // the router-side install is a refresh), and re-approval is the ONLY
          // recovery a shipping box has when the first attempt failed: the row
          // stays 'approved' with no usable peer, /profile 503s, and the
          // connect tick that could self-heal is behind
          // OVERLAY_CONNECT_ENABLED (default false, in no deployment
          // artifact). So retry the provisioning half only.
          //
          // The original approver + enrolment time are passed back in so a
          // retry repairs the tunnel without rewriting the audit trail.
          const retried = await provisionApprovedPeer(req, pending, {
            linkTokenEnrolledBy: pending.approvedBy ?? req.user?.id ?? null,
            enrolledAt: pending.enrolledAt ?? undefined,
          });
          return res.status(200).json({
            state: "approved",
            device_id: pending.hqDeviceRef ?? null,
            // Same field the first approve returns — a client polling this must
            // not see `undefined` on the retry that actually fixed things.
            tunnel_ready: retried !== null,
          });
        }
        if (pending.state !== "pending") {
          // 'approving' (a concurrent approver already holds the claim),
          // 'denied', or 'expired'. Never re-vouch.
          return res
            .status(409)
            .json({ error: `cannot approve a ${pending.state} enrollment` });
        }

        // SEND-BACK #2 — make the vouch fire AT MOST ONCE. Atomically CLAIM the
        // row (pending → approving) before doing anything irreversible. The
        // conditional update is the serialization point: two overlapping
        // approves both read 'pending' above, but only ONE flips the row here
        // (count === 1); the loser matches 0 rows and gets a clean 409 instead
        // of a duplicate HQ vouch. 'approving' is CHECK-enum pinned (migration).
        const claim = await prisma.pendingOverlayEnrollment.updateMany({
          where: { id: pending.id, state: "pending" },
          data: { state: "approving" },
        });
        if (claim.count === 0) {
          return res.status(409).json({ error: "already_being_approved" });
        }

        // We now OWN the claim. Any pre-vouch rejection (or a failed vouch) must
        // COMPENSATE the row back to 'pending' so the owner can retry — the
        // claim is otherwise a dead 'approving' row nobody can act on.
        const compensate = (): Promise<unknown> =>
          prisma.pendingOverlayEnrollment
            .updateMany({
              where: { id: pending.id, state: "approving" },
              data: { state: "pending" },
            })
            .catch((e) =>
              logger.warn(
                { err: e, pendingId: pending.id },
                "overlay approve: compensation to pending failed",
              ),
            );

        // Hard cap on concurrently-active QR-enrolled overlay devices — reject
        // over cap BEFORE vouching. Our own row is 'approving', so it is NOT
        // counted in the 'approved' tally.
        const activeCount = await prisma.pendingOverlayEnrollment.count({
          where: { state: "approved" },
        });
        if (activeCount >= limits.maxActiveQrDevices) {
          await compensate();
          audit({
            event: "overlay_enroll_cap_reached",
            method: req.method,
            route: ROUTE_APPROVE,
            status: 409,
            clientId,
            refs: { pending_id: pending.id, cap: limits.maxActiveQrDevices },
          });
          return res.status(409).json({ error: "overlay_device_cap_reached" });
        }
        if (!config.HQ_ISSUANCE_URL) {
          await compensate();
          return res.status(503).json({
            error:
              "The box hasn't linked to its fleet directory yet — remote-access enrollment turns on automatically once it does.",
          });
        }

        // SEND-BACK #7 — dedupe by wgPublicKey BEFORE vouching. VpnPeer.publicKey
        // is @unique, so two staged rows sharing one wg key that BOTH vouch would
        // collide on peer-install as an unhandled 500. Reject the second with a
        // clean 409 (an active peer already holds it, or another enrollment was
        // already approved with it).
        const [dupPeer, dupApproved] = await Promise.all([
          prisma.vpnPeer.findFirst({
            where: { publicKey: pending.wgPublicKey, status: "active" },
          }),
          prisma.pendingOverlayEnrollment.findFirst({
            where: {
              wgPublicKey: pending.wgPublicKey,
              state: "approved",
              id: { not: pending.id },
            },
          }),
        ]);
        if (dupPeer || dupApproved) {
          await compensate();
          audit({
            event: "overlay_enroll_wg_key_conflict",
            method: req.method,
            route: ROUTE_APPROVE,
            status: 409,
            clientId,
            refs: { pending_id: pending.id },
          });
          return res.status(409).json({ error: "wg_key_conflict" });
        }

        // The IDENTICAL box→HQ vouch the owner-JWT /devices route uses — fired
        // AT MOST ONCE per pending id thanks to the claim above. On failure,
        // compensate → pending (retryable) and surface 503 rather than leaving a
        // stuck 'approving' row or a half-made network grant.
        let result: unknown;
        try {
          result = await overlayEnroll({
            wgPublicKey: pending.wgPublicKey,
            signPublicKeyPem: pending.signPublicKeyPem,
            label: pending.label,
          });
        } catch (vouchErr) {
          await compensate();
          logger.warn(
            { err: vouchErr, pendingId: pending.id },
            "overlay approve: HQ vouch failed — rolled back to pending for retry",
          );
          audit({
            event: "overlay_enroll_vouch_failed",
            method: req.method,
            route: ROUTE_APPROVE,
            status: 503,
            clientId,
            refs: { pending_id: pending.id },
          });
          return res.status(503).json({
            error:
              "Couldn't reach the fleet directory to finish linking this device. It's back in your review queue — try approving again in a minute.",
          });
        }

        const deviceId = extractDeviceId(result);
        const nowDate = now();

        // WARP-1757 — approval is the moment the box becomes ready to accept
        // this device's handshake. Ensure wg0 exists, allocate the device's
        // tunnel address, persist the peer row, and install the router-side
        // peer keyed on the key the device ENROLLED with.
        //
        // Before this, approval installed nothing: the router-side peer was
        // created lazily by the connect tick, which ships disabled, so the
        // enrolled key was registered with HQ and then never used by any
        // tunnel. This is the seam that made "approved" mean "connectable".
        //
        // Provisioning failure does NOT roll the enrollment back. The HQ vouch
        // already succeeded and is not idempotent — compensating to 'pending'
        // would invite a second vouch for a device HQ already knows. The row
        // stays 'approved', the response says tunnel_ready:false, and /profile
        // reports honestly that the tunnel isn't ready. Recovery is an explicit
        // owner action: re-approving an already-'approved' row re-runs THIS
        // provisioning and nothing else (see the idempotent branch above), so
        // the retry never reaches the vouch. Do not assume the connect tick
        // will self-heal it — that tick is behind OVERLAY_CONNECT_ENABLED,
        // which defaults false and is set in no deployment artifact.
        const provisioned = await provisionApprovedPeer(req, pending, {
          linkTokenEnrolledBy: req.user?.id ?? null,
          deviceId,
        });
        // Finalize approving → approved. Guarded on 'approving' so a compensating
        // path (or a manual state change) can't be silently clobbered.
        await prisma.pendingOverlayEnrollment.updateMany({
          where: { id: pending.id, state: "approving" },
          data: {
            state: "approved",
            approvedBy: req.user?.id ?? null,
            enrolledAt: nowDate,
            hqDeviceRef: deviceId,
          },
        });
        // WARP-1757: provisionOverlayPeer now owns the peer row and stamps the
        // same provenance, so the previous best-effort updateMany here would be
        // a second writer for the same fields — removed rather than left to
        // race with it. When provisioning failed there is no row to stamp.
        audit({
          event: "overlay_enroll_approved",
          method: req.method,
          route: ROUTE_APPROVE,
          status: 200,
          clientId,
          refs: {
            device_id: deviceId,
            pending_id: pending.id,
            tunnel_ready: provisioned !== null,
          },
        });
        return res.status(200).json({
          state: "approved",
          device_id: deviceId,
          // Honest signal for the owner's UI: approved does not always mean the
          // wg0 peer landed. The device can retry its profile fetch.
          tunnel_ready: provisioned !== null,
        });
      } catch (err) {
        logger.warn({ err }, "overlay pending-enrollment approve failed");
        return next(err);
      }
    },
  );

  // ── POST /api/vpn/overlay/pending-enrollments/:id/deny ── (owner).
  router.post(
    "/vpn/overlay/pending-enrollments/:id/deny",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const pending = await prisma.pendingOverlayEnrollment.findUnique({
          where: { id: req.params.id },
        });
        if (!pending) {
          return res.status(404).json({ error: "not_found" });
        }
        await prisma.pendingOverlayEnrollment.update({
          where: { id: pending.id },
          data: { state: "denied" },
        });
        audit({
          event: "overlay_enroll_denied",
          method: req.method,
          route: "/vpn/overlay/pending-enrollments/:id/deny",
          status: 200,
          clientId: req.user?.id ?? "unknown",
          refs: { pending_id: pending.id },
        });
        return res.status(200).json({ state: "denied" });
      } catch (err) {
        return next(err);
      }
    },
  );

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
      // Hybrid P1: the box's home-facing LAN IP a HOME-mode peer dials directly.
      // Discovered dynamically (DHCP — never hardcoded); null when it can't be
      // discovered and no fallback is set. Unlike endpointHost this is a private
      // LAN address that every household member on the home network already
      // sees, so it is not admin-gated. `.local`-style leakage isn't a concern
      // (it's an IP the client needs to build a home-mode conf).
      const homeEndpointHost = await resolveHomeEndpointHost();
      if (!status) {
        return res.json({
          configured: false,
          endpointConfigured,
          offLanReachable,
          homeEndpointHost,
          publicFqdn,
          message: "VPN not yet bootstrapped — POST /api/vpn/peers to start.",
        });
      }
      res.json({
        configured: true,
        endpointConfigured,
        offLanReachable,
        endpointHost: exposeEndpointHost ? (endpointHost || null) : null,
        homeEndpointHost,
        publicFqdn,
        listenPort: status.listen_port,
        serverPublicKey: status.public_key,
        addresses: status.addresses,
        peerCount: status.peer_count,
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
  });

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
        isAdmin(req) || isMcpService ? {} : { userId: user.username };
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
      //   away — the public FQDN / operator override (resolveEndpointHost).
      //   home — the box's discovered home-facing LAN IP (resolveHomeEndpointHost).
      let confEndpointHost: string;
      if (mode === "home") {
        const homeHost = await resolveHomeEndpointHost();
        if (!homeHost) {
          return res.status(503).json({
            error:
              "The box couldn't determine its LAN-facing IP for a direct (on-site) connection. It's assigned by your router (DHCP), so it can't be guessed — retry once the box is fully online, or set WIREGUARD_HOME_ENDPOINT_HOST in .env to pin it.",
          });
        }
        confEndpointHost = homeHost;
      } else {
        // FQDN-first endpoint resolution. See resolveEndpointHost above.
        const endpointHost = await resolveEndpointHost();
        if (!endpointHost) {
          return res.status(503).json({
            error:
              "The box hasn't learned its web address yet — remote access turns on automatically once it does. (Operators can set WIREGUARD_ENDPOINT_HOST in .env to override.)",
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
        dns: mode === "home" ? config.WIREGUARD_HOME_DNS : config.WIREGUARD_DNS,
        serverPublicKey: setup.public_key,
        endpointHost: confEndpointHost,
        listenPort: config.WIREGUARD_LISTEN_PORT,
        lanCidr: config.WIREGUARD_LAN_CIDR,
        vpnSubnet: config.WIREGUARD_VPN_SUBNET,
        mode,
        // Split-tunnel box subnet(s) for home mode; ignored by away mode.
        homeAllowedIps: config.WIREGUARD_HOME_ALLOWED_IPS,
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
        const removal = await deleteVpnPeer({ publicKey: peer.publicKey });
        // A 200 from routing is not proof the tunnel is down. On `uci.apply`
        // failure it answers `status: "staged" / applied: false` — the peer is
        // out of the config but STILL LIVE on wg0 until a reload. Marking the
        // row revoked here would tell an owner revoking a stolen phone that
        // the device is cut off while it still holds a route into the LAN, and
        // would then HIDE the retry (the row renders "· revoked" and the trash
        // button disappears). So: leave the row active, and say so.
        if (!isRevokeApplied(removal)) {
          logger.error(
            { peerId: id, publicKey: peer.publicKey, removed: removal.removed },
            "vpn: router staged the peer removal but never applied it — peer is still live on the interface; row left active",
          );
          return res.status(502).json({
            code: "REVOKE_STAGED",
            error:
              "We removed this device from the router's configuration, but the change didn't take effect — the device is still connected. Try revoking it again in a moment.",
            id,
          });
        }
      } catch (err) {
        if (!(err instanceof RouterError && err.status === 404)) {
          throw err;
        }
        logger.warn(
          { peerId: id, publicKey: peer.publicKey },
          "vpn: peer already gone on router — marking row revoked anyway",
        );
      }

      // Conditional write, not a blind `update` keyed on id alone. The read
      // above, this check and this write are three statements, and the router
      // call between them is the long pole — plenty of room for a concurrent
      // writer to flip the row. Re-asserting `status: "active"` in the WHERE
      // makes the transition atomic; `count === 0` means somebody else already
      // revoked it, which is the same terminal state the caller asked for, so
      // it stays a success and we do NOT re-stamp their `revokedAt`.
      const { count } = await prisma.vpnPeer.updateMany({
        where: { id, status: "active" },
        data: { status: "revoked", revokedAt: new Date() },
      });
      if (count === 0) {
        logger.warn(
          { peerId: id },
          "vpn: peer left active status concurrently during revoke — treating as already revoked",
        );
      }

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
