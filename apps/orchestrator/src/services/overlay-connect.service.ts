/**
 * WARP-1385 (ADR-030, epic WARP-1382) — the box-side WireGuard overlay connect
 * agent + the box→HQ device-enroll bridge.
 *
 * Direct-first remote access: the box keeps an OUTBOUND long-poll to HQ (no
 * inbound listener — ADR-009 holds). On a connect request HQ hands the box a
 * session offer; the box STUN-discovers its own public UDP mapping (via the
 * device-bridge, which owns host udp/51820 after WARP-1385 Part A), answers HQ
 * with that endpoint, and installs/refreshes the phone as a wg0 peer with the
 * phone's observed endpoint + a 25 s keepalive — WireGuard's own initiations +
 * keepalives ARE the box-side punch.
 *
 * Design notes:
 *   - HQ + device-bridge are hit over real HTTP (`fetchImpl`, default global
 *     `fetch`) so tests assert the exact wire bodies. The routing wg-peer
 *     install is an injected collaborator (`peers`) wired to openwrt.client in
 *     production and asserted separately at that seam.
 *   - Every HQ overlay message is PoP-signed with the box device key
 *     (`signWithDeviceKey`), utf-8 bytes → base64 signature → `{sig, sig_alg}`,
 *     matching WARP-1384's `ecdsa-sha256` domain-prefixed contract.
 *   - No `while(true)`: the poll loop + the idle-expiry sweep are driven by
 *     cron-runtime's `scheduleInterval` in index.ts. Each tick is one bounded
 *     iteration that fails closed (throws) so the runtime's backoff/logging
 *     handles transient HQ/bridge errors.
 *   - Punch telemetry (WARP-1389): box-side counters on the Analytics.metric
 *     surface + an HQ-side D1 success-rate recipe are documented in
 *     docs/overlay-connect-punch-telemetry.md.
 */
import { createHash } from "node:crypto";
import type { DeviceIdentityClient } from "./device-identity.client.js";

// --- HQ overlay message contracts (WARP-1384; box signs with its device key) ---

const OVERLAY_POLL_PREFIX = "droplet-overlay-poll:v1:";
const OVERLAY_ANSWER_PREFIX = "droplet-overlay-answer:v1:";
const OVERLAY_ENROLL_PREFIX = "droplet-overlay-enroll:v1:";

/** `droplet-overlay-poll:v1:<device_id>:<iso-ts>` */
export function buildOverlayPollMessage(deviceId: string, ts: string): string {
  return `${OVERLAY_POLL_PREFIX}${deviceId}:${ts}`;
}

/** `droplet-overlay-answer:v1:<session_id>:<box_endpoint>:<iso-ts>` */
export function buildOverlayAnswerMessage(
  sessionId: string,
  boxEndpoint: string,
  ts: string,
): string {
  return `${OVERLAY_ANSWER_PREFIX}${sessionId}:${boxEndpoint}:${ts}`;
}

/** `droplet-overlay-enroll:v1:<device_id>:<sign_key_fingerprint>:<wg_public_key>` */
export function buildOverlayEnrollMessage(
  deviceId: string,
  signKeyFingerprint: string,
  wgPublicKey: string,
): string {
  return `${OVERLAY_ENROLL_PREFIX}${deviceId}:${signKeyFingerprint}:${wgPublicKey}`;
}

const OVERLAY_REVOKE_PREFIX = "droplet-overlay-revoke:v1:";

/** `droplet-overlay-revoke:v1:<device_id>:<wg_public_key>` — byte-for-byte the
 *  string HQ's verifyBoxSignature rebuilds (fleet-hq worker/src/crypto.ts). */
export function buildOverlayRevokeMessage(
  deviceId: string,
  wgPublicKey: string,
): string {
  return `${OVERLAY_REVOKE_PREFIX}${deviceId}:${wgPublicKey}`;
}

/** Stable lowercase-hex sha256 (the sign-key fingerprint embedded in the enroll
 *  grant is `sha256(sign_public_key_pem)`). */
export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

// --- Types -----------------------------------------------------------------

type Identity = Pick<
  DeviceIdentityClient,
  "signWithDeviceKey" | "getDeviceIdentityStatus"
>;

export interface OverlayLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}

const noopLogger: OverlayLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/** The PoP fields the box attaches to every overlay message. `sig` is the
 *  base64 device-key signature; `sig_alg` is HQ's wire enum ("ecdsa-sha256" /
 *  "rsa-pss"). `key_fingerprint` is the BOX device key fingerprint. */
interface OverlayPoP {
  key_fingerprint: string;
  sig: string;
  sig_alg: string;
}

/** A session offer from HQ.
 *
 *  WARP-1384 pins the poll response to `{session_id, client_endpoint,
 *  expires_at}`. A WireGuard peer, however, is keyed by the peer's PUBLIC KEY,
 *  so the box cannot install/refresh the phone peer without it —
 *  `clientPublicKey` (and the optional label) are the minimum the box needs and
 *  are sourced from the box-vouched device grant HQ already holds. Kept in this
 *  one isolated type so aligning the field name with WARP-1384's final shape is
 *  a one-line change. */
export interface OverlayOffer {
  sessionId: string;
  clientEndpoint: string;
  clientPublicKey: string;
  clientLabel?: string;
  expiresAt?: string;
}

/** Outcome of an overlay peer removal at this seam (WARP-2060). Production
 *  derives it from routing's DeleteVpnPeerResult via `isRevokeApplied`. */
export interface OverlayRemoveResult {
  /** `false` ⇒ the router staged the removal but never applied it — the peer
   *  is still live on the interface and the row must NOT be marked revoked. */
  applied: boolean;
}

/** The wg-peer collaborator (openwrt.client in production). */
export interface OverlayPeerOps {
  install(p: {
    interface: string;
    publicKey: string;
    allowedIps: string[];
    endpoint: string;
    persistentKeepalive: number;
    description: string;
  }): Promise<void>;
  /** Remove a peer from the interface. May return an outcome: `applied: false`
   *  means the router STAGED the removal (peer out of config, STILL LIVE on
   *  wg0 — the busy-router uci.apply timeout case). A void return is treated
   *  as applied, mirroring `isRevokeApplied`'s absent-means-applied rule, so
   *  seams that cannot report the distinction keep working (WARP-2060). */
  remove(p: {
    interface: string;
    publicKey: string;
  }): Promise<OverlayRemoveResult | void>;
  /** WARP-1389 — per-peer runtime `latest handshake` epoch (seconds), keyed by
   *  public_key, for peers whose handshake state was actually OBSERVED: value 0
   *  = observed never-handshook, > 0 = handshook. A peer whose handshake is
   *  UNKNOWN (routing had no runtime data) is OMITTED from the map entirely —
   *  the sweep must skip it, never score a guessed 0 as a failure. Production
   *  reads it from the routing peer list (openwrt.listVpnPeers). */
  listHandshakes?(iface: string): Promise<Record<string, number>>;
}

/**
 * WARP-1389 — the box-side metric surface. Shaped as the orchestrator's existing
 * `Analytics.metric` (services/analytics) so production passes the real
 * `analytics` proxy verbatim; the sink is fail-open + currently buffered (inert
 * until WARP-617), exactly like `recordService`'s `metric()` calls. Opt-in
 * observability only — the labels below carry NO packet contents and NO client
 * IPs, only coarse outcome + NAT class.
 */
export interface OverlayMetricSink {
  metric(name: string, value: number, labels?: Record<string, string>): void;
}

const noopMetrics: OverlayMetricSink = { metric() {} };

/** Coarse NAT class derivable from the box's OWN observed mapping: if the STUN
 *  reflexive port equals the WireGuard listen port (51820) the upstream NAT is
 *  port-preserving (punch-friendly); otherwise it rewrote the port
 *  (symmetric-ish, punch-hostile). No client data — the box's own mapping only. */
export function natClassFromBoxEndpoint(boxEndpoint: string): string {
  const port = boxEndpoint.slice(boxEndpoint.lastIndexOf(":") + 1);
  return port === "51820" ? "port_preserving" : "symmetric";
}

export interface OverlayVpnPeerRow {
  id: string;
  publicKey: string;
  assignedIp: string;
  status: string;
  kind: string;
}

/** WARP-1474 — the approved dashboard-QR enrollment a newly-installed overlay
 *  peer inherits its provenance from (createdBy / linkTokenId / label /
 *  enrolledAt). Optional on the structural surface so overlay-connect tests that
 *  predate the QR flow keep passing without providing it. */
export interface OverlayPendingEnrollmentRow {
  linkTokenId: string;
  label: string;
  approvedBy: string | null;
  enrolledAt: Date | null;
}

/** Structural Prisma surface — tests pass a minimal in-memory stub. */
export interface OverlayConnectPrisma {
  vpnPeer: {
    findUnique(args: {
      where: { publicKey: string };
    }): Promise<OverlayVpnPeerRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<OverlayVpnPeerRow>;
    update(args: {
      where: { publicKey: string };
      data: Record<string, unknown>;
    }): Promise<OverlayVpnPeerRow>;
    findMany(args: {
      where: Record<string, unknown>;
    }): Promise<OverlayVpnPeerRow[]>;
  };
  // WARP-1474: present in production; used to stamp QR-enroll provenance onto the
  // overlay peer the FIRST time it's installed after an owner approval.
  pendingOverlayEnrollment?: {
    findFirst(args: {
      where: Record<string, unknown>;
    }): Promise<OverlayPendingEnrollmentRow | null>;
  };
}

export interface OverlayConnectConfig {
  /** HQ fleet-server base URL — the SAME base the TLS issuance client uses
   *  (config.HQ_ISSUANCE_URL). Empty string ⇒ overlay is not configured. */
  hqBaseUrl: string;
  /** config.DROPLET_DEVICE_ID — the box's HQ registry id. */
  deviceId: string;
  /** config.DEVICE_BRIDGE_URL — the host device-bridge base. */
  bridgeUrl: string;
  /** bridgeAuthToken() — the shared device-bridge secret. */
  bridgeToken: string;
  /** wg interface the overlay peers live on (default "wg0"). */
  vpnInterface: string;
  /** persistent-keepalive seconds for the punch (default 25). */
  keepaliveSeconds: number;
  /** how long an overlay peer may sit without a session before expiry. */
  idleExpiryHours: number;
  /** per-request HTTP timeout. */
  httpTimeoutMs?: number;
}

export interface OverlayConnectDeps {
  config: OverlayConnectConfig;
  identity: Identity;
  prisma: OverlayConnectPrisma;
  peers: OverlayPeerOps;
  /** Allocate the next free tunnel IP for a NEW overlay peer (production wires
   *  this to vpn.service.allocatePeerIp). Only called on first sight of a key. */
  allocateIp: () => Promise<string>;
  /** WARP-1389 — box-side punch telemetry. Defaults to a no-op sink; production
   *  passes the real `analytics` proxy. */
  metrics?: OverlayMetricSink;
  now?: () => Date;
  logger?: OverlayLogger;
  fetchImpl?: typeof fetch;
}

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

// --- HTTP helpers ----------------------------------------------------------

async function overlayFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Map the identity daemon's reported algorithm (e.g. "ECDSA-P256-SHA256") to
 *  HQ's wire enum. HQ's `verifySignatureOverMessage` accepts ONLY
 *  "ecdsa-sha256" / "rsa-pss" and fails CLOSED on anything else, so passing the
 *  daemon string through verbatim 401s every overlay call. The tls-issuance
 *  paths pin the literal for the same reason (see `signChallenge`). */
function toWireSigAlg(algorithm: string): string {
  const a = algorithm.trim().toLowerCase();
  if (a.includes("ecdsa")) return "ecdsa-sha256";
  if (a.includes("rsa")) return "rsa-pss";
  return a;
}

async function signOverlayMessage(
  identity: Identity,
  message: string,
): Promise<OverlayPoP> {
  const keyFingerprint = (await identity.getDeviceIdentityStatus())
    .certFingerprint;
  const signed = await identity.signWithDeviceKey(
    new TextEncoder().encode(message),
  );
  return {
    key_fingerprint: keyFingerprint,
    sig: Buffer.from(signed.signature).toString("base64"),
    sig_alg: toWireSigAlg(signed.algorithm),
  };
}

// --- Poll ------------------------------------------------------------------

/**
 * One outbound long-poll to HQ. Signs `droplet-overlay-poll:v1:<device_id>:<ts>`
 * and POSTs the PoP. Returns the session offer on 200, or `null` on 204 (idle).
 * Throws on any non-2xx (the caller backs off).
 */
export async function pollOverlaySession(
  deps: OverlayConnectDeps,
): Promise<OverlayOffer | null> {
  const { config, identity } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const ts = (deps.now?.() ?? new Date()).toISOString();
  const pop = await signOverlayMessage(
    identity,
    buildOverlayPollMessage(config.deviceId, ts),
  );
  const base = config.hqBaseUrl.replace(/\/+$/, "");
  const r = await overlayFetch(
    fetchImpl,
    `${base}/api/overlay/poll`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: config.deviceId,
        key_fingerprint: pop.key_fingerprint,
        sig: pop.sig,
        sig_alg: pop.sig_alg,
        ts,
      }),
    },
    timeoutMs,
  );
  if (r.status === 204) return null; // idle — no session pending
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`HQ overlay poll returned ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = (await r.json()) as Record<string, unknown>;
  const sessionId = String(data.session_id ?? "");
  const clientEndpoint = String(data.client_endpoint ?? "");
  const clientPublicKey = String(data.client_public_key ?? "");
  if (!sessionId || !clientEndpoint || !clientPublicKey) {
    throw new Error(
      "HQ overlay poll returned a session missing session_id / client_endpoint / client_public_key",
    );
  }
  return {
    sessionId,
    clientEndpoint,
    clientPublicKey,
    clientLabel:
      typeof data.client_label === "string" ? data.client_label : undefined,
    expiresAt: typeof data.expires_at === "string" ? data.expires_at : undefined,
  };
}

// --- STUN probe via the device-bridge --------------------------------------

/** Ask the host device-bridge for the box's own public UDP mapping (observed
 *  from host udp/51820). Returns `<ip>:<port>`; throws (fail-closed) otherwise. */
export async function probeBoxEndpoint(
  deps: OverlayConnectDeps,
): Promise<string> {
  const { config } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  if (!config.bridgeToken) {
    throw new Error(
      "device-bridge auth token not configured — cannot STUN-probe the box endpoint",
    );
  }
  const r = await overlayFetch(
    fetchImpl,
    `${config.bridgeUrl}/host/stun-probe`,
    { method: "GET", headers: { "X-Droplet-Auth": config.bridgeToken } },
    timeoutMs,
  );
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(
      `device-bridge STUN probe returned ${r.status}: ${body.slice(0, 200)}`,
    );
  }
  const data = (await r.json()) as { ip?: unknown; port?: unknown };
  const ip = typeof data.ip === "string" ? data.ip : "";
  const port = typeof data.port === "number" ? data.port : Number(data.port);
  if (!ip || !Number.isInteger(port) || port <= 0) {
    throw new Error("device-bridge STUN probe returned no usable {ip, port}");
  }
  return `${ip}:${port}`;
}

// --- Answer ----------------------------------------------------------------

/** Sign `droplet-overlay-answer:v1:<session_id>:<box_endpoint>:<ts>` and POST it
 *  so HQ can relay the box's endpoint to the phone. Throws on non-2xx. */
export async function answerOverlaySession(
  deps: OverlayConnectDeps,
  sessionId: string,
  boxEndpoint: string,
): Promise<void> {
  const { config, identity } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const ts = (deps.now?.() ?? new Date()).toISOString();
  const pop = await signOverlayMessage(
    identity,
    buildOverlayAnswerMessage(sessionId, boxEndpoint, ts),
  );
  const base = config.hqBaseUrl.replace(/\/+$/, "");
  const r = await overlayFetch(
    fetchImpl,
    `${base}/api/overlay/answer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: config.deviceId,
        key_fingerprint: pop.key_fingerprint,
        sig: pop.sig,
        sig_alg: pop.sig_alg,
        ts,
        session_id: sessionId,
        box_endpoint: boxEndpoint,
      }),
    },
    timeoutMs,
  );
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(
      `HQ overlay answer returned ${r.status}: ${body.slice(0, 200)}`,
    );
  }
}

// --- Peer install/refresh --------------------------------------------------

/** Ensure a wg0 overlay peer exists for `offer.clientPublicKey`, install/refresh
 *  its endpoint to the phone's observed mapping, and record the session on the
 *  explicit-state VpnPeer row (kind='overlay', lastSessionAt=now). First sight
 *  allocates a tunnel IP; later sights reuse it. */
export async function installOrRefreshOverlayPeer(
  deps: OverlayConnectDeps,
  offer: OverlayOffer,
): Promise<OverlayVpnPeerRow> {
  const { config, prisma } = deps;
  const now = deps.now?.() ?? new Date();
  const existing = await prisma.vpnPeer.findUnique({
    where: { publicKey: offer.clientPublicKey },
  });

  // WARP-1474: if this key was linked via the dashboard-QR flow, stamp the
  // approved enrollment's provenance onto the peer row so the audit trail shows
  // who linked which QR. Best-effort + guarded — a peer from the owner-JWT
  // /devices path (no pending row) or a runtime without the model just gets no
  // provenance, never an error.
  const provenance = await resolveOverlayProvenance(
    prisma,
    offer.clientPublicKey,
    now,
  );

  let row: OverlayVpnPeerRow;
  let assignedIp: string;
  if (existing) {
    // Reconnect-reliability guard (QA): reactivating a previously-REVOKED row
    // reuses its old assignedIp. If that IP was handed to another ACTIVE peer
    // during the idle window, flipping this row back to 'active' with the same
    // IP violates the partial-unique-active-IP index (P2002) and the tick
    // throws — the phone can't reconnect until manual cleanup. So: if the stored
    // IP is no longer free among active peers, re-allocate a fresh one via the
    // same allocation path the normal mint uses. (A same-key active refresh is
    // NOT a clash — the holder is this very row, excluded below.)
    const activeOnIp = await prisma.vpnPeer.findMany({
      where: { status: "active", assignedIp: existing.assignedIp },
    });
    const ipTaken = activeOnIp.some(
      (r) => r.publicKey !== offer.clientPublicKey,
    );
    assignedIp = ipTaken ? await deps.allocateIp() : existing.assignedIp;
    row = await prisma.vpnPeer.update({
      where: { publicKey: offer.clientPublicKey },
      data: {
        assignedIp,
        kind: "overlay",
        status: "active",
        mode: "away",
        lastSessionAt: now,
        revokedAt: null,
        deviceLabel: offer.clientLabel ?? existing_label_fallback(existing),
        ...provenance,
      },
    });
  } else {
    assignedIp = await deps.allocateIp();
    row = await prisma.vpnPeer.create({
      data: {
        userId: OVERLAY_PEER_USER,
        deviceLabel: offer.clientLabel ?? "Remote device",
        publicKey: offer.clientPublicKey,
        assignedIp,
        status: "active",
        mode: "away",
        kind: "overlay",
        lastSessionAt: now,
        ...provenance,
      },
    });
  }

  // Install/refresh the router-side peer LAST — WireGuard's initiations +
  // keepalives from this endpoint are the box side of the punch.
  await deps.peers.install({
    interface: config.vpnInterface,
    publicKey: offer.clientPublicKey,
    allowedIps: [`${assignedIp}/32`],
    endpoint: offer.clientEndpoint,
    persistentKeepalive: config.keepaliveSeconds,
    description: offer.clientLabel ?? `overlay ${offer.sessionId}`,
  });

  return row;
}

/** overlay peers are the owner's remote devices; they share a synthetic userId
 *  namespace (they carry no per-user Nextcloud identity in Stage 1b — Stage 2 /
 *  WARP-1386 wires real owner identity through enrollment). The idle-expiry
 *  sweep filters on `kind`, independent of this value. */
const OVERLAY_PEER_USER = "overlay";

function existing_label_fallback(row: OverlayVpnPeerRow): string {
  return (row as { deviceLabel?: string }).deviceLabel ?? "Remote device";
}

/** WARP-1474 — look up the approved dashboard-QR enrollment for this key and
 *  return the VpnPeer provenance columns to stamp. Returns {} (no provenance)
 *  when the model isn't present, no approved row matches, or the lookup faults —
 *  provenance is metadata, never a reason to fail a reconnect. */
async function resolveOverlayProvenance(
  prisma: OverlayConnectPrisma,
  publicKey: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const model = prisma.pendingOverlayEnrollment;
  if (!model?.findFirst) return {};
  try {
    const approved = await model.findFirst({
      where: { wgPublicKey: publicKey, state: "approved" },
    });
    if (!approved) return {};
    return {
      linkTokenEnrolledBy: approved.approvedBy ?? null,
      linkTokenId: approved.linkTokenId,
      linkTokenLabel: approved.label,
      enrolledAt: approved.enrolledAt ?? now,
    };
  } catch {
    return {};
  }
}

// --- One connect tick (poll → probe → answer → install) --------------------

/**
 * One bounded connect iteration. Polls HQ; if a session is offered, probes the
 * box endpoint, answers, and installs/refreshes the phone peer. Idle (204) is a
 * clean no-op. Any error propagates so the cron-runtime records the failure and
 * backs off (NO in-service retry loop).
 */
export async function runOverlayConnectTick(
  deps: OverlayConnectDeps,
): Promise<"idle" | "connected"> {
  const logger = deps.logger ?? noopLogger;
  if (!deps.config.hqBaseUrl) {
    logger.debug?.({}, "overlay-connect: HQ not configured — skipping tick");
    return "idle";
  }
  const offer = await pollOverlaySession(deps);
  if (!offer) return "idle";

  logger.info(
    { sessionId: offer.sessionId },
    "overlay-connect: HQ session offer received",
  );
  const boxEndpoint = await probeBoxEndpoint(deps);
  await answerOverlaySession(deps, offer.sessionId, boxEndpoint);
  await installOrRefreshOverlayPeer(deps, offer);
  // WARP-1389 — one punch ATTEMPT recorded, tagged with the coarse NAT class the
  // box's own observed mapping implies (port-preserving vs symmetric). The
  // succeeded/failed split is settled later by the idle-expiry sweep from the
  // peer's real wg handshake.
  (deps.metrics ?? noopMetrics).metric("overlay.punch.attempted", 1, {
    nat_class: natClassFromBoxEndpoint(boxEndpoint),
  });
  logger.info(
    { sessionId: offer.sessionId, boxEndpoint },
    "overlay-connect: overlay peer installed/refreshed",
  );
  return "connected";
}

// --- Idle-expiry sweep -----------------------------------------------------

/**
 * Revoke overlay peers that have not carried a session in `idleExpiryHours`.
 * EXPLICIT state only: `kind = 'overlay' AND status = 'active' AND
 * lastSessionAt < cutoff` — never derived from a NULL. Removes the router peer,
 * then marks the row revoked. Returns the count expired.
 *
 * WARP-2060 — the handshake read below is load-bearing for CORRECTNESS, not
 * just telemetry. `lastSessionAt` is only ever stamped at approve-time and at
 * HQ punch-session start; the lan/direct/mapped candidates deliberately use no
 * rendezvous at all, so a client connected through them NEVER refreshes the DB
 * clock. Before this fix the sweep revoked such peers mid-connection — the
 * tunnel died under active traffic. Now:
 *   - an OBSERVED handshake inside the idle window is proof of life: the row's
 *     `lastSessionAt` is refreshed to the handshake time and the peer is
 *     spared (it ages out naturally from its last real handshake);
 *   - when the handshake read is WIRED but FAILS (routing down), teardown is
 *     skipped for the whole sweep — revoking blind is how live tunnels die;
 *     the next sweep retries. A consumer that never wired `listHandshakes`
 *     proceeds on the DB clock alone, as before;
 *   - a peer ABSENT from the map (routing had no runtime data — the realistic
 *     case is a row whose wg peer is already gone) proceeds to teardown on the
 *     DB clock, which is what keeps orphaned rows from holding slots forever.
 *
 * WARP-1389 — this is also where the punch outcome is settled: reading each
 * torn-down peer's real wg `latest handshake` (the SAME peer status this sweep
 * reads to decide teardown), a peer that ever handshook is a punch SUCCESS; one
 * that expired without a handshake is a FAILURE. Counters go on the box metric
 * surface (no client data, coarse outcome only).
 */
export async function expireIdleOverlayPeers(
  deps: OverlayConnectDeps,
): Promise<number> {
  const { config, prisma } = deps;
  const logger = deps.logger ?? noopLogger;
  const metrics = deps.metrics ?? noopMetrics;
  const now = deps.now?.() ?? new Date();
  const idleWindowMs = config.idleExpiryHours * 3_600_000;
  const cutoff = new Date(now.getTime() - idleWindowMs);
  const stale = await prisma.vpnPeer.findMany({
    where: {
      kind: "overlay",
      status: "active",
      lastSessionAt: { lt: cutoff },
    },
  });
  if (stale.length === 0) return 0;
  // One read of the live per-peer handshake state (0/absent = never handshook).
  let handshakes: Record<string, number> | null = null;
  if (deps.peers.listHandshakes) {
    try {
      handshakes = await deps.peers.listHandshakes(config.vpnInterface);
    } catch (err) {
      // WARP-2060: without handshake data we cannot tell an idle peer from a
      // live one whose clock simply never refreshes (lan/direct/mapped). Do
      // NOT revoke blind — skip teardown entirely and retry next sweep.
      logger.warn(
        { err },
        "overlay-connect: could not read peer handshakes — teardown skipped this sweep (revoking blind would kill live tunnels)",
      );
      return 0;
    }
  }
  let expired = 0;
  let spared = 0;
  for (const row of stale) {
    // WARP-2060: an observed handshake inside the idle window is activity.
    // Refresh the DB clock to the handshake time and spare the peer. The
    // refresh failing must never fall through to removal — sparing is the
    // safe direction.
    if (handshakes) {
      const observed = handshakes[row.publicKey];
      if (
        observed !== undefined &&
        observed > 0 &&
        now.getTime() - observed * 1000 < idleWindowMs
      ) {
        try {
          await prisma.vpnPeer.update({
            where: { publicKey: row.publicKey },
            data: { lastSessionAt: new Date(observed * 1000) },
          });
        } catch (err) {
          logger.warn(
            { err, publicKey: row.publicKey },
            "overlay-connect: failed to refresh lastSessionAt from a live handshake — peer spared anyway",
          );
        }
        spared += 1;
        continue;
      }
    }
    try {
      const removal = await deps.peers.remove({
        interface: config.vpnInterface,
        publicKey: row.publicKey,
      });
      // WARP-2060: routing can answer "staged" — peer out of config, STILL
      // LIVE on wg0 (busy router, uci.apply timeout). Marking the row revoked
      // would free the device's slot and tell the owner it is cut off while it
      // keeps a working route into the LAN, and nothing would ever retry. Same
      // defect the manual revoke route already fixed (vpn.ts, REVOKE_STAGED).
      if (removal && removal.applied === false) {
        logger.warn(
          { publicKey: row.publicKey },
          "overlay-connect: router staged the peer removal but never applied it — peer still live on the interface; row left active for retry next sweep",
        );
        continue;
      }
      await prisma.vpnPeer.update({
        where: { publicKey: row.publicKey },
        data: { status: "revoked", revokedAt: now },
      });
      expired += 1;
      // Settle the punch outcome from the peer's real handshake. `handshakes`
      // carries ONLY peers whose handshake was actually OBSERVED: an epoch > 0
      // is a success, an observed 0 is a failure. A peer ABSENT from the map is
      // UNKNOWN (routing had no runtime data) — emit NOTHING, never a guessed 0.
      if (handshakes) {
        const observed = handshakes[row.publicKey];
        if (observed !== undefined) {
          metrics.metric(
            observed > 0 ? "overlay.punch.succeeded" : "overlay.punch.failed",
            1,
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err, publicKey: row.publicKey },
        "overlay-connect: failed to expire idle overlay peer — will retry next sweep",
      );
    }
  }
  if (expired > 0 || spared > 0) {
    logger.info(
      { expired, spared },
      "overlay-connect: idle sweep done (spared = actively-handshaking peers whose lastSessionAt was refreshed)",
    );
  }
  return expired;
}

// --- Device enroll (Part D — box→HQ vouching bridge) -----------------------

export interface OverlayEnrollInput {
  wgPublicKey: string;
  signPublicKeyPem: string;
  label: string;
}

export interface OverlayEnrollDeps {
  config: Pick<OverlayConnectConfig, "hqBaseUrl" | "deviceId" | "httpTimeoutMs">;
  identity: Identity;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

/**
 * Vouch for an owner device to HQ. The box signs the grant
 * `droplet-overlay-enroll:v1:<device_id>:<sha256(sign_public_key_pem)>:<wg_public_key>`
 * with its device key and forwards the client material to HQ's device registry.
 * HQ never owns user accounts — the box's signature IS the vouch. Returns HQ's
 * enroll result verbatim. This is the bridge the Android client (WARP-1386)
 * calls via POST /api/vpn/overlay/devices.
 */
export async function enrollOverlayDevice(
  deps: OverlayEnrollDeps,
  input: OverlayEnrollInput,
): Promise<unknown> {
  const { config, identity } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  if (!config.hqBaseUrl) {
    throw new Error("HQ_ISSUANCE_URL not configured — cannot enroll overlay device");
  }
  const signKeyFingerprint = sha256Hex(input.signPublicKeyPem);
  const pop = await signOverlayMessage(
    identity,
    buildOverlayEnrollMessage(
      config.deviceId,
      signKeyFingerprint,
      input.wgPublicKey,
    ),
  );
  const base = config.hqBaseUrl.replace(/\/+$/, "");
  const r = await overlayFetch(
    fetchImpl,
    `${base}/api/overlay/devices/enroll`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: config.deviceId,
        key_fingerprint: pop.key_fingerprint,
        sig: pop.sig,
        sig_alg: pop.sig_alg,
        client: {
          wg_public_key: input.wgPublicKey,
          sign_public_key_pem: input.signPublicKeyPem,
          label: input.label,
        },
      }),
    },
    timeoutMs,
  );
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(
      `HQ overlay enroll returned ${r.status}: ${body.slice(0, 200)}`,
    );
  }
  const result = (await r.json()) as { state?: unknown } & Record<
    string,
    unknown
  >;
  // WARP-2061: HQ's enroll is idempotent on wg_public_key and deliberately
  // never un-revokes — a replayed enroll for a revoked client answers HTTP 200
  // with state:'revoked'. Treating that 200 as success is how a factory-reset
  // (whose release path revokes every client at HQ) permanently bricked
  // re-enrollment: the box showed the device linked while HQ 403'd its every
  // connect, forever, with no error anywhere. A non-active state is a FAILED
  // vouch and must fail loudly. `state` absent (older HQ builds) is treated as
  // active — absent-means-ok, consistent with isRevokeApplied's rule.
  if (result.state !== undefined && result.state !== "active") {
    throw new OverlayEnrollRejectedError(String(result.state));
  }
  return result;
}

/** WARP-2061 — HQ answered the enroll but the device's registry state is not
 *  'active' (typically 'revoked' after a factory-reset release or an owner
 *  revoke). The vouch did NOT take; connects from this client will be refused
 *  by HQ. The device must re-enroll with a FRESH WireGuard keypair — HQ's
 *  idempotency keys on wg_public_key and never un-revokes. */
export class OverlayEnrollRejectedError extends Error {
  readonly hqState: string;
  constructor(hqState: string) {
    super(
      `HQ enrollment state is '${hqState}', not 'active' — the vouch did not take; the device must enroll with a fresh WireGuard key`,
    );
    this.name = "OverlayEnrollRejectedError";
    this.hqState = hqState;
  }
}

/**
 * WARP-2061 — tell HQ an owner revoked a client device, so the revocation
 * STICKS. Without this call the device stays 'active' in HQ's registry: its
 * next connect request passes HQ's client-PoP gate, the box's connect tick
 * receives the offer, and installOrRefreshOverlayPeer resurrects the revoked
 * row — the owner's revoke silently un-revokes itself within one poll tick.
 * HQ's revoke also expires the client's in-flight sessions, so a session
 * already brokered cannot land after the local peer is gone.
 *
 * 404 ("client not found for this device") is success: the device was never
 * enrolled at HQ — nothing to revoke is the state the caller wants.
 */
export async function revokeOverlayDeviceAtHq(
  deps: OverlayEnrollDeps,
  wgPublicKey: string,
): Promise<void> {
  const { config, identity } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = config.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  if (!config.hqBaseUrl) {
    throw new Error(
      "HQ_ISSUANCE_URL not configured — cannot revoke overlay device at HQ",
    );
  }
  const pop = await signOverlayMessage(
    identity,
    buildOverlayRevokeMessage(config.deviceId, wgPublicKey),
  );
  const base = config.hqBaseUrl.replace(/\/+$/, "");
  const r = await overlayFetch(
    fetchImpl,
    `${base}/api/overlay/devices/revoke`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: config.deviceId,
        key_fingerprint: pop.key_fingerprint,
        sig: pop.sig,
        sig_alg: pop.sig_alg,
        wg_public_key: wgPublicKey,
      }),
    },
    timeoutMs,
  );
  if (r.status === 404) return;
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(
      `HQ overlay revoke returned ${r.status}: ${body.slice(0, 200)}`,
    );
  }
}
