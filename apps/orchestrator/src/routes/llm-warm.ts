/**
 * WARP-3127 (voice latency, epic WARP-1430) — `POST /api/llm/warm`: start
 * loading the box's active chat model the moment the wake word is heard.
 *
 * WARP-1826 keeps a model resident for 5 minutes after its last use, so a
 * placement that went wrong on the GPU heals itself. The price is a reload on
 * the first turn after a quiet spell, and on the voice module that reload used
 * to start only once the transcript arrived. voice-io now calls this route the
 * moment it hears the wake word, so the reload overlaps the person speaking
 * and STT. The residency is not touched: nothing here sets keep_alive, and
 * there is no periodic keep-warm.
 *
 * Who may call it: `requireRoleOrService("_service:voice", "owner", "admin")`.
 * The voice principal is pinned BY ID (id and `service` role must both match),
 * so every other service principal is refused, and so are family and guest:
 * loading a model is a GPU decision. ADR-004 §3 (WARP-3127 amendment).
 *
 * What it does: answers 202 at once with an advisory `{ state }` ("warm" |
 * "warming" | "unknown", see onDemandWarmState), then warms fire-and-forget
 * through `warmActiveModelOnDemand` — probe first, load only a model that is
 * not resident, one load per model however many wakes arrive. The body is
 * ignored: the caller cannot name a model, so it cannot put a second one on
 * the GPU. Every failure is swallowed; an unreachable runtime is still a 202.
 *
 * Chat itself stays on the ai-gateway path. The warm goes to the inference
 * runtime's own /v1/chat/completions (model-readiness.service), never through
 * ollama-manager's /proxy.
 *
 * Mounted in app.ts BEFORE createLlmRouter, so no `/llm/:param` route there can
 * ever shadow it. It sits under the `chat` module's `/api/llm` prefix like
 * /api/llm/chat. This file exports only the router factory (the route-file
 * rule).
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";

import { createLogger } from "../lib/logger.js";
import { requireRoleOrService } from "../middleware/auth.js";
import { warmActiveModelOnDemand } from "../services/active-model.service.js";
import {
  onDemandWarmState,
  type OnDemandWarmState,
} from "../services/model-readiness.service.js";

const logger = createLogger("llm-warm-route");

/** voice-io's principal (middleware/auth.ts SERVICE_PRINCIPALS). */
const VOICE_SERVICE_ID = "_service:voice";

interface LlmWarmRouterDeps {
  /** The warm to start. Defaults to the box's active model, on demand. */
  warm?: () => Promise<unknown>;
  /** The advisory state for the 202 body. */
  state?: () => OnDemandWarmState;
}

export function createLlmWarmRouter(
  prisma: PrismaClient,
  deps: LlmWarmRouterDeps = {},
): Router {
  const router = Router();
  // Both defaults are read at request time, never at construction: suites that
  // build the whole app often factory-mock these services.
  const warm = deps.warm ?? (() => warmActiveModelOnDemand(prisma));
  const readState = deps.state ?? (() => onDemandWarmState());

  router.post(
    "/llm/warm",
    requireRoleOrService(VOICE_SERVICE_ID, "owner", "admin"),
    (req: Request, res: Response) => {
      let state: OnDemandWarmState = "unknown";
      try {
        state = readState();
      } catch {
        // Advisory only; the warm is what the caller wanted.
      }
      // After the response is on its way. Promise.resolve().then() also turns
      // a synchronous throw into a rejection, so one catch covers both.
      setImmediate(() => {
        Promise.resolve()
          .then(() => warm())
          .catch((err: unknown) => {
            logger.debug(
              { err: err instanceof Error ? err.message : String(err), caller: req.user?.id },
              "on-demand warm failed (non-fatal)",
            );
          });
      });
      res.status(202).json({ state });
    },
  );

  return router;
}
