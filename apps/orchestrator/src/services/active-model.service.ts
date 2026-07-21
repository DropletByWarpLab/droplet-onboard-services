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
 * control-plane preference the orchestrator resolves, not on-box state. The
 * resolver is defensive — a stored tag that isn't installed (model since
 * removed) resolves to null so chat falls back to LLM_MODEL / the single
 * installed model instead of pointing at a model that isn't there.
 */
import type { PrismaClient } from "@prisma/client";
import type { ModelInfo } from "../types/index.js";

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
 * Identifiers (id + name) of installed LOCAL (ollama) models — the only
 * models eligible to be the active local chat model. Cloud providers are
 * excluded: the active-local-model choice never points off-box.
 */
export function localModelIdentifiers(models: ModelInfo[]): Set<string> {
  const ids = new Set<string>();
  for (const m of models) {
    if (m.provider !== "ollama") continue;
    if (m.id) ids.add(m.id);
    if (m.name) ids.add(m.name);
  }
  return ids;
}

/**
 * Resolve a stored active-model tag against the installed local set.
 * Returns the tag only when it's actually installed; otherwise null.
 */
export function resolveActiveChatModel(
  stored: string | null,
  installed: Set<string>,
): string | null {
  return stored && installed.has(stored) ? stored : null;
}
