/**
 * WARP-2979 (ADR-059 P4 §6.10, D19) — which model unattended work may use,
 * when that work must never leave the box: the ONE local-only resolver.
 *
 * Moved verbatim from services/filing/extract.ts (WARP-2730's
 * `resolveFilingModel`, which filing keeps as a re-export), so filing's
 * pre-flight and Droplet's incident summaries (security-narrator.service.ts)
 * ask the same question the same way. Nothing here sends a request.
 *
 * 🔴 THE CLOUD REFUSAL IS NOT A PREFERENCE. A background job has no person
 * behind it, and the per-turn cloud decision answers "allowed" for exactly
 * that principal — so it is never asked here. The answer is local, full
 * stop: the active chat model resolved against INSTALLED LOCAL models, a
 * degraded listing counted as unreachable, and `resolveOffLanProvider` as a
 * second opinion. A cloud active model resolves to "no local model", never
 * to itself.
 */
import type { PrismaClient } from "@prisma/client";

import * as aiGateway from "./ai-gateway.client.js";
import { readActiveChatModel, resolveStoredChatModel } from "./active-model.service.js";
import { isLocalProvider, resolveOffLanProvider } from "./cloud-access.service.js";
import { createLogger } from "../lib/logger.js";
import type { ModelInfo } from "../types/index.js";

const logger = createLogger("local-background-model");

export type ResolvedModel =
  | { ok: true; model: string }
  | { ok: false; reason: "model_unreachable" | "cloud_model_refused"; detail?: string };

/**
 * Which model will do the work — and whether it is allowed to.
 *
 * CATALOGUE-FIRST, per `resolveOffLanProvider`: the prefix mirror
 * (`providerForModelName`) returns `undefined` for an id it does not know,
 * which reads as "local" and is precisely how an uncatalogued cloud id would
 * slip through. The catalogue is asked first and its answer wins.
 *
 * A gateway that cannot be listed is `model_unreachable`, not a fallback to a
 * hardcoded tag: `email-analysis.service.ts` used to carry a
 * `mistral:7b-instruct` fallback (removed in WARP-3047) that was not pulled in
 * production and 404'd upstream, which turned every analysis into a silent
 * default. A worker that writes must fail loudly.
 *
 * `refuseCloudActive` (WARP-2979, the incident narrator's opt-in; filing
 * never sets it): when the owner's ACTIVE chat model is one the catalogue
 * lists under a cloud provider, answer `cloud_model_refused` instead of
 * falling back to a local model. With a cloud model active the box's one
 * local model may not be loaded (WARP-3047's one-model rule), so background
 * work that would load one pauses until a local model is active again. A
 * stored tag the catalogue does not list (a stale local model) is not a
 * cloud choice: the box's own fallback stands. Only the catalogue decides —
 * a legacy display name never goes through the prefix mirror here.
 */
export async function resolveLocalBackgroundModel(
  prisma: PrismaClient,
  opts: { refuseCloudActive?: boolean } = {},
): Promise<ResolvedModel> {
  let installed: ModelInfo[];
  try {
    const models = await aiGateway.listModels();
    // 🔴 A DEGRADED listing is treated as unreachable, not as "no local
    // models". `resolveActiveChatModel` accepts `null` for "could not confirm"
    // and passes the stored tag through unresolved, which is right for a
    // dashboard that must render something — and wrong here. Working against
    // a model we could not confirm is installed is how a background run ends
    // up dispatched to whatever the gateway falls back to.
    if (models.degraded === true || (models.degraded_providers?.length ?? 0) > 0) {
      return { ok: false, reason: "model_unreachable", detail: "model listing degraded" };
    }
    installed = models.models ?? [];
  } catch (err) {
    logger.warn({ err }, "local background model: could not list models");
    return { ok: false, reason: "model_unreachable", detail: "model listing failed" };
  }

  // WARP-2882: the same resolver as GET /api/models — a stored legacy
  // display name maps to the runtime id instead of the first installed model.
  const stored = await readActiveChatModel(prisma);
  if (opts.refuseCloudActive && stored && installed.some((m) => (m.id === stored || m.name === stored) && !isLocalProvider(m.provider))) {
    return { ok: false, reason: "cloud_model_refused", detail: "the active chat model is a cloud model" };
  }
  const model = resolveStoredChatModel(stored, installed);
  if (!model) {
    return { ok: false, reason: "model_unreachable", detail: "no local model installed" };
  }

  // Belt and braces. `resolveStoredChatModel` already filtered to local
  // providers, so a non-local answer here means the catalogue disagrees with
  // itself — and a disagreement about whether a request leaves the LAN is
  // resolved in the direction of not sending it.
  const offLan = await resolveOffLanProvider({ user: undefined, model });
  if (offLan) {
    return { ok: false, reason: "cloud_model_refused", detail: offLan };
  }
  return { ok: true, model };
}
