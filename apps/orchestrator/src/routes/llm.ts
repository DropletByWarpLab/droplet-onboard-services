import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import * as aiGateway from "../services/ai-gateway.client.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import { TOOLS } from "@droplet/tools-core";
import { mcpClient } from "../services/mcp-client.singleton.js";
import type { McpCallContext } from "../services/mcp-client.service.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { encodeSSE, type SSEEvent } from "../types/sse-events.js";
import type { ModelsResponse } from "../types/index.js";
import {
  ChatPersistenceService,
  type PersistedToolCall,
} from "../services/chat-persistence.service.js";
import { publish as mqttPublish } from "../services/mqtt.service.js";
import { requireRole } from "../middleware/auth.js";

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
  max_tokens: z.number().positive().optional(),
  provider: z.string().optional(),
  max_iter: z.number().int().min(1).max(10).optional(),
  allowed_tools: z.array(z.string()).optional(),
  conversationId: z.string().uuid().optional(),
  turnId: z.string().min(1).max(128).optional(),
  // WARP-174: setup wizard's "Ask the AI" sample prompt and similar
  // throwaway flows (system pings, health probes) set this to true
  // so the call skips ensureConversation + createTurnRows. Without
  // the flag every wizard tap creates a real ChatSession that
  // shows up in the customer's /chat history sidebar — confusing
  // first-run UX (their oldest conversation is the wizard's probe).
  ephemeral: z.boolean().optional().default(false),
});

const CONVERSATION_ID_HEADER = "X-Conversation-Id";
/** WARP-329: assistant row id, set alongside X-Conversation-Id on the same
 *  response. The client uses it to update the matching `streaming` row when
 *  the MQTT `turn-completed` event lands. */
const ASSISTANT_MESSAGE_ID_HEADER = "X-Assistant-Message-Id";

// Which tool names require the caller to have owner/admin role. Read-only
// tools (list_*, get_*, search_*) are fine for any authenticated user; write
// tools (block/unblock/accept/scan, file mutations) must be gated because
// the LLM is driven by user-controlled prompt text and will happily call
// them on request.
//
// As of WARP-104 the set is derived directly from each tool's
// `requiresWrite` boolean in `@droplet/tools-core` so role-gate behaviour
// can never drift from per-tool intent. Adding a write tool to the
// registry automatically includes it here. Legacy aliases
// `block_device` / `unblock_device` are not registered in tools-core —
// callers must use the canonical `block_network_device` /
// `unblock_network_device` names.
const WRITE_TOOLS = new Set(
  Array.from(TOOLS.values())
    .filter((t) => t.requiresWrite)
    .map((t) => t.name),
);

// RBAC helpers for /api/llm/chat. Threat model: the LLM is steered by
// user-controlled prompt text; only owner/admin sessions are allowed to
// touch write tools.
type AuthedRequest = { user?: { username?: string; role?: string } };

function isPrivilegedRole(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

async function narrowAllowedToolsForRole(
  role: string | undefined,
  requestedAllowed: string[] | undefined,
): Promise<string[] | undefined> {
  if (isPrivilegedRole(role)) {
    return requestedAllowed;
  }
  if (requestedAllowed?.length) {
    return requestedAllowed.filter((n) => !WRITE_TOOLS.has(n));
  }
  // Default for unprivileged users: every tool the live MCP server
  // advertises, minus write tools. listTools() throws if the child
  // crashed mid-runtime — fall back to an empty allowed set in that case
  // so the model sees zero tools rather than something privileged.
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
function replayedWriteToolAttempt(rawMessages: unknown): boolean {
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
      return typeof name === "string" && WRITE_TOOLS.has(name);
    });
}

// WARP-329 replaced the post-stream `persistTurn` helper with
// save-on-send: see `persistence.createTurnRows` (pre-agent) +
// `persistence.finalizeAssistantMessage` (post-agent) inline below.

export function createLlmRouter(prisma: PrismaClient): Router {
  const router = Router();
  const persistence = new ChatPersistenceService(prisma);

  // List available models
  router.get("/llm/models", async (_req, res, next) => {
    try {
      const cached = await cacheGet<ModelsResponse>(MODELS_CACHE_KEY);
      if (cached) {
        res.json(cached);
        return;
      }

      const models = await aiGateway.listModels();
      await cacheSet(MODELS_CACHE_KEY, models, MODELS_CACHE_TTL);
      res.json(models);
    } catch (err) {
      next(err);
    }
  });

  // Chat completion — drives the orchestrator agent loop end-to-end.
  // When stream=true the client receives the four SSE event types
  // defined in spec §8.2 (content_delta, tool_call, tool_result, done).
  // Non-streaming returns the AgentResult shape (assistant message +
  // trace + iterations + stop_reason).
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

      // RBAC: write tools require owner/admin. /api/llm/chat is the
      // live MCP-backed route — without this gate any authenticated
      // session could drive write tools via curl.
      // Reads `req.body.messages` (raw) for the spoof check because
      // Zod strips unrecognized keys (tool_calls) from the parsed shape.
      const role = (req as AuthedRequest).user?.role;
      if (
        !isPrivilegedRole(role) &&
        replayedWriteToolAttempt(
          (req.body as { messages?: unknown })?.messages,
        )
      ) {
        res.status(403).json({ error: "forbidden_tool_for_role" });
        return;
      }
      const allowedForUser = await narrowAllowedToolsForRole(
        role,
        chatReq.allowed_tools,
      );

      // Resolve the caller's Nextcloud session token so file-tool
      // handlers (`list_files`, `read_file`, `write_file`, etc.) can
      // authenticate to Nextcloud as the dashboard user. Threaded to
      // the MCP stdio child via `McpCallContext` → `_meta.ncToken` on
      // every `tools/call`. `resolveNcToken` returns null when the
      // request has no Nextcloud session (e.g. a direct API caller
      // without the cookie); file tools will then surface
      // AUTH_REQUIRED, which is the same behavior as before WARP-104.
      const ncToken = (await resolveNcToken(req).catch(() => null)) ?? undefined;
      // WARP-202: also forward the caller's username so handlers gated
      // on per-user RBAC (e.g. `search_content`'s pgvector lookup) can
      // scope queries to this user's chunks. The mcp-server's stdio
      // path treats `_meta.userId` as authoritative because the
      // orchestrator IS the trust boundary for that channel.
      const userId = (req as AuthedRequest).user?.username;
      const toolCallContext: McpCallContext | undefined = (ncToken || userId)
        ? { ...(ncToken ? { ncToken } : {}), ...(userId ? { userId } : {}) }
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
        const convo = await persistence
          .ensureConversation({
            conversationId: chatReq.conversationId,
            userId,
            model: chatReq.model,
            provider: chatReq.provider,
            firstUserContent: persistedUserContent,
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

      const deps: AgentDeps = {
        mcp: mcpClient,
        aiGateway: { chat: aiGateway.chat },
      };

      // Track tool calls observed during streaming so we can include
      // them in the persisted assistant message at the end of the turn.
      const liveToolCalls: PersistedToolCall[] = [];
      let liveAssistantContent = "";
      let lastFlushedContent = "";

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
        if (!conversationId || !assistantMessageId) return;
        const completedAt = new Date();
        try {
          await persistence.finalizeAssistantMessage({
            conversationId,
            messageId: assistantMessageId,
            content: liveAssistantContent,
            toolCalls: liveToolCalls,
            status,
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

      // ── Streaming path ──
      if (chatReq.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const onEvent = (e: SSEEvent) => {
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
            }
          }
        };
        let terminal: "completed" | "failed" | "aborted" = "completed";
        // WARP-329: detect client-side abort. req.on("close") fires when
        // the client disconnects mid-stream; we still finalize but flag
        // the turn as aborted so the row reflects reality.
        let clientAborted = false;
        req.on("close", () => {
          if (!res.writableEnded) clientAborted = true;
        });
        try {
          await runAgent({ ...deps, onEvent }, {
            model: chatReq.model,
            messages: chatReq.messages,
            temperature: chatReq.temperature,
            max_iter: chatReq.max_iter,
            allowed_tools: allowedForUser,
            toolCallContext,
          });
        } catch (err) {
          terminal = "failed";
          // eslint-disable-next-line no-console
          console.error("[llm/chat] agent loop failed:", err);
        } finally {
          res.end();
        }
        if (clientAborted) terminal = "aborted";
        await finalizeAndNotify(terminal);
        return;
      }

      // ── Non-streaming path ──
      let result;
      try {
        result = await runAgent(deps, {
          model: chatReq.model,
          messages: chatReq.messages,
          temperature: chatReq.temperature,
          max_iter: chatReq.max_iter,
          allowed_tools: allowedForUser,
          toolCallContext,
        });
        liveAssistantContent = result.message.content;
        for (const t of result.trace) {
          liveToolCalls.push({
            id: t.tool_call_id,
            name: t.tool,
            args: t.args,
            ok: true,
            data: t.result,
          });
        }
        await finalizeAndNotify("completed");
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
      const conversations = await persistence.listConversationsForUser(
        userId,
        limit,
        offset,
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
      const deleted = await persistence.deleteConversationForUser(
        req.params.id,
        userId,
      );
      if (!deleted) {
        res.status(404).json({ error: "conversation_not_found" });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

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
      const body = req.body as { title?: unknown };
      if (typeof body?.title !== "string") {
        res.status(400).json({ error: "title_required" });
        return;
      }
      let finalTitle: string | null;
      try {
        finalTitle = await persistence.renameConversationForUser(
          req.params.id,
          userId,
          body.title,
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
      res.json({
        id: req.params.id,
        title: finalTitle,
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
      await aiGateway.saveKey(provider, api_key);
      res.json({ status: "ok", provider });
    } catch (err) {
      next(err);
    }
  });

  router.get("/llm/keys", async (_req, res, next) => {
    try {
      const providers = await aiGateway.listKeys();
      res.json({ providers });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: same posture as POST /llm/keys/:provider.
  router.delete("/llm/keys/:provider", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      await aiGateway.deleteKey(req.params.provider);
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

  return router;
}
