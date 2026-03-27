import { Router } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import * as aiGateway from "../services/ai-gateway.client.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import type { ModelsResponse, ChatRequest } from "../types/index.js";

const MODELS_CACHE_KEY = "llm:models";
const MODELS_CACHE_TTL = 30;

const chatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    })
  ),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().positive().optional(),
  provider: z.string().optional(),
});

export function createLlmRouter(): Router {
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

  return router;
}
