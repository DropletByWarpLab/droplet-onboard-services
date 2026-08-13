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

/**
 * How a reported volume relates to camera footage. The operator's question
 * is "how much room do my recordings have", and only ONE of Frigate's
 * mounts answers it — summing them all answers nothing.
 */
export type StorageRole = "recordings" | "cache" | "shm" | "other";

export interface StorageStat {
  /** Mount point on Frigate's filesystem (e.g. /media/frigate/recordings). */
  path: string;
  /** All three are BYTES. Frigate reports MiB; we convert once, here. */
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** Filesystem type as Frigate reports it (ext4, overlay, tmpfs…). */
  mountType: string;
  /**
   * What this volume is FOR.
   *
   * Frigate reports `/media/frigate/recordings` and `/media/frigate/clips`
   * separately even though they are the SAME filesystem, plus `/tmp/cache`
   * (which on a normal box is the boot SSD) and `/dev/shm`. Summing them
   * double-counts the recordings drive and folds in two volumes that have
   * nothing to do with footage.
   */
  role: StorageRole;
  /**
   * True when another entry reports the same underlying filesystem and was
   * chosen as the representative one. Kept rather than dropped so the
   * diagnostics page can still show every mount Frigate knows about, while
   * anything that aggregates can skip these.
   */
  duplicateOf: string | null;
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

/** Frigate reports every storage figure in MiB. Convert once, here. */
const MIB = 1024 * 1024;

/** Frigate's own tag for the volume holding recordings. */
const RECORDINGS_HINT = "recordings";

function classifyRole(path: string): StorageRole {
  if (path.includes(RECORDINGS_HINT) || path.includes("clips")) return "recordings";
  if (path.includes("/dev/shm")) return "shm";
  if (path.includes("cache")) return "cache";
  return "other";
}

/**
 * Normalise `service.storage` into typed, byte-denominated volumes.
 *
 * Two shape facts drive this, both measured rather than assumed:
 *
 *  - Values are **MiB**. The old code passed them through as bytes, so a
 *    1.8 TB array would have rendered as "1.8 MB" the moment the key bug
 *    above was fixed.
 *  - `/media/frigate/recordings` and `/media/frigate/clips` are the SAME
 *    filesystem and report identical totals. They are marked as duplicates
 *    of one representative entry so nothing sums them twice.
 */
export function extractStorage(service: Record<string, unknown>): StorageStat[] {
  const storageMap = (service.storage ?? {}) as Record<string, Record<string, unknown>>;

  const rows = Object.entries(storageMap).map(([path, s]) => {
    const totalMib = Number(s.total ?? 0);
    const usedMib = Number(s.used ?? 0);
    const freeMib = Number(s.free ?? Math.max(0, totalMib - usedMib));
    return {
      path,
      totalBytes: Math.round((Number.isFinite(totalMib) ? totalMib : 0) * MIB),
      usedBytes: Math.round((Number.isFinite(usedMib) ? usedMib : 0) * MIB),
      freeBytes: Math.round((Number.isFinite(freeMib) ? freeMib : 0) * MIB),
      mountType: String(s.mount_type ?? "unknown"),
      role: classifyRole(path),
      duplicateOf: null as string | null,
    };
  });

  // Same filesystem == same (mountType, total, free). Frigate gives us no
  // device id, and those three together are a solid proxy: two genuinely
  // distinct volumes agreeing on all of them would be indistinguishable
  // for our purposes anyway.
  //
  // Which one becomes the representative matters, because it is the entry
  // the KPI reads. `/media/frigate/recordings` and `/media/frigate/clips`
  // BOTH classify as role "recordings", so role alone doesn't break the
  // tie — rank by how well the path answers "where is the footage".
  const rank = (r: (typeof rows)[number]): number => {
    if (r.path.includes(RECORDINGS_HINT)) return 0;
    if (r.role === "recordings") return 1;
    if (r.role === "cache") return 2;
    return 3;
  };
  const byFs = new Map<string, string>();
  for (const r of [...rows].sort((a, b) => rank(a) - rank(b))) {
    const key = `${r.mountType}|${r.totalBytes}|${r.freeBytes}`;
    const seen = byFs.get(key);
    if (seen === undefined) byFs.set(key, r.path);
    else r.duplicateOf = seen;
  }

  return rows;
}

/**
 * The one volume the operator actually asked about.
 *
 * Returns null rather than guessing when Frigate reports no recordings
 * mount — a fabricated denominator is worse than an honest "unknown",
 * because it would make a full drive look roomy.
 */
export function recordingsVolume(storage: StorageStat[]): StorageStat | null {
  const candidates = storage.filter((s) => s.role === "recordings" && !s.duplicateOf);
  if (candidates.length > 0) {
    // Prefer the mount literally named "recordings" over "clips".
    return candidates.find((s) => s.path.includes(RECORDINGS_HINT)) ?? candidates[0];
  }
  // Unusual layout: if there is exactly one real volume, it is the one.
  const real = storage.filter((s) => !s.duplicateOf && s.role !== "shm");
  return real.length === 1 ? real[0] : null;
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
  //
  // 🔴 Frigate nests this under `service`, NOT at the top level. Reading
  // `stats.storage` yielded an empty array on every single request, which
  // is why the Storage KPI read "—" / "No volumes reported" and the
  // per-mount table never rendered at all (WARP-1960). Confirmed against
  // the live box: `'storage' in stats` is False, `'storage' in
  // stats['service']` is True. This file already reads `stats.service`
  // correctly a few lines up for uptime.
  const storage = extractStorage(service);

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
