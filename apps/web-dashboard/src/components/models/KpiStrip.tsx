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
                `${gpu.vramGb} GB`,
                gpu.tempC !== null ? `${gpu.tempC}°C` : null,
                gpu.utilPct !== null
                  ? `${gpu.utilPct}% used`
                  : "idle — not reporting",
              ]
                .filter(Boolean)
                .join(" · ")
            : "No accelerator detected"
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
