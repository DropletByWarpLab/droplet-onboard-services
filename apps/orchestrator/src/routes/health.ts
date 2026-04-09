import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { isRedisHealthy } from "../services/cache.service.js";
import { healthCheck as aiGatewayHealth } from "../services/ai-gateway.client.js";
import { isMatterInitialized } from "../services/matter.service.js";
import type { HealthResponse } from "../types/index.js";

const startTime = Date.now();

export function createHealthRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const [dbOk, redisOk, aiOk] = await Promise.all([
      prisma.$queryRaw`SELECT 1`
        .then(() => true)
        .catch(() => false),
      isRedisHealthy(),
      aiGatewayHealth(),
    ]);

    const matterOk = isMatterInitialized();
    const allOk = dbOk && redisOk;
    const response: HealthResponse = {
      status: allOk ? "ok" : "degraded",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: "0.1.0",
      services: {
        db: dbOk,
        redis: redisOk,
        aiGateway: aiOk,
        matter: matterOk,
      },
    };

    res.status(allOk ? 200 : 503).json(response);
  });

  return router;
}
