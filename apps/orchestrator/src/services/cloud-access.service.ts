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
 * WHY AN UNRESOLVABLE MODEL COUNTS AS NOT-CLOUD: the provider comes from the
 * gateway's own model catalogue, which only lists models a configured provider
 * can actually serve. A model absent from it has no reachable cloud provider
 * behind it, and the gateway's fail-closed 451 still guards the workspace limb.
 * The alternative — copying `router.py`'s PROVIDER_PREFIXES table into the
 * orchestrator — would be exactly the kind of duplicated routing knowledge that
 * drifts.
 */
import { getModelProvider } from "./ai-gateway.client.js";
import { resolveEffectiveAccess } from "./effective-access.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("cloud-access");

/**
 * Providers exempt from the cloud gate. Mirrors `LOCAL_PROVIDERS` in
 * services/ai-gateway/middleware/off_lan_gating.py — the two layers must agree
 * on what "local" means or one of them gates the wrong traffic.
 */
export const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["ollama", "ollama_local"]);

/** True for a provider that never leaves the LAN. */
export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider.trim().toLowerCase());
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
 * would stay local.
 *
 * BOTH signals count, and either one being cloud is enough: the catalogue
 * (authoritative — it is the gateway's own routing table) and the caller's
 * forwarded `provider`. A client that mislabels a cloud model as `ollama`
 * is caught by the catalogue; a client that forwards a cloud provider for a
 * model the catalogue does not know is caught by the forwarded value. Neither
 * direction of a lie opens the gate.
 */
async function cloudProviderFor(args: CloudTurnArgs): Promise<string | null> {
  const forwarded = args.provider?.trim();
  if (forwarded && !isLocalProvider(forwarded)) return forwarded;

  let catalogued: string | undefined;
  try {
    catalogued = await getModelProvider(args.model);
  } catch (err) {
    // The client already degrades to `undefined` internally; a throw here
    // would be a transport surprise. Unknown provider = no evidence of a
    // reachable cloud route (see the header note).
    logger.warn({ err, model: args.model }, "model-provider lookup failed; treating turn as local");
    return null;
  }
  if (catalogued && !isLocalProvider(catalogued)) return catalogued;
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

  const provider = await cloudProviderFor(args);
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
