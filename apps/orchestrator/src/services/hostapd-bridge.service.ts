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
 * write only STAGES the value in memory here; the password write APPLIES the
 * staged SSID + the PSK in a single bridge POST. A password-only change (nothing
 * staged) falls back to the AP's current SSID read from the bridge.
 */

import pino from "pino";
import { config } from "../config.js";
import { RouterError } from "../types/router-error.js";
import type { WriteResult } from "./openwrt.client.js";

const logger = pino({ name: "hostapd-bridge" });

const BRIDGE_URL = config.DEVICE_BRIDGE_URL;

/**
 * Shared secret the device-bridge requires on its mutating routes. Same env
 * precedence + per-call read as routes/storage.ts's bridgeAuthToken() so a
 * secret injected after boot (and the tests) see the current value.
 */
function bridgeAuthToken(): string {
  return (
    process.env.BRIDGE_AUTH_TOKEN ||
    process.env.SERVICE_TOKEN_DISPLAY ||
    ""
  ).trim();
}

/** In-memory staged SSID from the preceding setWifiSsid call. Cleared after a
 *  successful apply so it never leaks into the next submit. */
let stagedSsid: string | null = null;

/** Stage the SSID for the imminent password apply (no bridge call, no AP
 *  reload). The wizard sends the password next, which does the single reload. */
export function stageSsid(ssid: string): void {
  stagedSsid = ssid;
}

function bridgeConnErr(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const codes = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
  ]);
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code && codes.has(cause.code)) return true;
  const direct = (err as { code?: string }).code;
  return !!direct && codes.has(direct);
}

/**
 * Read the AP's current SSID from the bridge (GET /openwrt/qr — same token).
 * Used as the SSID for a password-only change when nothing was staged. Returns
 * null on any failure; the caller turns a null into an explicit RouterError so
 * we never POST an empty SSID (which hostapd would reject).
 */
async function currentSsidFromBridge(): Promise<string | null> {
  const token = bridgeAuthToken();
  try {
    const res = await fetch(`${BRIDGE_URL}/openwrt/qr`, {
      signal: AbortSignal.timeout(3_000),
      ...(token ? { headers: { "X-Droplet-Auth": token } } : {}),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ssid?: string };
    return data.ssid && typeof data.ssid === "string" ? data.ssid : null;
  } catch {
    return null;
  }
}

/**
 * Apply the staged SSID + this PSK to the host hostapd AP via the device-bridge.
 * Exactly one bridge POST → one AP reload. Clears the staged SSID on success.
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
 *   - RouterError.unknown carrying the bridge's message on any other non-ok
 *     reply (e.g. the host script's 422 validation refusal).
 */
export async function applyWifi(psk: string): Promise<WriteResult> {
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
  let ssid = stagedSsid;
  if (!ssid) {
    ssid = await currentSsidFromBridge();
  }
  if (!ssid) {
    throw RouterError.unreachable(
      "Set Wi-Fi: could not determine the current network name (SSID).",
      { label: "Set Wi-Fi" },
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
    if (bridgeConnErr(err) || (err as Error)?.name === "AbortError") {
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

  // Applied — clear the stage so it doesn't leak into the next submit.
  stagedSsid = null;
  return { operationId: null };
}

/** Test-only: reset the in-memory staged SSID between tests. */
export function _resetForTests(): void {
  stagedSsid = null;
}
