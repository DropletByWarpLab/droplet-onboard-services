import { createLogger } from "../lib/logger.js";
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
      logger.info({ model }, "Model already pulled — ready");
      continue;
    }
    // Step 2 — model missing. Kick off a background pull.
    logger.info(
      { model, url: OLLAMA_URL },
      "Model not present — starting background pull (download time depends on model size and network)",
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
