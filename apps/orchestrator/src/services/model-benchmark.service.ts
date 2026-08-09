/**
 * WARP-836 — measured tokens/sec for a local model.
 *
 * There's no honest at-rest throughput number, so we MEASURE one: a short,
 * fixed generation with a bounded token budget, timed by this harness.
 *
 * WARP-1772 made the measurement RUNTIME-AGNOSTIC: it runs on the OpenAI
 * chat path (`/v1/chat/completions`), which both Ollama and Docker Model
 * Runner serve — the previous `/api/generate` + `eval_count`/`eval_duration`
 * form was Ollama-only (DMR 404s the endpoint and returns no native timing
 * fields on any path; verified in the WARP-1741 bench). Throughput is
 * `usage.completion_tokens / wall-clock`, one method on every runtime — the
 * same one-method-or-it-isn't-a-comparison rule the Phase-0 harness used.
 * The prompt is ~a dozen tokens, so prefill's contribution to the wall clock
 * is noise at a 96-token budget; on reasoning models the budget lands in the
 * reasoning channel, which counts toward `completion_tokens` and is exactly
 * the decode work being measured.
 *
 * This is deliberately an EXPLICIT, owner/admin action, never automatic: with
 * one resident model a benchmark of a non-resident model swaps VRAM and
 * evicts whatever chat model is loaded. The result is cached so the card can
 * show the last measurement without re-running the generation.
 */
import { createLogger } from "../lib/logger.js";

const logger = createLogger("model-benchmark");
const OLLAMA_URL =
  process.env.OLLAMA_URL ?? "http://host.docker.internal:11434";

// A tiny, deterministic prompt + a bounded token count: enough tokens for a
// stable rate reading, short enough that the generation itself is quick
// once the model is resident.
const BENCH_PROMPT = "In one sentence, describe what a computer is.";
const BENCH_MAX_TOKENS = 96;
// Generous — a cold load of a large model can take tens of seconds before the
// first token; the read timeout must survive it (mirrors OLLAMA_READ_TIMEOUT).
const BENCH_TIMEOUT_MS = 90_000;

/** Cache TTL for a measurement (7 days). A measurement is time-sensitive but
 *  stable for the same model+hardware; the user can always re-measure. */
export const BENCH_CACHE_TTL = 7 * 24 * 3600;

export interface BenchmarkResult {
  /** Wall-clock throughput, tokens/sec, one decimal place. */
  tokensPerSec: number;
  /** Tokens generated in the sample (`usage.completion_tokens`). */
  evalCount: number;
  /** Wall-clock time for the sample, ms. (Field name kept for wire
   *  compatibility with cached rows and the dashboard card.) */
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
 * Run one benchmark generation and compute tokens/sec from harness wall-clock
 * over `usage.completion_tokens`. Returns null on any failure (unreachable,
 * non-2xx, or a response missing usage) — the caller surfaces an honest
 * error, never a fabricated number.
 */
export async function benchmarkModel(
  name: string,
): Promise<BenchmarkResult | null> {
  try {
    const signal = AbortSignal.timeout(BENCH_TIMEOUT_MS);
    const startedAt = performance.now();
    const resp = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: name,
        messages: [{ role: "user", content: BENCH_PROMPT }],
        max_tokens: BENCH_MAX_TOKENS,
        stream: false,
      }),
      signal,
    });
    const elapsedMs = performance.now() - startedAt;
    if (!resp.ok) {
      await resp.json().catch(() => undefined);
      logger.debug({ model: name, status: resp.status }, "benchmark non-2xx");
      return null;
    }
    const data = (await resp.json()) as {
      usage?: { completion_tokens?: number };
    };
    const completionTokens = data.usage?.completion_tokens ?? 0;
    if (completionTokens <= 0 || elapsedMs <= 0) {
      logger.debug(
        { model: name, completionTokens, elapsedMs },
        "benchmark missing usage tokens",
      );
      return null;
    }
    const tokensPerSec =
      Math.round((completionTokens / (elapsedMs / 1000)) * 10) / 10;
    return {
      tokensPerSec,
      evalCount: completionTokens,
      evalDurationMs: Math.round(elapsedMs),
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
