"use client";

/**
 * WARP-836 — one local LLM card on the Models page (rendered 2-up).
 *
 * Informational card. Metrics are measured from the box's inference daemon
 * (disk size, parameter count, quantization, resident/graphics-memory) — see
 * model-metrics.service. Throughput (tokens/sec) has no at-rest source, so
 * owners/admins MEASURE it on demand (WARP-836): the "Measure speed" button
 * runs a short benchmark and the result is cached. Anything unmeasured renders
 * an honest "—", never fabricated. The status chip maps the backend lifecycle
 * enum to home-user language: ready → "running", loading → "loading",
 * error → "error".
 *
 * WARP-1749 — a dash alone under-explains. Each metric now arrives with a
 * `MetricState` saying WHY it has no number, and the card spends that state on
 * the tooltip: a value the runtime simply didn't report this poll reads
 * differently from one it can never report (Docker Model Runner cannot report
 * per-model graphics memory at all — its /api/ps has no such field). The value
 * itself is unchanged: still "—", still never a fabricated 0.
 *
 * WARP-1827 — placement surfacing: when the box reports a LOADED model is
 * running on the CPU ("cpu") or only partly on the GPU ("partial"), the card
 * shows a warning badge. Only those two explicit states warn — a "gpu"
 * placement is quiet, and a null/absent placement renders nothing (absence of
 * data is not a health signal).
 */

import { useState } from "react";
import {
  BookOpen,
  Cpu,
  Gauge,
  HardDrive,
  Layers,
  Loader2,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/shell/primitives";
import { benchmarkModel } from "@/lib/api";
import type { LocalModelRow } from "@/lib/types";

const DASH = "—";

/**
 * WARP-1749 — resolve the honesty state of one metric.
 *
 * `?? …` keeps the card working against an orchestrator that predates the
 * field: a number present means it was measured, and its absence means we
 * don't know why — which is exactly "unreported", the state whose copy matches
 * what this card said before the flag existed. Nothing about an Ollama box's
 * rendering moves.
 */
function stateOf(
  state: "measured" | "unreported" | "unsupported" | undefined,
  value: number | null | undefined,
): "measured" | "unreported" | "unsupported" {
  return state ?? (value != null ? "measured" : "unreported");
}

/** Humanise a context window: 131072 → "128k", 8192 → "8k", small → exact. */
function formatContext(tokens: number | null): string {
  if (tokens == null) return DASH;
  if (tokens >= 1000) {
    const k = tokens / 1024;
    // Show "128k" for clean powers, otherwise one decimal ("65.5k").
    const rounded = Number.isInteger(k) ? String(k) : k.toFixed(1);
    return `${rounded}k`;
  }
  return String(tokens);
}

/** Visual mapping for each lifecycle status. `label` is the home-user word. */
const STATUS_META: Record<
  LocalModelRow["status"],
  { label: string; dot: string; text: string; tint: string }
> = {
  ready: {
    label: "running",
    dot: "bg-system-green",
    text: "text-system-green",
    tint: "bg-system-green/15",
  },
  loading: {
    label: "loading",
    dot: "bg-system-orange",
    text: "text-system-orange",
    tint: "bg-system-orange/15",
  },
  error: {
    label: "error",
    dot: "bg-system-red",
    text: "text-system-red",
    tint: "bg-system-red/15",
  },
};

export function LocalModelCard({
  model,
  canManage = false,
  onBenchmarked,
}: {
  model: LocalModelRow;
  /** Owner/admin — only they can measure throughput. */
  canManage?: boolean;
  /** Called after a successful measurement so the page can refresh. */
  onBenchmarked?: () => void;
}) {
  const status = STATUS_META[model.status];
  const diskState = stateOf(model.gbOnDiskState, model.gbOnDisk);
  const vramState = stateOf(model.vramState, model.vramGb);
  // WARP-1827 — only an EXPLICIT degraded placement warns. "gpu" is quiet,
  // and null/absent (not loaded, or a runtime that can't say) shows nothing:
  // absence of data is not a health signal.
  const placementWarning =
    model.placement === "cpu"
      ? "Running on CPU"
      : model.placement === "partial"
        ? "Partially on GPU"
        : null;
  const gb = model.gbOnDisk != null ? `${model.gbOnDisk} GB` : DASH;
  // Tooltips carry the explanation; the visible value stays "—" so the stat row
  // reads the same at a glance. "unsupported" is the one worth spelling out —
  // it means no amount of waiting or refreshing will fill this in.
  const gbTitle =
    diskState === "measured"
      ? "On disk"
      : diskState === "unsupported"
        ? "On disk — this box’s AI runtime doesn’t report model file sizes"
        : "On disk — not reported for this model";
  // Parameter count · quantization, e.g. "20.9B · MXFP4". DASH when neither
  // is known (metrics probe missed this model).
  const spec =
    [model.parameterSize, model.quantization].filter(Boolean).join(" · ") ||
    DASH;
  // Resident state — honest three-way: in memory (real VRAM) / on disk /
  // unknown. "on disk" is only claimed when the metrics probe actually saw this
  // model, so we never assert "not loaded" from a failed probe.
  //
  // WARP-1749: a known size used to be the only proxy for "the probe saw it".
  // `unsupported` is a second, stronger one — that state is only ever set while
  // reading a model OUT of the installed listing, so the model is on disk even
  // though its size isn't knowable. Without this the DMR case degrades to a
  // bare "—" for a model we can see is installed. (Ollama never produces
  // `unsupported`, so nothing here moves on the default path.)
  const resident = model.loaded
    ? model.vramGb != null
      ? `${model.vramGb} GB in memory`
      : "in memory"
    : model.gbOnDisk != null || diskState === "unsupported"
      ? "on disk"
      : DASH;
  // Only the loaded-but-no-number case needs explaining: the model IS resident,
  // yet we're showing no figure next to it. Say whose limitation that is.
  const residentTitle =
    model.loaded && vramState === "unsupported"
      ? "In memory — this box’s AI runtime doesn’t report per-model graphics memory"
      : model.loaded && vramState === "unreported"
        ? "In memory — graphics memory use wasn’t reported for this model"
        : "Graphics memory in use";
  const hasMeter = model.diskBarPct != null;

  // Throughput — measured on demand (WARP-836). `localTps` shows the just-
  // measured value immediately even if the page payload hasn't refreshed yet
  // (or Redis is unavailable to cache it).
  const [measuring, setMeasuring] = useState(false);
  const [localTps, setLocalTps] = useState<number | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);
  const tps = localTps ?? model.tokensPerSec;
  const speed = tps != null ? `${tps} tok/s` : "not measured";

  async function measure() {
    if (measuring) return;
    setMeasuring(true);
    setBenchError(null);
    try {
      const { tokensPerSec } = await benchmarkModel(model.name);
      setLocalTps(tokensPerSec);
      onBenchmarked?.();
    } catch (e) {
      setBenchError(
        e instanceof Error ? e.message : "Couldn’t measure speed. Try again.",
      );
    } finally {
      setMeasuring(false);
    }
  }

  return (
    <div className="card flex flex-col gap-3.5" style={{ padding: "16px" }}>
      {/* Header: glyph · name + family · status chip */}
      <div className="flex items-start gap-2.5">
        <span
          className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
          aria-hidden
        >
          <Cpu size={18} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="type-subheadline font-medium truncate" style={{ color: "var(--text)" }}>
            {model.name}
          </h3>
          <p className="type-caption-1 truncate" style={{ color: "var(--text-muted)" }}>
            {model.family}
            {model.role ? ` · ${model.role}` : ""}
          </p>
        </div>
        {placementWarning && <Badge kind="warn">{placementWarning}</Badge>}
        <span
          className={`
            inline-flex items-center gap-1.5 h-6 px-2 rounded-full
            type-caption-2 font-medium ${status.tint}
          `}
          style={{ color: "var(--text)" }}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} aria-hidden />
          {status.label}
        </span>
      </div>

      {/* On-disk usage meter — only when the backend reports a percentage.
          Otherwise we say so plainly rather than draw an empty/zero bar. */}
      {hasMeter ? (
        <div
          className="h-1.5 rounded-full overflow-hidden bg-[var(--inset)]"
          role="progressbar"
          aria-label="On-disk usage"
          aria-valuenow={model.diskBarPct ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-[var(--brand)]"
            style={{ width: `${Math.min(100, Math.max(0, model.diskBarPct!))}%` }}
          />
        </div>
      ) : (
        <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>
          {/* "not available yet" implies it's coming. When the runtime has no
              way to report sizes it isn't coming, so say the true thing. */}
          {diskState === "unsupported"
            ? "On-disk usage isn’t reported by this box’s AI runtime"
            : "On-disk usage not available yet"}
        </p>
      )}

      {/* Foot stats — measured from the box's inference daemon: disk size ·
          parameters/quant · context window · resident graphics memory. Each is
          honest about missing data ("—", with a tooltip saying why); the
          trailing "local-only" is always true. */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1.5 type-caption-1"
        style={{ color: "var(--text-muted)" }}
      >
        <span className="inline-flex items-center gap-1" title={gbTitle}>
          <HardDrive size={12} strokeWidth={2} aria-hidden />
          <span className="tabular-nums">{gb}</span>
        </span>
        <span className="inline-flex items-center gap-1" title="Parameters · quantization">
          <Layers size={12} strokeWidth={2} aria-hidden />
          <span className="tabular-nums">{spec}</span>
        </span>
        <span className="inline-flex items-center gap-1" title="Context window">
          <BookOpen size={12} strokeWidth={2} aria-hidden />
          <span className="tabular-nums">ctx {formatContext(model.contextLength)}</span>
        </span>
        <span
          className="inline-flex items-center gap-1"
          title={residentTitle}
          style={{
            color: model.loaded
              ? "var(--system-green, #34c759)"
              : "var(--text-muted)",
          }}
        >
          <Gauge size={12} strokeWidth={2} aria-hidden />
          <span className="tabular-nums">{resident}</span>
        </span>
        <span className="inline-flex items-center gap-1 ml-auto" style={{ color: "var(--text-muted)" }}>
          <ShieldCheck size={12} strokeWidth={2} aria-hidden />
          local-only
        </span>
      </div>

      {/* Throughput — no honest at-rest source, so it's MEASURED on demand.
          Owners/admins get a button; everyone sees the last measurement. */}
      <div className="flex items-center gap-2 type-caption-1" style={{ color: "var(--text-muted)" }}>
        <span className="inline-flex items-center gap-1" title="Generation speed">
          <Zap size={12} strokeWidth={2} aria-hidden />
          <span className="tabular-nums">{speed}</span>
        </span>
        {canManage && (
          <button
            type="button"
            onClick={measure}
            disabled={measuring}
            className="type-caption-1 font-medium"
            style={{
              color: measuring ? "var(--text-muted)" : "var(--brand)",
              cursor: measuring ? "progress" : "pointer",
            }}
          >
            {measuring ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" aria-hidden />
                Measuring…
              </span>
            ) : tps != null ? (
              "Re-measure"
            ) : (
              "Measure speed"
            )}
          </button>
        )}
      </div>
      {benchError && (
        <p
          className="type-caption-2"
          role="alert"
          style={{ color: "var(--system-red, #ff3b30)" }}
        >
          {benchError}
        </p>
      )}
    </div>
  );
}
