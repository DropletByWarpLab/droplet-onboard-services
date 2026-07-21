/**
 * WARP-836 — measured tokens/sec for a local model.
 *
 * There's no honest at-rest throughput number, so we MEASURE one: a short,
 * fixed generation against Ollama's own /api/generate, reading its reported
 * `eval_count` / `eval_duration` (decode-only timing — the real tok/s, not a
 * wall-clock estimate polluted by network or tool loops).
 *
 * This is deliberately an EXPLICIT, owner/admin action, never automatic: with
 * OLLAMA_MAX_LOADED_MODELS=1 a benchmark of a non-resident model swaps VRAM and
 * evicts whatever chat model is loaded. The result is cached so the card can
 * show the last measurement without re-running the generation.
 */
import { createLogger } from "../lib/logger.js";

const logger = createLogger("model-benchmark");
const OLLAMA_URL =
  process.env.OLLAMA_URL ?? "http://host.docker.internal:11434";

// A tiny, deterministic prompt + a bounded token count: enough tokens for a
// stable decode-rate reading, short enough that the generation itself is quick
// once the model is resident.
const BENCH_PROMPT = "In one sentence, describe what a computer is.";
const BENCH_NUM_PREDICT = 96;
// Generous — a cold load of a large model can take tens of seconds before the
// first token; the read timeout must survive it (mirrors OLLAMA_READ_TIMEOUT).
const BENCH_TIMEOUT_MS = 90_000;

/** Cache TTL for a measurement (7 days). A measurement is time-sensitive but
 *  stable for the same model+hardware; the user can always re-measure. */
export const BENCH_CACHE_TTL = 7 * 24 * 3600;

export interface BenchmarkResult {
  /** Decode throughput, tokens/sec, one decimal place. */
  tokensPerSec: number;
  /** Tokens generated in the sample (Ollama `eval_count`). */
  evalCount: number;
  /** Decode time for the sample, ms (Ollama `eval_duration` / 1e6). */
  evalDurationMs: number;
  /** ISO timestamp the measurement was taken. */
  measuredAt: string;
}

/** Cache key for a model's last benchmark, normalised to match the ai-gateway
 *  / metrics naming (bare "gpt-oss" ⇄ "gpt-oss:latest"). */
export function benchCacheKey(name: string): string {
  const norm = name.includes(":") ? name : `${name}:latest`;
  return `models:bench:${norm}`;
}

/**
 * Run one benchmark generation and compute tokens/sec from Ollama's own
 * decode timing. Returns null on any failure (unreachable, non-2xx, or a
 * response missing eval timing) — the caller surfaces an honest error, never
 * a fabricated number.
 */
export async function benchmarkModel(
  name: string,
): Promise<BenchmarkResult | null> {
  try {
    const signal = AbortSignal.timeout(BENCH_TIMEOUT_MS);
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: name,
        prompt: BENCH_PROMPT,
        stream: false,
        options: { num_predict: BENCH_NUM_PREDICT },
      }),
      signal,
    });
    if (!resp.ok) {
      await resp.json().catch(() => undefined);
      logger.debug({ model: name, status: resp.status }, "benchmark non-2xx");
      return null;
    }
    const data = (await resp.json()) as {
      eval_count?: number;
      eval_duration?: number;
    };
    const evalCount = data.eval_count ?? 0;
    const evalDuration = data.eval_duration ?? 0; // nanoseconds
    if (evalCount <= 0 || evalDuration <= 0) {
      logger.debug(
        { model: name, evalCount, evalDuration },
        "benchmark missing eval timing",
      );
      return null;
    }
    const tokensPerSec =
      Math.round((evalCount / (evalDuration / 1e9)) * 10) / 10;
    return {
      tokensPerSec,
      evalCount,
      evalDurationMs: Math.round(evalDuration / 1e6),
      measuredAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.debug(
      { err: (err as Error).message, model: name },
      "benchmark failed (non-fatal — card keeps its honest placeholder)",
    );
    return null;
  }
}
