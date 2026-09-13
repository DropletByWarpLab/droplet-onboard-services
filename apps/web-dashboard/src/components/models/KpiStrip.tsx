"use client";

/**
 * WARP-836 — the Models page KPI strip.
 *
 * Four read-only tiles: models in use, GPU, average latency, cloud spend.
 * WARP-2883 made the first three real: the model tile counts what the box
 * can answer with (local + enabled cloud), the GPU tile names the hardware
 * and its VRAM, and latency is a measured round-trip per inference endpoint
 * with a colour-coded quality. Cloud spend is real — $0.00 while no cloud
 * escapes are enabled. Anything unmeasured still renders an honest "—".
 */

import type { ReactNode } from "react";
import { Clock, Cloud, Cpu, HardDrive, type LucideIcon } from "lucide-react";
import type {
  EndpointLatencyMs,
  ModelsGpuInfo,
  ModelsGpuReason,
} from "@/lib/types";

interface KpiStripProps {
  gpu: ModelsGpuInfo | null;
  /** Why `gpu` is null — see `gpuFallbackMeta`. Ignored when `gpu` is set. */
  gpuReason?: ModelsGpuReason;
  /** Mean round-trip over the enabled endpoints; 0 = nothing answered. */
  avgLatencyMs: number;
  /** The per-endpoint samples behind `avgLatencyMs`; null = not asked. */
  latency?: EndpointLatencyMs | null;
  cloudSpendUsd: number;
  /** Local models installed on the box. */
  localCount: number;
  /** Cloud providers switched on AND keyed — usable from this box. */
  cloudCount: number;
}

/** Format USD with two decimals, e.g. 0 → "$0.00". */
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * WARP-2883 — latency quality bands for a reachability round-trip (a local
 * /api/tags or a cloud /v1/models, NOT a generation). A local runtime answers
 * in single-digit ms; a cloud provider in a few hundred. Anything past a
 * second means the box is waiting on its network before a single token can
 * flow, which is what the owner needs to see in red.
 */
export type LatencyQuality = "good" | "fair" | "slow";
export function latencyQuality(ms: number): LatencyQuality {
  if (ms <= 250) return "good";
  if (ms <= 1000) return "fair";
  return "slow";
}
const QUALITY_LABEL: Record<LatencyQuality, string> = {
  good: "Good",
  fair: "Fair",
  slow: "Slow",
};
const QUALITY_COLOR: Record<LatencyQuality, string> = {
  good: "var(--color-system-green)",
  fair: "var(--color-system-orange)",
  slow: "var(--color-system-red)",
};

/** "local 4 ms · anthropic 312 ms" — only the endpoints that answered. */
function latencyBreakdown(latency: EndpointLatencyMs): string {
  return (["local", "anthropic", "openai"] as const)
    .filter((k) => typeof latency[k] === "number")
    .map((k) => `${k} ${latency[k]} ms`)
    .join(" · ");
}

/**
 * The GPU tile's sub-line, one entry per counter that could actually be read.
 *
 * VRAM in use and utilisation are DIFFERENT FACTS and the operator needs
 * both: on the lab box under load the card is 97% busy while VRAM sits at
 * 83%, and "97% used" beside a 15.9 GiB total reads as "15.4 GiB consumed, no
 * room for a second model" — a conclusion the numbers don't support. So
 * compute utilisation is labelled "busy", and VRAM in use stands on its own
 * (the capacity itself sits next to the name, WARP-2883).
 *
 * GiB because the arithmetic behind the number is binary (1024³) — see
 * `bytesToGiB` in the orchestrator's lib/gpu-telemetry.ts.
 */
function gpuMeta(gpu: ModelsGpuInfo): string {
  return [
    gpu.vramUsedGiB !== null ? `${gpu.vramUsedGiB} GiB in use` : null,
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

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function KpiStrip({
  gpu,
  gpuReason,
  avgLatencyMs,
  latency = null,
  cloudSpendUsd,
  localCount,
  cloudCount,
}: KpiStripProps) {
  const modelCount = localCount + cloudCount;
  const measured = avgLatencyMs > 0;
  const quality = measured ? latencyQuality(avgLatencyMs) : null;
  const breakdown = latency ? latencyBreakdown(latency) : "";

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* Models — what the box can answer with: local models on disk plus
          each cloud provider that is switched on and keyed (WARP-2883). */}
      <KpiTile
        icon={HardDrive}
        label="Model store"
        value={plural(modelCount, "model")}
        valueMuted={modelCount === 0}
        meta={`${plural(localCount, "local model")} · ${plural(cloudCount, "cloud provider")}`}
      />

      {/* GPU — live counters via device-bridge (WARP-1861).

          The value is the hardware's marketing name with its VRAM capacity
          beside it (WARP-2883); the DRM node is the fallback when no source
          could name the card.

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
        value={
          gpu ? (
            <>
              <span
                title={gpu.name}
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "100%",
                  display: "inline-block",
                  verticalAlign: "bottom",
                }}
              >
                {gpu.name}
              </span>
              {gpu.vramGiB !== null && <small>{gpu.vramGiB} GiB</small>}
            </>
          ) : (
            "Unavailable"
          )
        }
        valueMuted={!gpu}
        meta={gpu ? gpuMeta(gpu) : gpuFallbackMeta(gpuReason)}
      />

      {/* Avg latency — a measured round-trip per enabled inference endpoint
          (WARP-2883), colour-coded by `latencyQuality`. 0 means nothing
          answered the probe, rendered as unavailable rather than "0 ms". */}
      <KpiTile
        icon={Clock}
        label="Avg latency"
        value={measured ? `${avgLatencyMs} ms` : "—"}
        valueMuted={!measured}
        meta={
          quality ? (
            <>
              <span
                className="dot"
                data-quality={quality}
                style={{ background: QUALITY_COLOR[quality] }}
                aria-hidden
              />
              {QUALITY_LABEL[quality]}
              {breakdown ? ` · ${breakdown}` : ""}
            </>
          ) : latency ? (
            "No inference endpoint answered"
          ) : (
            "Latency isn’t measured yet"
          )
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
  value: ReactNode;
  meta: ReactNode;
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
