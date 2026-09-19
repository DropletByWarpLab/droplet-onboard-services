/**
 * WARP-1112 — the box's active local chat model.
 *
 * A single persisted choice ("which local model does this Droplet answer
 * with by default") backed by the `ai.model.chat` WorkspaceSetting. Written
 * only by `PATCH /api/models/active` (owner/admin, validated + audited);
 * read by `GET /api/models` (to show the active row) and `GET /api/llm/models`
 * (as `defaultModel`, so the dashboard chat defaults to it).
 *
 * Appliance stays stateless about model choice (ADR-003): this is a
 * control-plane preference the orchestrator resolves, not on-box state.
 *
 * WARP-1511 — the resolver is defensive in BOTH directions now: a stored
 * tag that isn't installed (model since removed) OR a blank/never-set value
 * falls back to the sole/first installed local model — the fallback the
 * seed row's own comment (WORKSPACE_SETTING_DEFAULTS, "ai.model.chat")
 * already promised but the original WARP-1112 cut never implemented, which
 * left a healthy single-model box reporting a permanent blank. It falls
 * back to null only when NO local model is installed (honest — never
 * fabricated) or when the installed set itself couldn't be confirmed this
 * request (gateway/Ollama probe failed) — see `resolveActiveChatModel`.
 */
import type { PrismaClient } from "@prisma/client";
import type { ModelInfo } from "../types/index.js";
import { isLocalProvider } from "./cloud-access.service.js";

/** WorkspaceSetting key holding the box's active local chat model. */
export const ACTIVE_CHAT_MODEL_KEY = "ai.model.chat";

/**
 * Read the stored active-model tag, or null when unset ("" — the explicit
 * "no choice yet" state) or the row is missing (older DB, pre-migration).
 */
export async function readActiveChatModel(
  prisma: PrismaClient,
): Promise<string | null> {
  const row = await prisma.workspaceSetting.findUnique({
    where: { key: ACTIVE_CHAT_MODEL_KEY },
    select: { valueJson: true },
  });
  const v = row?.valueJson;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * WARP-2882 — the id/name/provider triple is all resolution needs, so both
 * the gateway's `ModelInfo` and the page payload's `LocalModelInfo` qualify.
 */
export type LocalModelRef = Pick<ModelInfo, "id" | "name" | "provider">;

/**
 * WARP-2882 — resolve a caller-supplied reference (the runtime `id`, or the
 * gateway's DISPLAY `name` that older dashboards send) to the runtime id of
 * an installed LOCAL model. Null when nothing local matches. Every write and
 * daemon probe must use the returned id: the display name ("Gpt-oss 20B F16")
 * is not a model the runtime knows.
 */
export function resolveLocalModelId(
  models: LocalModelRef[],
  ref: string,
): string | null {
  for (const m of models) {
    if (!isLocalProvider(m.provider)) continue;
    if (m.id === ref || m.name === ref) return m.id;
  }
  return null;
}

/**
 * Resolve a stored active-model tag against the installed local set.
 *
 * WARP-1511 — resolution-on-read: the `ai.model.chat` row is never
 * rewritten by this function, a blank/stale value stays exactly as stored.
 *
 *   - `installed === null` means this request couldn't confirm the
 *     installed set (the ai-gateway/Ollama listing probe failed or is
 *     known-degraded). Rather than discarding a previously-good choice
 *     against an incomplete list, the stored value passes through
 *     unresolved — this never throws.
 *   - Otherwise, a `stored` tag that IS in `installed` wins unchanged.
 *   - A blank (`null`) OR stale (no-longer-installed) `stored` tag falls
 *     back to the sole/first installed local model, so a healthy box with
 *     at least one model never reports a blank active model. "First"
 *     follows the caller's Set iteration order (insertion order — the
 *     order its installed-models source returned them in), so it's
 *     deterministic per call.
 *   - An empty but CONFIRMED `installed` set (genuinely zero local models)
 *     stays honestly null — never fabricated.
 */
export function resolveActiveChatModel(
  stored: string | null,
  installed: Set<string> | null,
): string | null {
  if (installed === null) return stored;
  if (stored && installed.has(stored)) return stored;
  const [fallback] = installed;
  return fallback ?? null;
}

/**
 * WARP-2882 — THE read path for `ai.model.chat`: every consumer
 * (`GET /api/models`, `GET /api/llm/models` `defaultModel`, the filing
 * worker) goes through here so they all answer the same runtime id for the
 * same row.
 *
 * The stored value may be a legacy DISPLAY name — boxes that used the
 * picker before WARP-2882 hold "Gpt-oss 20B F16", and the row is never
 * rewritten on read (docs/MODEL_ID_MIGRATION.md §6). It is resolved through
 * `resolveLocalModelId` FIRST, then handed to `resolveActiveChatModel` with
 * an ids-only installed set for the WARP-1511 blank/stale fallback. Resolving
 * against ids alone silently re-pointed every such box at the first installed
 * model. `models === null` keeps the "couldn't confirm the installed set"
 * pass-through.
 */
export function resolveStoredChatModel(
  stored: string | null,
  models: LocalModelRef[] | null,
): string | null {
  if (models === null) return stored;
  const ids = new Set(
    models.filter((m) => isLocalProvider(m.provider)).map((m) => m.id),
  );
  return resolveActiveChatModel(
    stored ? resolveLocalModelId(models, stored) : null,
    ids,
  );
}
