/**
 * Camera-system status — the dashboard's "what's Frigate doing right
 * now?" surface. Wraps Frigate's `/api/stats` + `/api/version` into a
 * typed DTO with the fields the dashboard's system page cares about,
 * normalised across Frigate versions (the wire shape drifts: `gpu_usages`
 * vs `gpu_used_pct`, `storage` keys vary, etc).
 *
 * Aggregates per-camera FPS into a count of "live" cameras (anything
 * with a non-zero camera_fps in the last poll), so the page can show
 * "5 of 6 cameras live" at a glance without the operator having to
 * eyeball a stats blob.
 */

import { fetchStats, fetchVersion } from "./frigate.client.js";

export interface DetectorStat {
  name: string;
  /** Inference time in milliseconds, lower-is-better. */
  inferenceSpeedMs: number;
  /** Per-detector PID — useful for debugging hung detectors. */
  pid: number | null;
}

export interface GpuStat {
  name: string;
  /** GPU utilisation %, 0–100. */
  gpuPct: number;
  /** GPU memory utilisation %, 0–100. May be absent on some setups. */
  memPct: number | null;
  /** GPU temperature °C. May be absent. */
  tempC: number | null;
}

export interface StorageStat {
  /** Mount point on Frigate's filesystem (e.g. /media/frigate/recordings). */
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** "recordings" | "events" | "cache" | "tmpfs" — Frigate's tag for the volume. */
  mountType: string;
}

export interface CameraSystemStatus {
  /** Frigate version string (e.g. "0.13.2-abcdef"). */
  version: string;
  /** Frigate process uptime, seconds. */
  uptimeSec: number;
  /** Total cameras Frigate knows about. */
  cameraCount: number;
  /** Cameras with non-zero camera_fps in the last poll — i.e. actively
   *  receiving frames. */
  camerasLive: number;
  /** Per-camera FPS info for the operator-visible card grid. */
  cameraFps: Array<{
    name: string;
    cameraFps: number;
    detectionFps: number;
    skippedFps: number;
  }>;
  detectors: DetectorStat[];
  gpus: GpuStat[];
  storage: StorageStat[];
  /** Aggregate CPU usage % of all Frigate processes. Sum across the
   *  cpu_usages map. */
  cpuPct: number;
}

export async function getCameraSystemStatus(): Promise<CameraSystemStatus> {
  const [statsRaw, version] = await Promise.all([
    fetchStats(),
    fetchVersion().catch(() => "unknown"),
  ]);
  const stats = statsRaw as Record<string, unknown>;

  // --- service / process ---
  const service = (stats.service ?? {}) as Record<string, unknown>;
  const uptimeSec = Number(service.uptime ?? 0);

  // --- cameras ---
  const camerasMap = (stats.cameras ?? {}) as Record<string, Record<string, unknown>>;
  const cameraEntries = Object.entries(camerasMap);
  const cameraFps = cameraEntries.map(([name, c]) => ({
    name,
    cameraFps: Number(c.camera_fps ?? 0),
    detectionFps: Number(c.detection_fps ?? 0),
    skippedFps: Number(c.skipped_fps ?? 0),
  }));
  const camerasLive = cameraFps.filter((c) => c.cameraFps > 0).length;

  // --- detectors ---
  const detectorsMap = (stats.detectors ?? {}) as Record<string, Record<string, unknown>>;
  const detectors: DetectorStat[] = Object.entries(detectorsMap).map(
    ([name, d]) => ({
      name,
      inferenceSpeedMs: Number(d.inference_speed ?? 0),
      pid: d.pid !== undefined && d.pid !== null ? Number(d.pid) : null,
    }),
  );

  // --- gpus ---
  // Frigate's wire shape is loose: sometimes `gpu_usages: {name: {gpu, mem, ...}}`,
  // sometimes percentage strings ("12.3 %"). Coerce to numbers.
  const gpuMap = (stats.gpu_usages ?? {}) as Record<string, Record<string, unknown>>;
  const parsePct = (v: unknown): number => {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = parseFloat(v.replace("%", "").trim());
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };
  const gpus: GpuStat[] = Object.entries(gpuMap).map(([name, g]) => ({
    name,
    gpuPct: parsePct(g.gpu ?? g.gpu_pct ?? 0),
    memPct:
      g.mem !== undefined || g.mem_pct !== undefined
        ? parsePct(g.mem ?? g.mem_pct)
        : null,
    tempC:
      g.temp !== undefined && Number.isFinite(Number(g.temp))
        ? Number(g.temp)
        : null,
  }));

  // --- storage ---
  const storageMap = (stats.storage ?? {}) as Record<string, Record<string, unknown>>;
  const storage: StorageStat[] = Object.entries(storageMap).map(
    ([path, s]) => ({
      path,
      totalBytes: Number(s.total ?? 0),
      usedBytes: Number(s.used ?? 0),
      freeBytes: Number(s.free ?? Math.max(0, Number(s.total ?? 0) - Number(s.used ?? 0))),
      mountType: String(s.mount_type ?? "unknown"),
    }),
  );

  // --- aggregate cpu ---
  // cpu_usages is keyed by process name → { cpu, mem, ... }. Sum the
  // cpu values for an at-a-glance "Frigate is using X% of one core."
  const cpuMap = (stats.cpu_usages ?? {}) as Record<string, Record<string, unknown>>;
  let cpuPct = 0;
  for (const proc of Object.values(cpuMap)) {
    cpuPct += parsePct(proc.cpu ?? 0);
  }

  return {
    version: version.trim(),
    uptimeSec,
    cameraCount: cameraEntries.length,
    camerasLive,
    cameraFps,
    detectors,
    gpus,
    storage,
    cpuPct,
  };
}
