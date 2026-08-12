"use client";

/**
 * WARP-836 — the Models page KPI strip.
 *
 * Four read-only tiles: model-store usage, GPU, average latency, cloud spend.
 * Model-store disk and average latency are still placeholders (no probe
 * exists yet), so those render an honest "Unavailable" rather than a
 * fabricated number. GPU is a real reading as of WARP-1861, and cloud spend
 * is real — $0.00 while no cloud escapes are enabled.
 */

import { Clock, Cloud, Cpu, HardDrive, type LucideIcon } from "lucide-react";
import type { ModelsGpuInfo, ModelsGpuReason } from "@/lib/types";

interface KpiStripProps {
  gpu: ModelsGpuInfo | null;
  /** Why `gpu` is null — see `gpuFallbackMeta`. Ignored when `gpu` is set. */
  gpuReason?: ModelsGpuReason;
  avgLatencyMs: number;
  cloudSpendUsd: number;
  /** Count of local models — used only for the model-store tile's sub-line. */
  localCount: number;
}

/** Format USD with two decimals, e.g. 0 → "$0.00". */
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * The GPU tile's sub-line, one entry per counter that could actually be read.
 *
 * VRAM and utilisation are DIFFERENT FACTS and the operator needs both: on
 * the lab box under load the card is 97% busy while VRAM sits at 83%, and
 * "97% used" beside a 15.9 GiB total reads as "15.4 GiB consumed, no room for
 * a second model" — a conclusion the numbers don't support. So compute
 * utilisation is labelled "busy", and the VRAM pair stands on its own.
 *
 * GiB because the arithmetic behind the number is binary (1024³) — see
 * `bytesToGiB` in the orchestrator's lib/gpu-telemetry.ts.
 */
function gpuMeta(gpu: ModelsGpuInfo): string {
  const vram =
    gpu.vramUsedGiB !== null && gpu.vramGiB !== null
      ? `${gpu.vramUsedGiB} / ${gpu.vramGiB} GiB`
      : gpu.vramGiB !== null
        ? `${gpu.vramGiB} GiB`
        : gpu.vramUsedGiB !== null
          ? `${gpu.vramUsedGiB} GiB in use`
          : null;
  return [
    vram,
    gpu.tempC !== null ? `${gpu.tempC}°C` : null,
    // NOT "idle". `busy_percent` is null for ANY read failure — device-bridge's
    // `_read_sysfs_int` swallows every exception, and a driver that never
    // publishes `gpu_busy_percent` yields null permanently. Runtime suspend
    // was the excuse for the old wording, but suspend requires zero clients:
    // a card holding 13.2 GiB at 62°C is provably not idle, and the tile used
    // to say so anyway. An unread counter is reported as unread.
    gpu.utilPct !== null ? `${gpu.utilPct}% busy` : "utilisation not reported",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The GPU tile's sub-line when there is no `gpu` block — one string per
 * DISTINCT fact, because "no card" and "couldn't ask" are not the same claim.
 *
 * Only `no_card` is a measurement the bridge actually took, so only it gets to
 * say something about the customer's hardware. `unreachable` names the probe,
 * which is the thing that failed and the thing the owner can act on. An absent
 * reason (older orchestrator) commits to neither.
 */
function gpuFallbackMeta(reason: ModelsGpuReason | undefined): string {
  if (reason === "no_card") return "No accelerator detected";
  if (reason === "unreachable") return "Couldn’t reach the GPU sensor";
  return "GPU reading unavailable";
}

export function KpiStrip({
  gpu,
  gpuReason,
  avgLatencyMs,
  cloudSpendUsd,
  localCount,
}: KpiStripProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* Model store — disk usage isn't reported yet, so the value is honest
          "Unavailable"; the sub-line states the true, known fact instead. */}
      <KpiTile
        icon={HardDrive}
        label="Model store"
        value="Unavailable"
        valueMuted
        meta={
          localCount === 1
            ? "1 local model on the box"
            : `${localCount} local models on the box`
        }
      />

      {/* GPU — live counters via device-bridge (WARP-1861).

          EVERY counter is nullable, and that is the NORMAL case rather than
          a fault: with nothing holding the card the driver runtime-suspends
          it and those readings cannot be taken at all, and a pinned
          BRIDGE_GPU_CARD can name a live card whose VRAM total is
          unreadable. Rendering 0% there would claim a measurement nobody
          made, so each field degrades on its OWN — the tile drops the entry
          it can't fill and still names the card.

          And when there is no block at all, the sub-line says WHICH absence
          it is: a bridge that answered "no card" is a measurement, a bridge
          we couldn't reach is not. Saying "No accelerator detected" over an
          unreachable probe is an affirmative claim about hardware nobody
          looked at — the failure mode this whole chain exists to stop. */}
      <KpiTile
        icon={Cpu}
        label="GPU"
        value={gpu ? gpu.name : "Unavailable"}
        valueMuted={!gpu}
        meta={gpu ? gpuMeta(gpu) : gpuFallbackMeta(gpuReason)}
      />

      {/* Avg latency — 0 is the placeholder sentinel (no metrics surface yet),
          so render it as unavailable rather than a misleading "0 s". */}
      <KpiTile
        icon={Clock}
        label="Avg latency"
        value={avgLatencyMs > 0 ? `${(avgLatencyMs / 1000).toFixed(1)} s` : "—"}
        valueMuted={avgLatencyMs <= 0}
        meta={
          avgLatencyMs > 0
            ? "to first token"
            : "Latency isn’t measured yet"
        }
      />

      {/* Cloud spend — a real value. Zero while no provider is enabled. */}
      <KpiTile
        icon={Cloud}
        label="Cloud spend"
        value={usd(cloudSpendUsd)}
        meta="No cloud models enabled this month"
      />
    </div>
  );
}

function KpiTile({
  icon: Icon,
  label,
  value,
  meta,
  valueMuted = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  meta: string;
  /** When the value is a placeholder, render it in a quieter weight/colour so
   *  it doesn't read as a real metric. */
  valueMuted?: boolean;
}) {
  return (
    <div className="kpi">
      <span className="k">
        <Icon size={13} strokeWidth={2} aria-hidden />
        {label}
      </span>
      <span
        className="v tabular-nums"
        style={
          valueMuted
            ? { color: "var(--text-muted)", fontWeight: 400 }
            : undefined
        }
      >
        {value}
      </span>
      <span className="d">{meta}</span>
    </div>
  );
}
