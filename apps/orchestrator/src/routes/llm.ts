import { Router } from "express";
import { z } from "zod";
import { BrainMemoryItemStatus, type PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import * as aiGateway from "../services/ai-gateway.client.js";
import {
  attachImageBlocksToLastUserMessage,
  buildImageBlocks,
  decideVisionRoute,
} from "../services/vision-attachments.service.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import { completeOnce } from "../services/llm-complete.service.js";
import {
  runAgent,
  type AgentDeps,
  type AgentResult,
} from "../services/llm-agent.service.js";
import { EXCLUDED_FROM_CHAT_TOOLS } from "../services/chat-tool-scope.js";
import {
  isPrivilegedRole,
  narrowToolNamesForPrincipal,
  resolveToolAccessScope,
  VOICE_WRITE_TOOLS,
  WRITE_TOOLS,
  type ToolAccessScope,
} from "../services/tool-access.service.js";
import { createEnhancementDeps } from "../services/query-enhancement.service.js";
import { createFileCitationService } from "../services/file-citation.service.js";
import { TOOLS, TOOL_CATALOG, TOOL_DOMAINS } from "@droplet/tools-core";
import { mcpClient } from "../services/mcp-client.singleton.js";
import type { McpCallContext } from "../services/mcp-client.service.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { encodeSSE, type SSEEvent } from "../types/sse-events.js";
import type { ChatMessage, ModelsResponse } from "../types/index.js";
import { contentToText } from "../types/index.js";
import {
  ChatPersistenceService,
  type PersistedToolCall,
} from "../services/chat-persistence.service.js";
import { publish as mqttPublish } from "../services/mqtt.service.js";
import { decryptChunkRows } from "../services/file-search.service.js";
import { probeColdModel } from "../services/model-readiness.service.js";
import {
  readActiveChatModel,
  resolveActiveChatModel,
  localModelIdentifiers,
} from "../services/active-model.service.js";
import { requireRole } from "../middleware/auth.js";
import { decideCloudTurn, isLocalProvider } from "../services/cloud-access.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { visibleAudiences } from "../services/memory-audience.js";
import { loadIdentityPrompt } from "../services/identity-prompt.js";
import { composeToolGuidance } from "../services/tool-guidance.service.js";
import { getPersona, composePersonaBlock } from "../services/persona.service.js";
import {
  getInterviewOverlay,
  resetOnboardingForDeletedSession,
  INTERVIEW_CONDUCTOR_BLOCK,
} from "../services/business-onboarding.service.js";
import {
  getBusinessProfile,
  composeBusinessBlock,
  type WorkspaceTypeName,
} from "../services/business-profile.service.js";
import {
  degradeToFit,
  type RequestSizeParts,
} from "../services/context-budget.service.js";

/** WARP-456: severity bucket the dashboard renders for the activity feed. */
function activitySeverityForTurnStatus(
  status: "completed" | "failed" | "aborted",
): "ok" | "err" | "warn" {
  if (status === "completed") return "ok";
  if (status === "failed") return "err";
  return "warn"; // aborted — neutral-bad
}

/** WARP-456: drop `undefined` keys so the signed `refs` JSON is dense
 *  (matches the canonical-JSON shape the signer hashes). */
function stripUndefined(
  o: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const MODELS_CACHE_KEY = "llm:models";
const MODELS_CACHE_TTL = 30;

/**
 * WARP-329: per-stream debounce for flushing assistant content to Postgres.
 * Trade-off: too short = thrashing the DB on every SSE delta; too long =
 * mid-turn refresh shows stale content. 500 ms is the same cadence
 * `services/file-indexer` uses for chunk persistence.
 */
const STREAM_FLUSH_INTERVAL_MS = 500;

/**
 * WARP-329 — MQTT contract documented for downstream consumers.
 *
 * Topic:   `droplet/chat/<userId>/turn-completed`
 * QoS:     0 (best-effort; dashboard reconnects refresh state on its own)
 * Payload:
 *   {
 *     conversationId:    string  // ChatSession.id
 *     messageId:         string  // ChatMessage.id (the assistant row)
 *     status:            "completed" | "failed" | "aborted"
 *     snippet:           string  // first ~140 chars of assistant content
 *     completedAt:       string  // ISO 8601
 *   }
 *
 * Today the dashboard's WS bridge forwards this to the chat surface so
 * background tabs can fire a Notification when an in-flight turn finishes.
 * A future push-dispatcher service (mobile push, web-push for closed tabs)
 * MUST subscribe to the same topic — the payload contract above is the
 * stable wire.
 */
const CHAT_TURN_COMPLETED_TOPIC = (userId: string): string =>
  `droplet/chat/${userId}/turn-completed`;

interface TurnCompletedPayload {
  conversationId: string;
  messageId: string;
  status: "completed" | "failed" | "aborted";
  snippet: string;
  completedAt: string;
}

function publishTurnCompleted(
  userId: string | undefined,
  payload: TurnCompletedPayload,
): void {
  if (!userId) return;
  try {
    // `publish` takes Record<string, unknown>; the typed payload above
    // satisfies the shape at runtime, just not at the interface level.
    mqttPublish(
      CHAT_TURN_COMPLETED_TOPIC(userId),
      payload as unknown as Record<string, unknown>,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[llm/chat] MQTT publish failed (non-fatal):", err);
  }
}

/**
 * WARP-1479 — record WHY a turn produced no visible answer.
 *
 * The customer already gets an honest failed turn (the empty-completion
 * rewrite below); this is the operator's half. Blank turns are the eval
 * suite's largest failure class and nothing in the logs currently says
 * whether the model returned nothing, thought without answering, or our own
 * sanitizer demoted the completion — so every fix attempt would be a guess.
 * Counts and labels only; the raw excerpt rides along solely when
 * AGENT_BLANK_TURN_DEBUG is set (it can quote the user's own documents).
 */
function logBlankAnswer(
  result: AgentResult,
  conversationId: string | null,
  assistantMessageId: string | null,
): void {
  if (!result.blankDiagnostics) return;
  // eslint-disable-next-line no-console
  console.warn(
    "[llm/chat] blank_final_answer",
    JSON.stringify({
      conversationId,
      assistantMessageId,
      stop_reason: result.stop_reason,
      iterations: result.iterations,
      ...result.blankDiagnostics,
    }),
  );
}

/**
 * WARP-1602 — the inverse of `logBlankAnswer`: record a turn whose visible
 * answer still reads like the model's chain-of-thought.
 *
 * WARP-1479 gave blank turns an attribution line so the eval suite's largest
 * failure class stopped being a guess. Analysis-polluted turns had no such
 * line at all — they scored as healthy because the bubble was non-empty, which
 * is exactly how this leak survived from WARP-495 to the .87 walkthrough. Same
 * discipline: labels + counts always, the excerpt only under
 * AGENT_BLANK_TURN_DEBUG (a polluted answer quotes the customer's documents
 * just as readily as a clean one).
 */
function logPollutedAnswer(
  result: AgentResult,
  conversationId: string | null,
  assistantMessageId: string | null,
): void {
  if (!result.pollutedDiagnostics) return;
  // eslint-disable-next-line no-console
  console.warn(
    "[llm/chat] polluted_final_answer",
    JSON.stringify({
      conversationId,
      assistantMessageId,
      stop_reason: result.stop_reason,
      iterations: result.iterations,
      ...result.pollutedDiagnostics,
    }),
  );
}

// /llm/chat accepts tool-role messages on replay so a client can resume a
// session that already went through the agent loop. tool_call_id / tool_calls
// are optional so plain chat callers don't have to care.
//
// WARP-304: `conversationId` lets the caller continue an existing thread.
// When absent, the server mints a new one and returns it via the
// `X-Conversation-Id` response header (set for both streaming and
// non-streaming paths so the dashboard can read it identically). `turnId`
// is a client-supplied idempotency key — re-submitting the same turn is a
// no-op on the persisted side.
const chatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.string(),
      tool_call_id: z.string().optional(),
    })
  ),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  // Mirrors the ai-gateway's pydantic bound (schemas.py: int, ge=1,
  // le=4096). Now that the value is actually forwarded (WARP-849), an
  // out-of-range number must 400 here instead of 422ing at the gateway
  // and surfacing as a 500.
  max_tokens: z.number().int().min(1).max(4096).optional(),
  // WARP-1442 — optional gpt-oss reasoning-effort control. Mirrors the
  // ai-gateway's pydantic Literal (low|medium|high); an out-of-range value
  // 400s here rather than 422ing at the gateway. Unset by an explicit caller
  // means the route may still apply the `_service:voice` server-side default
  // (see VOICE_REASONING_EFFORT); every non-voice caller stays unchanged.
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  provider: z.string().optional(),
  // Spec §1 — the cap comes from config so it matches the loop's clamp.
  max_iter: z.number().int().min(1).max(config.agentMaxIter.capIter).optional(),
  allowed_tools: z.array(z.string()).optional(),
  // Per-turn override for the agent loop's tool advertisement. "none"
  // sends ZERO tools to the model so it can't wander into a speculative
  // tool call — voice-io's intent gate sets this for greetings,
  // time-of-day, and who-are-you utterances that the system prompt
  // already answers. "auto" matches the default behaviour. When the
  // field is absent the loop applies "auto" so existing callers (chat,
  // legacy clients) keep working unchanged.
  tool_choice: z.enum(["auto", "none"]).optional(),
  conversationId: z.string().uuid().optional(),
  turnId: z.string().min(1).max(128).optional(),
  // WARP-174: setup wizard's "Ask the AI" sample prompt and similar
  // throwaway flows (system pings, health probes) set this to true
  // so the call skips ensureConversation + createTurnRows. Without
  // the flag every wizard tap creates a real ChatSession that
  // shows up in the customer's /chat history sidebar — confusing
  // first-run UX (their oldest conversation is the wizard's probe).
  ephemeral: z.boolean().optional().default(false),
  // WARP-458 — emit `{type:"reasoning_step", text}` blocks on the
  // SSE wire BEFORE any content_delta on the same turn. Defaults to
  // `false` so existing clients (legacy dashboard, voice-io) see no
  // wire-shape change. The orchestrator ALWAYS parses + persists the
  // trace to `ChatMessage.reasoning` regardless of this flag — the
  // flag gates EMISSION, not PERSISTENCE — so the dashboard can
  // lazy-load reasoning on demand without re-running the turn.
  captureReasoning: z.boolean().optional().default(false),
  // Chat attachments (WARP-203 brain-memory items) referenced by this
  // turn. The dashboard uploads files via POST /api/files/brain/upload
  // and sends the resulting itemIds here on every turn of the
  // conversation; the route verifies ownership and injects the
  // extracted content (budgeted) as a system message so the model
  // actually sees what the user attached. Capped at 8 per turn; the
  // composer enforces the same cap at attach time (useChat.attach).
  attachments: z
    .array(z.object({ itemId: z.string().min(1).max(64) }))
    .max(8)
    .optional(),
  // The dashboard's client-minted draft chat id (`chat-<ts>`), sent on
  // the FIRST turn only. Brain-memory uploads made before the server
  // assigned a conversationId are tagged with it; the route re-stamps
  // every item carrying this tag (ownership-scoped) to the new
  // conversationId, so uploads that finish mid-turn or late still join
  // the conversation (chip rehydration + per-chat export).
  draftChatId: z.string().min(1).max(128).optional(),
  // WARP-845 — file a NEWLY-created conversation under one of the
  // caller's projects (ownership-validated in ensureConversation;
  // foreign ids are silently ignored). Existing conversations are never
  // moved by a turn.
  projectId: z.string().uuid().optional(),
});

// WARP-1426 — POST /llm/complete. Single-turn, non-agentic completion:
// system prompt + user text in, completion out. `.strict()` so a caller
// that tries to smuggle `tools`, `messages`, or any agent-loop field gets
// a 400 instead of a silently narrowed request. Caps mirror the tool
// contract: `text` at 24k chars (~6k tokens) keeps a translate/summarize
// payload inside a small local model's context window; `max_tokens`
// mirrors the ai-gateway's pydantic bound (schemas.py: ge=1, le=4096).
const completeRequestSchema = z
  .object({
    system: z.string().max(4000).optional(),
    text: z.string().min(1).max(24000),
    model: z.string().max(200).optional(),
    temperature: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().min(1).max(4096).optional(),
  })
  .strict();

const CONVERSATION_ID_HEADER = "X-Conversation-Id";
/** WARP-329: assistant row id, set alongside X-Conversation-Id on the same
 *  response. The client uses it to update the matching `streaming` row when
 *  the MQTT `turn-completed` event lands. */
const ASSISTANT_MESSAGE_ID_HEADER = "X-Assistant-Message-Id";
/** WARP-844: the user row's id for this turn, set alongside the two headers
 *  above. The dashboard re-ids its optimistic user bubble with it so
 *  edit-and-resend can truncate the persisted thread by a real row id. */
const USER_MESSAGE_ID_HEADER = "X-User-Message-Id";

// RBAC helpers for /api/llm/chat. The ADR-004 tier gate itself —
// `WRITE_TOOLS`, `VOICE_WRITE_TOOLS`, `isPrivilegedRole` — moved to
// services/tool-access.service.ts in WARP-1621 so the ToolSpec run path can
// ask the SAME question this route asks. It was unreachable from there while
// it lived in a route module, and the ToolSpec surfaces consequently enforced
// only the §3 axis: a `family` user could fire `control_device` by pressing
// Run on a spec. Re-exported below so existing importers of this module are
// unaffected.
// WARP-485: `id` is the canonical User.id UUID set by authMiddleware
// when the OCS or invite paths resolve a Nextcloud username to the
// local User row. `username` is kept for back-compat (pre-WARP-485 rows
// where ChatSession.userId is still the Nextcloud username). Both
// fields populate the `candidates` array in `loadOwnedSession`.
type AuthedRequest = { user?: { id?: string; username?: string; role?: string } };

export { VOICE_WRITE_TOOLS };

export function isVoicePrincipal(user: AuthedRequest["user"]): boolean {
  return user?.id === "_service:voice" && user?.role === "service";
}

type ReasoningEffort = "low" | "medium" | "high";

/**
 * WARP-1442 — the reasoning-effort default applied to the always-on voice
 * principal when it sends no explicit value. Voice replies are one short
 * spoken sentence, so the gpt-oss reasoning channel is wasted decode latency;
 * defaulting to "low" trims the inaudible reasoning-token overhead WITHOUT any
 * voice-io change (the whole knob stays server-side). Read from
 * `VOICE_REASONING_EFFORT` at call time (like DEFAULT_MODEL below) so it's
 * per-deployment overridable and testable. Anything other than a valid level
 * falls back to "low" — the point is trimming voice latency, so a misconfigured
 * env must not silently restore heavy reasoning.
 */
function voiceReasoningEffortDefault(): ReasoningEffort {
  const v = (process.env.VOICE_REASONING_EFFORT ?? "").trim().toLowerCase();
  return v === "medium" || v === "high" ? v : "low";
}

/**
 * WARP-1442 — resolve the effective reasoning effort for a turn. An explicit
 * caller value always wins; otherwise the voice principal gets the server-side
 * default and every other caller gets `undefined` (no field forwarded → the
 * gateway request is byte-for-byte unchanged for the dashboard / wizard).
 */
export function resolveReasoningEffort(
  explicit: ReasoningEffort | undefined,
  isVoice: boolean,
): ReasoningEffort | undefined {
  if (explicit) return explicit;
  return isVoice ? voiceReasoningEffortDefault() : undefined;
}

/**
 * WARP-1529 (RBAC v2 T5) — enforcement point 1 of 2: the CATALOG build.
 *
 * `scope` is the caller's resolved §3 tool reach (tool-access.service.ts).
 * `null`/omitted means no per-role narrowing applies — the owner's §3
 * bypass, service principals, and every person with no AccessRole (i.e.
 * every user on a box today). On that path this function is byte-for-byte
 * what it was before T5.
 *
 * With a scope, the §3 tool-domain axis composes ON TOP of the shipped
 * ADR-004 write filter; the two never fight, because both only ever remove.
 * Note the `undefined` requested list stays `undefined` for privileged
 * callers even under a scope: materialising it here would bypass
 * EXCLUDED_FROM_CHAT_TOOLS in the agent loop and blow the WARP-1118 context
 * budget. The loop applies the same scope to its own advertised pool
 * (llm-agent.service.ts), so that path is narrowed there instead.
 *
 * WARP-1621 — this is now a thin wrapper. Both axes live in
 * `narrowToolNamesForPrincipal` (tool-access.service.ts) so the ToolSpec run
 * path can ask the identical question; all this function still owns is the
 * chat-specific `undefined` handling (privileged ⇒ stay undefined; otherwise
 * materialise the live registry). The per-name verdict is not reimplemented
 * anywhere.
 */
export async function narrowAllowedToolsForRole(
  role: string | undefined,
  requestedAllowed: string[] | undefined,
  isVoice = false,
  scope: ToolAccessScope | null = null,
): Promise<string[] | undefined> {
  // Distinguish `undefined` (no list supplied → fall through to the
  // role default) from an explicit empty array (caller asked for ZERO
  // tools). `.length` truthiness would conflate the two and grant the
  // full non-write registry for an intentional `allowed_tools: []`.
  if (requestedAllowed !== undefined) {
    return narrowToolNamesForPrincipal(requestedAllowed, role, scope, isVoice);
  }
  if (isPrivilegedRole(role)) return undefined;
  // Default for unprivileged users: every tool the live MCP server
  // advertises, minus write tools (minus all but VOICE_WRITE_TOOLS for
  // voice). listTools() throws if the child crashed mid-runtime — fall back
  // to an empty allowed set in that case so the model sees zero tools rather
  // than something privileged.
  const tools = await mcpClient.listTools().catch(() => []);
  return narrowToolNamesForPrincipal(
    tools.map((t) => t.name),
    role,
    scope,
    isVoice,
  );
}

// D-7: enforcement deferred — UserUsagePolicy.llmDailyMessageCap (WARP-1271)
// is persisted but NOT enforced here. A future ticket wires a Redis UTC-day
// counter beside narrowAllowedToolsForRole and returns an honest 429 when a
// non-privileged caller's daily message count exceeds their configured cap.
// Do not read llmDailyMessageCap in this file until that ticket lands.

/**
 * WARP-1121 (§9.3/§15) — server-side write-tool strip for interview turns.
 * The interview session must never carry write tools REGARDLESS of the
 * caller's role or `allowed_tools`: the commit is a human-initiated REST
 * write (D-5), so the model gets no write surface inside the interview even
 * for the owner. `undefined` (privileged caller = full registry) resolves
 * to the live tool list first so the subtraction is real, not symbolic.
 */
async function stripWriteToolsForInterview(
  allowed: string[] | undefined,
): Promise<string[]> {
  if (allowed !== undefined) {
    return allowed.filter((n) => !WRITE_TOOLS.has(n));
  }
  const tools = await mcpClient.listTools().catch(() => []);
  return tools.map((t) => t.name).filter((n) => !WRITE_TOOLS.has(n));
}

// Belt-and-braces: even if the agent loop itself enforces the narrowed
// list, refuse at request-time if a client has planted tool-call entries
// invoking a write tool inside replayed assistant history. /chat
// permits role="tool" for resume-session callers but a spoofed
// assistant turn that sets `tool_calls` would otherwise bypass the
// narrowed-tool check on the next iteration.
//
// Takes the RAW request body (not the Zod-parsed shape) because Zod's
// default object schema strips unrecognized keys, including `tool_calls`
// — so reading from parsed.data would always be empty.
export function replayedWriteToolAttempt(
  rawMessages: unknown,
  exempt?: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(rawMessages)) return false;
  return rawMessages
    .flatMap((m) => {
      if (!m || typeof m !== "object") return [];
      const calls = (m as { tool_calls?: unknown }).tool_calls;
      return Array.isArray(calls) ? calls : [];
    })
    .some((c) => {
      if (!c || typeof c !== "object") return false;
      const fn = (c as { function?: { name?: unknown } }).function;
      const name = fn?.name;
      // WARP-1398: a replayed write tool the caller is actually allowed (the
      // voice principal's VOICE_WRITE_TOOLS) is not a spoof.
      return (
        typeof name === "string" &&
        WRITE_TOOLS.has(name) &&
        !(exempt?.has(name) ?? false)
      );
    });
}

// WARP-329 replaced the post-stream `persistTurn` helper with
// save-on-send: see `persistence.createTurnRows` (pre-agent) +
// `persistence.finalizeAssistantMessage` (post-agent) inline below.

// ── Base system prompt (RAG + durable-memory steering) ──
//
// Without a server-side base prompt the model receives ZERO guidance
// about this appliance's retrieval and memory surfaces — RAG invocation
// rode entirely on the search_content tool description, which already
// failed in practice (the WARP-642 hallucinated-tool guard exists
// because gpt-oss:20b invented `knowledge_base_search`), and WARP-461
// memory facts only surfaced if the model spontaneously called
// memory_recall. The base prompt names the tools and inlines the active
// facts (bounded below) so both work by default.
/**
 * Build the base prompt from the caller's EFFECTIVE tool set. Mentioning
 * a tool the role can't call is worse than silence: non-privileged roles
 * (family/guest/service) have write tools like memory_extract_fact
 * stripped by narrowAllowedToolsForRole, and a system prompt instructing
 * a stripped tool sends small local models straight into the WARP-642
 * hallucinated-tool guard (and, after 3 guard-only iterations, a failed
 * turn). `allowed` undefined = privileged caller = every tool.
 */
function buildBaseSystemPrompt(
  allowed: string[] | undefined,
  /**
   * WARP-1118 — the composed personality block (persona.service.ts). Spliced
   * in RIGHT AFTER identity and BEFORE tool guidance (§7.2): personality
   * refines HOW Droplet talks without outranking the identity layer's
   * safety/honesty rules (the block itself carries that reminder as its
   * prefix). Read fresh from Prisma each request by the caller; passed in
   * here so this stays a pure string builder. "" (or undefined) = no persona
   * block this turn — e.g. the estimator degraded it away under overflow, or
   * the fresh read failed (fail-open, same posture as the memory block).
   */
  personaBlock?: string,
  /**
   * WARP-1120 (§8/§10/§15) — the role-filtered business-context block
   * (business-profile.service.ts). Spliced in RIGHT AFTER the persona block
   * and BEFORE tool guidance (§10 composition order), rendered inside its own
   * §15 data-framing delimiter so the model treats it as reference data, not
   * directives. Already role-filtered by the composer (owner/admin → summary +
   * fields, family → summary only, guest/service → ""), and empty entirely on
   * a non-BUSINESS box. "" (or undefined) = no business block this turn — the
   * estimator degraded it away (dropped 1st), the box is HOME-typed, or the
   * fresh read failed (fail-open).
   */
  businessBlock?: string,
): string {
  // Identity leads: the full "who you are / what this box does" block
  // from data/droplet-identity.md (fail-open to the legacy one-liner),
  // shared by every surface — dashboard, voice, external MCP clients.
  const lines = [loadIdentityPrompt()];
  // Personality is appended immediately after identity, before tool
  // guidance — one injection owner for the persona block on this path.
  if (personaBlock && personaBlock.length > 0) {
    lines.push("", personaBlock);
  }
  // Business context follows persona, still before tool guidance. Summary-
  // first + delimiter-framed by the composer; a truncation loses detail, not
  // meaning.
  if (businessBlock && businessBlock.length > 0) {
    lines.push("", businessBlock);
  }
  // Tool guidance is composed per-category from the caller's EFFECTIVE
  // set (tool-guidance.service.ts) — the WARP-642 never-name-a-stripped-
  // tool invariant lives there, with its own unit tests.
  const guidanceBlock = composeToolGuidance(allowed);
  if (guidanceBlock.length > 0) {
    lines.push("", guidanceBlock);
  }
  return lines.join("\n");
}

/** Bounds for the durable-memory block appended to the base prompt.
 *  MemoryFact rows are short one-liners; 20 facts / 2k chars keeps the
 *  block well under the attachment/pin budgets while covering every
 *  realistic household fact list. Older facts beyond the cap stay
 *  reachable via the memory_recall tool. */
const MEMORY_FACTS_LIMIT = 20;
const MEMORY_FACTS_CHAR_BUDGET = 2000;

/** Render the active WARP-461 memory facts as a bounded bullet list,
 *  or "" when none exist. Newest first — when the budget bites, recent
 *  facts win. */
async function buildMemoryFactsBlock(
  prisma: PrismaClient,
  /** Caller's role — facts are filtered to the audiences this role may
   *  read (WARP-845 role-scoped distribution). */
  role: string | undefined,
): Promise<string> {
  const facts = await prisma.memoryFact.findMany({
    where: { active: true, audience: { in: visibleAudiences(role) } },
    orderBy: { addedAt: "desc" },
    take: MEMORY_FACTS_LIMIT,
  });
  const lines: string[] = [];
  let used = 0;
  for (const f of facts) {
    const line = `- [${f.category}] ${f.fact}`;
    if (used + line.length > MEMORY_FACTS_CHAR_BUDGET) break;
    used += line.length;
    lines.push(line);
  }
  if (lines.length === 0) return "";
  return (
    "\n\nDurable memory — facts previously saved for this business:\n" +
    lines.join("\n")
  );
}

// ── Chat-attachment context injection ──
//
// Budgets are deliberately conservative: local models often run with a
// small context window (Ollama defaults to a few thousand tokens), and
// the inlined attachment text shares that window with the system
// prompt, pins, history, and tool results. 12k chars ≈ 3k tokens total;
// anything beyond the budget is reachable via `search_content` (the
// file-indexer embedded the full document into FileContentChunk).
const ATTACHMENT_PER_ITEM_CHAR_BUDGET = 4000;
const ATTACHMENT_TOTAL_CHAR_BUDGET = 12000;
/** Upper bound on chunk rows fetched per item — bounds the query, and
 *  hitting it implies the document continues beyond what we inline. */
const ATTACHMENT_CHUNK_FETCH_CAP = 30;

/**
 * Build the system-message text describing the turn's attachments, or
 * null when none of the referenced items belong to the caller.
 *
 * Ownership is enforced the same way as /api/files/brain/*: the query
 * filters by `userId`, so a foreign or unknown itemId simply drops out
 * (no existence leak, no content leak). Ready items get their extracted
 * text inlined from FileContentChunk (chunkIdx order — the indexer
 * writes the document linearly); queued/indexing and failed items get a
 * one-line status note so the model can tell the user what's going on
 * instead of hallucinating content.
 */
async function buildAttachmentContext(
  prisma: PrismaClient,
  userId: string,
  refs: { itemId: string }[],
): Promise<string | null> {
  const ids = Array.from(new Set(refs.map((r) => r.itemId)));
  const items = await prisma.brainMemoryItem.findMany({
    where: { id: { in: ids }, userId },
  });
  if (items.length === 0) return null;
  // Preserve the client's order (upload order) rather than DB order.
  const byId = new Map(items.map((i) => [i.id, i]));

  let remainingBudget = ATTACHMENT_TOTAL_CHAR_BUDGET;
  let anyTruncated = false;
  let anyReady = false;
  const sections: string[] = [];
  let n = 0;
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) continue;
    n += 1;
    const mime = item.mimeType ? ` (${item.mimeType})` : "";
    const head = `[${n}] "${item.filename}"${mime}`;
    if (item.status === BrainMemoryItemStatus.ready) {
      anyReady = true;
      const chunks = await prisma.fileContentChunk.findMany({
        where: { brainItemId: item.id },
        orderBy: { chunkIdx: "asc" },
        select: { text: true },
        take: ATTACHMENT_CHUNK_FETCH_CAP,
      });
      // WARP-242: brain chunks hold dcv1 ciphertext at rest under the item's
      // per-document DEK — decrypt-on-read BEFORE the text enters the LLM
      // context. Unreadable chunks (DEK crypto-shredded) are dropped; when
      // everything is unreadable the empty-body branch below explains the
      // attachment instead of inlining garbage.
      const readable = await decryptChunkRows(
        prisma,
        chunks.map((c) => ({
          text: c.text,
          brainItemId: item.id,
          path: item.filename,
        })),
      );
      const fullText = readable.map((c) => c.text).join("\n").trim();
      const budget = Math.max(
        0,
        Math.min(ATTACHMENT_PER_ITEM_CHAR_BUDGET, remainingBudget),
      );
      const body = fullText.slice(0, budget);
      remainingBudget -= body.length;
      const truncated =
        body.length < fullText.length ||
        chunks.length === ATTACHMENT_CHUNK_FETCH_CAP;
      if (truncated) anyTruncated = true;
      if (body.length === 0) {
        // Either the extractor produced no text (e.g. image with no
        // OCR-able content) or the total budget is exhausted.
        sections.push(
          `${head} — no inlined content${truncated ? " (budget exhausted; retrieve it via search_content)" : " (no text could be extracted)"}.`,
        );
      } else {
        sections.push(
          `${head}:\n"""\n${body}${truncated ? "\n…[truncated]" : ""}\n"""`,
        );
      }
    } else if (item.status === BrainMemoryItemStatus.failed) {
      sections.push(
        `${head} — could not be processed (extraction failed). Tell the user if they ask about it.`,
      );
    } else {
      // indexing | queued_for_transcription
      sections.push(
        `${head} — still being processed; its content is not available yet. Tell the user if they ask about it.`,
      );
    }
  }
  if (sections.length === 0) return null;

  const lines = [
    "The user attached the following file(s) to this conversation. " +
      "Treat them as primary context for the user's request.",
    "",
    ...sections,
  ];
  if (anyTruncated) {
    lines.push(
      "",
      "Some attachment content was truncated. Call the search_content " +
        "tool to retrieve additional passages from these documents when " +
        "the inlined excerpt is not enough.",
    );
  } else if (anyReady) {
    lines.push(
      "",
      "Use the search_content tool if you need additional passages from " +
        "the user's stored documents.",
    );
  }
  return lines.join("\n");
}

export function createLlmRouter(prisma: PrismaClient): Router {
  const router = Router();
  const persistence = new ChatPersistenceService(prisma);

  // List available models. Degrade gracefully when the AI gateway is
  // unreachable (down / disabled / transient network blip): serve an empty
  // model list instead of 500ing the dashboard's 30s SWR poll and the setup
  // wizard's AI step. Mirrors /api/models (models-summary.service.ts), which
  // already returns an empty local list on the same failure.
  router.get("/llm/models", async (_req, res, next) => {
    try {
      // WARP-1112 — stamp the box's active local model as `defaultModel` on
      // whatever list we return, so the dashboard chat can default its picker
      // to it (instead of just "the first model in the list"). Merged fresh —
      // NOT part of the cached object — so a PATCH /api/models/active takes
      // effect on the next poll without a cache-invalidation dance. A
      // settings-read hiccup degrades to `defaultModel: null`, never an error.
      //
      // WARP-1511: `degraded` (the models list itself is unreachable or its
      // ollama listing is known-partial — the three call sites below pass it
      // explicitly) means `resp.models` can't be trusted as the complete
      // installed set, so the resolver gets `null` instead and passes the
      // stored value through unresolved rather than nulling it out — or
      // fabricating a fallback — against an incomplete list. `cached` is
      // never a degraded snapshot (only a healthy response gets cached
      // below), so its call keeps the default (not degraded).
      const stampDefault = async (
        resp: ModelsResponse,
        degraded = false,
      ): Promise<ModelsResponse> => {
        try {
          const active = resolveActiveChatModel(
            await readActiveChatModel(prisma),
            degraded ? null : localModelIdentifiers(resp.models),
          );
          return { ...resp, defaultModel: active };
        } catch {
          return { ...resp, defaultModel: null };
        }
      };

      const cached = await cacheGet<ModelsResponse>(MODELS_CACHE_KEY);
      if (cached) {
        res.json(await stampDefault(cached));
        return;
      }

      let models: ModelsResponse;
      try {
        models = await aiGateway.listModels();
      } catch (err) {
        // Only degrade for an UNREACHABLE gateway (down / disabled / transient
        // network blip). A reachable gateway that 5xxs, or a malformed-JSON
        // response, is a real failure and must surface as an error — not be
        // masked as an empty 200. `listModels()` throws a TypeError from
        // fetch() on network failure (ENOTFOUND / ECONNREFUSED) and an
        // Error("AI Gateway timeout …") on an AbortSignal.timeout; anything
        // else (e.g. "AI Gateway error: 503", a SyntaxError from res.json())
        // re-throws to the outer next(err) handler.
        const isUnreachable =
          err instanceof TypeError ||
          (err instanceof Error &&
            /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timeout/i.test(err.message));
        if (!isUnreachable) throw err;
        // Do NOT cache the empty fallback — the next request retries the
        // gateway so the list self-heals once it is reachable again.
        // WARP-1284: `degraded: true` tells the wizard this empty list means
        // "can't reach the AI service", not "no model pulled yet".
        console.warn("[llm/models] ai-gateway unreachable; serving empty list:", err);
        const empty: ModelsResponse = { models: [], degraded: true };
        res.json(await stampDefault(empty, true));
        return;
      }
      // WARP-1284: the gateway answered, but reported that its LOCAL Ollama
      // provider raised during the listing fan-out (`degraded_providers`,
      // additive since this ticket). The models list can't be trusted as
      // complete, so stamp `degraded: true` on the forwarded response and —
      // like the unreachable fallback above — never cache it: the next
      // request re-queries so the signal clears the moment the runtime
      // recovers. A cloud-only provider failure keeps today's behavior
      // (cached, unflagged): only the on-box provider drives the wizard's
      // local-AI state. WARP-1926 — match the accept-set, not a literal.
      if (models.degraded_providers?.some(isLocalProvider)) {
        console.warn(
          "[llm/models] ai-gateway reports degraded providers; serving uncached:",
          models.degraded_providers,
        );
        res.json(await stampDefault({ ...models, degraded: true }, true));
        return;
      }
      await cacheSet(MODELS_CACHE_KEY, models, MODELS_CACHE_TTL);
      res.json(await stampDefault(models));
    } catch (err) {
      next(err);
    }
  });

  // Chat completion — drives the orchestrator agent loop end-to-end.
  // When stream=true the client receives the SSE event types defined
  // in spec §8.2 (content_delta, tool_call, tool_result, done) plus
  // WARP-458's `reasoning_step` (when the per-request
  // `captureReasoning` flag is true) and WARP-903's `model_loading`
  // (emitted FIRST, at most once, when the selected model is installed
  // in Ollama but needs a cold load). Non-streaming returns the
  // AgentResult shape (assistant message + trace + iterations +
  // stop_reason). The persisted assistant `ChatMessage.reasoning`
  // column is written REGARDLESS of `captureReasoning` so the
  // dashboard can lazy-load reasoning on demand without re-running
  // inference.
  //
  // WARP-304: every turn is persisted to `ChatSession` / `ChatMessage`.
  // On the very first turn (no `conversationId` in the body) the server
  // creates a new session keyed to the authenticated user and returns
  // its id via the `X-Conversation-Id` response header (header is set
  // for both streaming and non-streaming so the dashboard reads it
  // identically). Subsequent turns send the id back. `turnId` is a
  // client-supplied idempotency key — re-submits skip the duplicate
  // persist.
  // WARP-171: per-route guard. owner + admin + family + guest +
  // service — any human-tier role can drive their own chat session,
  // AND voice-io's service principal MUST also be able to drive the
  // agent loop (it POSTs here with SERVICE_TOKEN_VOICE; see
  // `services/voice-io/voice/llm.py`). This is a deviation from
  // ADR-004 §3 which states "service principals are read-only" — the
  // existing voice flow is the read-only-tool-surface side of that
  // contract, but the route itself must remain reachable for
  // service. Tool-level RBAC (WRITE_TOOLS narrowing in `narrowAllowedToolsForRole`)
  // is what keeps voice from issuing destructive operations.
  router.post(
    "/llm/chat",
    requireRole("owner", "admin", "family", "guest", "service"),
    async (req, res, next) => {
    try {
      const parsed = chatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request",
          details: parsed.error.flatten(),
        });
        return;
      }
      const chatReq = parsed.data;

      // A thread with no user turn is never a legitimate request — every
      // caller (dashboard replay, voice-io's system+user pair, the setup
      // wizard's single-message probe) sends one. It's the signature of a
      // client replay bug: the dashboard's retryMessage once serialized an
      // empty `messages` array and the agent loop happily answered a blank
      // thread with a plausible-looking greeting. Distinct code so the
      // dashboard's pre-stream error path (useChat.ts
      // friendlyPreStreamError) surfaces the regression visibly.
      if (!chatReq.messages.some((m) => m.role === "user")) {
        res.status(400).json({ error: "empty_replay" });
        return;
      }

      // WARP-1530 / ADR-032 §3 axis (d) — the per-person cloud gate. Consults
      // the resolver's AND-gated `cloud` BEFORE a cloud provider is selected,
      // and refuses honestly rather than silently answering with the local
      // model. Placed here — after validation, before persistence, the
      // ncToken round-trip and the agent loop — so a refused turn writes no
      // rows and touches no provider. Local turns never reach the resolver.
      // ai-gateway's workspace-level 451 is untouched and still backstops this.
      const cloudDecision = await decideCloudTurn({
        user: (req as AuthedRequest).user,
        model: chatReq.model,
        provider: chatReq.provider,
      });
      if (cloudDecision.kind === "refused") {
        res.status(cloudDecision.status).json(cloudDecision.body);
        return;
      }

      // RBAC: write tools require owner/admin. /api/llm/chat is the
      // live MCP-backed route — without this gate any authenticated
      // session could drive write tools via curl.
      // Reads `req.body.messages` (raw) for the spoof check because
      // Zod strips unrecognized keys (tool_calls) from the parsed shape.
      const role = (req as AuthedRequest).user?.role;
      // WARP-1398: the voice principal may replay/use its scoped smart-home
      // control tools; every other non-privileged caller stays write-free.
      const isVoice = isVoicePrincipal((req as AuthedRequest).user);
      // WARP-1442 — resolve the reasoning-effort knob once for this turn. The
      // voice principal defaults to "low" (server-side) when it sends nothing;
      // an explicit value always wins; every other caller resolves to
      // undefined so its gateway request is byte-for-byte unchanged. Passed to
      // both the streaming and non-streaming runAgent calls below.
      const reasoningEffort = resolveReasoningEffort(
        chatReq.reasoning_effort,
        isVoice,
      );
      if (
        !isPrivilegedRole(role) &&
        replayedWriteToolAttempt(
          (req.body as { messages?: unknown })?.messages,
          isVoice ? VOICE_WRITE_TOOLS : undefined,
        )
      ) {
        res.status(403).json({ error: "forbidden_tool_for_role" });
        return;
      }
      // WARP-1529 (RBAC v2 T5) — resolve the caller's §3 tool reach ONCE per
      // turn and hand the same value to both enforcement points: the catalog
      // narrowing just below (UX) and the agent loop's fail-closed
      // pre-dispatch re-check (the boundary). `null` for the owner, for
      // service principals, and for everyone with no AccessRole — that path
      // stays byte-for-byte what it was.
      //
      // WARP-1582 — the ONE surface allowed to answer that from the session
      // claim instead of a per-turn `User` read. It applies only when the
      // claim is present and says "no custom role", every assignment path
      // revokes the session (so the stale window is one request), and the
      // coarse ADR-004 filter below plus the replay guard above still run
      // regardless. The full trust argument, and the reason the ToolSpec
      // runner deliberately does NOT get this, live in the module doc of
      // services/tool-access.service.ts. The allowed-surface list is pinned
      // by __tests__/tool-scope-claim-trust.guard.test.ts.
      const toolAccessScope = await resolveToolAccessScope(
        prisma,
        (req as AuthedRequest).user,
        "session-claim",
      );
      let allowedForUser = await narrowAllowedToolsForRole(
        role,
        chatReq.allowed_tools,
        isVoice,
        toolAccessScope,
      );

      // WARP-1121 (§9.3) — is this turn part of the live onboarding
      // interview? One indexed read; fail-open to "not an interview" so a
      // profile-read hiccup can never take normal chat down. When active:
      // write tools are stripped SERVER-SIDE regardless of role/allowed_tools
      // (D-5/§15), and the conductor block is appended below.
      let interviewActive = false;
      if (chatReq.conversationId) {
        try {
          const overlay = await getInterviewOverlay(
            prisma,
            chatReq.conversationId,
          );
          interviewActive = overlay.active;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[llm/chat] interview-overlay probe failed:", err);
        }
      }
      if (interviewActive) {
        allowedForUser = await stripWriteToolsForInterview(allowedForUser);
      }

      // Resolve the caller's Nextcloud session token so file-tool
      // handlers (`list_files`, `read_file`, `write_file`, etc.) can
      // authenticate to Nextcloud as the dashboard user. Threaded to
      // the MCP stdio child via `McpCallContext` → `_meta.ncToken` on
      // every `tools/call`. `resolveNcToken` returns null when the
      // request has no Nextcloud session (e.g. a direct API caller
      // without the cookie); file tools will then surface
      // AUTH_REQUIRED, which is the same behavior as before WARP-104.
      const ncToken = (await resolveNcToken(req).catch(() => null)) ?? undefined;
      if (!ncToken && (req as AuthedRequest).user) {
        // An authenticated dashboard user with no NC credential is the
        // signature of an unprovisioned session (passkey/SSO login, cache
        // restart, or logout on another device) — every ncToken-gated file
        // tool in this turn will return AUTH_REQUIRED. Loud here so the
        // failure is greppable at the turn that produced it.
        // eslint-disable-next-line no-console
        console.warn(
          "[llm/chat] no Nextcloud credential for this session — file tools will return AUTH_REQUIRED (a password re-login re-provisions it)",
        );
      }
      // WARP-202: also forward the caller's username so handlers gated
      // on per-user RBAC (e.g. `search_content`'s pgvector lookup) can
      // scope queries to this user's chunks. The mcp-server's stdio
      // path treats `_meta.userId` as authoritative because the
      // orchestrator IS the trust boundary for that channel.
      const userId = (req as AuthedRequest).user?.username;
      // WARP-493: brain-memory rows/dirs are keyed by the local User.id
      // UUID (see routes/files-brain.ts::getUserId). The attachment
      // ownership checks + originatingChatId re-stamps below MUST use
      // that key or every attachment silently drops out post-cutover.
      // Deliberately separate from `userId` above: the username still
      // keys ChatSession persistence and the MCP `_meta.userId`
      // contract (nextcloud-watcher chunks are username-keyed by
      // design). WARP-1014: the mcp-server resolves the UUID
      // counterpart at the query site (`src/chunk-owner.ts`), so
      // search_content's FileContentChunk scope spans BOTH key shapes
      // without widening `_meta`.
      const brainOwnerId = (req as AuthedRequest).user?.id;
      // WARP-845: also forward the caller's role so role-scoped handlers
      // (memory_recall) can filter what the model may read.
      const toolCallContext: McpCallContext | undefined =
        ncToken || userId || role
          ? {
              ...(ncToken ? { ncToken } : {}),
              ...(userId ? { userId } : {}),
              ...(role ? { userRole: role } : {}),
            }
          : undefined;

      // WARP-329: save-on-send.
      // The user message that drove this turn is the LAST role="user" in
      // the replay history. Older user turns were persisted by their own
      // requests. We seed the title from this first prompt when the
      // session is brand new.
      const lastUserMessage = [...chatReq.messages]
        .reverse()
        .find((m) => m.role === "user");
      const persistedUserContent = lastUserMessage?.content ?? null;

      // Working copy the agent loop runs on. Starts as the validated (string-
      // content) request messages; the pin / attachment / base-prompt splices
      // and the image-vision injection below build onto THIS array, leaving
      // `chatReq.messages` intact for the persistence reads above. A copy (not
      // an alias) so attaching image blocks never mutates the persisted user
      // text. `agentModel` may be overridden per-turn by vision auto-routing.
      let agentMessages: ChatMessage[] = [...chatReq.messages];
      let agentModel = chatReq.model;
      // WARP-904: the provider that actually served this turn — tracks
      // `agentModel`. Vision auto-routing (below) can swap the user's selected
      // model for a local VISION_MODEL whose provider differs from the one the
      // caller forwarded, so the per-turn audit row must record THIS value, not
      // `chatReq.provider`, or the persisted model/provider pair goes
      // internally inconsistent (e.g. model:"llava:7b" + provider:"openai").
      let agentProvider: string | null = chatReq.provider ?? null;

      let conversationId: string | null = null;
      let assistantMessageId: string | null = null;

      // WARP-174: ephemeral chats (setup wizard sample prompt, health
      // probes) skip the entire persistence path so they don't clutter
      // the user's /chat history sidebar. The reply still goes back to
      // the caller — we just don't write any rows.
      if (chatReq.ephemeral) {
        // Intentionally leave conversationId/assistantMessageId null;
        // downstream just won't set the X-Conversation-Id header.
      } else if (userId && persistedUserContent) {
        // ensureConversation: find-or-create the ChatSession row.
        // WARP-844 — the caller's own system message (persona). Read from
        // the raw request BEFORE the pin/attachment/base-prompt splices
        // below mutate chatReq.messages. Empty string means "cleared".
        const callerSystemPrompt =
          chatReq.messages.find((m) => m.role === "system")?.content ?? null;
        const convo = await persistence
          .ensureConversation({
            conversationId: chatReq.conversationId,
            userId,
            model: chatReq.model,
            provider: chatReq.provider,
            firstUserContent: persistedUserContent,
            systemPrompt: callerSystemPrompt,
            projectId: chatReq.projectId ?? null,
          })
          .catch((err: unknown) => {
            // Persistence failure must NOT block chat — the user can
            // still talk to the model; we just lose history for this
            // turn. Log and continue.
            // eslint-disable-next-line no-console
            console.error("[llm/chat] failed to ensure conversation:", err);
            return null;
          });
        if (convo?.id) {
          conversationId = convo.id;

          // WARP-329: persist user + assistant placeholder BEFORE running
          // the agent. A mid-turn refresh now sees the user prompt + a
          // "streaming" assistant row, instead of nothing at all.
          const turn = await persistence
            .createTurnRows({
              conversationId,
              userContent: persistedUserContent,
              turnId: chatReq.turnId ?? null,
              // WARP-904: stamp the model/provider the user had selected
              // for this turn onto both rows (audit trail for a
              // mid-conversation quick-switch).
              model: chatReq.model,
              provider: chatReq.provider ?? null,
            })
            .catch((err: unknown) => {
              // eslint-disable-next-line no-console
              console.error("[llm/chat] failed to create turn rows:", err);
              return null;
            });
          if (turn?.assistantMessageId) {
            assistantMessageId = turn.assistantMessageId;
            res.setHeader(CONVERSATION_ID_HEADER, conversationId);
            res.setHeader(ASSISTANT_MESSAGE_ID_HEADER, assistantMessageId);
            if (turn.userMessageId) {
              res.setHeader(USER_MESSAGE_ID_HEADER, turn.userMessageId);
            }
            // If the client re-submitted a turn whose assistant message is
            // already in a terminal state (completed/failed/aborted), short-
            // circuit. The model has already replied; the cached row IS the
            // answer. Replaying would charge another inference and confuse
            // the user.
            if (turn.assistantAlreadyFinal) {
              res.status(409).json({
                error: "turn_already_completed",
                conversationId,
                assistantMessageId,
              });
              return;
            }
          } else if (conversationId) {
            // Couldn't create rows but conversation exists — still expose
            // the id so the client can rehydrate later.
            res.setHeader(CONVERSATION_ID_HEADER, conversationId);
          }
        }
      }

      // WARP-437 follow-up — production-wire EnhancementDeps behind a
      // feature flag. `createEnhancementDeps` returns `undefined` unless
      // `QUERY_ENHANCEMENT_ENABLED=1`, in which case the agent loop's
      // default no-enhancement path runs (byte-for-byte WARP-286).
      // `DEFAULT_MODEL` matches `routes/admin-retrieval-eval.ts` which
      // already canonicalised the env var name for the eval harness.
      const aiGatewayGrpcUrl =
        process.env.AI_GATEWAY_GRPC_URL ?? "ai-gateway:50051";
      // Fall back to LLM_MODEL (the model the box actually pulls —
      // single-box.sh writes it to .env, and the orchestrator loads
      // .env via env_file) before the historic hardcoded name, which
      // production Ollama does not host. Without this, HyDE/multi-query
      // rewrites would 404 upstream and silently no-op.
      const defaultChatModel =
        process.env.DEFAULT_MODEL ??
        process.env.LLM_MODEL ??
        "mistral:7b-instruct";

      const deps: AgentDeps = {
        mcp: mcpClient,
        // WARP-561: close over the requesting user's id so the gateway scopes
        // BYOK key resolution to their namespace for every agent-loop turn.
        // WARP-329: forward the agent loop's client-disconnect AbortSignal so an
        // in-flight inference fetch is cancelled when the client goes away.
        aiGateway: {
          chat: (chatReq, signal) =>
            aiGateway.chat(chatReq, signal, (req as AuthedRequest).user?.id),
          // WARP-1442 — SERVER-SIDE token streaming. The agent loop only
          // consumes this when the caller streams (onEvent present, i.e. the
          // stream=true branch below); the non-streaming path never touches it.
          // Closes over the same user id for BYOK scoping (WARP-561) and threads
          // the WARP-329 disconnect signal into the streaming read.
          chatStream: (chatReq, signal) =>
            aiGateway.chatStream(chatReq, signal, (req as AuthedRequest).user?.id),
        },
        enhancement: createEnhancementDeps({
          aiGatewayGrpcUrl,
          defaultModel: defaultChatModel,
        }),
        // WARP-473 — fire-and-forget file citation enqueue. Only
        // wired when the turn is persisted (conversationId +
        // assistantMessageId present); a service-token caller
        // without a chat thread has no thread/message to attach to.
        citation:
          conversationId && assistantMessageId
            ? createFileCitationService(prisma)
            : undefined,
      };
      // Carry the authenticated user.id (UUID, not username) onto every
      // citation insert so the related-chats route can scope by owner.
      // userId is required by createFileCitationService's IDOR guard
      // — without it the service skips the insert and logs warn.
      const citationUserId =
        (req as AuthedRequest).user?.id ??
        (req as AuthedRequest).user?.username ??
        null;
      const citationContext =
        conversationId && assistantMessageId && citationUserId
          ? {
              userId: citationUserId,
              threadId: conversationId,
              messageId: assistantMessageId,
            }
          : undefined;

      // WARP-1921 — the §3 continuity input, read from the persisted trace.
      //
      // The replayed `chatReq.messages` cannot carry it: chatRequestSchema
      // declares only `{role, content, tool_call_id}`, so zod strips
      // `tool_calls` off every replayed assistant turn. Without this, a
      // follow-up naming no domain keyword ("rename it to Blue Spruce")
      // falls back to core-only advertisement and burns a self-heal
      // iteration — the gap the spec's §6 outcome named as the prerequisite
      // to shipping TOOL_SELECTION_MODE.
      //
      // Skipped entirely when selection is off (nothing consumes it) or the
      // turn is ephemeral/unauthenticated (no conversation to read).
      //
      // try/catch, NOT `.catch()`: a `.catch()` only handles a REJECTED
      // promise. If `getConversationToolNames` is missing from the object
      // entirely (an injected double, a partially-migrated deployment) the
      // call throws TypeError synchronously, before any promise exists — and
      // a 500 on every chat turn is a spectacular way for an optimisation to
      // fail. Continuity must never cost the user their answer; try/catch is
      // what enforces that rather than merely asserting it.
      let priorToolNames: string[] = [];
      if (config.TOOL_SELECTION_MODE !== "off" && conversationId && userId) {
        try {
          priorToolNames = await persistence.getConversationToolNames(
            conversationId,
            userId,
          );
        } catch (err: unknown) {
          // eslint-disable-next-line no-console
          console.error(
            "[llm/chat] continuity lookup failed; advertising without prior domains:",
            err,
          );
        }
      }

      // Track tool calls observed during streaming so we can include
      // them in the persisted assistant message at the end of the turn.
      const liveToolCalls: PersistedToolCall[] = [];
      let liveAssistantContent = "";
      let lastFlushedContent = "";
      // WARP-458 — captured reasoning trace for the assistant message.
      // Populated from `AgentResult.message.reasoning` (set by the
      // agent loop's parser regardless of `captureReasoning`). The
      // route persists this to `ChatMessage.reasoning` so a refresh /
      // rehydrate can re-render the trace without re-running inference.
      // `null` is the explicit "no reasoning on this turn" value, which
      // clears any previously-persisted reasoning if the same row is
      // overwritten (retried turn). `undefined` would skip the write.
      let liveReasoning: string | null = null;

      // WARP-329: debounced flush of streaming content to Postgres so
      // refreshes mid-turn see progress. setInterval keeps the flush
      // cadence steady regardless of token speed.
      const flushTimer: NodeJS.Timeout | null = assistantMessageId
        ? setInterval(() => {
            if (
              !assistantMessageId ||
              liveAssistantContent === lastFlushedContent
            ) {
              return;
            }
            lastFlushedContent = liveAssistantContent;
            persistence
              .updateAssistantStreaming(assistantMessageId, liveAssistantContent)
              .catch((err: unknown) => {
                // eslint-disable-next-line no-console
                console.warn(
                  "[llm/chat] streaming flush failed (non-fatal):",
                  err,
                );
              });
          }, STREAM_FLUSH_INTERVAL_MS)
        : null;

      const finalizeAndNotify = async (
        status: "completed" | "failed" | "aborted",
      ): Promise<void> => {
        if (flushTimer) clearInterval(flushTimer);
        const completedAt = new Date();

        // WARP-456: emit a signed audit row for the chat turn. Runs
        // even when there's no persisted conversation (service-token
        // callers, ephemeral wizard prompts) so the activity feed has
        // a complete record of inference activity. `refs` only carries
        // identifiers we actually have.
        await recordActivity({
          kind: "chat",
          severity: activitySeverityForTurnStatus(status),
          sourceIcon: "message-square",
          // WARP-181: the chat turn is attributed to the authenticated
          // caller (canonical UUID). Service principals (voice etc.)
          // map to `system` with a null id — the principal string is
          // preserved in refs.principal below.
          actor: actorFromRequest(req),
          what:
            status === "completed"
              ? "Chat turn completed"
              : status === "failed"
                ? "Chat turn failed"
                : "Chat turn aborted",
          sub: userId
            ? `${userId} • ${chatReq.model}`
            : `service • ${chatReq.model}`,
          refs: stripUndefined({
            userId,
            // WARP-181: service principals are recorded as a `system`
            // actor (actorId must be a canonical user UUID), so the
            // principal string lands here instead.
            principal:
              role === "service"
                ? ((req as AuthedRequest).user?.id ?? undefined)
                : undefined,
            model: chatReq.model,
            conversationId: conversationId ?? undefined,
            messageId: assistantMessageId ?? undefined,
            iterations: liveToolCalls.length,
            status,
          }),
        });

        if (!conversationId || !assistantMessageId) return;
        try {
          await persistence.finalizeAssistantMessage({
            conversationId,
            messageId: assistantMessageId,
            content: liveAssistantContent,
            toolCalls: liveToolCalls,
            status,
            reasoning: liveReasoning,
            // WARP-904: `agentModel`/`agentProvider` may differ from the
            // caller's `chatReq.model`/`chatReq.provider` when vision
            // auto-routing overrode the user's selection — persist what
            // actually ran (model AND its provider, kept in lockstep above),
            // not what was requested, so the audit row is a consistent pair.
            model: agentModel,
            provider: agentProvider,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[llm/chat] failed to finalize assistant turn:", err);
        }
        publishTurnCompleted(userId, {
          conversationId,
          messageId: assistantMessageId,
          status,
          snippet: liveAssistantContent.slice(0, 140),
          completedAt: completedAt.toISOString(),
        });
      };

      // ── WARP-460 Phase B3 — Context-pin injection ─────────────────
      //
      // If the user has pinned folders/files/email-threads/cameras to
      // this session, prepend a system message describing the pinned
      // working set. The model uses this to scope retrieval (e.g.
      // search_content gets a `folder:` hint) per FEATURES.md §2.2.7.
      //
      // Pins are PER-SESSION; we only fetch when we have a known
      // conversationId. New (just-created) sessions on the first turn
      // skip cleanly — no pins yet.
      //
      // Injection is additive: we splice a new system message at index
      // 0 rather than mutating an existing system message. Safer if
      // the caller already provided their own system message (voice-io
      // does this).
      if (conversationId) {
        try {
          const pins = await prisma.contextPin.findMany({
            where: { sessionId: conversationId },
            orderBy: { addedAt: "asc" },
          });
          if (pins.length > 0) {
            const lines = pins.map((p: { kind: string; ref: string; meta: unknown }) => {
              const metaSuffix =
                p.meta && typeof p.meta === "object"
                  ? ` ${JSON.stringify(p.meta)}`
                  : "";
              return `- ${p.kind}: ${p.ref}${metaSuffix}`;
            });
            const pinSystemMessage: ChatMessage = {
              role: "system",
              content:
                "Context pins for this conversation — prefer these as " +
                "scope hints when calling retrieval tools:\n" +
                lines.join("\n"),
            };
            agentMessages = [pinSystemMessage, ...agentMessages];
          }
        } catch (err) {
          // Pin-load failure must NOT block chat — degrade gracefully.
          // eslint-disable-next-line no-console
          console.warn("[llm/chat] context-pin load failed:", err);
        }
      }

      // ── Attachment context injection ─────────────────────────────
      //
      // Brain-memory items the client referenced for this turn. Unlike
      // pins this must work WITHOUT a persisted conversation — the
      // common case is a file attached before the very first turn.
      // Ownership is enforced inside buildAttachmentContext (query is
      // filtered by brainOwnerId — the caller's req.user.id UUID —
      // matching /api/files/brain's post-WARP-493 keying).
      if (chatReq.attachments?.length && brainOwnerId) {
        // ── Image vision routing ──
        // For image attachments with a normalized render, send the actual
        // image to a vision-capable model: the selected model if it can see,
        // else a configured local VISION_MODEL (auto-route, this turn only).
        // When no vision model is available, fall back to OCR text + a note.
        // Gated on actually having a renderable image, so non-image / pre-
        // feature uploads behave exactly as before.
        let ocrRefs: { itemId: string }[] = chatReq.attachments;
        let visionNote: string | null = null;
        try {
          const { blocks, usedItemIds } = await buildImageBlocks(
            prisma,
            brainOwnerId,
            chatReq.attachments.map((a) => a.itemId),
            { maxImages: config.vision.maxImages },
          );
          if (usedItemIds.length > 0) {
            const [selectedCaps, visionCaps] = await Promise.all([
              aiGateway.getModelCapabilities(chatReq.model),
              config.vision.model
                ? aiGateway.getModelCapabilities(config.vision.model)
                : Promise.resolve(undefined),
            ]);
            const route = decideVisionRoute({
              hasImages: true,
              selectedModel: chatReq.model,
              selectedVision: Boolean(selectedCaps?.vision),
              visionModel: config.vision.model,
              visionModelVision: Boolean(visionCaps?.vision),
            });
            if (route.mode === "image") {
              attachImageBlocksToLastUserMessage(agentMessages, blocks);
              // WARP-904: when we auto-route to the local VISION_MODEL (a
              // DIFFERENT model than the user picked), resolve ITS provider so
              // the persisted audit pair stays consistent. The model list is
              // already warm from the capability lookups above, so this is a
              // cache hit. Unknown → null (honest "unknown") rather than the
              // stale cloud provider, which would be a wrong, mismatched pair.
              // The selected-model image case (route.model === chatReq.model)
              // keeps the caller's forwarded provider untouched.
              if (route.model !== chatReq.model) {
                agentProvider =
                  (await aiGateway.getModelProvider(route.model)) ?? null;
              }
              agentModel = route.model;
              // Don't also inline a "no text could be extracted" note for an
              // image we're sending visually — OCR only over the rest.
              ocrRefs = chatReq.attachments.filter(
                (a) => !usedItemIds.includes(a.itemId),
              );
            } else {
              // mode === "ocr": no vision model available for this image.
              visionNote =
                "The user attached an image, but the current model cannot " +
                "view images. Work from any extracted text below; if asked " +
                "about the image's visual content, tell the user to switch to " +
                "a vision-capable model.";
            }
          }
        } catch (err) {
          // Vision routing must never block chat — fall through to OCR text.
          // eslint-disable-next-line no-console
          console.warn("[llm/chat] image-vision routing failed:", err);
        }

        // ── OCR-text attachment context (documents + non-vision fallback) ──
        try {
          const attachmentContext = await buildAttachmentContext(
            prisma,
            brainOwnerId,
            ocrRefs,
          );
          const systemParts: string[] = [];
          if (visionNote) systemParts.push(visionNote);
          if (attachmentContext) systemParts.push(attachmentContext);
          if (systemParts.length > 0) {
            const attachmentSystemMessage: ChatMessage = {
              role: "system",
              content: systemParts.join("\n\n"),
            };
            agentMessages = [attachmentSystemMessage, ...agentMessages];
          }
        } catch (err) {
          // Attachment-context failure must NOT block chat — the turn
          // proceeds without the inlined content (the model can still
          // reach the document via search_content).
          // eslint-disable-next-line no-console
          console.warn("[llm/chat] attachment-context load failed:", err);
        }

        // Durably join the items to this conversation: uploads are tagged with
        // the dashboard's client-minted draft chatId (`chat-<ts>`), which is
        // lost on reload. Re-stamping `originatingChatId` to the server
        // conversationId lets the dashboard rehydrate the chip row (and the
        // per-chat export) via GET /api/files/brain?originatingChatId=<id>.
        // Ownership-scoped by brainOwnerId (UUID), same as the context lookup.
        //
        // SEPARATE try/catch from the context build (pr-reviewer #550 finding):
        // when this was nested under the context build, a transient updateMany
        // failure was swallowed by the same generic "context load failed"
        // handler AFTER the context had already been injected — the model saw
        // the attachment this turn but the association never persisted, so the
        // chip silently vanished on reload with no distinct diagnostic. The
        // persistence outcome is now logged on its own; still non-fatal.
        if (conversationId) {
          try {
            await prisma.brainMemoryItem.updateMany({
              where: {
                id: { in: chatReq.attachments.map((a) => a.itemId) },
                userId: brainOwnerId,
                NOT: { originatingChatId: conversationId },
              },
              data: { originatingChatId: conversationId },
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              "[llm/chat] attachment chat-association persist failed " +
                "(chip may not rehydrate on reload):",
              err,
            );
          }
        }
      }

      // ── Draft-upload adoption (WARP-844 follow-up) ───────────────
      //
      // Uploads made while the chat was still a draft are tagged with
      // the client-minted chatId. Adopt them all into the persisted
      // conversation — including rows whose upload finished after the
      // send (the row is created at upload-request time, so it exists
      // by now). Ownership-scoped: a forged draftChatId can only ever
      // re-tag the caller's OWN items.
      if (chatReq.draftChatId && conversationId && brainOwnerId) {
        try {
          await prisma.brainMemoryItem.updateMany({
            where: {
              originatingChatId: chatReq.draftChatId,
              userId: brainOwnerId,
            },
            data: { originatingChatId: conversationId },
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[llm/chat] draft-upload adoption failed:", err);
        }
      }

      // ── Base system prompt injection ─────────────────────────────
      //
      // Additive splice at index 0 (same pattern as pins/attachments
      // above; this unshift runs LAST so the base prompt lands first).
      // Skipped when tool_choice="none": that's voice-io's greeting
      // path, which advertises zero tools and ships its own persona
      // prompt — tool guidance there would be misleading. Memory-fact
      // load failure degrades to the bare base prompt (fail-open, same
      // posture as the pin block).
      if (chatReq.tool_choice !== "none") {
        let memoryBlock = "";
        try {
          memoryBlock = await buildMemoryFactsBlock(prisma, role);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[llm/chat] memory-fact load failed:", err);
        }

        // WARP-1118 — compose the personality block fresh from Prisma each
        // request (§7.2: single-row read, no cache to invalidate). Fail-open
        // to no persona block on any error, same posture as the memory block.
        let personaBlock = "";
        try {
          personaBlock = composePersonaBlock(await getPersona(prisma));
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[llm/chat] persona load failed:", err);
        }

        // WARP-1120 §8/§9.1 — the role-filtered business block, composed fresh
        // each request. WARP-1341: business-only build — a missing singleton
        // row resolves to BUSINESS (a stale pre-migration HOME row still
        // short-circuits, matching the migration that removes them).
        // composeBusinessBlock role-filters and gates on type again
        // (defense-in-depth). Fail-open to no block on any error.
        let businessBlock = "";
        try {
          const workspace = await prisma.workspace.findUnique({
            where: { id: 1 },
          });
          const workspaceType = (workspace?.type ?? "BUSINESS") as WorkspaceTypeName;
          if (workspaceType === "BUSINESS") {
            businessBlock = composeBusinessBlock(
              role,
              await getBusinessProfile(prisma),
              workspaceType,
            );
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[llm/chat] business-profile load failed:", err);
        }

        // WARP-1118 §10 — the context-budget gate. Estimate the WHOLE
        // assembled request (identity + persona + [business, Phase 2] +
        // tool guidance + memory facts + serialized tools[] + the pins /
        // attachments / history already spliced into agentMessages) against
        // OLLAMA_CONTEXT_LENGTH − OUTPUT_RESERVE and drop deterministically:
        // business first (none yet), then persona, before the request can
        // hit the WARP-854 overflow. Identity + tool guidance are never
        // dropped. At the shipping 16384 window nothing normally drops — this
        // is defense-in-depth. `buildBaseSystemPrompt(allowedForUser, "")`
        // gives us the identity+guidance chars without a persona block for the
        // estimate; the guidance is folded into identityBlock here since both
        // are never-dropped fixed blocks.
        const identityAndGuidance = buildBaseSystemPrompt(allowedForUser, "");
        // WARP-1121 (§9.3/§10) — the interview conductor block. Appended
        // after the whole base prompt on interview turns only; folded into
        // the NEVER-DROPPED identity part for sizing (it must survive
        // degradation on interview sessions — dropping the conductor
        // mid-interview would silently break the topic protocol).
        const interviewBlock = interviewActive
          ? INTERVIEW_CONDUCTOR_BLOCK
          : "";
        // Serialize the effective tools[] the same way llm-agent.service.ts
        // does, so the estimate reflects what the model actually receives:
        // an explicit allowed set verbatim, otherwise the WARP-1424 default
        // chat scope (registry minus chat-tool-scope.ts exclusions).
        const effectiveTools = allowedForUser
          ? Array.from(TOOLS.values()).filter((t) =>
              allowedForUser!.includes(t.name),
            )
          : Array.from(TOOLS.values()).filter(
              (t) => !EXCLUDED_FROM_CHAT_TOOLS.has(t.name),
            );
        const toolSchemasJson = JSON.stringify(
          effectiveTools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            },
          })),
        );
        // Everything already spliced onto agentMessages (pins, attachments,
        // history) counts toward the window; serialize it as one blob.
        const assembledText = agentMessages
          .map((m) => contentToText(m.content))
          .join("\n");
        const sizeParts: RequestSizeParts = {
          // Interview conductor rides in the never-dropped identity part
          // (WARP-1121 §10 — interview sessions only; never dropped there).
          identityBlock: identityAndGuidance + interviewBlock,
          personaBlock,
          businessBlock, // WARP-1120 — role-filtered, BUSINESS-only, dropped 1st.
          toolGuidance: "", // folded into identityBlock above.
          memoryFactsBlock: memoryBlock,
          toolSchemasJson,
          pinsText: "",
          attachmentsText: "",
          historyText: assembledText,
        };
        const degraded = degradeToFit(sizeParts, {
          contextWindow: config.OLLAMA_CONTEXT_LENGTH,
          warn: (event) => {
            // Structured warn on every drop (§10) so an overflow-driven
            // degradation is diagnosable in the box logs.
            // eslint-disable-next-line no-console
            console.warn("[llm/chat] context-budget degradation", {
              conversationId: chatReq.conversationId ?? null,
              role: role ?? null,
              ...event,
            });
          },
        });

        const baseSystemMessage: ChatMessage = {
          role: "system",
          content:
            buildBaseSystemPrompt(
              allowedForUser,
              degraded.personaBlock,
              degraded.businessBlock,
            ) +
            memoryBlock +
            // WARP-1121 (§9.3) — conductor appended AFTER the base prompt on
            // interview turns; "" on every other turn.
            (interviewBlock ? "\n\n" + interviewBlock : ""),
        };
        agentMessages = [baseSystemMessage, ...agentMessages];
      }

      // ── Streaming path ──
      if (chatReq.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const onEvent = (e: SSEEvent) => {
          // WARP-854 — an "empty completion": the model "finished" without
          // producing any visible output or calling a tool. Seen in the
          // wild when the prompt alone overflows Ollama's context window
          // (e.g. the owner-role tool list vs. the default 4096-token
          // num_ctx): Ollama returns finish_reason=length with ZERO output
          // tokens, the loop reads it as model_done, and the turn used to
          // persist as completed-with-empty-content — invisible in the UI.
          // Rewrite the terminal event to an error so the dashboard shows
          // its retry chip instead of nothing, and finalize as `failed`.
          //
          // WARP-1479 — tool activity does NOT make a blank answer honest.
          // The original gate only rewrote `model_done` when the turn had
          // called no tools, so the common live shape — tools run, they
          // SUCCEED, and the final answer is still blank — persisted as a
          // silent "completed" empty bubble: chips, no answer, no retry.
          // (Live repro: "how much money did I spend last month?" — 4
          // successful tool calls, 49 s, zero visible output.) A turn with
          // no visible answer is a failed turn whatever its trace says, so
          // all three terminal reasons now rewrite on blank content alone.
          if (
            e.type === "done" &&
            liveAssistantContent.trim().length === 0 &&
            (e.stop_reason === "model_done" ||
              e.stop_reason === "context_budget" ||
              e.stop_reason === "repetition")
          ) {
            emptyCompletion = true;
            e = {
              ...e,
              stop_reason: "error",
              error:
                "empty_completion: the model produced no visible answer for " +
                "this turn. Common causes: the request (system prompt + " +
                "tools + history) overflowed the context window, or the " +
                "model returned nothing after its tool calls. Server logs " +
                "carry a `blank_final_answer` line attributing this turn.",
            };
          }
          try {
            res.write(encodeSSE(e));
          } catch {
            /* client gone */
          }
          if (e.type === "content_delta") {
            liveAssistantContent += e.text;
          } else if (e.type === "tool_call") {
            liveToolCalls.push({ id: e.id, name: e.name, args: e.args });
          } else if (e.type === "tool_result") {
            const existing = liveToolCalls.find((c) => c.id === e.id);
            if (existing) {
              existing.ok = e.ok;
              existing.status = e.status;
              existing.message = e.message;
              existing.data = e.data;
              // WARP-640 — persist the confirmation handle so a page reload
              // while the chip is in `confirmation_required` still renders the
              // "Approve & run" button. The token rides on e.confirmation (not
              // e.data) for a confirmation_required result. (review #497)
              if (e.confirmation) existing.confirmation = e.confirmation;
            }
          }
        };
        let terminal: "completed" | "failed" | "aborted" = "completed";
        // WARP-854 — set by the onEvent done-rewrite above.
        let emptyCompletion = false;
        // WARP-329: detect client-side abort — "close" fires when
        // the client disconnects mid-stream; we still finalize but flag
        // the turn as aborted so the row reflects reality. The
        // AbortController additionally tears down the in-flight work:
        // its signal is threaded into runAgent → the ai-gateway fetch
        // (cancelling inference) and is checked between agent-loop
        // iterations / before each tool dispatch, so a disconnect stops
        // the loop instead of letting it run (and fire write tools) in
        // the background.
        let clientAborted = false;
        const abortController = new AbortController();
        const onClientGone = () => {
          if (!res.writableEnded) {
            clientAborted = true;
            abortController.abort();
          }
        };
        // `req` alone is NOT enough on this route. Since Node 16 an
        // IncomingMessage emits "close" once its own stream completes — and
        // `express.json()` has already drained this POST's body by the time
        // the handler runs (`req.destroyed === true` here), so the listener
        // below is registered after the event it waits for and can never
        // fire. The GET/SSE routes that use the same idiom are unaffected:
        // no body, nothing drains, the stream stays open for the connection's
        // lifetime. `res` closes when the connection does, whether or not the
        // response ended, so it is the one that actually reports a Stop press
        // — and `writableEnded` (set synchronously by `res.end()`) keeps a
        // NORMAL completion from being mislabelled "aborted".
        req.on("close", onClientGone);
        res.on("close", onClientGone);

        // ── WARP-903 — cold-model loading signal ─────────────────────
        // One budgeted lifecycle probe (Ollama /api/ps + /api/tags via
        // model-readiness.service — chat completions stay DIRECT to
        // Ollama; never ollama-manager's /proxy) BEFORE the agent loop.
        // When the selected model is installed but not resident, tell
        // the client now so the 30-60 s cold load renders as an explicit
        // loading state instead of a silent hang. Probes `agentModel`
        // (post vision auto-route) — the model this turn actually runs
        // on. Non-fatal by contract: the probe itself never throws, and
        // the belt-and-braces catch here means even a future regression
        // degrades to "no event" — the turn must never block or fail on
        // this. Streaming-only: the non-streaming path has no channel to
        // deliver the event on.
        try {
          const cold = await probeColdModel(agentModel);
          if (cold) {
            onEvent({
              type: "model_loading",
              model: cold.model,
              sizeGb: cold.sizeGb,
            });
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[llm/chat] cold-model probe failed (non-fatal):", err);
        }

        try {
          const streamResult = await runAgent({ ...deps, onEvent }, {
            // Per-turn vision auto-route may override the user's selected model.
            model: agentModel,
            messages: agentMessages,
            temperature: chatReq.temperature,
            // WARP-849 — forward the caller's completion budget (the
            // schema accepted it but the loop never received it).
            max_tokens: chatReq.max_tokens,
            // WARP-1442 — resolved reasoning effort (voice → "low" default).
            reasoning_effort: reasoningEffort,
            max_iter: chatReq.max_iter,
            context_window: config.OLLAMA_CONTEXT_LENGTH,
            tool_selection_mode: config.TOOL_SELECTION_MODE,
            // WARP-1921 — cross-turn continuity for §3 selection.
            prior_tool_names: priorToolNames,
            allowed_tools: allowedForUser,
            // WARP-1529 — the same §3 scope, re-checked fail-closed before
            // every tool dispatch inside the loop.
            toolAccessScope,
            tool_choice: chatReq.tool_choice,
            toolCallContext,
            captureReasoning: chatReq.captureReasoning,
            citationContext,
            // WARP-329 — cancel inference + halt the loop on disconnect.
            signal: abortController.signal,
          });
          // WARP-458 — the agent loop populates message.reasoning
          // REGARDLESS of captureReasoning (only the wire-emit is
          // gated by the flag). Capture it here so finalizeAndNotify
          // persists, enabling lazy-load reasoning on rehydrate
          // without re-running inference.
          liveReasoning = streamResult.message.reasoning ?? null;
          // WARP-1602 — persist the TERMINAL answer, not the delta
          // accumulator. `liveAssistantContent` sums every `content_delta`
          // the turn emitted; on a multi-iteration turn that used to include
          // every intermediate iteration's analysis, so the stored `content`
          // was the model's chain-of-thought welded to its answer while the
          // blocking path (below) stored `result.message.content` clean. The
          // agent loop now quarantines intermediate content, so the two agree
          // by construction — this assignment makes the DB row depend on the
          // loop's own contract rather than on nothing having been mis-emitted
          // upstream, which is what let the divergence go unnoticed.
          //
          // Only on a real terminal. An `error` stop_reason (client abort,
          // mid-stream death) keeps the ACCUMULATOR instead: the agent loop
          // now settles its emitter on both teardown paths (WARP-1602 review
          // B1/B2), so the salvaged partial has already arrived here as
          // `content_delta` — and on a turn that mixed deferred and
          // non-deferred iterations the accumulator is the SUPERSET, while
          // `streamResult.message.content` carries only the torn-down
          // iteration's share. Overwriting would truncate the answer.
          if (streamResult.stop_reason !== "error") {
            liveAssistantContent = contentToText(streamResult.message.content);
          }
          logBlankAnswer(streamResult, conversationId, assistantMessageId);
          logPollutedAnswer(streamResult, conversationId, assistantMessageId);
        } catch (err) {
          // Use the name-based check rather than instanceof DOMException:
          // aligns with the codebase pattern and stays robust against
          // error-wrapping layers that re-throw as a plain Error with
          // name:"AbortError" (retry wrappers, SDK updates, etc.).
          const isAbortErr =
            err instanceof Error && (err as Error).name === "AbortError";
          if (!isAbortErr) {
            // Only non-abort errors mark the row as failed. For AbortErrors,
            // terminal stays "completed" so the clientAborted guard below
            // can correctly set "aborted" for mid-inference disconnects.
            terminal = "failed";
            // eslint-disable-next-line no-console
            console.error("[llm/chat] agent loop failed:", err);
          }
        } finally {
          res.end();
        }
        if (emptyCompletion) terminal = "failed";
        // Preserve the model-error label when emptyCompletion and clientAborted
        // are both set (e.g. context-window overflow races a client disconnect).
        if (clientAborted && terminal !== "failed") terminal = "aborted";
        await finalizeAndNotify(terminal);
        return;
      }

      // ── Non-streaming path ──
      let result;
      try {
        result = await runAgent(deps, {
          // Per-turn vision auto-route may override the user's selected model.
          model: agentModel,
          messages: agentMessages,
          temperature: chatReq.temperature,
          // WARP-849 — forward the caller's completion budget (the
          // schema accepted it but the loop never received it). The
          // setup wizard's sample probe relies on this so its raised
          // reasoning-safe budget actually reaches Ollama.
          max_tokens: chatReq.max_tokens,
          // WARP-1442 — resolved reasoning effort (voice → "low" default).
          reasoning_effort: reasoningEffort,
          max_iter: chatReq.max_iter,
          context_window: config.OLLAMA_CONTEXT_LENGTH,
          tool_selection_mode: config.TOOL_SELECTION_MODE,
          // WARP-1921 — cross-turn continuity for §3 selection.
          prior_tool_names: priorToolNames,
          allowed_tools: allowedForUser,
          // WARP-1529 — the same §3 scope, re-checked fail-closed before
          // every tool dispatch inside the loop.
          toolAccessScope,
          tool_choice: chatReq.tool_choice,
          toolCallContext,
          captureReasoning: chatReq.captureReasoning,
          citationContext,
        });
        logBlankAnswer(result, conversationId, assistantMessageId);
        logPollutedAnswer(result, conversationId, assistantMessageId);
        liveAssistantContent = contentToText(result.message.content);
        // WARP-458 — agent loop populates message.reasoning regardless
        // of captureReasoning; persist whenever present so the
        // dashboard can lazy-load the trace later.
        liveReasoning = result.message.reasoning ?? null;
        for (const t of result.trace) {
          liveToolCalls.push({
            id: t.tool_call_id,
            name: t.tool,
            args: t.args,
            ok: true,
            data: t.result,
          });
        }
        // WARP-854 — empty completion (no output, no tool calls): the
        // model "finished" without saying anything, typically because the
        // prompt overflowed the context window (see the streaming-path
        // comment). Surface it as an error instead of a silent success.
        //
        // WARP-1479 — a non-empty trace does NOT make a blank answer
        // honest (see the streaming site above for the live repro). All
        // three terminal reasons rewrite on blank content alone.
        if (
          contentToText(result.message.content).trim().length === 0 &&
          (result.stop_reason === "model_done" ||
            result.stop_reason === "context_budget" ||
            result.stop_reason === "repetition")
        ) {
          result = {
            ...result,
            stop_reason: "error" as const,
            error:
              "empty_completion: the model returned no output. This " +
              "usually means the request (system prompt + tools + " +
              "history) overflowed the model's context window.",
          };
          await finalizeAndNotify("failed");
        } else {
          await finalizeAndNotify("completed");
        }
      } catch (err) {
        await finalizeAndNotify("failed");
        throw err;
      }
      res.json({ ...result, conversationId, assistantMessageId });
    } catch (err) {
      next(err);
    }
    },
  );

  // WARP-1426 — lightweight single-turn completion. Unlike /llm/chat this
  // NEVER enters the agent loop: no tools are advertised, no conversation
  // rows are written, no history is replayed. It exists for the
  // translate_text / summarize_file MCP tools (@droplet/tools-core), which
  // call it with the mcp-server service principal — hence "service" in the
  // role list (same posture as /llm/chat above: the route must stay
  // reachable for service principals; there is no tool surface here to
  // narrow because nothing is ever dispatched).
  router.post(
    "/llm/complete",
    requireRole("owner", "admin", "family", "guest", "service"),
    async (req, res) => {
      const parsed = completeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request",
          details: parsed.error.flatten(),
        });
        return;
      }
      const body = parsed.data;
      // Same default-model triad as the query-enhancement wiring in
      // /llm/chat: DEFAULT_MODEL (canonical), then LLM_MODEL (what the box
      // actually pulled), then the historic hardcoded name.
      const model =
        body.model ??
        process.env.DEFAULT_MODEL ??
        process.env.LLM_MODEL ??
        "mistral:7b-instruct";

      // WARP-1530 — the same per-person cloud gate as /llm/chat. `model` is
      // caller-supplied here too, so without this a person denied cloud could
      // reach a cloud provider through the single-turn route instead of the
      // chat one. The registered consumers (translate_text / summarize_file
      // via the mcp-server service principal) are exempt by §3 and pay
      // nothing: the gate returns before any lookup for service principals.
      const cloudDecision = await decideCloudTurn({
        user: (req as AuthedRequest).user,
        model,
      });
      if (cloudDecision.kind === "refused") {
        res.status(cloudDecision.status).json(cloudDecision.body);
        return;
      }

      try {
        const result = await completeOnce({
          system: body.system,
          text: body.text,
          model,
          temperature: body.temperature,
          maxTokens: body.max_tokens,
          // WARP-561: scope BYOK key resolution to the caller when the
          // request carries a human user; service principals fall through
          // to the shared/device namespace.
          userId: (req as AuthedRequest).user?.id,
        });
        res.json(result);
      } catch (err) {
        // Gateway down, non-OK, or the 120 s belt-and-braces timeout in
        // completeOnce fired (CPU inference can be slow, but past that the
        // gateway is considered wedged). Map everything to one stable code
        // the MCP tools can surface verbatim.
        // eslint-disable-next-line no-console
        console.error("[llm/complete] completion failed:", err);
        res.status(502).json({ error: "llm_unavailable" });
      }
    },
  );

  // ── WARP-304: per-user conversation history ──
  // The dashboard reads `/api/llm/conversations/:id` on mount when a
  // `?c=<id>` URL hash is present, to rehydrate the thread. Listing is
  // exposed for the future sidebar; deletion lets the user clear a
  // thread they no longer want kept.
  //
  // All three endpoints scope by `req.user.username` — owner/admin do
  // NOT get visibility into other users' chats (privacy boundary).
  router.get("/llm/conversations", async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).user?.username;
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const limit = Number.parseInt(String(req.query.limit ?? "20"), 10) || 20;
      const offset = Number.parseInt(String(req.query.offset ?? "0"), 10) || 0;
      // WARP-844 — optional search needle (title OR message content).
      // Bounded so a pathological query can't become a giant ILIKE.
      const q =
        typeof req.query.q === "string" ? req.query.q.slice(0, 200) : undefined;
      // WARP-845 — optional project filter (sidebar folder expand).
      // Still userId-scoped in the service, so a foreign projectId just
      // yields an empty list.
      const projectId =
        typeof req.query.projectId === "string" && req.query.projectId.length > 0
          ? req.query.projectId
          : undefined;
      const conversations = await persistence.listConversationsForUser(
        userId,
        limit,
        offset,
        q,
        projectId,
      );
      res.json({ conversations });
    } catch (err) {
      next(err);
    }
  });

  router.get("/llm/conversations/:id", async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).user?.username;
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const detail = await persistence.getConversationForUser(
        req.params.id,
        userId,
      );
      if (!detail) {
        res.status(404).json({ error: "conversation_not_found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. Conversation rows are owned by the
  // requesting user; service principals should never delete on behalf
  // of a user. Human-tier roles only.
  router.delete("/llm/conversations/:id", requireRole("owner", "admin", "family", "guest"), async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).user?.username;
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      // WARP-1121 (§9.2) — capture whether this is the live interview
      // session BEFORE the delete: Prisma's onDelete SetNull wipes the
      // link during the delete itself. Fail-open — a probe error must
      // never block an ordinary conversation delete.
      let wasInterviewSession = false;
      try {
        const profile = await prisma.businessProfile.findUnique({
          where: { id: "singleton" },
          select: { interviewChatId: true },
        });
        wasInterviewSession = profile?.interviewChatId === req.params.id;
      } catch {
        /* not an interview delete as far as we can tell */
      }
      const deleted = await persistence.deleteConversationForUser(
        req.params.id,
        userId,
      );
      if (!deleted) {
        res.status(404).json({ error: "conversation_not_found" });
        return;
      }
      // WARP-1121 (§9.2) — deleting the active interview resets the
      // onboarding state (in_progress → not_started · re_running →
      // completed restore). Conditional update = race-safe; audited so a
      // vanished interview is never a silent mystery. No dead-end states.
      if (wasInterviewSession) {
        const reset = await resetOnboardingForDeletedSession(prisma);
        if (reset) {
          await recordActivity({
            kind: "system",
            severity: "info",
            sourceIcon: "building-2",
            what: "business_onboarding_reset",
            sub: `interview deleted · ${reset.from} → ${reset.state}`,
            refs: { conversationId: req.params.id, ...reset },
            actor: actorFromRequest(req),
          });
        }
      }
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // WARP-844 — truncate a conversation from a message onward. The
  // dashboard's edit-and-resend calls this BEFORE re-sending the edited
  // prompt so the persisted thread matches the visible one. Ownership +
  // 404 posture mirror the other conversation routes (cross-user and
  // unknown-message both 404; no existence leak).
  router.delete(
    "/llm/conversations/:id/messages/:messageId",
    requireRole("owner", "admin", "family", "guest"),
    async (req, res, next) => {
      try {
        const userId = (req as AuthedRequest).user?.username;
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const deleted = await persistence.truncateConversationFromMessage(
          req.params.id,
          userId,
          req.params.messageId,
        );
        if (deleted === "not_found") {
          res.status(404).json({ error: "message_not_found" });
          return;
        }
        if (deleted === "in_flight") {
          // A doomed row is still streaming (cross-tab edit) — refuse
          // rather than delete the turn out from under the agent loop.
          res.status(409).json({ error: "turn_in_flight" });
          return;
        }
        res.json({ deleted });
      } catch (err) {
        next(err);
      }
    },
  );

  // WARP-844 — thumbs rating on an assistant message. Body:
  // { feedback: "up" | "down" | null } (null clears). Ownership + 404
  // posture mirror the other conversation routes.
  router.patch(
    "/llm/conversations/:id/messages/:messageId/feedback",
    requireRole("owner", "admin", "family", "guest"),
    async (req, res, next) => {
      try {
        const userId = (req as AuthedRequest).user?.username;
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const parsed = z
          .object({ feedback: z.enum(["up", "down"]).nullable() })
          .safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid feedback",
            details: parsed.error.flatten(),
          });
          return;
        }
        const ok = await persistence.setMessageFeedback(
          req.params.id,
          userId,
          req.params.messageId,
          parsed.data.feedback,
        );
        if (!ok) {
          res.status(404).json({ error: "message_not_found" });
          return;
        }
        res.json({ feedback: parsed.data.feedback });
      } catch (err) {
        next(err);
      }
    },
  );

  // WARP-331: rename. Mirrors the GET/DELETE handlers above — scoped by
  // req.user.username, service maps "no such row owned by this user"
  // to a null return, and we surface that as 404.
  // WARP-171: per-route guard. Same posture as the delete above.
  router.patch("/llm/conversations/:id", requireRole("owner", "admin", "family", "guest"), async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).user?.username;
      if (!userId) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const body = req.body as {
        title?: unknown;
        projectId?: unknown;
        pinned?: unknown;
      };
      const hasTitle = typeof body?.title === "string";
      // WARP-845 — move into / out of a project. `null` = ungroup. An
      // empty string is rejected outright (it would skip the ownership
      // guard's truthiness check and then violate the FK).
      const hasProject =
        (typeof body?.projectId === "string" && body.projectId.length > 0) ||
        body?.projectId === null;
      // WARP-1917 — pin/unpin. Strictly boolean; a present-but-non-boolean
      // value 400s the whole PATCH before anything mutates (same posture
      // as the malformed-title rule below).
      const hasPinned = typeof body?.pinned === "boolean";
      if (body?.pinned !== undefined && !hasPinned) {
        res.status(400).json({ error: "invalid_pinned" });
        return;
      }
      if (
        body?.projectId !== undefined &&
        body?.projectId !== null &&
        (typeof body.projectId !== "string" || body.projectId.length === 0)
      ) {
        res.status(400).json({ error: "invalid_project_id" });
        return;
      }
      // A present-but-non-string title is a malformed request, not a
      // "field omitted" — reject it even when a valid projectId rides
      // along, instead of silently dropping the title leg.
      if (body?.title !== undefined && !hasTitle) {
        res.status(400).json({ error: "title_or_project_required" });
        return;
      }
      if (!hasTitle && !hasProject && !hasPinned) {
        res.status(400).json({ error: "title_or_project_required" });
        return;
      }
      // Pre-validate BOTH legs before mutating anything, so a bad
      // project id can't leave a half-applied rename behind (and gets
      // its own error code instead of `conversation_not_found`).
      if (hasTitle && (body.title as string).trim().length === 0) {
        res.status(400).json({ error: "title_required" });
        return;
      }
      if (hasProject && body.projectId !== null) {
        const project = await prisma.chatProject.findFirst({
          where: { id: body.projectId as string, userId },
          select: { id: true },
        });
        if (!project) {
          res.status(404).json({ error: "project_not_found" });
          return;
        }
      }
      let finalTitle: string | null = null;
      if (hasTitle) {
        try {
          finalTitle = await persistence.renameConversationForUser(
            req.params.id,
            userId,
            body.title as string,
          );
        } catch (err) {
          if (err instanceof Error && err.message === "title_required") {
            res.status(400).json({ error: "title_required" });
            return;
          }
          throw err;
        }
        if (finalTitle === null) {
          res.status(404).json({ error: "conversation_not_found" });
          return;
        }
      }
      if (hasProject) {
        const ok = await persistence.setConversationProject(
          req.params.id,
          userId,
          (body.projectId as string | null) ?? null,
        );
        if (!ok) {
          res.status(404).json({ error: "conversation_not_found" });
          return;
        }
      }
      // WARP-1917 — pin leg. Ownership enforced in the service's single
      // UPDATE; a miss is indistinguishable between other-user and
      // nonexistent (same no-existence-leak posture as the legs above).
      if (hasPinned) {
        const ok = await persistence.setConversationPinned(
          req.params.id,
          userId,
          body.pinned as boolean,
        );
        if (!ok) {
          res.status(404).json({ error: "conversation_not_found" });
          return;
        }
      }
      res.json({
        id: req.params.id,
        ...(hasTitle ? { title: finalTitle } : {}),
        ...(hasProject ? { projectId: body.projectId ?? null } : {}),
        ...(hasPinned ? { pinned: body.pinned as boolean } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  // List every tool the agent can call. Useful for the dashboard to
  // render a "capabilities" pane and for debugging tool schemas.
  // Proxies `mcpClient.listTools()` so the wire shape matches the
  // JSON-RPC `tools/list` response.
  //
  // RBAC: the result is filtered to match what `/api/llm/chat` would
  // actually permit for the caller's role — owner/admin see every
  // tool, family/guest see read-only. Without this, an unprivileged
  // user could enumerate `block_network_device`, `write_file`,
  // `commission_device`, etc. via the capabilities endpoint and use
  // that list to craft prompt-injection attempts. Execution is gated
  // independently in `/api/llm/chat`, so this is closing the
  // information-disclosure gap, not the privilege-escalation one.
  //
  // The `inputSchema → parameters` rename mirrors the OpenAI
  // function-calling shape callers historically expected.
  router.get("/llm/tools", async (req, res, next) => {
    try {
      const tools = await mcpClient.listTools();
      const role = (req as AuthedRequest).user?.role;
      const filtered = isPrivilegedRole(role)
        ? tools
        : tools.filter((t) => !WRITE_TOOLS.has(t.name));
      res.json({
        tools: filtered.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // WARP-555: read-only capability catalog for the dashboard `/tools`
  // surface. Distinct from `/api/tools` (the productized workflow shelf,
  // WARP-462) — this lists the BUILT-IN tools the agent can call, grouped
  // by domain, with the safety flags the JSON-RPC `tools/list` shape omits.
  //
  // Reads the in-process `TOOL_CATALOG` from `@droplet/tools-core` rather
  // than the live MCP child, so it never 500s on a crashed stdio process —
  // the surface that renders "what this Droplet can do" should always
  // render. `TOOL_CATALOG`'s domain/flags are derived from the canonical
  // registry, so this can't drift from per-tool intent.
  //
  // RBAC matches GET /llm/tools: owner/admin see every tool; everyone else
  // (family, guest, unauthenticated) sees read-only tools only, closing
  // the same information-disclosure gap on the destructive surface.
  router.get("/llm/tools/catalog", (req, res) => {
    const role = (req as AuthedRequest).user?.role;
    const tools = isPrivilegedRole(role)
      ? TOOL_CATALOG
      : TOOL_CATALOG.filter((t) => !t.requiresWrite);
    res.json({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        homeDescription: t.homeDescription,
        domain: t.domain,
        requiresWrite: t.requiresWrite,
        requiresConfirmation: t.requiresConfirmation,
      })),
      domains: TOOL_DOMAINS,
    });
  });

  // Key management (proxy to ai-gateway)
  // WARP-171: per-route guard. Provider API keys are household-tier
  // credentials (per-user OpenAI key etc.) — owner/admin/family scope.
  // No `guest` (read-only family-tier) and no `service`.
  router.post("/llm/keys/:provider", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const { provider } = req.params;
      const { api_key } = req.body;
      if (!api_key) {
        res.status(400).json({ error: "api_key is required" });
        return;
      }
      // WARP-561: forward the caller so the gateway namespaces the key per user.
      await aiGateway.saveKey(provider, api_key, (req as AuthedRequest).user?.id);
      res.json({ status: "ok", provider });
    } catch (err) {
      next(err);
    }
  });

  router.get("/llm/keys", async (req, res, next) => {
    try {
      const providers = await aiGateway.listKeys((req as AuthedRequest).user?.id);
      res.json({ providers });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: same posture as POST /llm/keys/:provider.
  router.delete("/llm/keys/:provider", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      await aiGateway.deleteKey(
        req.params.provider,
        (req as AuthedRequest).user?.id
      );
      res.json({ status: "deleted" });
    } catch (err) {
      next(err);
    }
  });

  // WARP-311: the legacy `/llm/sessions/*` routes that proxied to
  // ai-gateway-owned session state have been removed. The dashboard
  // moved off them in WARP-104; nothing in the orchestrator, the
  // dashboard, or any other tree consumer reaches them anymore, and
  // persistent conversation state now lives in the orchestrator's own
  // Postgres via WARP-304 (`/llm/conversations/*` above). The
  // ai-gateway's session endpoints stay available for direct callers
  // of the gateway, but the orchestrator no longer fronts them.

  // ── WARP-460 Phase B3 — Context pins ───────────────────────────────
  //
  // Per-thread bindings (folder / file / email_thread / camera /
  // camera_window) listed in the dashboard's side-panel "Context · N
  // sources" section (FEATURES.md §2.2.7). The agent loop reads pins on
  // every turn and prepends pin descriptions to the system prompt so
  // retrieval tools are scoped accordingly.
  //
  // Ownership check matches the chat-persistence pattern: the session's
  // `userId` column carries whatever the orchestrator wrote at session
  // creation (today: `req.user.username`; per WARP-485+WARP-488 the
  // backfill to UUID lands separately on ChatSession in a follow-up).
  // Read both shapes so the gate works through the transition.
  const pinCreateSchema = z.object({
    kind: z.enum(["folder", "file", "email_thread", "camera", "camera_window"]),
    ref: z.string().min(1).max(512),
    meta: z.record(z.unknown()).optional(),
  });

  async function loadOwnedSession(
    sessionId: string,
    req: import("express").Request,
  ): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
    const u = (req as AuthedRequest).user ?? {};
    const candidates: string[] = [];
    if (typeof u.id === "string") candidates.push(u.id);
    if (typeof u.username === "string") candidates.push(u.username);
    if (candidates.length === 0) {
      return { ok: false, status: 401, error: "Authentication required" };
    }
    const session = await prisma.chatSession.findFirst({
      where: { id: sessionId, userId: { in: candidates } },
      select: { userId: true },
    });
    if (!session) {
      return { ok: false, status: 404, error: "session not found" };
    }
    return { ok: true, userId: session.userId };
  }

  router.get(
    "/llm/:sessionId/pins",
    requireRole("owner", "admin", "family", "guest"),
    async (req, res, next) => {
      try {
        const owned = await loadOwnedSession(req.params.sessionId!, req);
        if (!owned.ok) {
          res.status(owned.status).json({ error: owned.error });
          return;
        }
        const pins = await prisma.contextPin.findMany({
          where: { sessionId: req.params.sessionId },
          orderBy: { addedAt: "asc" },
        });
        res.json({ pins });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/llm/:sessionId/pins",
    requireRole("owner", "admin", "family", "guest"),
    async (req, res, next) => {
      try {
        const owned = await loadOwnedSession(req.params.sessionId!, req);
        if (!owned.ok) {
          res.status(owned.status).json({ error: owned.error });
          return;
        }
        const parsed = pinCreateSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid pin",
            details: parsed.error.flatten(),
          });
          return;
        }
        const pin = await prisma.contextPin.create({
          data: {
            sessionId: req.params.sessionId!,
            kind: parsed.data.kind,
            ref: parsed.data.ref,
            meta: parsed.data.meta as object | undefined,
          },
        });
        res.status(201).json({ pin });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/llm/:sessionId/pins/:pinId",
    requireRole("owner", "admin", "family", "guest"),
    async (req, res, next) => {
      try {
        const owned = await loadOwnedSession(req.params.sessionId!, req);
        if (!owned.ok) {
          res.status(owned.status).json({ error: owned.error });
          return;
        }
        // Atomic ownership-scoped delete — if the pin doesn't exist or
        // belongs to a different session, count===0 and we 404. No
        // separate findUnique pre-check (avoids the TOCTOU pattern
        // captured in droplet-pr-review-patterns P1).
        const r = await prisma.contextPin.deleteMany({
          where: { id: req.params.pinId, sessionId: req.params.sessionId },
        });
        if (r.count === 0) {
          res.status(404).json({ error: "pin not found" });
          return;
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
