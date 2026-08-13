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
import { fetchCameraSystemStatus, fetchCameraStorage, restartFrigate } from "@/lib/api";
import type { CameraStorageSummary } from "@/lib/types";
import { confirmNetworkCommand } from "@/lib/api";
import type { CameraSystemStatus } from "@/lib/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ShellPage } from "@/components/shell/ShellPage";
import { Card, Kpi, Meter } from "@/components/shell/primitives";

/**
 * /cameras/system — Frigate-wide health surface (Phase 5).
 *
 * Aggregates the per-camera + per-detector + per-GPU + storage data
 * the camera engine exposes via /api/stats and surfaces it as the
 * operator's "is everything OK?" page. The big-number cards at the top
 * answer "right this second"; the tables underneath let the operator
 * drill into a misbehaving detector or storage volume.
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

  // WARP-1850: per-camera storage. Polled slower than the system status —
  // Frigate recomputes usage by summing segment sizes, so hammering it at
  // 5s buys nothing but load. `storageError` is surfaced rather than
  // swallowed: an empty breakdown reads as "nothing is using disk".
  const {
    data: storage,
    error: storageError,
  } = useSWR<CameraStorageSummary>(
    "/api/cameras/storage",
    fetchCameraStorage,
    { refreshInterval: 60_000 },
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

  // The headline number is the RECORDINGS drive, not a sum.
  //
  // Frigate reports four volumes: /media/frigate/recordings and
  // /media/frigate/clips (the SAME filesystem, so summing double-counts
  // it), /tmp/cache (the boot SSD) and /dev/shm (256 MiB of tmpfs).
  // Adding them produced a "% used" that described no real disk — on this
  // box it would have read ~3% of a phantom 4 TB (WARP-1960).
  const totalStorage = useMemo(() => {
    if (!data) return null;
    const vol =
      data.storage.find((s) => s.role === "recordings" && !s.duplicateOf) ?? null;
    if (!vol || vol.totalBytes <= 0) return null;
    return {
      total: vol.totalBytes,
      used: vol.usedBytes,
      free: vol.freeBytes,
      path: vol.path,
      pct: (vol.usedBytes / vol.totalBytes) * 100,
    };
  }, [data]);

  const actions = (
    <>
      <button onClick={() => router.push("/cameras")} className="btn ghost" type="button">
        <ArrowLeft size={15} />
        Cameras
      </button>
      <button
        onClick={() => mutate()}
        disabled={isLoading}
        className="icon-btn"
        aria-label="Refresh"
        title="Refresh"
        type="button"
      >
        <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
      </button>
    </>
  );

  return (
    <ShellPage
      icon={<Server size={15} />}
      label="System"
      title="Camera system"
      sub="Live health for the camera engine. Refreshes every 5 seconds."
      actions={actions}
    >
      {error && (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 8, color: "#ef4444", marginBottom: 16 }}>
          <AlertTriangle size={14} />
          <span>
            Couldn&apos;t reach the camera service:{" "}
            {error instanceof Error ? error.message : String(error)}
          </span>
        </div>
      )}

      {!data ? (
        <div className="grid c4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card" style={{ height: 96, background: "var(--surface-2)" }} />
          ))}
        </div>
      ) : (
        <>
          {/* Top stat tiles */}
          <div className="grid c4" style={{ marginBottom: 16 }}>
            <Kpi
              icon={<Server size={13} />}
              label="Engine"
              value={data.version}
              note={`Uptime ${fmtUptime(data.uptimeSec)}`}
            />
            <Kpi
              icon={<Video size={13} />}
              label="Cameras live"
              value={`${data.camerasLive} / ${data.cameraCount}`}
              note={
                data.cameraCount === 0
                  ? "No cameras configured"
                  : data.camerasLive === data.cameraCount
                    ? "All streaming"
                    : `${data.cameraCount - data.camerasLive} offline`
              }
              dot={
                data.cameraCount > 0 && data.camerasLive < data.cameraCount
                  ? "#d9a35c"
                  : "var(--success)"
              }
            />
            <Kpi
              icon={<Cpu size={13} />}
              label="CPU"
              value={`${data.cpuPct.toFixed(0)}%`}
              note="Across camera service processes"
              dot={data.cpuPct > 200 ? "#d9a35c" : "var(--success)"}
            />
            <Kpi
              icon={<HardDrive size={13} />}
              label="Recordings drive"
              value={
                totalStorage
                  ? totalStorage.pct < 1
                    ? "<1% used"
                    : `${totalStorage.pct.toFixed(0)}% used`
                  : "—"
              }
              note={
                totalStorage
                  ? `${fmtBytes(totalStorage.used)} of ${fmtBytes(totalStorage.total)} · ${fmtBytes(totalStorage.free)} free`
                  : "No recordings volume reported"
              }
              dot={totalStorage && totalStorage.pct > 85 ? "#d9a35c" : "var(--success)"}
            />
          </div>

          {/* Detectors + GPUs side-by-side */}
          <div className="grid c2" style={{ marginBottom: 16 }}>
            <Card icon={<Zap size={15} />} title="Detectors">
              {data.detectors.length === 0 ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  No detectors reporting.
                </p>
              ) : (
                <ul style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {data.detectors.map((d) => (
                    <li
                      key={d.name}
                      className="lrow"
                      style={{ justifyContent: "space-between" }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background:
                              d.inferenceSpeedMs > 0 ? "var(--success)" : "var(--text-muted)",
                          }}
                        />
                        <span className="nm">{d.name}</span>
                      </span>
                      <span className="rmeta mono">
                        {d.inferenceSpeedMs.toFixed(1)}&nbsp;ms
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card icon={<Activity size={15} />} title="GPUs">
              {data.gpus.length === 0 ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  No GPU stats reported. (CPU detector? Camera service without
                  nvidia runtime?)
                </p>
              ) : (
                <ul style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {data.gpus.map((g) => (
                    <li key={g.name} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span className="nm">{g.name}</span>
                        <span className="rmeta mono">
                          {g.gpuPct.toFixed(0)}%
                          {g.tempC !== null && (
                            <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                              {g.tempC.toFixed(0)}°C
                            </span>
                          )}
                        </span>
                      </div>
                      <Meter pct={g.gpuPct} />
                      {g.memPct !== null && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 11, color: "var(--text-muted)", width: 32 }}>
                            mem
                          </span>
                          <div style={{ flex: 1 }}>
                            <Meter pct={g.memPct} kind="warn" />
                          </div>
                          <span
                            style={{
                              fontSize: 11,
                              color: "var(--text-muted)",
                              fontFamily: "var(--font-mono)",
                              width: 40,
                              textAlign: "right",
                            }}
                          >
                            {g.memPct.toFixed(0)}%
                          </span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Per-camera FPS table */}
          <Card title="Per-camera throughput" className="span2" style={{ marginBottom: 16 }}>
            {data.cameraFps.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                No cameras configured yet.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Camera</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>FPS</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>Detect FPS</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>Skipped</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cameraFps.map((c) => (
                      <tr key={c.name} style={{ borderTop: "1px solid var(--card-bd)" }}>
                        <td style={{ padding: "8px", fontSize: 13, color: "var(--text)" }}>
                          {c.name.replace(/_/g, " ")}
                        </td>
                        <td style={{ padding: "8px", fontSize: 12, color: "var(--text-muted)", textAlign: "right", fontFamily: "var(--font-mono)" }}>
                          {c.cameraFps.toFixed(1)}
                        </td>
                        <td style={{ padding: "8px", fontSize: 12, color: "var(--text-muted)", textAlign: "right", fontFamily: "var(--font-mono)" }}>
                          {c.detectionFps.toFixed(1)}
                        </td>
                        <td
                          style={{
                            padding: "8px",
                            fontSize: 12,
                            textAlign: "right",
                            fontFamily: "var(--font-mono)",
                            color: c.skippedFps > 0 ? "#d9a35c" : "var(--text-muted)",
                          }}
                        >
                          {c.skippedFps.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
              Skipped frames mean the detector can&apos;t keep up with the
              capture rate. Lower the camera FPS or add a faster detector if
              this stays non-zero.
            </p>
          </Card>

          {/* Storage table */}
          {data.storage.length > 0 && (
            <Card title="Storage" className="span2" style={{ marginBottom: 16 }}>
              <ul style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {data.storage.map((s) => {
                  const pct = s.totalBytes > 0 ? (s.usedBytes / s.totalBytes) * 100 : 0;
                  return (
                    <li key={s.path} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ minWidth: 0 }}>
                          <span className="nm" style={{ display: "block" }}>{s.path}</span>
                          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {s.mountType}
                          </span>
                        </div>
                        <span className="rmeta mono">
                          {fmtBytes(s.usedBytes)} / {fmtBytes(s.totalBytes)}
                        </span>
                      </div>
                      <Meter pct={pct} kind={pct > 90 ? "danger" : pct > 75 ? "warn" : ""} />
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {/* Per-camera storage (WARP-1850) */}
          <Card
            icon={<HardDrive size={15} />}
            title="Storage by camera"
            className="span2"
            style={{ marginBottom: 16 }}
          >
            {storageError ? (
              <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Storage usage is unavailable right now, so this list may be
                incomplete. It isn&apos;t a sign that your cameras are using no
                space.
              </p>
            ) : !storage ? (
              <div style={{ height: 64, background: "var(--surface-2)", borderRadius: 8 }} />
            ) : storage.cameras.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                No cameras are recording yet.
              </p>
            ) : (
              <>
                {/* WARP-1963 — footage on the wrong disk.
                    Louder than near-full on purpose: a full drive shortens
                    retention, but this means the dedicated recordings drive
                    is doing nothing at all while the system disk fills. It
                    is the exact silent failure that left this box's 1.8 TB
                    array empty for a month. */}
                {storage.recordingsOnBootDisk === true && (
                  <div
                    data-testid="boot-disk-warning"
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      marginBottom: 12,
                      color: "#ef4444",
                      fontSize: 12,
                    }}
                  >
                    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>
                      <strong>Recordings are being written to the system disk.</strong>{" "}
                      The dedicated recordings drive isn&apos;t mounted, so footage
                      is filling the same disk the appliance runs on and you have
                      far less room than you think. Check that the recordings
                      volume is mounted, then restart the camera service.
                    </span>
                  </div>
                )}
                {storage.nearFull && (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      marginBottom: 12,
                      color: "#d9a35c",
                      fontSize: 12,
                    }}
                  >
                    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>
                      This drive is {storage.volume?.usedPercent.toFixed(0)}% full.
                      When it fills, the oldest footage is deleted first — every
                      camera quietly keeps less than you asked for. Lower a
                      retention window, or add storage.
                    </span>
                  </div>
                )}
                {/* WARP-1963 — the drive as ONE bar, split by camera.
                    Per-camera meters each ran 0–100% of the whole drive, so
                    at 0.24% every camera was an invisible sliver and the
                    picture answered nothing. Stacked, the segments plus free
                    space add up to the real capacity, which is what "how is
                    my space allocated" actually asks. */}
                {storage.volume && storage.volume.totalBytes > 0 && (
                  <div style={{ marginBottom: 14 }} data-testid="allocation-bar">
                    <div
                      style={{
                        display: "flex",
                        height: 14,
                        borderRadius: 7,
                        overflow: "hidden",
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {storage.cameras.map((c, i) =>
                        c.usedBytes === null || c.usedBytes <= 0 ? null : (
                          <div
                            key={c.camera}
                            data-testid={`allocation-seg-${c.camera}`}
                            title={`${c.camera} — ${fmtBytes(c.usedBytes)}`}
                            style={{
                              // Floor at a hairline so a real-but-tiny
                              // consumer is still visible; the NUMBER below
                              // carries the precision.
                              width: `max(2px, ${(c.usedBytes / storage.volume!.totalBytes) * 100}%)`,
                              background: `color-mix(in srgb, var(--brand) ${85 - Math.min(i, 4) * 15}%, transparent)`,
                            }}
                          />
                        ),
                      )}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginTop: 4,
                        fontSize: 11,
                        color: "var(--text-muted)",
                      }}
                    >
                      <span>
                        {fmtBytes(storage.volume.usedBytes)} used of{" "}
                        {fmtBytes(storage.volume.totalBytes)}
                      </span>
                      <span>{fmtBytes(storage.volume.freeBytes)} free</span>
                    </div>
                  </div>
                )}

                <ul style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {storage.cameras.map((c) => (
                    <li key={c.camera} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span className="nm" style={{ minWidth: 0 }}>{c.camera}</span>
                        <span className="rmeta mono">
                          {/* null ≠ 0: say we don't know, don't imply empty. */}
                          {c.usedBytes === null ? "not recorded yet" : fmtBytes(c.usedBytes)}
                          {/* The share was an unlabelled bar and nothing else.
                              At 0.24% that is an invisible sliver — say the
                              number. */}
                          {c.sharePercent !== null && (
                            <>
                              {" · "}
                              {c.sharePercent < 0.1 ? "<0.1" : c.sharePercent.toFixed(1)}% of drive
                            </>
                          )}
                          {c.bytesPerHour !== null && (
                            <> · {fmtBytes(c.bytesPerHour)}/hr</>
                          )}
                          {/* Computed since WARP-1850 and never rendered. */}
                          {c.daysAtCurrentRate !== null && (
                            <> · ≈{c.daysAtCurrentRate}d stored</>
                          )}
                        </span>
                      </div>
                      {c.sharePercent !== null && <Meter pct={c.sharePercent} />}
                    </li>
                  ))}
                </ul>
                {storage.totalBytesPerHour !== null && storage.volume && (
                  <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 12 }}>
                    All cameras together are writing about{" "}
                    {fmtBytes(storage.totalBytesPerHour)} an hour.
                    {storage.totalBytesPerHour > 0 && (
                      <>
                        {" "}
                        At that rate the free space lasts roughly{" "}
                        {Math.max(
                          0,
                          Math.round(storage.volume.freeBytes / (storage.totalBytesPerHour * 24)),
                        )}{" "}
                        more days before the oldest footage starts being deleted.
                      </>
                    )}
                  </p>
                )}
              </>
            )}
          </Card>

          {/* Restart card */}
          <Card className="span2">
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
                  Restart camera service
                </h2>
                <p style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                  Drops every camera stream while the engine reloads. Roughly
                  10–15 seconds. Useful if a detector hangs or a config change
                  needs to take effect.
                </p>
                {restartMsg && (
                  <p
                    style={{
                      fontSize: 12.5,
                      marginTop: 8,
                      color: restartMsg.startsWith("Restarting") ? "var(--success)" : "#ef4444",
                    }}
                  >
                    {restartMsg}
                  </p>
                )}
              </div>
              <button
                onClick={handleRestart}
                disabled={restarting}
                className="btn danger"
                type="button"
              >
                {restarting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Power size={14} />
                )}
                {restarting ? "Restarting…" : "Restart"}
              </button>
            </div>
          </Card>
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
    </ShellPage>
  );
}

// --- helpers ---

/**
 * Binary maths with binary labels.
 *
 * This divided by 1024 while labelling the result "KB"/"MB"/"GB" — SI
 * names for binary quantities, so every drive figure on this page read
 * ~2.4% low against the label it carried (WARP-1960). Frigate reports MiB
 * and the array is sized in TiB, so binary is the right base; the labels
 * are what were wrong.
 */
function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
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
