"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Cpu,
  HardDrive,
  Loader2,
  Power,
  RefreshCw,
  Server,
  Video,
  Zap,
} from "lucide-react";
import { fetchCameraSystemStatus, restartFrigate } from "@/lib/api";
import { confirmNetworkCommand } from "@/lib/api";
import type { CameraSystemStatus } from "@/lib/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";

/**
 * /cameras/system — Frigate-wide health surface (Phase 5).
 *
 * Aggregates the per-camera + per-detector + per-GPU + storage data
 * Frigate exposes via /api/stats and surfaces it as the operator's
 * "is everything OK?" page. The big-number cards at the top answer
 * "right this second"; the tables underneath let the operator drill
 * into a misbehaving detector or storage volume.
 *
 * The Restart button uses the same tier-2 confirmation flow the
 * camera-disable / camera-delete buttons use — restart drops every
 * stream for ~10 seconds, so we don't want a stray click to do it.
 */
export default function CameraSystemPage() {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSWR<CameraSystemStatus>(
    "/api/cameras/system",
    fetchCameraSystemStatus,
    { refreshInterval: 5000 },
  );

  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState<string | null>(null);
  // WARP-291: holds the tier-2 confirmation token + reason between the
  // first restartFrigate() call (which returns confirmation_required)
  // and the user's click on the <ConfirmDialog>. Null while no confirm
  // is pending.
  const [pendingRestart, setPendingRestart] = useState<
    { confirmationToken: string; reason: string } | null
  >(null);

  const handleRestart = async () => {
    setRestarting(true);
    setRestartMsg(null);
    try {
      const first = await restartFrigate();
      if (first.status === "confirmation_required" && first.confirmationToken) {
        // Surface the reason and require a click. The ConfirmDialog flow
        // continues in performRestartConfirm().
        setPendingRestart({
          confirmationToken: first.confirmationToken,
          reason:
            first.reason ?? "This will drop every camera for ~10 seconds.",
        });
        // Hold the spinner open while the user decides — they may be
        // reading the consequence copy.
        return;
      } else if (first.status === "restarting") {
        setRestartMsg("Restarting camera service — cameras back in ~15 seconds.");
      }
      void mutate();
      setRestarting(false);
    } catch (e) {
      setRestartMsg(e instanceof Error ? e.message : "Restart failed");
      setRestarting(false);
    }
  };

  const performRestartConfirm = async () => {
    const ctx = pendingRestart;
    if (!ctx) return;
    try {
      await confirmNetworkCommand(
        ctx.confirmationToken,
        "restart_frigate",
        "frigate.system",
      );
      const second = await restartFrigate();
      if (second.status === "restarting") {
        setRestartMsg("Restarting camera service — cameras back in ~15 seconds.");
      } else {
        setRestartMsg(`Unexpected response: ${second.status}`);
      }
      setPendingRestart(null);
      setRestarting(false);
      void mutate();
    } catch (e) {
      setRestartMsg(e instanceof Error ? e.message : "Restart failed");
      setRestarting(false);
      throw e;
    }
  };

  const cancelRestart = () => {
    setPendingRestart(null);
    setRestartMsg("Cancelled.");
    setRestarting(false);
  };

  const totalStorage = useMemo(() => {
    if (!data) return null;
    let total = 0;
    let used = 0;
    for (const s of data.storage) {
      total += s.totalBytes;
      used += s.usedBytes;
    }
    return total > 0 ? { total, used, pct: (used / total) * 100 } : null;
  }, [data]);

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => router.push("/cameras")}
          className="p-2 -ml-2 rounded-full hover:bg-surface-secondary transition-colors"
          aria-label="Back to cameras"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="type-large-title text-label-primary">Camera system</h1>
          <p className="type-subheadline text-label-tertiary mt-0.5">
            Live health for the camera engine. Refreshes every 5 seconds.
          </p>
        </div>
        <button
          onClick={() => mutate()}
          disabled={isLoading}
          className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
          <span className="type-subheadline">Refresh</span>
        </button>
      </div>

      {error && (
        <div className="dp-card p-4 mb-4 text-system-red flex items-center gap-2">
          <AlertTriangle size={16} />
          <p className="type-subheadline">
            Couldn&apos;t reach the camera service:{" "}
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      )}

      {!data ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="dp-card h-24 animate-pulse bg-surface-secondary" />
          ))}
        </div>
      ) : (
        <>
          {/* Top stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <StatCard
              icon={Server}
              label="Engine"
              value={data.version}
              hint={`Uptime ${fmtUptime(data.uptimeSec)}`}
            />
            <StatCard
              icon={Video}
              label="Cameras live"
              value={`${data.camerasLive} / ${data.cameraCount}`}
              hint={
                data.cameraCount === 0
                  ? "No cameras configured"
                  : data.camerasLive === data.cameraCount
                    ? "All streaming"
                    : `${data.cameraCount - data.camerasLive} offline`
              }
              tone={
                data.cameraCount > 0 && data.camerasLive < data.cameraCount
                  ? "warn"
                  : "ok"
              }
            />
            <StatCard
              icon={Cpu}
              label="CPU"
              value={`${data.cpuPct.toFixed(0)}%`}
              hint="Across camera service processes"
              tone={data.cpuPct > 200 ? "warn" : "ok"}
            />
            <StatCard
              icon={HardDrive}
              label="Storage"
              value={
                totalStorage
                  ? `${(totalStorage.pct).toFixed(0)}% used`
                  : "—"
              }
              hint={
                totalStorage
                  ? `${fmtBytes(totalStorage.used)} of ${fmtBytes(totalStorage.total)}`
                  : "No volumes reported"
              }
              tone={totalStorage && totalStorage.pct > 90 ? "warn" : "ok"}
            />
          </div>

          {/* Detectors + GPUs side-by-side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
            <div className="dp-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <Zap size={16} className="text-accent" />
                <h2 className="type-headline text-label-primary">Detectors</h2>
              </div>
              {data.detectors.length === 0 ? (
                <p className="type-caption-1 text-label-tertiary">
                  No detectors reporting.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {data.detectors.map((d) => (
                    <li
                      key={d.name}
                      className="flex items-center justify-between gap-2 p-2 rounded-lg hover:bg-surface-secondary"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            d.inferenceSpeedMs > 0
                              ? "bg-system-green"
                              : "bg-label-quaternary"
                          }`}
                        />
                        <span className="type-subheadline text-label-primary truncate">
                          {d.name}
                        </span>
                      </div>
                      <span className="type-caption-1 text-label-secondary font-mono">
                        {d.inferenceSpeedMs.toFixed(1)}&nbsp;ms
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="dp-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <Activity size={16} className="text-accent" />
                <h2 className="type-headline text-label-primary">GPUs</h2>
              </div>
              {data.gpus.length === 0 ? (
                <p className="type-caption-1 text-label-tertiary">
                  No GPU stats reported. (CPU detector? Camera service
                  without nvidia runtime?)
                </p>
              ) : (
                <ul className="space-y-2">
                  {data.gpus.map((g) => (
                    <li key={g.name} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="type-subheadline text-label-primary truncate">
                          {g.name}
                        </span>
                        <span className="type-caption-1 text-label-secondary font-mono">
                          {g.gpuPct.toFixed(0)}%
                          {g.tempC !== null && (
                            <span className="text-label-tertiary ml-2">
                              {g.tempC.toFixed(0)}°C
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-surface-secondary overflow-hidden">
                        <div
                          className="h-full bg-accent transition-all"
                          style={{ width: `${Math.min(100, g.gpuPct)}%` }}
                        />
                      </div>
                      {g.memPct !== null && (
                        <div className="flex items-center gap-2">
                          <span className="type-caption-2 text-label-tertiary w-12">
                            mem
                          </span>
                          <div className="flex-1 h-1 rounded-full bg-surface-secondary overflow-hidden">
                            <div
                              className="h-full bg-system-orange transition-all"
                              style={{ width: `${Math.min(100, g.memPct)}%` }}
                            />
                          </div>
                          <span className="type-caption-2 text-label-tertiary font-mono w-10 text-right">
                            {g.memPct.toFixed(0)}%
                          </span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Per-camera FPS table */}
          <div className="dp-card p-4 mb-4">
            <h2 className="type-headline text-label-primary mb-3">Per-camera throughput</h2>
            {data.cameraFps.length === 0 ? (
              <p className="type-caption-1 text-label-tertiary">
                No cameras configured yet.
              </p>
            ) : (
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-left">
                  <thead>
                    <tr className="type-caption-2 text-label-tertiary uppercase tracking-wide">
                      <th className="px-2 py-1.5 font-medium">Camera</th>
                      <th className="px-2 py-1.5 font-medium text-right">FPS</th>
                      <th className="px-2 py-1.5 font-medium text-right">Detect FPS</th>
                      <th className="px-2 py-1.5 font-medium text-right">Skipped</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cameraFps.map((c) => (
                      <tr key={c.name} className="border-t border-separator">
                        <td className="px-2 py-2 type-subheadline text-label-primary">
                          {c.name.replace(/_/g, " ")}
                        </td>
                        <td className="px-2 py-2 type-caption-1 text-label-secondary text-right font-mono">
                          {c.cameraFps.toFixed(1)}
                        </td>
                        <td className="px-2 py-2 type-caption-1 text-label-secondary text-right font-mono">
                          {c.detectionFps.toFixed(1)}
                        </td>
                        <td
                          className={`px-2 py-2 type-caption-1 text-right font-mono ${
                            c.skippedFps > 0
                              ? "text-system-orange"
                              : "text-label-tertiary"
                          }`}
                        >
                          {c.skippedFps.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="type-caption-2 text-label-tertiary mt-2">
              Skipped frames mean the detector can&apos;t keep up with the
              capture rate. Lower the camera FPS or add a faster detector if
              this stays non-zero.
            </p>
          </div>

          {/* Storage table */}
          {data.storage.length > 0 && (
            <div className="dp-card p-4 mb-4">
              <h2 className="type-headline text-label-primary mb-3">Storage</h2>
              <ul className="space-y-2">
                {data.storage.map((s) => {
                  const pct = s.totalBytes > 0 ? (s.usedBytes / s.totalBytes) * 100 : 0;
                  return (
                    <li key={s.path} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0">
                          <span className="type-subheadline text-label-primary truncate block">
                            {s.path}
                          </span>
                          <span className="type-caption-2 text-label-tertiary">
                            {s.mountType}
                          </span>
                        </div>
                        <span className="type-caption-1 text-label-secondary font-mono">
                          {fmtBytes(s.usedBytes)} / {fmtBytes(s.totalBytes)}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-surface-secondary overflow-hidden">
                        <div
                          className={`h-full transition-all ${
                            pct > 90
                              ? "bg-system-red"
                              : pct > 75
                                ? "bg-system-orange"
                                : "bg-accent"
                          }`}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Restart card */}
          <div className="dp-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="type-headline text-label-primary mb-1">
                  Restart camera service
                </h2>
                <p className="type-caption-1 text-label-tertiary">
                  Drops every camera stream while the engine reloads. Roughly
                  10–15 seconds. Useful if a detector hangs or a config change
                  needs to take effect.
                </p>
                {restartMsg && (
                  <p
                    className={`type-caption-1 mt-2 ${
                      restartMsg.startsWith("Restarting")
                        ? "text-system-green"
                        : "text-system-red"
                    }`}
                  >
                    {restartMsg}
                  </p>
                )}
              </div>
              <button
                onClick={handleRestart}
                disabled={restarting}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-system-red/15 text-system-red hover:bg-system-red/25 disabled:opacity-60"
              >
                {restarting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Power size={14} />
                )}
                <span className="type-subheadline">
                  {restarting ? "Restarting…" : "Restart"}
                </span>
              </button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={pendingRestart !== null}
        onConfirm={performRestartConfirm}
        onCancel={cancelRestart}
        title="Restart the camera service?"
        description={
          pendingRestart?.reason ??
          "Every camera will drop for about 10 seconds. Live feeds and recordings resume automatically."
        }
        confirmLabel="Restart"
        variant="destructive"
      />
    </div>
  );
}

// --- helpers ---

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "ok",
}: {
  icon: typeof Server;
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="dp-card p-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon
          size={14}
          className={tone === "warn" ? "text-system-orange" : "text-label-tertiary"}
        />
        <span className="type-caption-2 text-label-tertiary uppercase tracking-wide">
          {label}
        </span>
      </div>
      <div className="type-title-3 text-label-primary truncate">{value}</div>
      {hint && (
        <div className="type-caption-2 text-label-tertiary mt-0.5 truncate">
          {hint}
        </div>
      )}
    </div>
  );
}

function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
