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
 *   - GPU stats: null for v1 (ai-gateway `/gpu` probe is a follow-up).
 *   - Cloud spend: 0 for v1 (E2 OffLanEgressSample dependency unbuilt).
 */
import * as aiGateway from "./ai-gateway.client.js";

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
  /** Sustained tokens/sec from the most recent benchmark — null until
   *  the ai-gateway benchmark surface lands. */
  tokensPerSec: number | null;
  /** 0-100 percentage for the on-disk usage bar. Null until gbOnDisk
   *  has a value to compare against the model-store quota. */
  diskBarPct: number | null;
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
  vramGb: number;
  utilPct: number;
  tempC: number;
}

export interface ModelsPagePayload {
  local: LocalModelInfo[];
  cloud: CloudProviderInfo[];
  gpu: GpuInfo | null;
  avgLatencyMs: number;
  cloudSpendUsd: number;
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
  // A cloud-only provider failure does NOT degrade: only ollama serves
  // local models (same rule as GET /api/llm/models).
  let local: LocalModelInfo[] = [];
  let degraded = false;
  try {
    const resp = await aiGateway.listModels();
    degraded = resp.degraded_providers?.includes("ollama") ?? false;
    local = resp.models.map((m) => ({
      name: m.name,
      family: inferFamily(m.name),
      provider: m.provider,
      contextLength: m.context_window,
      gbOnDisk: null,
      role: null,
      status: "ready",
      tokensPerSec: null,
      diskBarPct: null,
    }));
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

  return {
    local,
    cloud,
    // GPU probe: ai-gateway doesn't expose one yet. Returning null is
    // documented in FEATURES.md §2.11 — the dashboard renders a
    // "GPU info unavailable" tile.
    gpu: null,
    // Avg latency: requires a metrics aggregation surface that doesn't
    // exist yet. 0 until ai-gateway exports a /metrics summary.
    avgLatencyMs: 0,
    // Cloud spend: sum over OffLanEgressSample where channel =
    // cloud_model_escape. E2 dependency; placeholder 0.
    cloudSpendUsd: 0,
    degraded,
  };
}
