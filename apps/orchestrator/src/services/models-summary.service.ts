/**
 * WARP-471 Phase F3 — Models page composer.
 *
 * READ-ONLY by design (one-model rule per CLAUDE.md): never expose
 * pull/swap/escape mutations. The dashboard's §2.11 Models page
 * renders local LLMs + cloud opt-in providers + GPU stats + cloud
 * spend tracking, all in one shape.
 *
 * Composition sources:
 *   - Local list: `aiGateway.listModels()` (existing flat list).
 *   - Cloud list: static three-provider catalogue + per-provider
 *     enabled flag from `WorkspaceSetting`'s off-LAN allowlist
 *     channel (Phase E1 will own the real keys; v1 returns
 *     enabled=false for all three).
 *   - GPU stats: the host device-bridge's read-only `/gpu` (WARP-1861).
 *     Every counter degrades on its own — see `GpuInfo`.
 *   - Cloud spend: 0 for v1 (E2 OffLanEgressSample dependency unbuilt).
 */
import * as aiGateway from "./ai-gateway.client.js";
import { isLocalProvider } from "./cloud-access.service.js";
import { bytesToGiB, fetchGpuTelemetry } from "../lib/gpu-telemetry.js";
import { cacheGet } from "./cache.service.js";
import {
  fetchLocalModelMetrics,
  metricsFor,
  type MetricState,
  type ModelPlacement,
} from "./model-metrics.service.js";
import {
  benchCacheKey,
  type BenchmarkResult,
} from "./model-benchmark.service.js";

export interface LocalModelInfo {
  name: string;
  family: string;
  provider: string;
  contextLength: number | null;
  /** GB on disk — null until ai-gateway exposes per-model disk usage. */
  gbOnDisk: number | null;
  /** "chat" | "embed" | "vision" | etc — null until ai-gateway tags. */
  role: string | null;
  /** "ready" | "loading" | "error" — defaults to "ready" if the model
   *  is in the listed set. ai-gateway exposes status via a future probe. */
  status: "ready" | "loading" | "error";
  /** Sustained tokens/sec. Null until a benchmark surface exists — there is
   *  no honest source today (Ollama doesn't expose throughput at rest), so
   *  this stays "—" rather than fabricated (WARP-836 honesty contract). */
  tokensPerSec: number | null;
  /** 0-100 percentage for the on-disk usage bar — this model's share of the
   *  model store. Null until real disk sizes are known (WARP-836). */
  diskBarPct: number | null;
  // ── WARP-836 honest metrics, measured from the inference daemon ──
  /** Parameter count as the daemon reports it, e.g. "20.9B". Null when unknown. */
  parameterSize?: string | null;
  /** Quantization level, e.g. "MXFP4" / "Q4_K_M". Null when unknown. */
  quantization?: string | null;
  /** True when the model is currently resident in memory (/api/ps). */
  loaded?: boolean;
  /** Graphics memory the resident model uses (GB), or null when unmeasured. */
  vramGb?: number | null;
  // ── WARP-1749 honesty, part two: WHY a number is missing ──────────────
  // A null used to mean three different things at once. These say which,
  // so the page can print "—" where a value may yet arrive and an explicit
  // "this runtime doesn't report it" where one never will. Optional +
  // additive: an older dashboard ignores them and renders exactly as before.
  /** Why `gbOnDisk` is null, when it is. */
  gbOnDiskState?: MetricState;
  /** Why `vramGb` is null, when it is. `unsupported` on a DMR box: its
   *  /api/ps never populates `size_vram` on any accelerator. */
  vramState?: MetricState;
  /** ISO timestamp of the last on-demand throughput benchmark (drives
   *  `tokensPerSec`), or null when never measured. */
  benchmarkedAt?: string | null;
  // ── WARP-1827 placement of a LOADED model (additive/optional) ─────────
  // The UI mirror of the appliance-side placement verdict (inference-manager
  // /health.placement, WARP-1825) — same min(1, size_vram/size) arithmetic,
  // same 0.9 GPU threshold, so the two surfaces can never disagree.
  /** min(1, size_vram/size), 3 decimals, or null when unknowable. */
  gpuFraction?: number | null;
  /** "gpu" / "partial" / "cpu"; null when not loaded or inputs absent. */
  placement?: ModelPlacement | null;
  /** Why `placement` is null, when it is; null itself for an unloaded row. */
  placementState?: MetricState | null;
}

export interface CloudProviderInfo {
  provider: "anthropic" | "openai" | "gemini";
  /** From `OffLanAllowlistChannel.cloud_model_escape` once Phase E1
   *  lands. Today: always false (cloud escape default-off per
   *  FEATURES.md §8). */
  enabled: boolean;
  /** ISO timestamp of last cloud-escape call, or null. */
  lastUsedAt: string | null;
  /** Cumulative spend this billing period; 0 until E2 wires
   *  `OffLanEgressSample` aggregation. */
  spendUsd: number;
}

export interface GpuInfo {
  name: string;
  // WARP-1861: EVERY counter is nullable, because the bridge legitimately
  // cannot always read each one and they fail independently. When nothing
  // holds the card, amdgpu runtime-SUSPENDS it and the sysfs reads return
  // EBUSY rather than a number — so on an idle appliance that is the common
  // case, not an edge case. `0` would be a lie a threshold check would
  // happily pass.
  //
  // GiB, not GB, and named for it: the bridge reports raw bytes and the
  // conversion is binary (see lib/gpu-telemetry.ts::bytesToGiB), which is how
  // VRAM is actually sized. The tile labels it "GiB" to match.
  /** Total VRAM. Null on a BRIDGE_GPU_CARD-pinned node whose
   *  mem_info_vram_total is unreadable — the card is still present. */
  vramGiB: number | null;
  /** VRAM currently in use, so the tile can show pressure as well as size —
   *  utilisation is a COMPUTE figure and says nothing about how full the
   *  card is. */
  vramUsedGiB: number | null;
  utilPct: number | null;
  tempC: number | null;
}

/**
 * WARP-1861 — why `gpu` is null, when it is.
 *
 * `null` is not a measurement, and neither is a failed probe. Two facts hide
 * behind an absent GPU block and only one of them is a statement about the
 * customer's hardware:
 *
 *   - `no_card`    the bridge ANSWERED and resolved no card (`available:false`
 *                  plus a reason). A negative measurement — safe to state.
 *   - `unreachable` we could not ask at all. `fetchGpuTelemetry()` returns null
 *                  for no token, ECONNREFUSED, timeout, non-2xx and a
 *                  malformed body alike. That is a fact about the PROBE.
 *
 * Collapsing the second into the first is how a box with a working 16 GiB dGPU
 * ends up telling its owner "No accelerator detected" because
 * droplet-device-bridge.service didn't restart after a refresh (WARP-1829) or
 * a setup.sh re-run dropped SERVICE_TOKEN_DISPLAY (WARP-1865).
 * GET /api/hardware/gpu already keeps them apart for the LLM tool; the
 * dashboard payload has to as well.
 */
export type GpuReason = "unreachable" | "no_card";

export interface ModelsPagePayload {
  local: LocalModelInfo[];
  cloud: CloudProviderInfo[];
  gpu: GpuInfo | null;
  /** Why `gpu` is null. Null when `gpu` is populated. */
  gpuReason: GpuReason | null;
  avgLatencyMs: number;
  cloudSpendUsd: number;
  /**
   * WARP-1112 — the installed local model the box answers with by default
   * (the `ai.model.chat` setting), or null when unset / the stored tag is
   * no longer installed. Set by the /api/models route (merged fresh, not
   * part of the cached payload), never fabricated here.
   */
  activeModel?: string | null;
  /**
   * WARP-1289 — honesty flag, mirroring WARP-1284's `degraded` on
   * GET /api/llm/models: true when `local` can't be trusted as complete
   * because the ai-gateway was unreachable OR the gateway reported its
   * local Ollama provider raised during the listing fan-out
   * (`degraded_providers`). An empty `local` WITH `degraded` means
   * "can't reach the AI service right now", NOT "no model pulled yet" —
   * the Models page renders the two differently.
   */
  degraded: boolean;
}

/**
 * Best-effort family inference from a model name (`gpt-oss:20b` →
 * `gpt-oss`, `llama3.1:70b` → `llama`). Cheap; ai-gateway will own
 * the real taxonomy when it adds a `/families` endpoint.
 */
function inferFamily(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("llama")) return "llama";
  if (lower.includes("gpt-oss")) return "gpt-oss";
  if (lower.includes("qwen")) return "qwen";
  if (lower.includes("mistral")) return "mistral";
  if (lower.includes("phi")) return "phi";
  if (lower.includes("gemma")) return "gemma";
  if (lower.includes("nomic")) return "nomic";
  // Default: first segment before any size/version suffix.
  return lower.split(/[:\-]/)[0] ?? lower;
}

export async function getModelsPagePayload(): Promise<ModelsPagePayload> {
  // Local list — best-effort. If ai-gateway is unavailable we still
  // render the page (empty local list + the cloud placeholders) so the
  // dashboard doesn't dead-end on the Models tab during an outage.
  //
  // WARP-1289: but never SILENTLY — an unreachable gateway (or a gateway
  // whose local Ollama provider raised during the listing fan-out, per
  // WARP-1284's `degraded_providers`) sets `degraded: true` so the page
  // can say "can't reach your AI service" instead of "no local models".
  // A cloud-only provider failure does NOT degrade: only the on-box
  // provider serves local models (same rule as GET /api/llm/models).
  // WARP-1926: match on the LOCAL_PROVIDERS accept-set, not the literal
  // `ollama` — the gateway emits `local` now, and a stale literal here
  // silently reports "not degraded" while the AI service is down.
  let local: LocalModelInfo[] = [];
  let degraded = false;
  try {
    const resp = await aiGateway.listModels();
    degraded = resp.degraded_providers?.some(isLocalProvider) ?? false;
    local = resp.models.map((m) => ({
      name: m.name,
      family: inferFamily(m.name),
      provider: m.provider,
      contextLength: m.context_window,
      gbOnDisk: null,
      role: null,
      status: "ready" as const,
      tokensPerSec: null,
      diskBarPct: null,
      parameterSize: null,
      quantization: null,
      loaded: false,
      vramGb: null,
      // Nothing has been probed yet at this point in the compose. "unreported"
      // is the truthful starting state: we have not asked the daemon, so we
      // cannot claim either a number or that one is impossible.
      gbOnDiskState: "unreported" as MetricState,
      vramState: "unreported" as MetricState,
      // Placement is only ever a claim about a probed, LOADED model — the
      // truthful starting state is "no claim at all" (WARP-1827).
      gpuFraction: null,
      placement: null,
      placementState: null,
    }));

    // WARP-836 — enrich local (ollama) rows with real daemon metrics: disk
    // size, parameter count, quantization, and resident/VRAM. Best-effort:
    // if the probe fails the rows keep their honest null placeholders ("—"),
    // never a fabricated number. A single extra call, behind the route's 30s
    // cache. (Cloud rows have no local footprint — left untouched.)
    try {
      const metrics = await fetchLocalModelMetrics();
      if (metrics.size > 0) {
        for (const row of local) {
          if (!isLocalProvider(row.provider)) continue;
          const m = metricsFor(metrics, row.name);
          if (!m) continue;
          row.gbOnDisk = m.gbOnDisk;
          row.parameterSize = m.parameterSize;
          row.quantization = m.quantization;
          row.loaded = m.loaded;
          row.vramGb = m.vramGb;
          // Carry the reason through. The `??` fallback keeps this tolerant of
          // a metrics object from before WARP-1749 (or a partial test double):
          // a number present means it was measured, otherwise we don't know
          // why it's missing, which is exactly "unreported".
          row.gbOnDiskState =
            m.gbOnDiskState ?? (m.gbOnDisk != null ? "measured" : "unreported");
          row.vramState =
            m.vramState ?? (m.vramGb != null ? "measured" : "unreported");
          // WARP-1827 placement — additive; `?? null` keeps this tolerant of
          // a metrics object from before the field existed (or a partial test
          // double): no claim survives that the probe didn't actually make.
          row.gpuFraction = m.gpuFraction ?? null;
          row.placement = m.placement ?? null;
          row.placementState = m.placementState ?? null;
        }
        // Disk bar = each model's share of the total on-disk model store.
        //
        // WARP-1749: a "share of the store" is only meaningful when the WHOLE
        // store is known. On a runtime that reports a size for some models and
        // not others (DMR gives one only for models its native listing knows),
        // dividing by a partial total inflates every bar — a 2 GB model would
        // render as 100% of a store it is a tenth of. Rather than draw a
        // confidently wrong bar we draw none, and the card says the usage
        // breakdown isn't available. Ollama reports every size, so this
        // condition is always true there and the bars are unchanged.
        const localRows = local.filter((r) => isLocalProvider(r.provider));
        const everySizeKnown =
          localRows.length > 0 && localRows.every((r) => r.gbOnDisk != null);
        const totalGb = localRows.reduce((s, r) => s + (r.gbOnDisk ?? 0), 0);
        if (everySizeKnown && totalGb > 0) {
          for (const row of localRows) {
            row.diskBarPct = Math.round(((row.gbOnDisk ?? 0) / totalGb) * 100);
          }
        }
      }
    } catch {
      // Metrics are a best-effort enrichment — never fail the page for them.
    }

    // WARP-836 — surface the last MEASURED throughput (tokens/sec) from the
    // benchmark cache. We only READ a prior on-demand measurement here; never
    // auto-run a benchmark on a page load (it would load/evict models).
    try {
      for (const row of local) {
        if (!isLocalProvider(row.provider)) continue;
        const bench = await cacheGet<BenchmarkResult>(benchCacheKey(row.name));
        if (bench) {
          row.tokensPerSec = bench.tokensPerSec;
          row.benchmarkedAt = bench.measuredAt;
        }
      }
    } catch {
      // Cache miss / no Redis — tok/s stays "—" until the user measures.
    }
  } catch {
    local = [];
    degraded = true;
  }

  // Cloud list — three providers per FEATURES.md §2.11. All
  // default-off; Phase E1 wires real enabled flags via OffLan
  // allowlist channel state.
  const cloud: CloudProviderInfo[] = [
    { provider: "anthropic", enabled: false, lastUsedAt: null, spendUsd: 0 },
    { provider: "openai", enabled: false, lastUsedAt: null, spendUsd: 0 },
    { provider: "gemini", enabled: false, lastUsedAt: null, spendUsd: 0 },
  ];

  // WARP-1861 — GPU counters via the host device-bridge. Never throws;
  // an absent bridge or an unresolvable card yields null, which the tile
  // already renders as "Unavailable".
  const telemetry = await fetchGpuTelemetry();
  // A CARD, not a complete reading, is what decides whether there is a tile.
  // Requiring a VRAM total here would drop the whole tile over one unreadable
  // field: with BRIDGE_GPU_CARD pinned, device-bridge returns the pinned node
  // WITHOUT reading mem_info_vram_total, so a card sitting at 97% and 62°C can
  // legitimately report a null total — and the page would have said "No
  // accelerator detected" over a GPU that is present and actively reporting.
  // Each counter degrades on its own instead; the tile omits what it lacks.
  const gpu: GpuInfo | null =
    telemetry?.available && telemetry.card
      ? {
          // The DRM node name is what the operator can act on — it is the
          // same identifier BRIDGE_GPU_CARD pins and the same one that
          // appears in the flip script's resolver.
          name: telemetry.card,
          vramGiB: bytesToGiB(telemetry.vramTotalBytes),
          vramUsedGiB: bytesToGiB(telemetry.vramUsedBytes),
          // Nullable by design: a runtime-suspended card reports neither,
          // and 0% on a card nothing can currently read would be a lie.
          utilPct: telemetry.busyPercent,
          tempC: telemetry.tempC,
        }
      : null;
  // Carry WHY, not just the absence. `telemetry === null` means the probe
  // never completed — no token, bridge down, timeout, non-2xx, bad body —
  // which is evidence about us, not about the customer's hardware. Only a
  // bridge that answered gets to have its "no card" repeated as a fact.
  const gpuReason: GpuReason | null =
    gpu !== null ? null : telemetry === null ? "unreachable" : "no_card";

  return {
    local,
    cloud,
    // WARP-1861 — real GPU counters, from the host device-bridge.
    //
    // The note that used to sit here planned an ai-gateway `/gpu` probe. That
    // would have been drift: ai-gateway is a thin provider router, and the
    // handbook bans the orchestrator from reading /dev/dri itself (see the
    // header of hardware-summary.service.ts). device-bridge is the
    // host-privileged surface that already exists for exactly this, behind
    // the same token.
    //
    // Still null when the bridge is absent or no card resolves — it is
    // profile-gated, so "not running" is ordinary — and the dashboard's
    // existing "GPU info unavailable" tile stays the honest fallback rather
    // than a fabricated zero.
    gpu,
    // ...and WHY it is null, so the tile can tell "we asked and there is no
    // card" apart from "we never got to ask". See `GpuReason`.
    gpuReason,
    // Avg latency: requires a metrics aggregation surface that doesn't
    // exist yet. 0 until ai-gateway exports a /metrics summary.
    avgLatencyMs: 0,
    // Cloud spend: sum over OffLanEgressSample where channel =
    // cloud_model_escape. E2 dependency; placeholder 0.
    cloudSpendUsd: 0,
    degraded,
  };
}
