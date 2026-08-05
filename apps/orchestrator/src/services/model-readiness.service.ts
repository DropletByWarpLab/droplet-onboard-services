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

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://host.docker.internal:11434";

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
// warmDefaultModel() fires Ollama's documented load-into-memory no-op
// (POST /api/generate with a model name and NO prompt) so the load
// happens in the background minutes before the customer asks.
// ──────────────────────────────────────────────────────────────────

/** Skip re-warming when the last successful attempt was this recent.
 *  Also blunts abuse via the pre-auth PATCH /setup/state trigger. */
const WARM_DEBOUNCE_MS = 10 * 60 * 1000;

/** Timestamp of the last warm ATTEMPT (module-level debounce). Reset to
 *  0 on failure so the next trigger — typically the pull-complete hook
 *  firing after a first-boot 404 — retries immediately. */
let lastWarmAttemptAt = 0;

/** Exported for testing: clears the module-level warm debounce. */
export function resetWarmStateForTests(): void {
  lastWarmAttemptAt = 0;
}

/**
 * Load the configured chat model (LLM_MODEL) into Ollama's memory
 * without generating anything. Fire-and-forget at every call site;
 * never throws. The request body is exactly `{model}`:
 *
 *   - NO prompt — empty-prompt /api/generate is Ollama's documented
 *     "just load the model" request; it returns after the load.
 *   - NO keep_alive — a body value would OVERRIDE the container's
 *     OLLAMA_KEEP_ALIVE env (24 h on the box); residency policy stays
 *     owned by the compose file, not this code path.
 *
 * All failures (404 while the model is still pulling, ECONNREFUSED
 * while Ollama boots) are swallowed at debug level: warming is an
 * optimization, never a dependency.
 *
 * When the ollama-manager sidecar (droplet-local-LLM Phase 3c) lands,
 * prefer its lifecycle API over raw Ollama — same fall-through note as
 * the pull logic above.
 */
export async function warmDefaultModel(): Promise<void> {
  const model = process.env.LLM_MODEL ?? "";
  if (!model) {
    logger.debug("LLM_MODEL unset — skipping model warm");
    return;
  }
  const now = Date.now();
  if (now - lastWarmAttemptAt < WARM_DEBOUNCE_MS) {
    return;
  }
  // Stamp at attempt start so concurrent triggers debounce against the
  // in-flight warm rather than stacking duplicate loads.
  lastWarmAttemptAt = now;
  const startedAt = Date.now();
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!resp.ok) {
      // Drain the error body — under undici an unconsumed body can pin
      // the socket until GC. Same pattern as the ok branch below.
      await resp.json().catch(() => undefined);
      // Likely 404: the model isn't pulled yet (first boot mid-pull).
      // Clear the debounce so the pull-complete hook can warm this boot.
      lastWarmAttemptAt = 0;
      logger.debug(
        { model, status: resp.status },
        "model_warm_skipped (Ollama non-2xx — model may still be pulling)",
      );
      return;
    }
    // Drain the body so the socket is released; the response carries no
    // useful payload for a load-only request.
    await resp.json().catch(() => undefined);
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    logger.info({ model, elapsedSec }, "model_warm_complete");
  } catch (err) {
    // ECONNREFUSED and friends — Ollama not up yet. Non-fatal.
    lastWarmAttemptAt = 0;
    logger.debug(
      { model, err: (err as Error).message },
      "model_warm_failed (Ollama unreachable — will retry on next trigger)",
    );
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
      fetch(`${OLLAMA_URL}/api/ps`, { signal }),
      fetch(`${OLLAMA_URL}/api/tags`, { signal }),
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
  if (inferenceRuntime() !== "dmr") return "serveable";

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
 */
export async function ensureDefaultModelPulled(): Promise<void> {
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
    return;
  }

  // Step 1 — which models are already in Ollama?
  let tags: OllamaTagsResponse;
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!resp.ok) {
      logger.warn(
        { status: resp.status, url: OLLAMA_URL },
        "Ollama /api/tags returned non-2xx; skipping model-readiness",
      );
      return;
    }
    tags = (await resp.json()) as OllamaTagsResponse;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, url: OLLAMA_URL },
      "Cannot reach Ollama for model-readiness check; will retry on next startup",
    );
    return;
  }

  const present = new Set((tags.models ?? []).map((m) => m.name));
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
        // WARP-1041 — pulled ≠ loaded. Warm the CHAT default so the first
        // ask after this boot (wizard probe or /chat) skips the 30-90 s
        // GPU load. Only the LLM_MODEL: warming is chat-first, and the
        // vision model loads on demand.
        if (model === process.env.LLM_MODEL) {
          void warmDefaultModel();
        }
        continue;
      }
    }
    // Step 2 — model not ready: either absent from the listing, or listed but
    // not serveable (WARP-1749). Kick off a background pull.
    logger.info(
      { model, url: OLLAMA_URL },
      "Model not ready — starting background pull (download time depends on model size and network)",
    );
    // Fire-and-forget. The `void` makes intent explicit and silences the
    // floating-promise lint. Errors are caught + logged inside backgroundPull.
    void backgroundPull(model);
  }
}

// Exported for testing: the streaming progress parser is the unit under
// regression test (completed:0 must be forwarded as pct=0).
export async function backgroundPull(model: string): Promise<void> {
  const startedAt = Date.now();
  // Seed at -10 (not -1) so the very first event (pct=0) clears the +10
  // throttle below and logs the start of the pull.
  let lastLoggedPercent = -10;
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/pull`, {
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
          // WARP-1041 — the freshly-pulled chat default is on disk but
          // NOT in GPU memory. Warm it now so a first-boot customer's
          // wizard probe doesn't pay the cold load (and so a startup
          // warm that 404'd mid-pull gets its retry this boot).
          if (model === process.env.LLM_MODEL) {
            void warmDefaultModel();
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
