import { Router } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import * as aiGateway from "../services/ai-gateway.client.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import { TOOL_REGISTRY } from "../services/llm-tools.js";
import { mcpClient } from "../services/mcp-client.singleton.js";
import { encodeSSE, type SSEEvent } from "../types/sse-events.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import type { ModelsResponse, SessionChatRequest } from "../types/index.js";

const MODELS_CACHE_KEY = "llm:models";
const MODELS_CACHE_TTL = 30;

// /llm/chat accepts tool-role messages on replay so a client can resume a
// session that already went through the agent loop. tool_call_id / tool_calls
// are optional so plain chat callers don't have to care.
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
});

// Only system / user / assistant are accepted from the caller — role="tool"
// is intentionally NOT in the enum to prevent a client from planting a
// spoofed tool-result message into the conversation (which would bias the
// next turn toward calling a privileged write tool). Tool-role messages
// are only appended by the agent loop itself, from actual MCP callTool()
// results. See the security review in PR #66 for the threat model.
const agentRequestSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    }),
  ),
  max_iter: z.number().int().min(1).max(10).optional(),
  temperature: z.number().min(0).max(2).optional(),
  allowed_tools: z.array(z.string()).optional(),
});

// Which tool names require the caller to have owner/admin role. Read-only
// tools (list_*, get_*, search_*) are fine for any authenticated user; write
// tools (block/unblock/accept/scan, file mutations) must be gated because
// the LLM is driven by user-controlled prompt text and will happily call
// them on request.
//
// Note: spec §6.2 reconciles legacy names (`block_device` etc.) into the
// MCP-canonical names. Until WARP-102 ports every handler, both names may
// be present in the registry; we list the MCP-canonical names here. The
// in-process /api/llm/agent path still calls into `llm-tools.ts` which
// uses the legacy names — keep both sides covered.
const WRITE_TOOLS = new Set([
  "block_device",
  "block_network_device",
  "unblock_device",
  "unblock_network_device",
  "accept_discovered_camera",
  "scan_for_cameras",
  // File mutation tools (from the file write/search PR). Write-gated because
  // the LLM can be steered into creating/deleting/moving user files via
  // a malicious prompt — only confirmed chat flows should flip the gate.
  "write_file",
  "delete_file",
  "create_directory",
  "rename_file",
  "move_file",
  "copy_file",
  // Calendar / Reminders / Notifications. Calendar mutations don't touch
  // the network or other devices, but they DO modify the user's calendar
  // — same prompt-injection threat model applies.
  "create_event",
  "update_event",
  "delete_event",
  "create_reminder",
  "complete_reminder",
  "send_notification",
  // Clip export writes to Nextcloud + creates a Files entry; share_clip
  // emits a token that grants public read access until expiry.
  "export_clip",
  "share_clip",
]);

// RBAC helpers — shared between /api/llm/chat and /api/llm/agent so the
// two routes can't drift apart on which tools an unprivileged user can
// drive. Same threat model: the LLM is steered by user-controlled prompt
// text; only owner/admin sessions are allowed to touch write tools.
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
// invoking a write tool inside replayed assistant history. Spoofed tool
// results are blocked at the schema level for /agent (role="tool" not
// allowed); /chat permits role="tool" for resume-session callers but
// the same spoof-then-bypass risk exists if the planted assistant turn
// sets `tool_calls`.
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

export function createLlmRouter(_prisma: PrismaClient): Router {
  const router = Router();

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
  router.post("/llm/chat", async (req, res, next) => {
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

      // RBAC: same gate as /api/llm/agent — write tools require
      // owner/admin. Lifted up here because /api/llm/chat is the live
      // route the dashboard will switch to in WARP-104; without this
      // any authenticated session could drive write tools via curl.
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

      const deps: AgentDeps = {
        mcp: mcpClient,
        aiGateway: { chat: aiGateway.chat },
      };

      if (chatReq.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const onEvent = (e: SSEEvent) => {
          // Best-effort write — if the client disconnected mid-stream
          // res.write throws ECONNRESET; swallow because the abort path
          // (req.on("close")) handles the rest.
          try {
            res.write(encodeSSE(e));
          } catch {
            /* client gone */
          }
        };
        try {
          await runAgent({ ...deps, onEvent }, {
            model: chatReq.model,
            messages: chatReq.messages,
            temperature: chatReq.temperature,
            max_iter: chatReq.max_iter,
            allowed_tools: allowedForUser,
          });
        } finally {
          res.end();
        }
        return;
      }

      const result = await runAgent(deps, {
        model: chatReq.model,
        messages: chatReq.messages,
        temperature: chatReq.temperature,
        max_iter: chatReq.max_iter,
        allowed_tools: allowedForUser,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // List every tool the agent can call. Useful for the dashboard to
  // render a "capabilities" pane and for debugging tool schemas.
  // WARP-104 will refactor this to proxy mcpClient.listTools(); for now
  // it still surfaces the in-process registry that /api/llm/agent uses.
  router.get("/llm/tools", (_req, res) => {
    res.json({
      tools: Object.values(TOOL_REGISTRY).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    });
  });

  // Tool-aware agent endpoint. WARP-104 deletes this — it overlaps with
  // /api/llm/chat now that the chat path drives the orchestrator agent
  // loop directly. While it lives, route it through the same MCP client
  // so the two endpoints can't drift out of sync mid-sprint.
  router.post("/llm/agent", async (req, res, next) => {
    try {
      const parsed = agentRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request",
          details: parsed.error.flatten(),
        });
        return;
      }
      const role = (req as AuthedRequest).user?.role;

      // RBAC + replayed-write detection (shared with /api/llm/chat — see
      // helpers above the router). Reads raw req.body.messages because
      // Zod strips unrecognized keys (tool_calls) from parsed.data.
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
        parsed.data.allowed_tools,
      );

      // Nextcloud-scoped tools (list_files / search_files / list_recent_files)
      // need the caller's NC session token. The new MCP-backed agent
      // doesn't yet thread ncToken into the stdio child (WARP-103 will);
      // for now the route resolves it but it's not propagated. Document
      // the gap so QA doesn't get surprised.
      await resolveNcToken(req).catch(() => null);

      const result = await runAgent(
        { mcp: mcpClient, aiGateway: { chat: aiGateway.chat } },
        {
          model: parsed.data.model,
          messages: parsed.data.messages,
          max_iter: parsed.data.max_iter,
          temperature: parsed.data.temperature,
          allowed_tools: allowedForUser,
        },
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Key management (proxy to ai-gateway)
  router.post("/llm/keys/:provider", async (req, res, next) => {
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

  router.delete("/llm/keys/:provider", async (req, res, next) => {
    try {
      await aiGateway.deleteKey(req.params.provider);
      res.json({ status: "deleted" });
    } catch (err) {
      next(err);
    }
  });

  // --- Sessions ---
  // Sessions still proxy to the ai-gateway (which owns persistent
  // conversation state). The dashboard's /chat page goes through these
  // session routes today, so the SSE shape change on /api/llm/chat
  // doesn't reach it.

  router.post("/llm/sessions", async (req, res, next) => {
    try {
      const { model, title, system_prompt } = req.body;
      if (!model) {
        res.status(400).json({ error: "model is required" });
        return;
      }
      const session = await aiGateway.createSession({ model, title, system_prompt });
      res.status(201).json(session);
    } catch (err) {
      next(err);
    }
  });

  router.get("/llm/sessions", async (req, res, next) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const sessions = await aiGateway.listSessions(limit, offset);
      res.json(sessions);
    } catch (err) {
      next(err);
    }
  });

  router.get("/llm/sessions/:sessionId", async (req, res, next) => {
    try {
      const session = await aiGateway.getSession(req.params.sessionId);
      res.json(session);
    } catch (err) {
      next(err);
    }
  });

  router.patch("/llm/sessions/:sessionId", async (req, res, next) => {
    try {
      const { title } = req.body;
      if (!title) {
        res.status(400).json({ error: "title is required" });
        return;
      }
      const session = await aiGateway.updateSession(req.params.sessionId, title);
      res.json(session);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/llm/sessions/:sessionId", async (req, res, next) => {
    try {
      await aiGateway.deleteSession(req.params.sessionId);
      res.json({ status: "deleted" });
    } catch (err) {
      next(err);
    }
  });

  router.post("/llm/sessions/:sessionId/chat", async (req, res, next) => {
    try {
      const { message, stream, temperature, max_tokens, provider } = req.body;
      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }

      const chatReq: SessionChatRequest = {
        message,
        stream: stream ?? false,
        temperature,
        max_tokens,
        provider,
      };

      const gatewayRes = await aiGateway.sessionChat(
        req.params.sessionId,
        chatReq
      );

      if (chatReq.stream && gatewayRes.body) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        const reader = gatewayRes.body as ReadableStream<Uint8Array>;
        const nodeStream = Readable.fromWeb(reader as never);
        nodeStream.pipe(res);

        req.on("close", () => {
          nodeStream.destroy();
        });
      } else {
        const data = await gatewayRes.json();
        res.json(data);
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
