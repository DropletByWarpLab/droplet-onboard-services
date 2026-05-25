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
 * Before Phase 3, the single-box PoC needed someone to manually run
 * `docker exec droplet-ollama ollama pull gpt-oss:20b` before the
 * dashboard model list would surface anything. With `setup.sh --poc`
 * writing `LLM_MODEL=gpt-oss:20b` to .env (Phase 2) and the manifest
 * declaring it as the default (droplet-jetson-ai Phase 3a), this
 * service notices the gap on first orchestrator boot and closes it
 * by hitting Ollama's HTTP API directly. The user vision: plug the
 * WAN cable in, walk away, come back to a working dashboard with
 * the model already loaded.
 *
 * Why not via ai-gateway
 * ----------------------
 * Per architecture-guard rule 2, ai-gateway is a thin provider router
 * (LiteLLM for cloud, httpx for local Ollama). Tool dispatch + model
 * lifecycle live in the orchestrator. This service is the orchestrator
 * owning the lifecycle half.
 *
 * Why not via ollama-manager
 * --------------------------
 * The canonical path for model lifecycle is the `ollama-manager`
 * sidecar (port 8002) in `droplet-jetson-ai`, which exposes
 * `/models/sync`, `/models/eligible`, `/models/pull` with VRAM gating
 * and manifest awareness. On the PoC today the manager isn't deployed
 * (Phase 3c — separate cross-repo work). When it lands, this service
 * should prefer the manager's `/models/sync` over Ollama's raw
 * `/api/pull`; falling back to direct Ollama keeps the PoC working
 * meanwhile and matches the production fall-through behavior when
 * the manager is unreachable.
 */

import pino from "pino";

const logger = pino({ name: "model-readiness" });

const OLLAMA_URL =
  process.env.JETSON_OLLAMA_URL ?? "http://host.docker.internal:11434";
const LLM_MODEL = process.env.LLM_MODEL ?? "";

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
  if (!LLM_MODEL) {
    logger.info("LLM_MODEL unset — skipping model readiness check");
    return;
  }

  // Step 1 — is the model already in Ollama?
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

  const present = (tags.models ?? []).some((m) => m.name === LLM_MODEL);
  if (present) {
    logger.info({ model: LLM_MODEL }, "Model already pulled — ready");
    return;
  }

  // Step 2 — model missing. Kick off a background pull.
  logger.info(
    { model: LLM_MODEL, url: OLLAMA_URL },
    "Model not present — starting background pull (download time depends on model size and network)",
  );
  // Fire-and-forget. The `void` makes intent explicit and silences the
  // floating-promise lint. Errors are caught + logged inside backgroundPull.
  void backgroundPull(LLM_MODEL);
}

async function backgroundPull(model: string): Promise<void> {
  const startedAt = Date.now();
  let lastLoggedPercent = -1;
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
        if (ev.total && ev.completed) {
          const pct = Math.floor((ev.completed / ev.total) * 100);
          if (pct >= lastLoggedPercent + 10) {
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
