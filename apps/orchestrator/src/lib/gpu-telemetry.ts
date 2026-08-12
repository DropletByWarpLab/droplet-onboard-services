/**
 * GPU telemetry probe (WARP-1861).
 *
 * The handbook bans direct `/dev/dri/` probing from the orchestrator — see the
 * header of `services/hardware-summary.service.ts` — so GPU counters come from
 * the host device-bridge, which already runs in the host's namespace behind a
 * shared token. Its READ-ONLY `GET /gpu` returns the card's counters plus the
 * processes holding it (`services/oled-display/device-bridge.py`,
 * `gpu_snapshot()`).
 *
 * `fetchGpuTelemetry()` degrades to `null` on ANY failure — no token, bridge
 * unreachable, timeout, non-2xx, malformed body — and never throws, matching
 * the bridge-caller posture in `lib/host-topology.ts` and
 * `lib/vpn-home-endpoint.ts`. The bridge is profile-gated, so "not running" is
 * an ordinary state, not an error (WARP-645).
 *
 * Every numeric field is nullable on purpose. A card that doesn't publish
 * `gpu_busy_percent`, and a card sitting genuinely idle, are different facts;
 * collapsing them to `0` produces a reading every threshold check happily
 * passes — which is how a saturated GPU can read as healthy. Measured on the
 * lab box: when nothing holds the card, amdgpu runtime-SUSPENDS it and those
 * sysfs reads return EBUSY rather than a number, so null here is the common
 * case on an idle appliance, not an edge case.
 */

import { config } from "../config.js";
import { bridgeAuthToken, isBridgeConnectionError, isTimeoutOrAbort } from "./bridge-errors.js";
import { createLogger } from "./logger.js";

const logger = createLogger("gpu-telemetry");

/** Bounded so a slow/unreachable bridge never stalls the models page. */
const BRIDGE_GPU_TIMEOUT_MS = 3_000;

/** A process currently holding the GPU, as reported by the bridge. */
export interface GpuProcess {
  pid: number;
  comm: string;
  cmdline: string;
  /** 12-char container short id, or null for a host process. */
  containerId: string | null;
}

/** The bridge's GPU snapshot, normalised to camelCase. */
export interface GpuTelemetry {
  /** false when no card resolved — every counter is then null. */
  available: boolean;
  /** DRM node name (e.g. "card1"), or null when unavailable. */
  card: string | null;
  /** Why the card is unavailable; null when it is available. */
  reason: string | null;
  busyPercent: number | null;
  vramTotalBytes: number | null;
  vramUsedBytes: number | null;
  /** used/total, 3dp — derived by the bridge so surfaces can't disagree. */
  vramUsedFraction: number | null;
  powerWatts: number | null;
  tempC: number | null;
  processes: GpuProcess[];
}

/** Narrow an unknown JSON value to a finite number, else null. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseProcesses(raw: unknown): GpuProcess[] {
  if (!Array.isArray(raw)) return [];
  const out: GpuProcess[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const pid = num(e.pid);
    // A row with no pid isn't a process; dropping it beats surfacing a
    // half-null entry the UI would have to special-case.
    if (pid === null) continue;
    out.push({
      pid,
      comm: typeof e.comm === "string" ? e.comm : "",
      cmdline: typeof e.cmdline === "string" ? e.cmdline : "",
      containerId: typeof e.container_id === "string" ? e.container_id : null,
    });
  }
  return out;
}

/**
 * Query the host device-bridge's READ-ONLY `GET /gpu`.
 *
 * Best-effort: any failure degrades to `null`, never throws. Callers render
 * "GPU info unavailable" rather than a fabricated zero.
 */
export async function fetchGpuTelemetry(): Promise<GpuTelemetry | null> {
  const token = bridgeAuthToken();
  if (!token) {
    logger.debug({}, "gpu: bridge auth token not configured — skipping probe");
    return null;
  }
  let res: Response;
  try {
    res = await fetch(`${config.DEVICE_BRIDGE_URL}/gpu`, {
      method: "GET",
      headers: { "X-Droplet-Auth": token },
      signal: AbortSignal.timeout(BRIDGE_GPU_TIMEOUT_MS),
    });
  } catch (err) {
    if (isBridgeConnectionError(err) || isTimeoutOrAbort(err)) {
      // The bridge is profile-gated; absent is ordinary, not a fault.
      logger.debug({ err }, "gpu: device-bridge not reachable for gpu probe");
    } else {
      logger.warn({ err }, "gpu: device-bridge gpu probe failed");
    }
    return null;
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, "gpu: device-bridge gpu probe non-2xx");
    return null;
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.available !== "boolean") return null;

  return {
    available: body.available,
    card: typeof body.card === "string" ? body.card : null,
    reason: typeof body.reason === "string" ? body.reason : null,
    busyPercent: num(body.busy_percent),
    vramTotalBytes: num(body.vram_total_bytes),
    vramUsedBytes: num(body.vram_used_bytes),
    vramUsedFraction: num(body.vram_used_fraction),
    powerWatts: num(body.power_watts),
    tempC: num(body.temp_c),
    processes: parseProcesses(body.processes),
  };
}

/**
 * Bytes → GiB (binary, 1024³), 1dp. Null in, null out.
 *
 * GiB, not GB, all the way to the pixel: the function name, the payload field
 * (`vramGiB`) and the tile's unit label all say the same thing. The divisor
 * is the binary one because that is how VRAM is actually sized — mem_info_
 * vram_total on the lab's 16 GiB card reads 17_095_983_104, which is 15.9 GiB
 * and 17.1 GB. Printing "17.1 GB" for a card the customer bought as "16GB"
 * would be a worse lie than the 15.9 it replaces, so the unit label moved to
 * match the arithmetic rather than the other way round.
 */
export function bytesToGiB(bytes: number | null): number | null {
  if (bytes === null) return null;
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}
