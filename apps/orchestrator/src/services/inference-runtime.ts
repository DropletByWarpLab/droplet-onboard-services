/**
 * inference-runtime.ts — which local inference backend this box runs, and the
 * small amount of parsing that only the non-default backend needs.
 *
 * WARP-1749 (ADR-005 §1). The appliance can serve local models from either
 * Ollama (the default, unchanged) or Docker Model Runner ("DMR"). ONE env var
 * selects it — `INFERENCE_RUNTIME` — the same word that selects the backend in
 * droplet-local-LLM's `ollama-manager` runtime adapter and that switches on
 * ai-gateway's static capability table. A box therefore cannot end up
 * half-migrated: either everything reads `dmr` or nothing does.
 *
 * Nothing in this module changes what an Ollama box does. `inferenceRuntime()`
 * answers "ollama" for an unset/empty value, and every DMR-only code path in
 * the orchestrator is gated on an explicit `=== "dmr"`.
 *
 * Why the orchestrator needs its own copy of this knowledge
 * --------------------------------------------------------
 * The orchestrator talks to the daemon directly for two lifecycle concerns the
 * ollama-manager sidecar does not own: the Models page's honest metrics
 * (`model-metrics.service.ts`) and first-boot model readiness
 * (`model-readiness.service.ts`). Both need to know when a MISSING number is
 * structural rather than transient — see `MetricState` in model-metrics.
 *
 * Unknown values
 * --------------
 * `ollama-manager` treats an unrecognised `INFERENCE_RUNTIME` as FATAL
 * (WARP-1743), so a box with a typo never finishes booting and this module
 * never has to make that call. Its only job here is the narrower one: never
 * claim DMR semantics for a value it does not recognise. It logs once and
 * falls back to the default backend's behaviour — which is also today's
 * behaviour, so an unrecognised value cannot regress an Ollama box.
 */
import { createLogger } from "../lib/logger.js";

const logger = createLogger("inference-runtime");

/** The backends this repo knows how to talk to. */
export type InferenceRuntimeName = "ollama" | "dmr";

/** Warn once per process about an unrecognised value — this is read on every
 *  metrics probe and we don't want a log line per page load. */
let warnedUnknownRuntime = false;

/** Exported for testing: lets a test re-arm the once-only unknown-value warn. */
export function resetRuntimeWarnForTests(): void {
  warnedUnknownRuntime = false;
}

/**
 * The configured backend. Read from the environment on every call (not cached
 * at module load) so tests can `vi.stubEnv` it and so a restarted container
 * always reflects the current `.env` rather than a stale import-time snapshot.
 */
export function inferenceRuntime(): InferenceRuntimeName {
  const raw = (process.env.INFERENCE_RUNTIME ?? "").trim().toLowerCase();
  if (raw === "" || raw === "ollama") return "ollama";
  if (raw === "dmr") return "dmr";
  if (!warnedUnknownRuntime) {
    warnedUnknownRuntime = true;
    logger.error(
      { INFERENCE_RUNTIME: raw },
      "unknown INFERENCE_RUNTIME — using the default (ollama) wire behaviour; ollama-manager treats this as fatal, so this box is misconfigured",
    );
  }
  return "ollama";
}

/** True only for an explicit `INFERENCE_RUNTIME=dmr`. Every DMR-only branch in
 *  the orchestrator goes through this so the Ollama path stays untouched. */
export function isDmrRuntime(): boolean {
  return inferenceRuntime() === "dmr";
}

/**
 * Base URL of the inference daemon's management API.
 *
 * Same precedence as the merged runtime adapter: `INFERENCE_RUNTIME_URL` wins,
 * `OLLAMA_URL` is the fallback so an existing box keeps working after the flip
 * without a second variable. Used ONLY by DMR-only probes — the Ollama-shaped
 * endpoints (`/api/tags`, `/api/ps`, `/api/pull`) keep reading the `OLLAMA_URL`
 * constants their modules already captured, so nothing moves on the default
 * path.
 */
export function inferenceRuntimeUrl(): string {
  const explicit = (process.env.INFERENCE_RUNTIME_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const legacy = (process.env.OLLAMA_URL ?? "").trim();
  if (legacy) return legacy.replace(/\/+$/, "");
  return "http://host.docker.internal:11434";
}

// ──────────────────────────────────────────────────────────────────────
// Human size strings
//
// MEASURED (2026-08-05, docker/model-runner:v1.2.6): DMR's ollama-compatible
// `GET /api/tags` reports `size: 0` for every model, always. The only place a
// real per-model file size exists is the NATIVE `GET /models`, which reports it
// as a HUMAN STRING — `config.size = "256.35 MiB"`. That string is the input
// this parser exists for.
//
// A string we cannot parse is UNKNOWN, never zero (WARP-836 honesty contract).
// ──────────────────────────────────────────────────────────────────────

/** Decimal (SI) and binary (IEC) multipliers, keyed lower-case. */
const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/**
 * Parse a human size string into bytes. `"256.35 MiB"` → 268807147.
 *
 * Deliberately strict: one number, one known unit, nothing else. Anything the
 * grammar doesn't cover — an empty string, a bare number with no unit, a unit
 * we don't know, a negative value, `"unknown"` — returns null, which callers
 * MUST render as unknown rather than substituting 0. Returning a plausible
 * number for an unparsed string is exactly the failure mode this whole ticket
 * is about.
 *
 * Note 0 IS parsed (`"0 B"` → 0). Whether zero is a believable measurement is
 * the caller's judgement, not the parser's — for a model file on disk it is
 * not, and model-metrics.service treats it as unknown.
 */
export function parseHumanSizeBytes(input: unknown): number | null {
  if (typeof input !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(input);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = SIZE_UNITS[m[2]!.toLowerCase()];
  if (unit === undefined) return null;
  return value * unit;
}

// ──────────────────────────────────────────────────────────────────────
// OCI reference folding
//
// DMR reports FULLY QUALIFIED ids — `docker.io/ai/smollm2:latest` — from
// `/api/tags` and `/api/ps` (verified live 2026-08-05). Its native `GET
// /models` is the only source of a real file size, so the two listings have to
// be joined on a key both vocabularies reduce to.
//
// This is the TypeScript half of `_normalize_oci_reference()` in
// droplet-local-LLM's `runtime/dmr.py` (WARP-1743) and follows the same two
// rules: drop a leading registry host, and drop only the implicit `:latest`
// tag. A meaningful tag (`ai/smollm2:360M-Q4_K_M` selects a quantization) is
// KEPT, because two builds of one repository are two different files with two
// different sizes.
// ──────────────────────────────────────────────────────────────────────

/** OCI's implicit default tag — carries no selection information. */
const IMPLICIT_TAG = "latest";

/**
 * Reduce an OCI-ish model reference to the form we join on.
 *
 *   `docker.io/ai/smollm2:latest`  → `ai/smollm2`
 *   `ai/smollm2:360M-Q4_K_M`       → `ai/smollm2:360M-Q4_K_M`   (tag kept)
 *   `ai/smollm2`                   → `ai/smollm2`               (idempotent)
 *   `gpt-oss:20b`                  → `gpt-oss:20b`              (untouched)
 *
 * A first segment containing a `.` or a `:` (a port), or the literal
 * `localhost`, is a registry host — the OCI distribution spec's own rule.
 * The tag is only ever split off the LAST segment, so `localhost:5000/ai/x`
 * never mistakes the port for a tag. References deeper than three segments are
 * left alone rather than guessed at.
 */
export function normalizeModelReference(reference: string): string {
  let segments = reference.split("/").filter(Boolean);
  if (segments.length === 0) return "";
  if (segments.length === 3) {
    const first = segments[0]!;
    if (first.includes(".") || first.includes(":") || first === "localhost") {
      segments = segments.slice(1);
    }
  }
  const last = segments[segments.length - 1]!;
  const colon = last.indexOf(":");
  if (colon >= 0) {
    const repository = last.slice(0, colon);
    const tag = last.slice(colon + 1);
    if (!tag || tag === IMPLICIT_TAG) {
      segments[segments.length - 1] = repository;
    }
  }
  return segments.join("/");
}

/**
 * The same reference with ANY tag dropped — "is some build of this repository
 * the one I'm looking at?".
 *
 * Used only as a SECOND-CHANCE join key, and only when it is unambiguous (see
 * model-metrics.service). Matching on a repository alone would happily
 * attribute one build's size to another build's row, which is the same class
 * of lie as printing 0.
 */
export function modelRepositoryKey(reference: string): string {
  const normalized = normalizeModelReference(reference);
  const segments = normalized.split("/");
  const last = segments[segments.length - 1] ?? "";
  const colon = last.indexOf(":");
  if (colon >= 0) segments[segments.length - 1] = last.slice(0, colon);
  return segments.join("/");
}
