/**
 * provider.ts — what "local" means on the model rows the dashboard renders.
 *
 * WARP-1926. Every surface that distinguishes on-box inference from a cloud
 * provider used to compare against the string literal `"ollama"`. That was
 * already a misnomer — the value names WHERE inference runs, not which daemon
 * serves it — and it became an outright lie when Docker Model Runner shipped
 * as the default runtime (WARP-1870): the gateway reported `provider:
 * "ollama"` on boxes with no Ollama installed.
 *
 * The gateway now emits `local`. These helpers are the ONE place the dashboard
 * decides what counts as local, mirroring `LOCAL_PROVIDERS` in
 * apps/orchestrator/src/services/cloud-access.service.ts and
 * services/ai-gateway/middleware/off_lan_gating.py.
 *
 * The legacy `ollama*` spellings stay in the accept-set deliberately:
 * `provider` is a PERSISTED column, so conversation history written before the
 * rename carries `ollama`, and a dashboard that stopped recognising it would
 * render every historical turn as if it had run in the cloud.
 */

/** The canonical local-provider name — what the gateway emits today. */
export const LOCAL_PROVIDER = "local";

/**
 * Every spelling that means on-box inference: the canonical name plus the
 * pre-WARP-1926 aliases still present in persisted rows.
 */
export const LOCAL_PROVIDERS: ReadonlySet<string> = new Set([
  LOCAL_PROVIDER,
  "ollama",
  "ollama_local",
]);

/** True for a provider that never leaves the LAN. */
export function isLocalProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return LOCAL_PROVIDERS.has(provider.trim().toLowerCase());
}

/**
 * Human label for the box's inference runtime, for the one surface that should
 * name the actual engine (Settings → AI providers). Everywhere else the honest
 * word is "Local" — customers care that inference stays on the box, not which
 * daemon loads the weights.
 */
export function inferenceRuntimeLabel(runtime: string | null | undefined): string {
  switch ((runtime ?? "").trim().toLowerCase()) {
    case "dmr":
      return "Docker Model Runner";
    case "ollama":
      return "Ollama";
    default:
      // Never invent a runtime name. An unset/unknown value means the
      // orchestrator did not report one (an older box, or /health degraded),
      // and a generic truth beats a confident guess.
      return "On-device runtime";
  }
}
