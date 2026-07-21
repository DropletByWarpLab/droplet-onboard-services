/**
 * WARP-836 honest metrics — real per-model stats read straight from Ollama.
 *
 * ai-gateway's model list is capability-only (name/provider/context/vision).
 * The real footprint lives in Ollama's own lifecycle endpoints, which the
 * orchestrator already reaches for model-readiness (same `OLLAMA_URL`):
 *   - GET /api/tags — installed models → disk size, parameter size, quantization
 *   - GET /api/ps   — loaded models → graphics memory in use (size_vram)
 *
 * This turns the Models card's documented "—" placeholders into MEASURED
 * numbers. Honesty contract holds: any field Ollama doesn't report stays
 * null, and a probe failure yields an empty map (callers keep their "—"),
 * never a fabricated value.
 */
import { createLogger } from "../lib/logger.js";

const logger = createLogger("model-metrics");
const OLLAMA_URL =
  process.env.OLLAMA_URL ?? "http://host.docker.internal:11434";
const PROBE_BUDGET_MS = 2000;

interface OllamaTagEntry {
  name: string;
  size?: number;
  details?: { parameter_size?: string; quantization_level?: string };
}
interface OllamaPsEntry {
  name: string;
  size_vram?: number;
}

export interface LocalModelMetrics {
  /** GB on disk (decimal), or null when Ollama didn't report a size. */
  gbOnDisk: number | null;
  /** e.g. "20.9B" — parameter count as Ollama reports it. */
  parameterSize: string | null;
  /** e.g. "MXFP4" / "Q4_K_M" — quantization level. */
  quantization: string | null;
  /** True when the model is currently resident in memory (from /api/ps). */
  loaded: boolean;
  /** Graphics memory the resident model uses (GB), or null when not loaded. */
  vramGb: number | null;
}

/** Bytes → decimal GB, one decimal place; null for missing/zero. */
function bytesToGb(n: number | null | undefined): number | null {
  return typeof n === "number" && n > 0 ? Math.round(n / 1e8) / 10 : null;
}

/** Ollama sometimes reports a bare name; normalise so "gpt-oss" and
 *  "gpt-oss:latest" collate with the ai-gateway list. */
function norm(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/**
 * Best-effort snapshot of per-model metrics, keyed by normalised name.
 * Empty map on any probe failure — callers keep their honest "—".
 */
export async function fetchLocalModelMetrics(): Promise<
  Map<string, LocalModelMetrics>
> {
  const out = new Map<string, LocalModelMetrics>();
  try {
    const signal = AbortSignal.timeout(PROBE_BUDGET_MS);
    // allSettled (not all): if one endpoint rejects we still consume the
    // other's body — an undrained undici body can pin the socket.
    const [psSettled, tagsSettled] = await Promise.allSettled([
      fetch(`${OLLAMA_URL}/api/ps`, { signal }),
      fetch(`${OLLAMA_URL}/api/tags`, { signal }),
    ]);
    const psResp = psSettled.status === "fulfilled" ? psSettled.value : null;
    const tagsResp =
      tagsSettled.status === "fulfilled" ? tagsSettled.value : null;

    if (!tagsResp?.ok) {
      // Without /api/tags there's nothing to enrich. Drain a resolved /api/ps.
      await psResp?.json().catch(() => undefined);
      return out;
    }
    const tags = (await tagsResp.json()) as { models?: OllamaTagEntry[] };
    let ps: { models?: OllamaPsEntry[] } = { models: [] };
    if (psResp?.ok) {
      ps = (await psResp.json()) as { models?: OllamaPsEntry[] };
    } else {
      await psResp?.json().catch(() => undefined);
    }

    const vramByName = new Map<string, number | null>();
    for (const m of ps.models ?? []) {
      vramByName.set(norm(m.name), bytesToGb(m.size_vram));
    }
    for (const m of tags.models ?? []) {
      const key = norm(m.name);
      const isLoaded = vramByName.has(key);
      out.set(key, {
        gbOnDisk: bytesToGb(m.size),
        parameterSize: m.details?.parameter_size ?? null,
        quantization: m.details?.quantization_level ?? null,
        loaded: isLoaded,
        vramGb: isLoaded ? (vramByName.get(key) ?? null) : null,
      });
    }
  } catch (err) {
    logger.debug(
      { err: (err as Error).message, url: OLLAMA_URL },
      "model metrics probe failed (non-fatal — card keeps honest placeholders)",
    );
  }
  return out;
}

/** Look up metrics for a model name, tolerating the bare/":latest" split. */
export function metricsFor(
  metrics: Map<string, LocalModelMetrics>,
  name: string,
): LocalModelMetrics | null {
  return metrics.get(norm(name)) ?? metrics.get(name) ?? null;
}
