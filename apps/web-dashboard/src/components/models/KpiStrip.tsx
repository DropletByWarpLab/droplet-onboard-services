"use client";

/**
 * WARP-836 — the Models page KPI strip.
 *
 * Four read-only tiles: model-store usage, GPU, average latency, cloud spend.
 * All but cloud spend are placeholders today (the backend returns null/0 for
 * GPU + latency + per-model disk until ai-gateway exposes those probes), so
 * those tiles render an honest "Unavailable" rather than a fabricated number.
 * Cloud spend is a real value — $0.00 while no cloud escapes are enabled.
 */

import { Clock, Cloud, Cpu, HardDrive, type LucideIcon } from "lucide-react";
import type { ModelsGpuInfo } from "@/lib/types";

interface KpiStripProps {
  gpu: ModelsGpuInfo | null;
  avgLatencyMs: number;
  cloudSpendUsd: number;
  /** Count of local models — used only for the model-store tile's sub-line. */
  localCount: number;
}

/** Format USD with two decimals, e.g. 0 → "$0.00". */
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function KpiStrip({
  gpu,
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

          util and temp are nullable, and that is the NORMAL case rather
          than a fault: with nothing holding the card the driver
          runtime-suspends it and those readings cannot be taken at all.
          Rendering 0% there would claim a measurement nobody made, so each
          field degrades on its own and the tile still names the card and
          its VRAM. */}
      <KpiTile
        icon={Cpu}
        label="GPU"
        value={gpu ? gpu.name : "Unavailable"}
        valueMuted={!gpu}
        meta={
          gpu
            ? [
                `${gpu.vramGb} GB VRAM`,
                gpu.tempC !== null ? `${gpu.tempC}°C` : null,
                // "busy", not "used". utilPct is gpu_busy_percent — COMPUTE
                // utilisation. Rendered as "% used" beside a GB figure it
                // reads as "97% of VRAM consumed", a different number that
                // can be far lower.
                gpu.utilPct !== null
                  ? `${gpu.utilPct}% busy`
                  : // NOT "idle": a null is a reading nobody took. The bridge
                    // returns null on ANY sysfs failure, which covers a
                    // runtime-suspended card AND a wedged or resetting one —
                    // the same payload can show a held card while busy is
                    // null. Asserting idleness would re-create in words the
                    // fabricated zero this ticket exists to kill.
                    "utilisation not reported",
              ]
                .filter(Boolean)
                .join(" · ")
            : // NOT "no accelerator". gpu is null on the most ordinary path
              // there is: device-bridge is profile-gated (WARP-645), so a
              // mini-rack with a 16 GB Radeon lands here whenever that
              // profile or its token is absent. Claiming the hardware is
              // missing sends the operator hunting for a GPU, not a bridge.
              "Accelerator stats aren’t being reported"
        }
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
