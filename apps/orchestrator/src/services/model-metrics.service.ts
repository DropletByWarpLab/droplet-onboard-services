/**
 * WARP-836 honest metrics — real per-model stats read straight from the local
 * inference daemon.
 *
 * ai-gateway's model list is capability-only (name/provider/context/vision).
 * The real footprint lives in the daemon's own lifecycle endpoints, which the
 * orchestrator already reaches for model-readiness (same `OLLAMA_URL`):
 *   - GET /api/tags — installed models → disk size, parameter size, quantization
 *   - GET /api/ps   — loaded models → graphics memory in use (size_vram)
 *
 * This turns the Models card's documented "—" placeholders into MEASURED
 * numbers. Honesty contract holds: any field the daemon doesn't report stays
 * null, and a probe failure yields an empty map (callers keep their "—"),
 * never a fabricated value.
 *
 * ── WARP-1749: why a null is no longer enough ──────────────────────────
 * Those two endpoints are Ollama's. Docker Model Runner (DMR) replicates their
 * SHAPE but not their content, and the gaps are structural, not transient
 * (measured live 2026-08-05 against docker/model-runner:v1.2.6):
 *
 *   - `/api/ps` NEVER populates `size_vram`. Its handler builds a PS entry from
 *     {Name, Model, Digest} and never assigns Size/SizeVram — on ROCm and CUDA
 *     alike. `/metrics` is empty. Per-model VRAM is UNOBTAINABLE from DMR.
 *   - `/api/tags` returns `size: 0` for every model, always. A real size exists
 *     only on the NATIVE `GET /models`, as a human string
 *     (`config.size = "256.35 MiB"`).
 *
 * A bare `null` collapses three different facts into one: "not measured yet",
 * "the daemon didn't say", and "this runtime can never say". The Models page's
 * whole selling point is honesty, so each metric now carries an explicit
 * `MetricState` next to its value — state is stated, never inferred from the
 * absence of a number (and never from a fabricated 0).
 *
 * OUT OF SCOPE (open on WARP-1742): sourcing VRAM from anywhere else — host
 * `rocm-smi`, nvidia-smi, a patched DMR. This module reports what the runtime
 * reports and says so when the runtime reports nothing. It never substitutes a
 * number from another source.
 */
import { createLogger } from "../lib/logger.js";
import {
  inferenceRuntime,
  inferenceRuntimeUrl,
  modelRepositoryKey,
  normalizeModelReference,
  parseHumanSizeBytes,
} from "./inference-runtime.js";

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

/**
 * Why a metric has no number — explicit, because "null" alone can't tell the
 * user whether to wait, retry, or stop expecting it.
 *
 *   - `measured`    — the daemon gave us this number. Render it.
 *   - `unreported`  — this runtime CAN report the field but didn't for this
 *                     model (missing key, or the probe failed). Transient-ish;
 *                     the same box may report it on the next poll.
 *   - `unsupported` — this runtime has no way to report it. Structural: waiting
 *                     will not help. The UI says so instead of showing "—" and
 *                     letting the user assume something is broken.
 */
export type MetricState = "measured" | "unreported" | "unsupported";

export interface LocalModelMetrics {
  /** GB on disk (decimal), or null when no size was measured. */
  gbOnDisk: number | null;
  /** Why `gbOnDisk` is null, when it is. */
  gbOnDiskState: MetricState;
  /** e.g. "20.9B" — parameter count as the daemon reports it. */
  parameterSize: string | null;
  /** e.g. "MXFP4" / "Q4_K_M" — quantization level. */
  quantization: string | null;
  /** True when the model is currently resident in memory (from /api/ps). */
  loaded: boolean;
  /** Graphics memory the resident model uses (GB), or null when unmeasured. */
  vramGb: number | null;
  /** Why `vramGb` is null, when it is. Always `unsupported` under DMR. */
  vramState: MetricState;
}

/**
 * Bytes → decimal GB, one decimal place.
 *
 * 0 is NOT a measurement here and never has been: a model that exists on disk
 * cannot occupy zero bytes, and DMR hard-codes `size: 0` on /api/tags. Folding
 * it to null (rather than rendering "0 B") is the behaviour this function has
 * always had — WARP-1749 only names the reason in `MetricState`.
 */
function bytesToGb(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.round(n / 1e8) / 10
    : null;
}

/** The daemon sometimes reports a bare name; normalise so "gpt-oss" and
 *  "gpt-oss:latest" collate with the ai-gateway list. */
function norm(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

// ──────────────────────────────────────────────────────────────────────
// DMR native `GET /models` — the ONLY source of a real per-model size when
// the runtime is DMR. Response entries carry a `config` object whose `size` is
// a human string ("256.35 MiB"); that field is the one we measured and the one
// this enrichment exists for. `parameters`/`quantization` are read from the
// same object DEFENSIVELY — if they are absent or not strings the fields
// simply stay unknown, so reading them cannot invent anything.
// ──────────────────────────────────────────────────────────────────────

interface NativeModelFacts {
  sizeBytes: number | null;
  parameterSize: string | null;
  quantization: string | null;
}

/** Index of native facts, joinable from an `/api/tags` name. */
interface NativeModelIndex {
  /** Keyed by full reference minus registry host and `:latest`. */
  byReference: Map<string, NativeModelFacts>;
  /** Keyed by repository alone. A null value marks an AMBIGUOUS repository
   *  (two builds installed) — we then decline to guess which one a row is. */
  byRepository: Map<string, NativeModelFacts | null>;
}

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Pull the reference strings an entry might be addressable by. Deliberately
 * shape-tolerant: only `config.size` is a measured fact about this payload, so
 * every other key is probed rather than assumed. An entry we can't name simply
 * doesn't join, which leaves the row unknown — never wrongly enriched.
 */
function referencesOf(entry: Record<string, unknown>): string[] {
  const out: string[] = [];
  const tags = entry.tags;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      const s = readString(t);
      if (s) out.push(s);
    }
  }
  for (const key of ["id", "name", "model"]) {
    const s = readString(entry[key]);
    if (s) out.push(s);
  }
  return out;
}

/** Parse whatever `GET /models` returned into a joinable index, or null when
 *  the payload isn't a shape we recognise (→ callers report "unsupported",
 *  never a guess). */
function indexNativeModels(body: unknown): NativeModelIndex | null {
  let entries: unknown[] | null = null;
  if (Array.isArray(body)) entries = body;
  else if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const key of ["models", "data", "objects"]) {
      if (Array.isArray(obj[key])) {
        entries = obj[key] as unknown[];
        break;
      }
    }
  }
  if (!entries) return null;

  const index: NativeModelIndex = {
    byReference: new Map(),
    byRepository: new Map(),
  };
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const config =
      entry.config && typeof entry.config === "object"
        ? (entry.config as Record<string, unknown>)
        : {};
    const facts: NativeModelFacts = {
      sizeBytes: parseHumanSizeBytes(config.size),
      parameterSize: readString(config.parameters),
      quantization: readString(config.quantization),
    };
    for (const ref of referencesOf(entry)) {
      index.byReference.set(normalizeModelReference(ref), facts);
      const repo = modelRepositoryKey(ref);
      if (!repo) continue;
      // Second sighting of a repository = two builds installed. Mark it
      // ambiguous rather than letting the last one win: attributing one
      // build's size to another build's row is the same lie as printing 0.
      index.byRepository.set(
        repo,
        index.byRepository.has(repo) && index.byRepository.get(repo) !== facts
          ? null
          : facts,
      );
    }
  }
  return index;
}

/** Look a tags-name up in the native index. Exact reference first; repository
 *  only when it names exactly one installed build. */
function nativeFactsFor(
  index: NativeModelIndex,
  name: string,
): NativeModelFacts | null {
  const exact = index.byReference.get(normalizeModelReference(name));
  if (exact) return exact;
  const repo = modelRepositoryKey(name);
  return repo ? (index.byRepository.get(repo) ?? null) : null;
}

/**
 * Best-effort snapshot of per-model metrics, keyed by normalised name.
 * Empty map on any probe failure — callers keep their honest "—".
 */
export async function fetchLocalModelMetrics(): Promise<
  Map<string, LocalModelMetrics>
> {
  const out = new Map<string, LocalModelMetrics>();
  const runtime = inferenceRuntime();
  const isDmr = runtime === "dmr";
  try {
    const signal = AbortSignal.timeout(PROBE_BUDGET_MS);
    // allSettled (not all): if one endpoint rejects we still consume the
    // other's body — an undrained undici body can pin the socket.
    //
    // The third request exists ONLY under DMR. On an Ollama box this array is
    // the same two fetches it has always been — no extra traffic, no changed
    // ordering, nothing for the default path to regress on.
    const [psSettled, tagsSettled, nativeSettled] = await Promise.allSettled([
      fetch(`${OLLAMA_URL}/api/ps`, { signal }),
      fetch(`${OLLAMA_URL}/api/tags`, { signal }),
      ...(isDmr
        ? [fetch(`${inferenceRuntimeUrl()}/models`, { signal })]
        : []),
    ]);
    const psResp = psSettled?.status === "fulfilled" ? psSettled.value : null;
    const tagsResp =
      tagsSettled?.status === "fulfilled" ? tagsSettled.value : null;
    const nativeResp =
      nativeSettled?.status === "fulfilled" ? nativeSettled.value : null;

    if (!tagsResp?.ok) {
      // Without /api/tags there's nothing to enrich. Drain the siblings.
      await Promise.all([
        psResp?.json().catch(() => undefined),
        nativeResp?.json().catch(() => undefined),
      ]);
      return out;
    }
    const tags = (await tagsResp.json()) as { models?: OllamaTagEntry[] };
    let ps: { models?: OllamaPsEntry[] } = { models: [] };
    if (psResp?.ok) {
      ps = (await psResp.json()) as { models?: OllamaPsEntry[] };
    } else {
      await psResp?.json().catch(() => undefined);
    }

    // DMR only: the native listing that actually knows file sizes.
    let native: NativeModelIndex | null = null;
    if (nativeResp) {
      const body = await nativeResp.json().catch(() => undefined);
      if (nativeResp.ok) {
        native = indexNativeModels(body);
        if (!native) {
          logger.debug(
            { url: inferenceRuntimeUrl() },
            "native GET /models returned an unrecognised shape — sizes stay unknown",
          );
        }
      }
    }

    const vramByName = new Map<string, number | null>();
    for (const m of ps.models ?? []) {
      vramByName.set(norm(m.name), bytesToGb(m.size_vram));
    }
    for (const m of tags.models ?? []) {
      const key = norm(m.name);
      const isLoaded = vramByName.has(key);
      const vramGb = isLoaded ? (vramByName.get(key) ?? null) : null;

      // ── disk size ──
      // Ollama: /api/tags carries the real byte count. DMR: it is structurally
      // 0, so the only chance is the native listing's human string.
      let gbOnDisk = bytesToGb(m.size);
      let gbOnDiskState: MetricState = gbOnDisk != null ? "measured" : "unreported";
      let parameterSize = m.details?.parameter_size ?? null;
      let quantization = m.details?.quantization_level ?? null;
      if (isDmr) {
        // Nothing usable came from /api/tags and nothing ever will — start
        // from "this runtime doesn't report it" and upgrade only on a real
        // measurement.
        if (gbOnDisk == null) gbOnDiskState = "unsupported";
        const facts = native ? nativeFactsFor(native, m.name) : null;
        if (facts) {
          const nativeGb = bytesToGb(facts.sizeBytes);
          if (nativeGb != null) {
            gbOnDisk = nativeGb;
            gbOnDiskState = "measured";
          }
          // Same payload, same defensiveness: fill a gap, never overwrite a
          // value /api/tags already reported.
          parameterSize = parameterSize ?? facts.parameterSize;
          quantization = quantization ?? facts.quantization;
        }
      }

      // ── graphics memory ──
      // MEASURED: DMR's /api/ps handler never assigns SizeVram, so a resident
      // model reports no VRAM figure on any accelerator. That is a property of
      // the runtime, not of this model or this moment — say `unsupported` so
      // the UI can explain it instead of showing a bare dash.
      const vramState: MetricState = isDmr
        ? "unsupported"
        : vramGb != null
          ? "measured"
          : "unreported";

      out.set(key, {
        gbOnDisk,
        gbOnDiskState,
        parameterSize,
        quantization,
        loaded: isLoaded,
        vramGb,
        vramState,
      });
    }
  } catch (err) {
    logger.debug(
      { err: (err as Error).message, url: OLLAMA_URL, runtime },
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
