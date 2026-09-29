import { createLogger } from "../lib/logger.js";
import {
  inferenceRuntime,
  inferenceRuntimeUrl,
  modelRepositoryKey,
  normalizeModelReference,
  parseHumanSizeBytes,
} from "./inference-runtime.js";
/**
 * model-readiness.service.ts — First-boot Ollama model pull.
 *
 * On orchestrator startup, checks whether the configured LLM_MODEL is
 * present in Ollama; if not, fires an HTTP /api/pull request in the
 * background. Non-blocking — returns immediately so the orchestrator
 * is fully serving requests while the model downloads. Logs progress
 * at 10 % increments + a final success/failure line.
 *
 * Why this exists
 * ---------------
 * Before Phase 3, the single-box deployment needed someone to manually
 * run `docker exec droplet-ollama ollama pull gpt-oss:20b` before the
 * dashboard model list would surface anything. With `setup.sh
 * --single-box` writing `LLM_MODEL=gpt-oss:20b` to .env (via
 * configure_single_box_env in scripts/lib/single-box.sh) and the
 * manifest declaring it as the default (droplet-local-LLM Phase 3a),
 * this service notices the gap on first orchestrator boot and closes
 * it by hitting Ollama's HTTP API directly. The user vision: plug the
 * WAN cable in, walk away, come back to a working dashboard with
 * the model already loaded.
 *
 * Why not via ai-gateway
 * ----------------------
 * ai-gateway is a thin provider router (LiteLLM for cloud, httpx for
 * local Ollama) — see CLAUDE.md's architecture rules and the
 * droplet-architecture-guard skill. Tool dispatch + model lifecycle
 * live in the orchestrator. This service is the orchestrator owning
 * the lifecycle half.
 *
 * Why not via ollama-manager
 * --------------------------
 * The canonical path for model lifecycle is the `ollama-manager`
 * sidecar (port 8002) in `droplet-local-LLM`, which exposes
 * `/models/sync`, `/models/eligible`, `/models/pull` with VRAM gating
 * and manifest awareness. On the PoC today the manager isn't deployed
 * (Phase 3c — separate cross-repo work). When it lands, this service
 * should prefer the manager's `/models/sync` over Ollama's raw
 * `/api/pull`; falling back to direct Ollama keeps the PoC working
 * meanwhile and matches the production fall-through behavior when
 * the manager is unreachable.
 */


const logger = createLogger("model-readiness");

// WARP-2857 — resolved per call by the ONE resolver in inference-runtime.ts,
// which reads INFERENCE_RUNTIME_URL first and falls back to the deprecated
// OLLAMA_URL. This was a module-level capture of the legacy variable alone,
// which is why it could not see the canonical name at all.

interface OllamaTagsResponse {
  models?: Array<{ name: string; size?: number; modified_at?: string }>;
}

interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────
// WARP-1041 — model pre-warm. Pull ≠ load: a pulled model still costs
// 30-90 s of GPU load on the first inference after a boot, and the
// setup wizard's "Ask the AI" probe is exactly that first inference.
//
// WARP-1772: the warm request is the OpenAI chat path with max_tokens=1,
// NOT Ollama's empty-prompt /api/generate. Both runtimes serve
// /v1/chat/completions; only Ollama serves /api/generate — under DMR the
// old request 404'd, cleared the debounce, and pre-warm silently died at
// debug level (the flip audit's "looks fine, is broken" #1). One token of
// generation is the cost of being runtime-agnostic; on a reasoning model
// that token lands in the reasoning channel and no content is produced,
// which is fine — the warm needs the LOAD, not the output.
// ──────────────────────────────────────────────────────────────────

/** Skip re-warming when the last successful attempt was this recent.
 *  Also blunts abuse via the pre-auth PATCH /setup/state trigger. */
const WARM_DEBOUNCE_MS = 10 * 60 * 1000;

/** Timestamp of the last warm ATTEMPT, per model. Cleared for that model on
 *  failure so the next trigger — typically the pull-complete hook firing
 *  after a first-boot 404 — retries immediately.
 *
 *  WARP-3047: keyed BY MODEL. One module-level stamp meant a login's warm
 *  of A swallowed, for ten minutes, the warm of B that a model switch fires
 *  seconds later — the common case of an owner who signs in and then
 *  switches. */
const lastWarmAttemptAt = new Map<string, number>();

/** Exported for testing: clears the module-level warm debounce and the
 *  WARP-3127 in-flight / on-demand warm state. */
export function resetWarmStateForTests(): void {
  lastWarmAttemptAt.clear();
  inFlightWarmRequests.clear();
  lastWarmCompletedAt.clear();
  onDemandWarmJobs.clear();
  lastResidencyConfirmedAt = Number.NEGATIVE_INFINITY;
}

/** How one load request ended: the runtime answered 2xx (the model is
 *  loaded), answered non-2xx (still pulling / could not load), or never
 *  answered (runtime unreachable). */
type WarmRequestOutcome = "loaded" | "failed" | "unreachable";

/** WARP-3127 — the load request currently in flight, per model. EVERY
 *  trigger (setup, login, switch, boot, pull-complete, wake) goes through
 *  `issueWarmRequest`, so two triggers of one model share a single load
 *  instead of stacking a second 30-90 s load on the runtime. */
const inFlightWarmRequests = new Map<string, Promise<WarmRequestOutcome>>();

/** WARP-3127 — when a warm of each model last COMPLETED (2xx). Read by the
 *  on-demand path's "residency unknown" fallback. */
const lastWarmCompletedAt = new Map<string, number>();

/** WARP-3127 — last time ANY model was confirmed resident (a probe saw it in
 *  /api/ps, or a warm completed). Box-wide on purpose: the box answers with
 *  one active model (WARP-3047), and POST /api/llm/warm answers before it has
 *  resolved which one. Feeds only the advisory `onDemandWarmState`. */
let lastResidencyConfirmedAt = Number.NEGATIVE_INFINITY;

/**
 * The one load request every warm trigger shares — the OpenAI chat path,
 * max_tokens=1, no keep_alive (see `warmDefaultModel` for why each). Joins
 * the request already in flight for `model` when there is one. Never throws.
 */
function issueWarmRequest(model: string): Promise<WarmRequestOutcome> {
  const inFlight = inFlightWarmRequests.get(model);
  if (inFlight) return inFlight;
  const request: Promise<WarmRequestOutcome> = sendWarmRequest(model).finally(() => {
    // Only clear our own entry: a test reset may have replaced it.
    if (inFlightWarmRequests.get(model) === request) inFlightWarmRequests.delete(model);
  });
  inFlightWarmRequests.set(model, request);
  return request;
}

async function sendWarmRequest(model: string): Promise<WarmRequestOutcome> {
  const startedAt = Date.now();
  try {
    const resp = await fetch(`${inferenceRuntimeUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
    });
    if (!resp.ok) {
      // Drain the error body — under undici an unconsumed body can pin
      // the socket until GC. Read as TEXT: DMR's load failure is a
      // text/plain "unable to load runner: …" body, not JSON.
      const detail = (await resp.text().catch(() => "")).slice(0, 300);
      logger.warn(
        { model, status: resp.status, detail },
        "model_warm_failed (runtime non-2xx — 404: still pulling; 500: could not load, e.g. not enough GPU memory)",
      );
      return "failed";
    }
    // Drain the body so the socket is released; the response carries no
    // useful payload for a load-only request.
    await resp.json().catch(() => undefined);
    const now = Date.now();
    lastWarmCompletedAt.set(model, now);
    lastResidencyConfirmedAt = now;
    const elapsedSec = Math.floor((now - startedAt) / 1000);
    logger.info({ model, elapsedSec }, "model_warm_complete");
    return "loaded";
  } catch (err) {
    // ECONNREFUSED and friends — the runtime is not up yet. Non-fatal.
    logger.debug(
      { model, err: (err as Error).message },
      "model_warm_failed (runtime unreachable — will retry on next trigger)",
    );
    return "unreachable";
  }
}

/**
 * Load `model` — the box's ACTIVE chat model, resolved by the caller
 * (`warmActiveModel` in active-model.service) — into the serving runtime's
 * memory. Fire-and-forget at every call site; never throws. WARP-3047: this
 * used to warm env LLM_MODEL whatever the box had been switched to, so every
 * login loaded the old model next to the new one on DMR.
 *
 *   - OpenAI path, max_tokens=1 — the ONLY load-triggering request both
 *     runtimes serve (Ollama and DMR). Ollama's nicer empty-prompt
 *     /api/generate no-op is Ollama-only and 404s on DMR (WARP-1772).
 *   - NO keep_alive — residency policy stays owned by the compose file
 *     (OLLAMA_KEEP_ALIVE) or the runtime's own configuration, never
 *     this code path.
 *
 * All failures are swallowed: warming is an optimization, never a
 * dependency. ECONNREFUSED while the runtime boots stays at debug; a non-2xx
 * is logged at WARN with the runtime's own reason (WARP-3047), because that
 * is where "not enough GPU memory to load the model" shows up — a model that
 * doesn't fit must be visible, not a debug line nobody reads.
 */
export async function warmDefaultModel(
  model?: string | null,
  opts: { force?: boolean } = {},
): Promise<void> {
  const target = (model ?? "").trim();
  if (!target) {
    logger.debug("no active model resolved — skipping model warm");
    return;
  }
  const now = Date.now();
  // `force` is for the owner's explicit, audited model switch only
  // (PATCH /models/active): an earlier warm of this model may since have been
  // unloaded by a swap away and back, so the debounce would skip a warm that
  // is needed. Every automatic trigger (login, setup, boot) stays debounced.
  if (!opts.force && now - (lastWarmAttemptAt.get(target) ?? 0) < WARM_DEBOUNCE_MS) {
    return;
  }
  // Stamp at attempt start so concurrent triggers debounce against the
  // in-flight warm rather than stacking duplicate loads.
  lastWarmAttemptAt.set(target, now);
  // WARP-3127: the request itself is shared with the on-demand (wake) warm,
  // and joins one already in flight for this model.
  const outcome = await issueWarmRequest(target);
  if (outcome !== "loaded") {
    // A 404 is the model still pulling (first boot mid-pull); a 500 is a
    // runtime that could not load it; unreachable is a runtime still
    // booting. Clear the debounce in every case so the pull-complete hook
    // (or the next trigger) can retry this boot.
    lastWarmAttemptAt.delete(target);
  }
}

// ──────────────────────────────────────────────────────────────────
// WARP-903 — cold-model probe. `/api/llm/chat` (streaming) asks "is
// the selected model already resident in memory?" right before the
// agent loop so it can emit a `model_loading` SSE event instead of
// letting the customer stare at a silent 30-60 s first-token gap.
// Lifecycle observability only — chat completions go DIRECT to Ollama
// via the ai-gateway and must never route through ollama-manager's
// /proxy (same posture as the pull/warm logic above).
// ──────────────────────────────────────────────────────────────────

/** Shared budget for the two lifecycle GETs. Local Ollama answers both
 *  in single-digit milliseconds; a wedged Ollama costs AT MOST this
 *  much added latency on the turn — never a failure (spec: 1-2 s). */
const COLD_PROBE_BUDGET_MS = 1500;

export interface ColdModelStatus {
  /** The model name exactly as the caller requested (echoed on the wire). */
  model: string;
  /** Decimal gigabytes on disk (one decimal), or null when unreported. */
  sizeGb: number | null;
}

/** Ollama canonicalises un-tagged names to `<name>:latest`. */
function canonicalModelName(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/**
 * One-shot coldness check for `model` against Ollama's documented
 * lifecycle endpoints — GET /api/ps (models loaded in memory) + GET
 * /api/tags (models installed on disk, with sizes). Returns a
 * ColdModelStatus when the model is INSTALLED but NOT LOADED (a real
 * cold load is about to happen); null in every other case:
 *
 *   - already loaded (warm)            → null
 *   - unknown to Ollama                → null (cloud-provider model, or
 *     a not-yet-pulled name — either way a "loading" claim the stream
 *     could never honestly clear)
 *   - probe error / non-2xx / timeout  → null (the probe is an
 *     optimization, never a dependency — WARP-903 AC)
 *
 * NEVER throws.
 */
export async function probeColdModel(
  model: string,
): Promise<ColdModelStatus | null> {
  try {
    const signal = AbortSignal.timeout(COLD_PROBE_BUDGET_MS);
    // allSettled, not all: if ONE fetch rejects (e.g. a socket reset on
    // /api/ps) while the OTHER resolves 2xx, Promise.all would reject and we
    // would return null WITHOUT ever consuming the resolved sibling's body —
    // under undici an undrained body can pin the socket until GC. allSettled
    // lets us reach and drain that fulfilled body below.
    const [psSettled, tagsSettled] = await Promise.allSettled([
      fetch(`${inferenceRuntimeUrl()}/api/ps`, { signal }),
      fetch(`${inferenceRuntimeUrl()}/api/tags`, { signal }),
    ]);
    const psResp = psSettled.status === "fulfilled" ? psSettled.value : null;
    const tagsResp =
      tagsSettled.status === "fulfilled" ? tagsSettled.value : null;
    if (!psResp?.ok || !tagsResp?.ok) {
      // Not fully usable — a rejection (socket reset / unreachable) or a
      // non-2xx on either endpoint. Drain every body that DID resolve (a
      // rejected fetch has none), then claim nothing: without a good /api/ps
      // we cannot know loadedness. Same drain as the happy path's .json().
      await Promise.all([
        psResp?.json().catch(() => undefined),
        tagsResp?.json().catch(() => undefined),
      ]);
      logger.debug(
        {
          model,
          psStatus: psResp?.status ?? "unreachable",
          tagsStatus: tagsResp?.status ?? "unreachable",
        },
        "cold_probe_skipped (Ollama non-2xx or unreachable)",
      );
      return null;
    }
    const ps = (await psResp.json()) as OllamaTagsResponse;
    const tags = (await tagsResp.json()) as OllamaTagsResponse;
    const wanted = canonicalModelName(model);
    const loaded = new Set(
      (ps.models ?? []).map((m) => canonicalModelName(m.name)),
    );
    if (loaded.has(wanted)) return null; // warm — nothing to announce
    const installed = (tags.models ?? []).find(
      (m) => canonicalModelName(m.name) === wanted,
    );
    if (!installed) return null; // cloud model / not pulled — not ours to claim
    // WARP-1749: `size` is a real byte count under Ollama and hard-coded 0
    // under DMR, so the > 0 guard already yields an honest null there rather
    // than "0.0 GB" — the SSE says "loading" without claiming a size. This
    // path deliberately does NOT run the serveability corroboration
    // (verifyListedModelServeable): it sits in the chat hot path on a 1.5 s
    // budget, and its only output is a cosmetic "model is loading" event. A
    // phantom's failure surfaces from the completion request a moment later.
    const sizeGb =
      typeof installed.size === "number" && installed.size > 0
        ? Math.round(installed.size / 1e8) / 10
        : null;
    return { model, sizeGb };
  } catch (err) {
    logger.debug(
      { model, err: (err as Error).message },
      "cold_probe_failed (non-fatal — chat proceeds without model_loading)",
    );
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// WARP-3127 — warm on wake. POST /api/llm/warm (voice-io, the moment the
// wake word fires) asks for the active model to be loaded NOW, so a reload
// after WARP-1826's 5-minute residency overlaps the person speaking + STT
// instead of starting after them. The residency itself is untouched: no
// keep_alive, no periodic keep-warm. Unlike the triggers above this one is
// probe-first (it loads only a model that is not already resident) and has
// NO debounce of its own: a wake after an unload must warm again.
// ──────────────────────────────────────────────────────────────────

/** A warm that completed this recently left the model resident for at least
 *  another minute of the 5-minute residency (OLLAMA_KEEP_ALIVE, WARP-1826).
 *  Consulted only when the probe cannot tell whether the model is loaded. */
const RECENT_WARM_MS = 4 * 60 * 1000;

/** Where a model stands in the serving runtime right now. */
export type ModelResidency = "loaded" | "cold" | "unknown";

/** How one on-demand warm ended (logged, and returned for tests). */
export type OnDemandWarmOutcome =
  | "no-model" // nothing resolved: no runtime traffic
  | "loaded" // already resident: no warm
  | "recently-warmed" // residency unknown, but a warm completed < ~4 min ago
  | "warmed" // warm issued (or joined) and the runtime loaded the model
  | "warm-failed"; // warm issued, runtime non-2xx or unreachable

/** The advisory state POST /api/llm/warm answers with. */
export type OnDemandWarmState = "warm" | "warming" | "unknown";

/** The on-demand job (probe + warm) in flight, per model. Concurrent wakes
 *  share one probe and one load. */
const onDemandWarmJobs = new Map<string, Promise<OnDemandWarmOutcome>>();

interface RuntimeModelEntry {
  name?: unknown;
  model?: unknown;
}

/** True when `list` (an /api/ps or /api/tags body) names `model`. Matches
 *  Ollama's implicit `:latest` (canonicalModelName) AND DMR's registry-
 *  qualified ids (`docker.io/ai/x` vs `ai/x`, normalizeModelReference). */
function listsModel(list: { models?: unknown }, model: string): boolean {
  const wanted = canonicalModelName(model);
  const wantedRef = normalizeModelReference(model);
  const entries: RuntimeModelEntry[] = Array.isArray(list.models) ? list.models : [];
  return entries.some((entry) =>
    [entry?.name, entry?.model].some(
      (id) =>
        typeof id === "string" &&
        id.length > 0 &&
        (canonicalModelName(id) === wanted || normalizeModelReference(id) === wantedRef),
    ),
  );
}

/**
 * Tri-state residency probe for the on-demand warm: GET /api/ps (loaded in
 * memory) + GET /api/tags (installed on disk) on one shared
 * COLD_PROBE_BUDGET_MS. Both runtimes serve both; DMR's entries are
 * registry-qualified (ADR-036), which `listsModel` folds.
 *
 *   - listed by /api/ps                        → "loaded"
 *   - not in /api/ps, installed per /api/tags  → "cold"
 *   - /api/ps unusable, or the model is in
 *     neither list (or /api/tags unusable)     → "unknown"
 *
 * `probeColdModel` above keeps its contract for the chat hot path: its null
 * covers "loaded", "not listed" AND "probe failed", so it cannot tell
 * "loaded" from "don't know" — the one thing a warm decision needs.
 * NEVER throws.
 */
export async function probeModelResidency(model: string): Promise<ModelResidency> {
  try {
    const signal = AbortSignal.timeout(COLD_PROBE_BUDGET_MS);
    const [psSettled, tagsSettled] = await Promise.allSettled([
      fetch(`${inferenceRuntimeUrl()}/api/ps`, { signal }),
      fetch(`${inferenceRuntimeUrl()}/api/tags`, { signal }),
    ]);
    // Every body that resolved is read — and so drained (undici socket
    // release) — even when its sibling rejected or it answered non-2xx.
    const readList = async (
      settled: PromiseSettledResult<Response>,
    ): Promise<{ models?: unknown } | null> => {
      if (settled.status !== "fulfilled") return null;
      const body: unknown = await settled.value.json().catch(() => null);
      return settled.value.ok && body !== null && typeof body === "object"
        ? (body as { models?: unknown })
        : null;
    };
    const [ps, tags] = await Promise.all([readList(psSettled), readList(tagsSettled)]);
    if (ps === null) {
      logger.debug({ model }, "residency_probe_unknown (/api/ps unreachable or non-2xx)");
      return "unknown";
    }
    if (listsModel(ps, model)) return "loaded";
    if (tags !== null && listsModel(tags, model)) return "cold";
    return "unknown";
  } catch (err) {
    logger.debug(
      { model, err: (err as Error).message },
      "residency_probe_failed (non-fatal — treated as unknown)",
    );
    return "unknown";
  }
}

/**
 * WARP-3127 — load `model` (the box's active model, resolved by the caller:
 * `warmActiveModelOnDemand` in active-model.service) only if it is not
 * already resident. Never throws; resolves to what it did.
 *
 *   - a load of this model already in flight (any trigger) → join it
 *   - probe "loaded"  → nothing to do
 *   - probe "cold"    → warm
 *   - probe "unknown" → warm, unless a warm of THIS model completed in the
 *                       last ~4 min (still inside the 5 min residency)
 *
 * No debounce: a wake after the runtime unloaded the model must warm again.
 * Concurrent calls for one model share a single probe + load. Info log when a
 * warm is issued (plus `model_warm_complete` when it lands), debug otherwise.
 */
export function warmModelIfCold(model?: string | null): Promise<OnDemandWarmOutcome> {
  const target = (model ?? "").trim();
  if (!target) {
    logger.debug("no active model resolved — skipping on-demand warm");
    return Promise.resolve("no-model");
  }
  const inFlight = onDemandWarmJobs.get(target);
  if (inFlight) return inFlight;
  const job: Promise<OnDemandWarmOutcome> = runOnDemandWarm(target).finally(() => {
    if (onDemandWarmJobs.get(target) === job) onDemandWarmJobs.delete(target);
  });
  onDemandWarmJobs.set(target, job);
  return job;
}

async function runOnDemandWarm(model: string): Promise<OnDemandWarmOutcome> {
  try {
    const loading = inFlightWarmRequests.get(model);
    if (loading) {
      // A login / setup / switch warm of this model is already loading it.
      logger.debug({ model }, "on-demand warm joined an in-flight warm");
      return (await loading) === "loaded" ? "warmed" : "warm-failed";
    }
    const residency = await probeModelResidency(model);
    if (residency === "loaded") {
      lastResidencyConfirmedAt = Date.now();
      logger.debug({ model }, "on-demand warm skipped (model already resident)");
      return "loaded";
    }
    const lastCompleted = lastWarmCompletedAt.get(model) ?? Number.NEGATIVE_INFINITY;
    if (residency === "unknown" && Date.now() - lastCompleted < RECENT_WARM_MS) {
      logger.debug({ model }, "on-demand warm skipped (residency unknown, warmed < 4 min ago)");
      return "recently-warmed";
    }
    logger.info({ model, residency }, "model_warm_on_demand (loading the active model ahead of the turn)");
    return (await issueWarmRequest(model)) === "loaded" ? "warmed" : "warm-failed";
  } catch (err) {
    logger.debug({ model, err: (err as Error).message }, "on-demand warm failed (non-fatal)");
    return "warm-failed";
  }
}

/**
 * The advisory state POST /api/llm/warm returns with its 202. Synchronous,
 * because the route answers before it has resolved or probed anything:
 *
 *   - "warming" — a load is in flight right now (any trigger)
 *   - "warm"    — a model was confirmed resident in the last ~4 min
 *   - "unknown" — neither; the job the request just started will find out
 *
 * Box-wide rather than per model: the box answers with one active model
 * (WARP-3047). A hint for logs, never a guarantee.
 */
export function onDemandWarmState(): OnDemandWarmState {
  if (inFlightWarmRequests.size > 0) return "warming";
  return Date.now() - lastResidencyConfirmedAt < RECENT_WARM_MS ? "warm" : "unknown";
}

// ──────────────────────────────────────────────────────────────────
// WARP-1749 — presence in /api/tags is NOT readiness.
//
// This service has always equated "listed by GET /api/tags" with "ready to
// serve". Under Ollama that equation holds: Ollama lists a model only once its
// blobs are written and verified, and the entry carries the real byte count, so
// a listing is a statement about a complete model on disk.
//
// It does not hold under Docker Model Runner. MEASURED (2026-08-05,
// docker/model-runner:v1.2.6): a corrupt blob WEDGES the model store — the pull
// fails with a digest mismatch, a retry fails differently, and `/api/tags`
// then lists the model anyway at `size: 0`. The model is PRESENT AND
// UNSERVEABLE, and because DMR reports `size: 0` for healthy models too, the
// ollama-compatible surface cannot tell the two apart. Left alone, first boot
// would log "Model already pulled — ready", warm a model that cannot load, and
// hand the customer a dashboard whose wizard probe fails with no explanation.
//
// The corroborating source is DMR's NATIVE `GET /models`, the same listing
// model-metrics uses for file sizes: it reports a real per-model size as a
// human string (`config.size = "256.35 MiB"`). A model the native listing does
// not carry a usable size for is not something we are willing to call ready.
//
// Fail-open by design. An unreachable or unrecognised native listing yields
// `unverified`, which is treated exactly like today's behaviour — probes in
// this service are optimisations, never dependencies, and a probe outage must
// not trigger a pull storm against a store that is probably fine.
//
// NOT fixed here, deliberately: the `present` set below still compares raw
// strings, so a DMR box whose `.env` says `smollm2:360M` will not match the
// `docker.io/ai/smollm2:latest` the daemon reports and will pull rather than
// recognise it. That id-vocabulary translation is `comparable_id()`'s job in
// droplet-local-LLM's runtime adapter (WARP-1743) and belongs with the
// lifecycle owner, not duplicated here. This guard only makes the branch that
// DOES match honest.
// ──────────────────────────────────────────────────────────────────

/** Budget for the corroborating native listing. Same posture as the cold
 *  probe: a wedged daemon costs at most this much on startup, never a hang. */
const SERVEABILITY_BUDGET_MS = 1500;

/**
 * Whether a model that `/api/tags` LISTS can actually be served.
 *
 *   - `serveable`   — listing corroborated (or the runtime is one where a
 *                     listing is itself the corroboration).
 *   - `not_serveable` — the runtime's own store does not carry a usable copy:
 *                     the phantom left by a failed DMR pull.
 *   - `unverified`  — we could not ask. Callers must treat this as today's
 *                     behaviour, not as a failure.
 *
 * NEVER throws.
 */
export type ServeabilityVerdict = "serveable" | "not_serveable" | "unverified";

export async function verifyListedModelServeable(
  model: string,
): Promise<ServeabilityVerdict> {
  // Default runtime: a listing IS the corroboration (see the block comment).
  // No request is made, so an Ollama box behaves byte-for-byte as before.
  //
  // WARP-1870 — except when the configuration contradicts itself. The runtime
  // selector defaults to "ollama" when INFERENCE_RUNTIME is absent, and losing
  // that variable is a real failure mode (a compose `${VAR:-}` resolving
  // against an env file that lacks the key — the WARP-1860 shape). On a DMR
  // box that lands here and returns a confident "serveable" for a model this
  // code never asked about, which is the exact phantom the DMR branch below
  // exists to catch. The tell is free: the chat URL still points at DMR.
  // Report "unverified" — we genuinely could not corroborate — rather than
  // asserting health we have no evidence for.
  if (inferenceRuntime() !== "dmr") {
    const url = inferenceRuntimeUrl();
    if (/dmr|:12434/i.test(url)) {
      logger.warn(
        { model, url, runtime: inferenceRuntime() },
        "serveability_unverified (runtime is not dmr but the chat URL points at DMR — INFERENCE_RUNTIME was likely lost; a docker restart does not re-read it, use --force-recreate)",
      );
      return "unverified";
    }
    return "serveable";
  }

  const url = `${inferenceRuntimeUrl()}/models`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(SERVEABILITY_BUDGET_MS),
    });
    // Drain in every branch — an undrained undici body can pin the socket.
    const body = await resp.json().catch(() => undefined);
    if (!resp.ok) {
      logger.warn(
        { model, status: resp.status, url },
        "serveability_unverified (native model listing answered non-2xx)",
      );
      return "unverified";
    }
    const entries = nativeModelEntries(body);
    if (!entries) {
      logger.warn(
        { model, url },
        "serveability_unverified (native model listing shape not recognised)",
      );
      return "unverified";
    }
    return nativeListingHasUsableSize(entries, model)
      ? "serveable"
      : "not_serveable";
  } catch (err) {
    logger.warn(
      { model, url, err: (err as Error).message },
      "serveability_unverified (native model listing unreachable)",
    );
    return "unverified";
  }
}

/** The array inside whatever `GET /models` returned, or null when the payload
 *  isn't a shape we recognise (→ `unverified`, never a guess). */
function nativeModelEntries(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const key of ["models", "data", "objects"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return null;
}

/**
 * True when the native listing names `model` AND reports a parseable, non-zero
 * size for it. Both halves matter: a missing entry is the wedged-store phantom,
 * and an entry with no usable size is a copy we cannot vouch for either.
 *
 * Matching is done on the same folded OCI reference model-metrics joins on —
 * DMR reports `docker.io/ai/smollm2:latest` where `.env` says `smollm2:360M` —
 * with the repository as a second chance, since a manifest name carries an
 * Ollama-style tag that has no OCI equivalent to compare against.
 */
function nativeListingHasUsableSize(entries: unknown[], model: string): boolean {
  const wantedRef = normalizeModelReference(model);
  const wantedRepo = modelRepositoryKey(model);
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const refs: string[] = [];
    if (Array.isArray(entry.tags)) {
      for (const t of entry.tags) if (typeof t === "string") refs.push(t);
    }
    for (const key of ["id", "name", "model"]) {
      const v = entry[key];
      if (typeof v === "string") refs.push(v);
    }
    const matches = refs.some(
      (r) =>
        normalizeModelReference(r) === wantedRef ||
        (wantedRepo !== "" && modelRepositoryKey(r) === wantedRepo),
    );
    if (!matches) continue;
    const config =
      entry.config && typeof entry.config === "object"
        ? (entry.config as Record<string, unknown>)
        : {};
    const bytes = parseHumanSizeBytes(config.size);
    if (bytes != null && bytes > 0) return true;
  }
  return false;
}

/**
 * Idempotent: check whether `LLM_MODEL` is already pulled; if not,
 * kick off a background pull and return immediately. Safe to call on
 * every startup — when the model is present this is a single GET that
 * returns in ~10 ms.
 *
 * Non-fatal in every failure mode: orchestrator startup never blocks
 * on this, never exits on a pull failure. The dashboard model list
 * (`useModels` SWR poll) will surface the model once Ollama has it.
 *
 * WARP-3047 — the env loop stays env-driven (it PROVISIONS the seeded
 * models), but the warm does not: `resolveActiveModel` names the model the
 * box actually answers with, and exactly that one is warmed — after the
 * loop when it is already present, or by its pull-complete hook when it is
 * being pulled. Injected rather than imported so this module stays free of
 * Prisma and the gateway client.
 */
export async function ensureDefaultModelPulled(
  resolveActiveModel: () => Promise<string | null>,
): Promise<void> {
  // The chat default (LLM_MODEL) plus the optional local vision model
  // (VISION_MODEL) the image-vision path auto-routes to. Both are ensured at
  // startup so a fresh box has them ready without manual `ollama pull`.
  const models = Array.from(
    new Set(
      [process.env.LLM_MODEL ?? "", process.env.VISION_MODEL ?? ""].filter(
        Boolean,
      ),
    ),
  );
  if (models.length === 0) {
    logger.info("LLM_MODEL/VISION_MODEL unset — skipping model readiness check");
    warmActiveUnlessPulling(resolveActiveModel, new Set());
    return;
  }

  // Step 1 — which models are already in Ollama?
  let tags: OllamaTagsResponse;
  try {
    const resp = await fetch(`${inferenceRuntimeUrl()}/api/tags`);
    if (!resp.ok) {
      logger.warn(
        { status: resp.status, url: inferenceRuntimeUrl() },
        "Ollama /api/tags returned non-2xx; skipping model-readiness",
      );
      return;
    }
    tags = (await resp.json()) as OllamaTagsResponse;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, url: inferenceRuntimeUrl() },
      "Cannot reach Ollama for model-readiness check; will retry on next startup",
    );
    return;
  }

  // ──────────────────────────────────────────────────────────────────
  // WARP-1742 (epic WARP-1740, Ollama → Docker Model Runner) — READ THIS
  // BEFORE PORTING THIS CHECK TO DMR. Documentation only: Ollama is still
  // the runtime and nothing below changes behavior.
  //
  // Against Ollama, name-presence in /api/tags is a sound readiness signal.
  // Against Docker Model Runner it is NOT. A pull that fails integrity
  // verification can leave a PHANTOM entry: observed on DMR v1.2.6, a pull
  // downloaded all 270,590,624 bytes and then failed `blob digest mismatch`,
  // after which /api/tags listed the model with `size: 0` — present, but
  // unserveable. The retry failed *differently* (`rename …incomplete` →
  // ENOENT); only wiping the model volume recovered the store. A presence
  // test like the one below would therefore latch "already pulled — ready"
  // forever and never re-pull a model that can never answer.
  //
  // Note the first failure was an integrity check doing its job — that is
  // the supply-chain argument for OCI working as intended (WARP-1745). It
  // is the RECOVERY path that needs hardening, not the verification.
  //
  // Size is not a usable discriminator either: DMR's /api/tags reports
  // `size: 0` for every model, always. The real size is only on the native
  // `GET /models` response, and as a human-readable string rather than a
  // number. So a DMR readiness check must verify SERVEABILITY, not listing.
  // ──────────────────────────────────────────────────────────────────
  const present = new Set((tags.models ?? []).map((m) => m.name));
  const pulling = new Set<string>();
  for (const model of models) {
    if (present.has(model)) {
      // WARP-1749 — listed ≠ serveable. On the default runtime this returns
      // "serveable" without a request, so the branch below is the same one
      // that has always run. On DMR it catches the wedged-store phantom.
      const verdict = await verifyListedModelServeable(model);
      if (verdict === "not_serveable") {
        logger.error(
          { model, runtime: inferenceRuntime() },
          "model_listed_but_not_serveable — the daemon lists this model but its own store has no usable copy (a failed pull can leave this phantom). Treating it as missing and retrying the pull; if that keeps failing on a digest mismatch the store is wedged and only `docker model purge -f` clears it — note that removes EVERY model.",
        );
        // Fall through to the pull below: re-pulling is the same repair we
        // would attempt for a model that was never there, and it self-heals an
        // incomplete (as opposed to corrupt) copy. Deliberately NOT warmed —
        // warming a phantom just errors.
      } else {
        logger.info({ model, serveability: verdict }, "Model already pulled — ready");
        continue;
      }
    }
    // Step 2 — model not ready: either absent from the listing, or listed but
    // not serveable (WARP-1749). Kick off a background pull.
    logger.info(
      { model, url: inferenceRuntimeUrl() },
      "Model not ready — starting background pull (download time depends on model size and network)",
    );
    // Fire-and-forget. The `void` makes intent explicit and silences the
    // floating-promise lint. Errors are caught + logged inside backgroundPull.
    pulling.add(model);
    void backgroundPull(model, resolveActiveModel);
  }

  // WARP-1041 — pulled ≠ loaded. Warm the ACTIVE chat model (WARP-3047: not
  // LLM_MODEL — the owner may have switched) so the first ask after this
  // boot skips the 30-90 s GPU load. One model only: warming is chat-first,
  // the vision model loads on demand, and on DMR a second warm is a second
  // resident model. A model being pulled right now is warmed by its
  // pull-complete hook instead — warming it here would 404.
  warmActiveUnlessPulling(resolveActiveModel, pulling);
}

/**
 * Resolve the active model and warm it, off the boot path: the resolver asks
 * the ai-gateway, which may not be up yet this early (it starts after the
 * orchestrator), and boot must never wait on that.
 */
function warmActiveUnlessPulling(
  resolveActiveModel: () => Promise<string | null>,
  pulling: ReadonlySet<string>,
): void {
  void resolveActiveModel()
    .then((active) => {
      if (active && !pulling.has(active)) return warmDefaultModel(active);
      return undefined;
    })
    .catch((err: unknown) => {
      logger.debug({ err: (err as Error).message }, "model_warm_skipped (active model unresolved)");
    });
}

// Exported for testing: the streaming progress parser is the unit under
// regression test (completed:0 must be forwarded as pct=0).
//
// WARP-3047 — `resolveActiveModel` is asked at COMPLETION, not at start: a
// multi-GB pull outlives the boot, and the model to warm is whichever one the
// box answers with by the time the weights are on disk. Omitted → never warm.
export async function backgroundPull(
  model: string,
  resolveActiveModel?: () => Promise<string | null>,
): Promise<void> {
  const startedAt = Date.now();
  // Seed at -10 (not -1) so the very first event (pct=0) clears the +10
  // throttle below and logs the start of the pull.
  let lastLoggedPercent = -10;
  try {
    const resp = await fetch(`${inferenceRuntimeUrl()}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
    });
    if (!resp.ok || !resp.body) {
      logger.error(
        { status: resp.status, model },
        "Ollama /api/pull failed at request time",
      );
      return;
    }

    // Ollama streams newline-delimited JSON progress events while pulling.
    // Each event has {status, total?, completed?, digest?}. We log every
    // 10 % to keep the log readable on large models (gpt-oss:20b is
    // ~13 GB; on a 100 Mbit/s link the pull takes ~20 min).
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: OllamaPullProgress;
        try {
          ev = JSON.parse(line) as OllamaPullProgress;
        } catch {
          // Malformed line — Ollama occasionally emits partial JSON on
          // chunk boundaries. The TextDecoder({stream:true}) above mostly
          // handles this; ignore the rare straggler.
          continue;
        }
        if (ev.error) {
          logger.error({ model, error: ev.error }, "Ollama reported pull error");
          return;
        }
        // Guard on null/undefined, NOT falsiness: Ollama emits the first
        // progress event for each new blob/layer with `completed: 0`. A
        // falsy check (`ev.total && ev.completed`) silently drops that event,
        // so the front-panel/dashboard progress bar appears frozen at the
        // previous layer's high-water mark on multi-layer pulls. Forwarding
        // `completed: 0` lets pct=0 be logged at the start of every layer.
        if (ev.total != null && ev.completed != null) {
          const pct = Math.floor((ev.completed / ev.total) * 100);
          // Log every +10% within a layer, AND whenever progress resets to a
          // lower value: Ollama restarts at completed:0 for each new blob/layer,
          // so a decrease signals a new layer whose 0% start must be logged —
          // otherwise the log sticks at the previous layer's high-water mark on
          // multi-layer pulls (the bar appears frozen).
          if (pct >= lastLoggedPercent + 10 || pct < lastLoggedPercent) {
            logger.info(
              {
                model,
                percent: pct,
                completedGb: (ev.completed / 1e9).toFixed(2),
                totalGb: (ev.total / 1e9).toFixed(2),
              },
              "model_pull_progress",
            );
            lastLoggedPercent = pct;
          }
        }
        if (ev.status === "success") {
          const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
          logger.info({ model, elapsedSec }, "model_pull_complete");
          // WARP-1041 — the freshly-pulled chat model is on disk but NOT
          // in GPU memory. Warm it now — if it is the ACTIVE one — so a
          // first-boot customer's wizard probe doesn't pay the cold load
          // (and so a startup warm that 404'd mid-pull gets its retry).
          if (resolveActiveModel) {
            warmActiveUnlessPulling(
              async () => ((await resolveActiveModel()) === model ? model : null),
              new Set(),
            );
          }
        }
      }
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, model },
      "Background model pull failed (Ollama may have crashed, network may have dropped)",
    );
  }
}
