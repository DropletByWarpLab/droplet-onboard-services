/**
 * logs-bridge.service — the orchestrator side of the diagnostics log fetch
 * (WARP-823).
 *
 * Host logs (journald units + container logs) live on the host, outside the
 * orchestrator container. The orchestrator can NOT shell `journalctl` /
 * `docker logs` itself — it has no access to the host's log streams, and
 * arbitrary child_process shell-out from a network-facing tier is exactly the
 * pattern the architecture forbids. The ONLY host-exec path is the
 * device-bridge, which already shells repo-tracked host scripts behind its
 * auth token (run_pool_command / run_set_hostapd). So the log collector is a
 * repo-tracked host script (scripts/host/droplet-collect-logs.sh) the bridge
 * execs; this module fetches its output over the bridge's auth-gated
 * GET /logs/bundle.
 *
 * Reuses the EXACT device-bridge access pattern from hostapd-bridge.service.ts:
 * the shared `config.DEVICE_BRIDGE_URL`, the BRIDGE_AUTH_TOKEN /
 * SERVICE_TOKEN_DISPLAY precedence read per-call (WARP-165), the
 * `X-Droplet-Auth` header, fail-closed on an empty token, and clean
 * RouterError.unreachable degradation when the bridge isn't reachable (so the
 * Settings UI can render a calm "diagnostics unavailable" state instead of a
 * 500).
 *
 * The host script redacts secrets as it reads (defense in depth); the
 * orchestrator route applies redactSecrets() AGAIN on every line before it is
 * written into the zip, so this module returns the bridge payload verbatim and
 * the redaction guarantee does not depend on the bridge being reachable or
 * up-to-date.
 */

import { config } from "../config.js";
import { RouterError } from "../types/router-error.js";
import { isBridgeConnectionError } from "../lib/bridge-errors.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("logs-bridge");

const BRIDGE_URL = config.DEVICE_BRIDGE_URL;

/** Per-service log capture as the host collector returns it. */
export interface BridgeServiceLog {
  /** Logical service name, e.g. "orchestrator", "ai-gateway", "routing". */
  name: string;
  /** Where the lines came from: "docker" (container) or "journald" (host unit). */
  source: string;
  /** The captured log text — already host-side redacted + line/size-bounded. */
  lines: string;
  /** Optional per-service note (e.g. "no container by that name"). */
  note?: string;
}

/** The whole bundle payload the bridge returns from GET /logs/bundle. */
export interface BridgeLogBundle {
  collected_at: string;
  window_hours: number;
  services: BridgeServiceLog[];
  /** True when any service hit the per-service line/byte cap and was clipped. */
  truncated: boolean;
}

export interface FetchLogBundleOptions {
  /** Bounded look-back window in hours (the route validates the range). */
  windowHours: number;
  /** Optional single-service filter, passed through to the collector. */
  service?: string;
}

/**
 * Shared secret the device-bridge requires on its auth-gated routes. Same env
 * precedence + per-call read as hostapd-bridge.service.ts / routes/storage.ts
 * so a secret injected after boot (and the tests) see the current value.
 */
function bridgeAuthToken(): string {
  return (
    process.env.BRIDGE_AUTH_TOKEN ||
    process.env.SERVICE_TOKEN_DISPLAY ||
    ""
  ).trim();
}

/** A fetch/abort failure meaning "the request didn't get a response" — a
 *  dropped connection or a client-side timeout. (Mirrors the helper in
 *  hostapd-bridge.service.ts.) */
function isTimeoutOrAbort(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Fetch the host log bundle through the device-bridge.
 *
 * Throws:
 *   - a BRIDGE_AUTH_UNCONFIGURED-coded Error when no bridge token is set
 *     (fail closed — we never reach the bridge without the shared secret),
 *   - RouterError.unreachable when the bridge can't be reached / times out
 *     (the Settings UI renders this as the calm "diagnostics unavailable"
 *     state),
 *   - RouterError.unknown carrying the bridge's message on any other non-ok
 *     reply (e.g. the collector failed on the host).
 */
export async function fetchLogBundleFromBridge(
  opts: FetchLogBundleOptions,
): Promise<BridgeLogBundle> {
  const token = bridgeAuthToken();
  if (!token) {
    // Fail closed: with no bridge auth token we cannot reach the host
    // collector. Mirrors hostapd-bridge.service.ts's posture.
    const err = new Error(
      "Diagnostics can't be collected — the device-bridge auth token is not configured.",
    );
    (err as { code?: string }).code = "BRIDGE_AUTH_UNCONFIGURED";
    throw err;
  }

  const params = new URLSearchParams({ hours: String(opts.windowHours) });
  if (opts.service) params.set("service", opts.service);
  const url = `${BRIDGE_URL}/logs/bundle?${params.toString()}`;

  let res: Response;
  try {
    // Collecting + redacting journald/docker logs on the host takes a moment;
    // allow a bounded window. The route's own timeout is the outer bound.
    res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { "X-Droplet-Auth": token },
    });
  } catch (err) {
    if (isBridgeConnectionError(err) || isTimeoutOrAbort(err)) {
      logger.warn(
        { bridgeUrl: BRIDGE_URL },
        "device-bridge not reachable for log bundle",
      );
      throw RouterError.unreachable("Collect diagnostics: device-bridge not reachable", {
        label: "Collect diagnostics",
        cause: err,
      });
    }
    throw RouterError.unknown(
      `Collect diagnostics: ${(err as Error).message || "bridge request failed"}`,
      { label: "Collect diagnostics" },
    );
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    logger.warn(
      { status: res.status, bridgeError: body.error },
      "log bundle collection rejected by device-bridge",
    );
    throw RouterError.unknown(
      body.error || "Diagnostics could not be collected on the device.",
      { label: "Collect diagnostics", status: res.status },
    );
  }

  const data = (await res.json()) as Partial<BridgeLogBundle>;
  return {
    collected_at: data.collected_at ?? new Date().toISOString(),
    window_hours: data.window_hours ?? opts.windowHours,
    services: Array.isArray(data.services) ? data.services : [],
    truncated: data.truncated ?? false,
  };
}
