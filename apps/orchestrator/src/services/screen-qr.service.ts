/**
 * Screen-QR state machine + poller.
 *
 * Owns "what QR should currently be on the status display screen". Three
 * states, in priority order:
 *
 *   1. setup-URL  — when no admin user exists yet (first boot).
 *                   QR points at https://<lan-ip>/setup so the
 *                   customer scans → phone opens wizard directly.
 *   2. peer       — when a WireGuard peer was generated in the
 *                   last PEER_DISPLAY_WINDOW_MS. Shows the peer's
 *                   wg-config QR so the phone next to the box can
 *                   scan + import without dashboard browsing.
 *   3. wifi       — the steady state. Pulls the WiFi SSID/key QR
 *                   from device-bridge's /openwrt/qr (already
 *                   provided by services/oled-display/device-bridge.py)
 *                   and shows that.
 *
 * The poller re-evaluates every POLL_INTERVAL_MS and only pushes when
 * the desired QR changed (avoids slamming the display with the same
 * image every 30 s). Peer events are surfaced via `notePeerCreated()`,
 * which other routes (vpn.ts) call to bump the window.
 *
 * Design notes:
 *   - State machine lives in orchestrator (Node) — same process that
 *     already owns display.client.ts and the VPN peer route. No new
 *     service.
 *   - In-memory state. A restart resets the window (intentional —
 *     after a restart any peer QR is stale anyway).
 *   - Poller stop()s cleanly on app shutdown so test suites can run
 *     the whole orchestrator without leaking timers.
 */
import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import pino from "pino";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { pushClaimCode, pushCustomImage } from "./display.client.js";
import { ensureClaimCode, isClaimed } from "./claim-code.service.js";
import { renderQRToScreenPng } from "./qr-render.js";

const logger = pino({ name: "screen-qr" });

/** How often the poller re-evaluates which QR should be on screen. */
const POLL_INTERVAL_MS = 30_000;

/** How long after a peer is created we keep the peer QR on screen. */
const PEER_DISPLAY_WINDOW_MS = 60_000;

/**
 * Trust-mode flag for the peer-QR-on-screen feature.
 *
 * Off by default. When a WireGuard peer is created, this service can
 * render the peer's full WireGuard `.conf` (which includes the client
 * `PrivateKey`) as a QR on the status display for 60 s so the operator's
 * phone can scan + import directly via the WireGuard mobile app's
 * built-in QR scanner. That's slick UX in a trusted physical space
 * (private home, locked office) — but in a shared-space deployment
 * (photo studio, dealership showroom, kiosk) the same QR is a valid
 * VPN credential that anyone in line-of-sight can photograph in the
 * 60 s window.
 *
 * Default is `false` (off): the dashboard's authenticated /remote-access
 * QR remains the canonical peer-import path; the screen falls through
 * to the wifi/setup QR. Operators in trusted spaces flip
 * `SCREEN_PEER_QR_ENABLED=true` in .env and accept the exposure
 * trade-off in exchange for the WireGuard auto-import UX.
 *
 * The URL-redirect alternative (one-time token in QR → browser fetch)
 * was rejected because it breaks the WireGuard mobile app's QR-scan
 * auto-import, forcing customers into a "scan → browser → download →
 * manual import" flow that loses the UX value of the screen QR in
 * the first place.
 */
const PEER_QR_ENABLED =
  (process.env.SCREEN_PEER_QR_ENABLED ?? "false").toLowerCase() === "true";

/** device-bridge runs on the host with network_mode: host (port 9090). */
const DEVICE_BRIDGE_URL =
  process.env.DEVICE_BRIDGE_URL || "http://host.docker.internal:9090";

export type ScreenQRMode = "setup" | "peer" | "wifi" | "none";

export interface ScreenQRDecision {
  mode: ScreenQRMode;
  payload: string;
  caption: string;
  /** Stable cache-key. Used to skip re-pushes when nothing changed. */
  signature: string;
}

interface PeerEvent {
  /** Full WireGuard .conf string the peer would scan to import. */
  config: string;
  /** When the peer was generated. Used for the display window. */
  createdAt: number;
  /** Short peer name for the on-screen caption. */
  name?: string;
}

/** In-memory peer-event state. Cleared on restart. */
let lastPeerEvent: PeerEvent | null = null;

/**
 * Prisma handle for the claim-screen branch. Set by `startScreenQRPoller`
 * (which receives it from app.ts, same as the reminders poller). Null until
 * the poller starts; the claim branch is skipped while null so unit tests of
 * the QR logic don't need a DB.
 */
let prismaRef: PrismaClient | null = null;

/** Production collaborators for `decideClaimScreen`. Real DB + display client. */
const claimScreenDeps: ClaimScreenDeps = {
  isClaimed,
  ensureClaimCode,
  pushClaimCode,
  setupUrl,
};

/** The signature of whatever's currently on screen (avoids re-pushes). */
let activeSignature = "";

/** Poller handle so app.ts can call stop() on shutdown. */
let pollerInterval: NodeJS.Timeout | null = null;

/**
 * In-flight guard for `refreshNow()`. The poller interval keeps firing
 * even if a previous tick is still in `pushCustomImage` (multipart
 * upload over the host bridge). Without this guard, a slow display
 * push can stack concurrent ticks that all race on `activeSignature`,
 * double-push the same image to the status display, and burn the display
 * service's small worker pool. Single-flight is the right shape: if
 * a refresh is already running, skip this tick.
 */
let refreshInFlight = false;

/**
 * Note that a WireGuard peer was just generated. When
 * `SCREEN_PEER_QR_ENABLED=true` the poller's next tick will push the
 * peer's QR to the screen and hold it for PEER_DISPLAY_WINDOW_MS.
 *
 * When the flag is off (the default for shared-space deployments)
 * this is a no-op: we don't record the event so the screen's wifi/setup
 * fall-through isn't perturbed and we don't briefly hold credential
 * material in memory for nothing.
 *
 * Called from `apps/orchestrator/src/routes/vpn.ts` on successful
 * peer creation.
 */
export function notePeerCreated(config: string, name?: string): void {
  if (!PEER_QR_ENABLED) {
    logger.debug(
      { name },
      "screen-qr: peer created but SCREEN_PEER_QR_ENABLED=false; not surfacing on screen",
    );
    return;
  }
  lastPeerEvent = { config, createdAt: Date.now(), name };
  // Kick the poller ASAP so the user doesn't wait up to 30 s for the
  // QR to appear after generating a peer. Catches errors so a display
  // outage doesn't ripple into the request response.
  refreshNow().catch((err) =>
    logger.warn({ err }, "screen-qr: refreshNow after peer-create failed"),
  );
}

/**
 * Decide what QR should be on screen right now. Pure function over
 * the inputs (real-user count, peer event freshness, WiFi info).
 * Tested in isolation in screen-qr.service.test.ts.
 *
 * `realUserCount` is the count of Nextcloud users with the system
 * admin filtered out — the system admin is created by the Nextcloud
 * container and isn't a "real" customer account.
 */
export async function decideScreenQR(
  realUserCount: number,
  peer: PeerEvent | null,
  now: number,
  fetchWifiQR: () => Promise<{ payload: string; ssid: string } | null>,
): Promise<ScreenQRDecision> {
  // Priority 1: no real user yet → show setup URL.
  if (realUserCount === 0) {
    const url = setupUrl();
    return {
      mode: "setup",
      payload: url,
      caption: "Scan to set up your Droplet",
      signature: `setup:${url}`,
    };
  }

  // Priority 2: recent peer-creation event.
  if (peer && now - peer.createdAt < PEER_DISPLAY_WINDOW_MS) {
    return {
      mode: "peer",
      payload: peer.config,
      caption: peer.name
        ? `Scan to add VPN peer ${peer.name}`
        : "Scan to add VPN peer",
      signature: `peer:${peer.createdAt}:${peer.name || ""}`,
    };
  }

  // Priority 3: WiFi SSID QR. Returns null if device-bridge is down —
  // we treat that as "show nothing" rather than throwing so the display
  // keeps whatever was on it.
  const wifi = await fetchWifiQR();
  if (wifi) {
    return {
      mode: "wifi",
      payload: wifi.payload,
      caption: `WiFi: ${wifi.ssid}`,
      signature: `wifi:${wifi.payload}`,
    };
  }

  return { mode: "none", payload: "", caption: "", signature: "none" };
}

/**
 * Collaborators `decideClaimScreen` needs, injected so the decision is
 * unit-testable with no DB and no network (AC6). Production wiring passes the
 * real claim-code service + display client + setupUrl.
 */
export interface ClaimScreenDeps {
  isClaimed: (prisma: PrismaClient) => Promise<boolean>;
  ensureClaimCode: (prisma: PrismaClient) => Promise<string | null>;
  pushClaimCode: (code: string, setupUrl: string) => Promise<boolean>;
  setupUrl: () => string;
}

export interface ClaimScreenResult {
  /** True if the claim screen owns this tick — the caller MUST skip the QR
   *  image push. False means "fall through to the QR/peer/wifi logic". */
  handled: boolean;
  /** Set only when handled: the push outcome (false = display outage). */
  pushed?: boolean;
  /** Set only when handled: claim-scoped, changes only when the code rotates,
   *  so the poller can skip re-pushing the same code every tick. */
  signature?: string;
}

/** Short, stable signature fragment for a claim code (8 hex chars of its
 *  hash). We never put the plaintext code in the signature/log. */
function claimSignature(code: string): string {
  const h = createHash("sha256").update(code).digest("hex").slice(0, 8);
  return `claim:${h}`;
}

/**
 * HIGHEST-priority branch of the refresh path (WARP-632 / ADR-017): while the
 * box is NOT claimed, render the minted claim code on the lid and SKIP the QR
 * image push for this tick. Once claimed, hand back to the QR/peer/wifi logic.
 *
 * Single owner: the orchestrator already owns the first-boot PyPortal screen
 * via this service, so the claim screen lives here too (no second pusher racing
 * the display). The mint + seed is a write to the orchestrator's own Prisma DB
 * (`ensureClaimCode`), so this is the natural home.
 *
 * Returns `{ handled: false }` when claimed, or when a race means the code was
 * just consumed (ensureClaimCode → null) — both fall through to the QR logic.
 * When a code is minted we push it and return `{ handled: true, pushed, signature }`.
 * We report `handled: true` even on a failed push so we don't briefly show the
 * WiFi QR on a display blip while the box is still unclaimed; the caller only
 * records the signature on a successful push, so the next tick retries.
 */
export async function decideClaimScreen(
  prisma: PrismaClient,
  deps: ClaimScreenDeps,
): Promise<ClaimScreenResult> {
  if (await deps.isClaimed(prisma)) {
    return { handled: false };
  }
  const code = await deps.ensureClaimCode(prisma);
  if (!code) {
    // Race: isClaimed said false but the code was just consumed. Don't push a
    // stale claim screen — fall through.
    return { handled: false };
  }
  const pushed = await deps.pushClaimCode(code, deps.setupUrl());
  return { handled: true, pushed, signature: claimSignature(code) };
}

/**
 * Build the setup URL for a freshly-flashed box. Returns
 * `https://<lan-ip>/setup` using the first non-loopback IPv4 we find;
 * falls back to the box's hostname if no IP can be resolved.
 *
 * Self-signed-cert browser warning is unavoidable on first scan, but
 * the cert is already what the dashboard uses everywhere — the
 * customer's only going to see it once.
 */
export function setupUrl(): string {
  const host = lanHostname();
  return `https://${host}/setup`;
}

function lanHostname(): string {
  // Prefer an env override so deployments behind a DNS name can pin
  // the QR target (DUCKDNS_DOMAIN, custom domain, etc.). The wizard's
  // resolveEndpointHost() pattern already does this for the WG side.
  const override = (process.env.SCREEN_QR_HOST || "").trim();
  if (override) return override;

  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      // IPv4, non-loopback, non-docker-bridge.
      if (
        iface.family === "IPv4" &&
        !iface.internal &&
        !iface.address.startsWith("172.") &&
        !iface.address.startsWith("169.254.")
      ) {
        return iface.address;
      }
    }
  }
  // Last resort — better than nothing.
  return process.env.HOSTNAME || "droplet.local";
}

/**
 * Fetch the WiFi-hotspot QR payload from device-bridge.
 * Returns null on any error — the poller treats null as "skip this
 * tick, leave the screen alone".
 */
async function fetchWifiQRFromBridge(): Promise<
  { payload: string; ssid: string } | null
> {
  try {
    const res = await fetch(`${DEVICE_BRIDGE_URL}/openwrt/qr`, {
      // device-bridge is local-only; short timeout.
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { payload?: string; ssid?: string };
    if (!data.payload || !data.ssid) return null;
    return { payload: data.payload, ssid: data.ssid };
  } catch {
    return null;
  }
}

/**
 * Re-evaluate state + push if the desired QR has changed.
 * Returns the decision for callers that want to log/inspect.
 *
 * Single-flight: if a previous refresh is still running, returns null
 * immediately rather than queueing a second concurrent push. The
 * poller and `notePeerCreated`'s kick share this guard.
 */
async function refreshNow(): Promise<ScreenQRDecision | null> {
  if (!started) {
    // Not started yet — nothing to do.
    return null;
  }
  if (refreshInFlight) {
    logger.debug("screen-qr: refresh already in flight; skipping tick");
    return null;
  }
  refreshInFlight = true;

  try {
    // Priority 0 (WARP-632 / ADR-017): while the box is NOT claimed, the claim
    // code owns the lid. Mint + push it and skip the QR image push entirely.
    // Only when claimed do we fall through to the setup/peer/wifi QR logic.
    if (prismaRef) {
      try {
        const claim = await decideClaimScreen(prismaRef, claimScreenDeps);
        if (claim.handled) {
          // Record the signature only on a successful push so a display blip
          // is retried next tick rather than silently latched.
          if (claim.pushed && claim.signature) {
            if (claim.signature !== activeSignature) {
              activeSignature = claim.signature;
              logger.info("screen-qr: pushed claim screen");
            }
          }
          return null;
        }
      } catch (err) {
        // A claim-branch failure (DB down, etc.) must not blank the screen or
        // crash the poller — log and fall through to the QR logic.
        logger.warn({ err }, "screen-qr: claim branch failed; falling through to QR");
      }
    }

    const userCount = await countRealNextcloudUsers().catch((err) => {
      // Treat "Nextcloud unreachable" as "first boot, still" — better
      // to default to the setup-URL QR (which is the safe initial state)
      // than to fail open and show the wifi QR when no admin exists.
      logger.warn({ err }, "screen-qr: user-count failed; treating as 0 (first boot)");
      return 0;
    });

    const decision = await decideScreenQR(
      userCount,
      lastPeerEvent,
      Date.now(),
      fetchWifiQRFromBridge,
    );

    // Skip re-push if signature unchanged.
    if (decision.signature === activeSignature) {
      return decision;
    }
    if (decision.mode === "none") {
      // Nothing to push — but record the signature so we don't retry
      // every tick on a flapping device-bridge.
      activeSignature = decision.signature;
      return decision;
    }

    try {
      const { png } = await renderQRToScreenPng(decision.payload, {
        caption: decision.caption,
      });
      const ok = await pushCustomImage(png, `qr-${decision.mode}.png`);
      if (ok) {
        activeSignature = decision.signature;
        logger.info(
          { mode: decision.mode, caption: decision.caption },
          "screen-qr: pushed new QR",
        );
      } else {
        logger.warn(
          { mode: decision.mode },
          "screen-qr: display service rejected the image",
        );
      }
    } catch (err) {
      logger.warn({ err, mode: decision.mode }, "screen-qr: render or push failed");
    }
    return decision;
  } finally {
    refreshInFlight = false;
  }
}

/** Set by start(); skips ticks before the app is up. */
let started = false;

/**
 * Boot the poller. Idempotent — calling twice replaces the handle.
 * `app.ts` calls this once during boot. `prisma` is used by the claim-screen
 * branch (WARP-632); the user-count leg still goes through Nextcloud's OCS API.
 */
export function startScreenQRPoller(prisma: PrismaClient): void {
  prismaRef = prisma;
  started = true;
  if (pollerInterval) {
    clearInterval(pollerInterval);
  }
  // First refresh runs immediately so the screen catches up on boot
  // without waiting POLL_INTERVAL_MS.
  refreshNow().catch((err) =>
    logger.warn({ err }, "screen-qr: initial refresh failed"),
  );
  pollerInterval = setInterval(() => {
    refreshNow().catch((err) =>
      logger.warn({ err }, "screen-qr: scheduled refresh failed"),
    );
  }, POLL_INTERVAL_MS);
  // Don't block process exit on this timer (it's a daemon).
  pollerInterval.unref();
  logger.info("screen-qr: poller started");
}

export function stopScreenQRPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
  started = false;
  prismaRef = null;
}

/**
 * Test-only: reset the in-memory state between tests. Not exported
 * via index.ts; consumers shouldn't touch this in production code.
 */
export function _resetForTests(): void {
  lastPeerEvent = null;
  activeSignature = "";
  prismaRef = null;
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
  started = false;
}


/**
 * Count Nextcloud users with the system admin filtered out — same
 * filtering the dashboard's /auth/users endpoint applies. Used by
 * the poller to decide whether we're still on first boot.
 *
 * Uses NEXTCLOUD_ADMIN_USER / NEXTCLOUD_ADMIN_PASSWORD Basic auth
 * directly (same pattern as nextcloud.client.ts's ncInstallAndCreateAdmin).
 * The orchestrator already has those secrets in its env.
 */
export async function countRealNextcloudUsers(): Promise<number> {
  const adminUser = process.env.NEXTCLOUD_ADMIN_USER || "admin";
  const adminPassword = process.env.NEXTCLOUD_ADMIN_PASSWORD || "";
  if (!adminPassword) {
    // No admin password — orchestrator's env is misconfigured. Treat
    // as "no users known", which routes to the setup-URL QR. Honest
    // failure mode.
    return 0;
  }
  const basic = Buffer.from(`${adminUser}:${adminPassword}`).toString("base64");
  const url = `${config.NEXTCLOUD_URL}/ocs/v1.php/cloud/users?format=json`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${basic}`,
      "OCS-APIRequest": "true",
      Accept: "application/json",
    },
    // Nextcloud's user list is small + local — cap quickly so a
    // hung container doesn't stall the poller.
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) {
    throw new Error(`Nextcloud /cloud/users returned ${res.status}`);
  }
  const data = (await res.json()) as { ocs?: { data?: { users?: string[] } } };
  const usernames = data.ocs?.data?.users ?? [];
  const systemUser = adminUser.toLowerCase();
  return usernames.filter((u) => u.toLowerCase() !== systemUser).length;
}
