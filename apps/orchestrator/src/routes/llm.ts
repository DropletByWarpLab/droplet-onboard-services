import { Router } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import * as aiGateway from "../services/ai-gateway.client.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import { runAgent } from "../services/llm-agent.service.js";
import { TOOL_REGISTRY } from "../services/llm-tools.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import type { ModelsResponse, ChatRequest, SessionChatRequest } from "../types/index.js";

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
});

// Only system / user / assistant are accepted from the caller — role="tool"
// is intentionally NOT in the enum to prevent a client from planting a
// spoofed tool-result message into the conversation (which would bias the
// next turn toward calling a privileged write tool). Tool-role messages
// are only appended by the agent loop itself, from actual dispatchTool()
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
// tools (block/unblock/accept/scan) must be gated because the LLM is driven
// by user-controlled prompt text and will happily call them on request.
const WRITE_TOOLS = new Set([
  "block_device",
  "unblock_device",
  "accept_discovered_camera",
  "scan_for_cameras",
]);

export function createLlmRouter(prisma: PrismaClient): Router {
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

  // Chat completion
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

      const chatReq: ChatRequest = parsed.data;
      const gatewayRes = await aiGateway.chat(chatReq);

      if (chatReq.stream && gatewayRes.body) {
        // Stream SSE through to the client
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        const reader = gatewayRes.body as ReadableStream<Uint8Array>;
        const nodeStream = Readable.fromWeb(reader as any);
        nodeStream.pipe(res);

        // Clean up on client disconnect
        req.on("close", () => {
          nodeStream.destroy();
        });
      } else {
        // Non-streaming: forward JSON response
        const data = await gatewayRes.json();
        res.json(data);
      }
    } catch (err) {
      next(err);
    }
  });

  // List every tool the agent can call. Useful for the dashboard to
  // render a "capabilities" pane and for debugging tool schemas.
  router.get("/llm/tools", (_req, res) => {
    res.json({
      tools: Object.values(TOOL_REGISTRY).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    });
  });

  // Tool-aware agent endpoint. Runs a ReAct-style loop against the local
  // LLM — on each turn, if the model emits `tool_calls`, we dispatch
  // them against the registry (network, files, cameras, system) and
  // feed the results back. Returns the final assistant message plus a
  // trace of every tool invocation.
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
      const user = (req as { user?: { username: string; role?: string } }).user;
      const username = user?.username;
      const role = user?.role;
      const isPrivileged = role === "owner" || role === "admin";

      // Narrow the advertised tool set for non-privileged users so the model
      // never even sees the write tools as an option. Callers can further
      // restrict via `allowed_tools[]` but not widen past this.
      const requestedAllowed = parsed.data.allowed_tools;
      const allowedForUser = isPrivileged
        ? requestedAllowed
        : (requestedAllowed ?? []).filter((n) => !WRITE_TOOLS.has(n)) ||
          // Implicit allowed set when caller didn't pass one: all read-only.
          Array.from(Object.keys(TOOL_REGISTRY)).filter((n) => !WRITE_TOOLS.has(n));

      // Also refuse at dispatch time if the model somehow emits a write-tool
      // call anyway (prompt-injected, hallucination). Belt and braces.
      if (!isPrivileged) {
        const writeAttempted = (parsed.data.messages ?? [])
          .flatMap((m) => (m as { tool_calls?: { function: { name: string } }[] }).tool_calls ?? [])
          .some((c) => WRITE_TOOLS.has(c.function?.name));
        if (writeAttempted) {
          res.status(403).json({ error: "forbidden_tool_for_role" });
          return;
        }
      }

      // Nextcloud-scoped tools (list_files / search_files / list_recent_files)
      // need the caller's NC session token. Other tools ignore it.
      const ncToken = (await resolveNcToken(req).catch(() => null)) ?? undefined;
      const result = await runAgent(
        { ...parsed.data, allowed_tools: allowedForUser },
        prisma,
        username,
        ncToken,
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
        const nodeStream = Readable.fromWeb(reader as any);
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
