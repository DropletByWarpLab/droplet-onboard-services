/**
 * cloud-access.service.ts — WARP-1530 / ADR-032 §3 axis (d) "Cloud" (RBAC v2 T6).
 *
 * The ONE place the orchestrator asks "may THIS person's turn run on a cloud
 * provider?". Consumers: POST /api/llm/chat and POST /api/llm/complete — every
 * route that hands a caller-chosen model to the ai-gateway.
 *
 * TWO INDEPENDENT LAYERS, BOTH FAIL-CLOSED (§3):
 *   • here, per-PERSON — the orchestrator is where user identity exists, so
 *     `role.cloudModelsAllowed` can be honoured;
 *   • services/ai-gateway/middleware/off_lan_gating.py, per-WORKSPACE — the
 *     gateway has no user identity and shouldn't; its 451 stays UNTOUCHED as
 *     the backstop. This module never removes work from it.
 *
 * The verdict is the resolver's AND-gated `cloud` field
 * (`workspace.cloud_model_escape && role.cloudModelsAllowed`) — this module
 * deliberately re-derives NEITHER limb, so a person whose role permits cloud
 * is still refused while the workspace escape is off, and vice versa.
 *
 * WHEN THE GATE DOES NOT ENGAGE (each one a deliberate, documented choice):
 *   • `service` principals (voice, mcp-server) — §3 keeps them on their
 *     dedicated `requireRoleOrService` paths and out of layer 2;
 *   • a session with no person id — there is nothing to resolve; the
 *     workspace-level gateway 451 still applies;
 *   • a turn with no cloud-resolving provider — the resolver is never read, so
 *     local chat (every box's hot path) takes ZERO new per-turn DB work.
 *
 * HOW A TURN'S PROVIDER IS RESOLVED, and why the catalogue is not enough:
 * the gateway's `/ai/models` catalogue is NOT a list of every model a cloud
 * provider will serve. Its cloud half is six hardcoded ids
 * (`providers/openai_cloud.py` OPENAI_MODELS, `providers/anthropic_cloud.py`
 * ANTHROPIC_MODELS). Actual routing is by PREFIX — `router.py`
 * `resolve_provider` / PROVIDER_PREFIXES — and the cloud providers forward
 * whatever string they are handed straight to litellm
 * (`f"openai/{model}"`). So `gpt-5`, `o3-mini`, `gpt-4o-2024-08-06` and
 * `claude-opus-4-20250514` all reach a cloud provider while resolving to
 * NOTHING in the catalogue. Trusting the catalogue alone would let a
 * cloud-denied person out with one crafted model string, and the ai-gateway
 * backstop cannot help: it is workspace-scoped, and per-person denial only
 * matters while the workspace escape is ON.
 *
 * So the resolution order below mirrors the gateway's, in the same order:
 *   1. the caller's forwarded provider, when it names a non-local one;
 *   2. the catalogue, which is authoritative WHEN it resolves (it carries the
 *      box's actually-pulled local models);
 *   3. the PROVIDER_PREFIXES mirror below;
 *   4. otherwise not-cloud — the gateway's own `return self.local` default.
 *
 * The mirror is duplicated knowledge, deliberately, on the same terms as
 * `LOCAL_PROVIDERS` above: it is pinned to its source by a parity test that
 * PARSES `router.py` at test time (`cloud-access.service.test.ts`), so drift
 * fails CI rather than silently reopening this hole.
 */
import { getModelProvider } from "./ai-gateway.client.js";
import { resolveEffectiveAccess } from "./effective-access.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("cloud-access");

/**
 * Providers exempt from the cloud gate. Mirrors `LOCAL_PROVIDERS` in
 * services/ai-gateway/middleware/off_lan_gating.py — the two layers must agree
 * on what "local" means or one of them gates the wrong traffic. A parity test
 * parses that file and fails CI on drift.
 *
 * WARP-1926: `local` is the canonical name the gateway now emits. The two
 * `ollama*` spellings are LEGACY ALIASES and must stay — `provider` is a
 * PERSISTED column (`ChatSession.provider`, `ChatMessage.provider`), so every
 * turn recorded before the rename carries `ollama` on disk. Widening this set
 * is the safe direction; narrowing it refuses on-box traffic.
 */
export const LOCAL_PROVIDERS: ReadonlySet<string> = new Set([
  "local",
  "ollama",
  "ollama_local",
]);

/**
 * The CANONICAL local-provider name — what the gateway emits today and what
 * every new row persists. Distinct from `LOCAL_PROVIDERS`, which is the wider
 * *accept* set (canonical + legacy aliases). Emit this; accept those.
 */
export const LOCAL_PROVIDER = "local";

/** True for a provider that never leaves the LAN. */
export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider.trim().toLowerCase());
}

/**
 * The LOCAL half of `router.py`'s PROVIDER_PREFIXES. Checked FIRST, exactly as
 * the gateway checks it: the dict iterates in insertion order with `local`
 * listed first, so a local family whose name collides with a cloud prefix wins.
 * `gpt-oss` is the canonical case — OpenAI's OPEN-WEIGHTS model, served on-box,
 * whose name starts with the cloud prefix `gpt`. Dropping this ordering would
 * 451 the box's own model.
 */
export const LOCAL_MODEL_PREFIXES: readonly string[] = [
  "llama",
  "mistral",
  "phi",
  "gemma",
  "qwen",
  "codellama",
  "deepseek",
  "gpt-oss",
];

/** The CLOUD half of `router.py`'s PROVIDER_PREFIXES, in the same order. */
export const CLOUD_MODEL_PREFIXES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["anthropic", ["claude"]],
  ["openai", ["gpt", "o1", "o3"]],
];

/**
 * Which provider `router.py` would route `model` to on NAME alone — the
 * fallback for everything the catalogue does not know. Mirrors
 * `resolve_provider`'s order: the configured local model wins outright, then
 * local prefixes, then cloud prefixes. `undefined` = no prefix matched, which
 * is the gateway's `return self.local` default (i.e. local).
 */
export function providerForModelName(model: string): string | undefined {
  const name = model.trim().toLowerCase();
  if (!name) return undefined;

  // router.py: `if self._local_model and model_lower == self._local_model`.
  // The box's configured model routes local even when its name collides with
  // a cloud prefix — read at call time so a deployment override applies
  // without a restart, matching how the route reads it elsewhere.
  const configuredLocal = (process.env.LLM_MODEL ?? "").trim().toLowerCase();
  if (configuredLocal && name === configuredLocal) return LOCAL_PROVIDER;

  if (LOCAL_MODEL_PREFIXES.some((p) => name.startsWith(p))) return LOCAL_PROVIDER;
  for (const [provider, prefixes] of CLOUD_MODEL_PREFIXES) {
    if (prefixes.some((p) => name.startsWith(p))) return provider;
  }
  return undefined;
}

/** The sovereignty channel this refusal belongs to (the ai-gateway's key). */
const CHANNEL = "cloud_model_escape";

export interface CloudRefusalBody {
  error: string;
  channel: string;
  provider: string;
  /** `per_person` — distinguishes this from the gateway's workspace 451. */
  scope: "per_person";
  message: string;
}

export type CloudTurnDecision =
  | { kind: "allowed" }
  | { kind: "refused"; status: number; body: CloudRefusalBody };

export interface CloudTurnArgs {
  /** The authenticated principal (`req.user`). */
  user: { id?: string; role?: string } | undefined;
  /** The model the caller asked for. */
  model: string;
  /** The provider the caller forwarded, when it sent one. Never trusted alone. */
  provider?: string;
}

/**
 * 451 Unavailable For Legal Reasons — the repo's sovereignty signal
 * (routes/email.ts, routes/web.ts, ai-gateway's off-LAN gate). The message is
 * honest about the AND-gate without claiming which limb closed: the resolver
 * returns one boolean by design, and guessing at the cause would send an
 * operator to the wrong settings page.
 */
function refusedBody(provider: string): CloudRefusalBody {
  return {
    error: "off_lan_blocked",
    channel: CHANNEL,
    provider,
    scope: "per_person",
    message:
      "Cloud models are not available for this account. Cloud access needs BOTH " +
      "the box's off-LAN cloud_model_escape channel (Settings → Off-LAN " +
      "allowlist) AND a role that permits cloud models (Settings → Access & " +
      "Roles). This request was answered by neither — nothing was sent off the LAN.",
  };
}

/**
 * 503, not 451 — the email.ts split. A gate we could not READ is a transient
 * infrastructure failure needing a different operator response than a channel
 * someone deliberately closed; collapsing them into one status sends people to
 * the wrong remedy. Fail-CLOSED either way: cloud egress never opens because
 * the gate broke.
 */
function unavailableBody(provider: string): CloudRefusalBody {
  return {
    error: "access_gate_unavailable",
    channel: CHANNEL,
    provider,
    scope: "per_person",
    message:
      "Cloud access could not be verified right now, so the request was not sent " +
      "off the LAN. Try again shortly.",
  };
}

const ALLOWED: CloudTurnDecision = { kind: "allowed" };

/**
 * Resolve which non-local provider this turn would reach, or `null` when it
 * would stay local. Mirrors `router.py::resolve_provider`'s order (see the
 * header) so the gate's verdict matches where the request would ACTUALLY go.
 *
 * Every signal that says "cloud" is enough, in either direction: a client that
 * mislabels a cloud model as `ollama` is caught by the catalogue or the prefix
 * mirror; a client that forwards a cloud provider for a model neither knows is
 * caught by the forwarded value. No lie opens the gate.
 *
 * WARP-1983 — EXPORTED for the stored-content egress gate in `routes/llm.ts`,
 * which must be able to ask "is this turn leaving the LAN?" on its own.
 * Deliberately NOT answered by reading `decideCloudTurn`'s verdict: that
 * function short-circuits to ALLOWED for `service` principals and for sessions
 * with no person id BEFORE it ever resolves a provider, so a voice-principal
 * turn on a cloud model returns the same `allowed` as a local one. Keying the
 * egress gate off that would let exactly the principal with no human in the
 * loop carry Drive content off-box. "May this person use cloud?" and "is this
 * request leaving the box?" are different questions and are asked separately.
 */
export async function resolveOffLanProvider(args: CloudTurnArgs): Promise<string | null> {
  const forwarded = args.provider?.trim();
  if (forwarded && !isLocalProvider(forwarded)) return forwarded;

  let catalogued: string | undefined;
  try {
    catalogued = await getModelProvider(args.model);
  } catch (err) {
    // `findModelInfo` swallows its own transport errors and returns undefined,
    // so this is defensive against a future client change rather than a path
    // seen today. It falls through to the prefix mirror instead of returning
    // "local" — an unreadable catalogue must not become a bypass.
    logger.warn(
      { err, model: args.model },
      "model-provider lookup threw; falling back to the PROVIDER_PREFIXES mirror",
    );
  }
  // The catalogue is authoritative when it resolves: it carries the box's
  // actually-pulled local models, so a local model whose name collides with a
  // cloud prefix is settled here before the mirror ever runs.
  if (catalogued) return isLocalProvider(catalogued) ? null : catalogued;

  // Uncatalogued — the case the six hardcoded cloud ids leave wide open.
  const byName = providerForModelName(args.model);
  if (byName && !isLocalProvider(byName)) return byName;
  return null;
}

/**
 * The per-person cloud verdict for one turn. Callers render
 * `decision.body` at `decision.status` and return WITHOUT dispatching —
 * never a silent downgrade to the local model, which would answer a
 * question the person never asked with a model they did not choose.
 */
export async function decideCloudTurn(args: CloudTurnArgs): Promise<CloudTurnDecision> {
  // §3: service principals never resolve through layer 2. Checked FIRST so
  // the voice loop's hot path adds no lookup at all.
  if (args.user?.role === "service") return ALLOWED;
  const userId = args.user?.id;
  if (!userId) return ALLOWED;

  const provider = await resolveOffLanProvider(args);
  if (!provider) return ALLOWED; // local turn — the resolver is never read

  let cloud: boolean;
  try {
    const access = await resolveEffectiveAccess(userId);
    if (!access) {
      // The session outlived its User row. We cannot establish permission,
      // so we do not grant it.
      logger.warn({ userId }, "cloud gate: no such user; refusing cloud turn");
      return { kind: "refused", status: 503, body: unavailableBody(provider) };
    }
    cloud = access.cloud;
  } catch (err) {
    logger.warn({ err, userId }, "cloud gate: effective-access read failed; failing closed");
    return { kind: "refused", status: 503, body: unavailableBody(provider) };
  }

  if (cloud) return ALLOWED;
  return { kind: "refused", status: 451, body: refusedBody(provider) };
}
