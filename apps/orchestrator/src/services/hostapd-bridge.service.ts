/**
 * hostapd-bridge.service — the orchestrator side of the single-box Wi-Fi write
 * (WARP-808).
 *
 * On the single-box deployment shape the home Wi-Fi AP is a raw `hostapd -B` on
 * the host (in the droplet-openwrt container), NOT a UCI router. A UCI SSID/PSK
 * write therefore hits a nonexistent `wireless.*` section (ubus NOT_FOUND → the
 * routing service 500s → RouterError). So on this shape the write must go
 * through the device-bridge's auth-gated POST /openwrt/wifi/hostapd, which
 * shells the repo-tracked host script (scripts/host/droplet-set-hostapd.sh) to
 * upsert the attach env file + restart droplet-openwrt-attach.service (which
 * regenerates /etc/hostapd.conf and respawns hostapd).
 *
 * This module reuses the EXACT device-bridge access pattern from
 * routes/storage.ts: the shared `config.DEVICE_BRIDGE_URL`, the
 * BRIDGE_AUTH_TOKEN/SERVICE_TOKEN_DISPLAY precedence read per-call (WARP-165),
 * the `X-Droplet-Auth` header, fail-closed on an empty token, and clean
 * RouterError.unreachable degradation when the bridge isn't reachable (so the
 * setup wizard's K3 unreachable notice — WARP-807 — works on single-box too).
 *
 * Apply model (drives "exactly one AP reload per submit", AC4): the wizard calls
 * setWifiSsid then setWifiPassword, but hostapd needs BOTH together. So the SSID
 * write only STAGES the value; the password write APPLIES the staged SSID + the
 * PSK in a single bridge POST. A password-only change (nothing staged) falls
 * back to the AP's current SSID read from the bridge.
 *
 * Staging is keyed by the authenticated user (review #2). The SSID write and the
 * password/confirm write are SEPARATE HTTP requests, so the staged SSID can't be
 * threaded through one call stack — it has to survive between requests. A single
 * process-global slot meant two concurrent wizard sessions clobbered each other,
 * and an error path could leave a stale value for a later unrelated apply. Keying
 * the stage by userId isolates concurrent sessions, and applyWifi() CONSUMES the
 * staged value (read-and-delete in one synchronous step, before any await) so it
 * is used exactly once and never lingers after an error.
 */

import pino from "pino";
import { config } from "../config.js";
import { RouterError, routerErrorFromResponse } from "../types/router-error.js";
import {
  isBridgeConnectionError,
  isTimeoutOrAbort,
  bridgeAuthToken,
} from "../lib/bridge-errors.js";
import type { WriteResult } from "./openwrt.client.js";

const logger = pino({ name: "hostapd-bridge" });

const BRIDGE_URL = config.DEVICE_BRIDGE_URL;

/**
 * Staged SSIDs from the preceding setWifiSsid call, keyed by the authenticated
 * user (review #2). Each entry is consumed (deleted) by the matching
 * applyWifi() so it never leaks into a later submit. Keyed (rather than a single
 * global) so two concurrent wizard sessions can't clobber each other.
 *
 * A user with no id (unauthenticated / test) maps to ANON_KEY — still isolated
 * from real per-user entries.
 */
const stagedSsidByUser = new Map<string, string>();
const ANON_KEY = "__anon__";

function stageKey(userId?: string | null): string {
  return userId && userId.length > 0 ? userId : ANON_KEY;
}

/** Stage the SSID for the imminent password apply (no bridge call, no AP
 *  reload). The wizard sends the password next, which does the single reload. */
export function stageSsid(ssid: string, userId?: string | null): void {
  stagedSsidByUser.set(stageKey(userId), ssid);
}

/**
 * Read the AP's current SSID from the bridge (GET /openwrt/qr — same token).
 * Used as the SSID for a password-only change when nothing was staged.
 *
 * Failure classification (WARP-836): the previous version collapsed EVERY
 * failure to `null`, and the caller turned any null into RouterError.unreachable
 * — so a 401/403 from a stale BRIDGE_AUTH_TOKEN (e.g. install-device-bridge.sh
 * re-run without refreshing the orchestrator env) was mislabeled "device not
 * reachable", misdirecting triage to the network instead of the token. Now:
 *   - a TRANSPORT failure (connection refused / DNS / client-side timeout)
 *     throws RouterError.unreachable — the bridge genuinely didn't answer;
 *   - an HTTP STATUS error means the bridge IS reachable but rejected the
 *     request, so it is classified by `routerErrorFromResponse` (401/403 → AUTH)
 *     — the same centralized classifier the rest of the network surface uses,
 *     consistent with applyWifi's own BRIDGE_AUTH_UNCONFIGURED no-token guard;
 *   - a reachable bridge that simply has no SSID in the body returns `null`,
 *     which the caller turns into "could not determine the current network name"
 *     (we never POST an empty SSID, which hostapd would reject).
 */
async function currentSsidFromBridge(): Promise<string | null> {
  const token = bridgeAuthToken();
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_URL}/openwrt/qr`, {
      signal: AbortSignal.timeout(3_000),
      ...(token ? { headers: { "X-Droplet-Auth": token } } : {}),
    });
  } catch (err) {
    // The bridge never answered: dropped connection or client-side timeout.
    if (isBridgeConnectionError(err) || isTimeoutOrAbort(err)) {
      throw RouterError.unreachable("Set Wi-Fi: device-bridge not reachable", {
        label: "Set Wi-Fi",
        cause: err,
      });
    }
    throw RouterError.unknown(
      `Set Wi-Fi: ${(err as Error).message || "bridge request failed"}`,
      { label: "Set Wi-Fi" },
    );
  }
  // The bridge answered with an HTTP error — it IS reachable. 401/403 → AUTH,
  // 5xx → unreachable, anything else → unknown-with-status. NOT a blanket
  // "unreachable" that would point triage at the network.
  if (!res.ok) {
    throw routerErrorFromResponse(res, "Set Wi-Fi");
  }
  const data = (await res.json().catch(() => ({}))) as { ssid?: string };
  return data.ssid && typeof data.ssid === "string" ? data.ssid : null;
}

/**
 * Apply the staged SSID + this PSK to the host hostapd AP via the device-bridge.
 * Exactly one bridge POST → one AP reload. Consumes (clears) the staged SSID for
 * this user up front so it can't be reused.
 *
 * Returns `{ operationId: null }` — unlike the UCI safe-apply path there is no
 * rollback/operation record for a hostapd write; the wizard's poll loop is a
 * no-op for a null operationId.
 *
 * Throws:
 *   - a BRIDGE_AUTH_UNCONFIGURED-coded Error when no bridge token is set
 *     (fail closed — we never mutate the host AP without the shared secret),
 *   - RouterError.unreachable when the bridge can't be reached (the setup
 *     wizard renders this as the soft "finish from Network later" notice),
 *   - RouterError.auth (code AUTH) when reading the current SSID and the bridge
 *     rejects our token (401/403) — distinct from "unreachable" so a stale
 *     BRIDGE_AUTH_TOKEN points triage at the token, not the network (WARP-836),
 *   - RouterError.unknown carrying the bridge's message on any other non-ok
 *     reply (e.g. the host script's 422 validation refusal).
 */
export async function applyWifi(
  psk: string,
  userId?: string | null,
): Promise<WriteResult> {
  // CONSUME the staged SSID atomically (read + delete in one synchronous step,
  // before any await). This guarantees it is used exactly once and never lingers
  // after an error path — even if the bridge POST below throws (review #2).
  const key = stageKey(userId);
  const staged = stagedSsidByUser.get(key) ?? null;
  stagedSsidByUser.delete(key);

  const token = bridgeAuthToken();
  if (!token) {
    // Fail closed: with no bridge auth token we cannot safely mutate the host
    // AP. Mirrors storage.ts's BRIDGE_AUTH_UNCONFIGURED posture.
    const err = new Error(
      "Wi-Fi can't be saved — the device-bridge auth token is not configured.",
    );
    (err as { code?: string }).code = "BRIDGE_AUTH_UNCONFIGURED";
    throw err;
  }

  // Resolve the SSID: the staged value from the preceding setWifiSsid, or the
  // AP's live SSID for a password-only change.
  let ssid = staged;
  if (!ssid) {
    ssid = await currentSsidFromBridge();
  }
  if (!ssid) {
    // The bridge IS reachable (currentSsidFromBridge throws UNREACHABLE/AUTH on
    // a transport/HTTP failure and only returns null when the AP simply has no
    // SSID set yet) — so this is NOT a reachability fault. Classifying it as
    // UNREACHABLE fired the wizard's WARP-807 "device not reachable, finish
    // later" notice and pointed triage at the network, when the real cause is a
    // password-only apply before any network name was ever configured. Surface
    // it as a 422 precondition with actionable copy instead (no PSK logged).
    throw RouterError.unknown(
      "Set Wi-Fi: set the Wi-Fi network name before saving a password — " +
        "no network name is configured yet.",
      { label: "Set Wi-Fi", status: 422 },
    );
  }

  let res: Response;
  try {
    const ctrl = new AbortController();
    // Writing the env file + restarting the attach service (which respawns
    // hostapd) takes a few seconds on the box; allow a bounded window.
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      res = await fetch(`${BRIDGE_URL}/openwrt/wifi/hostapd`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Droplet-Auth": token,
        },
        body: JSON.stringify({ ssid, psk }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (isBridgeConnectionError(err) || isTimeoutOrAbort(err)) {
      // Bridge unreachable / timed out — surface as UNREACHABLE so the wizard's
      // WARP-807 notice fires (and we never log the PSK).
      logger.warn({ bridgeUrl: BRIDGE_URL }, "device-bridge not reachable for hostapd Wi-Fi write");
      throw RouterError.unreachable("Set Wi-Fi: device-bridge not reachable", {
        label: "Set Wi-Fi",
        cause: err,
      });
    }
    throw RouterError.unknown(
      `Set Wi-Fi: ${(err as Error).message || "bridge request failed"}`,
      { label: "Set Wi-Fi" },
    );
  }

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!res.ok) {
    // The host-script validation refused (422), the box isn't in hostapd mode
    // (409), or some other bridge error. Surface the bridge's message; it's the
    // actionable text (e.g. the SSID/PSK length error). NEVER log the PSK.
    logger.warn(
      { status: res.status, bridgeError: body.error },
      "hostapd Wi-Fi write rejected by device-bridge",
    );
    throw RouterError.unknown(body.error || "The Wi-Fi change could not be applied.", {
      label: "Set Wi-Fi",
      status: res.status,
    });
  }

  return { operationId: null };
}

/** Test-only: reset the in-memory staged SSIDs between tests. */
export function _resetForTests(): void {
  stagedSsidByUser.clear();
}
