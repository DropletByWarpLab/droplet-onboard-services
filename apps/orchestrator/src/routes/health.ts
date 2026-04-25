import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { isRedisHealthy } from "../services/cache.service.js";
import { healthCheck as aiGatewayHealth } from "../services/ai-gateway.client.js";
import { isMatterInitialized } from "../services/matter.service.js";
import { isRouterHealthy } from "../services/network.service.js";
import { isFrigateHealthy } from "../services/camera.service.js";
import { healthCheck as switchHealthCheck } from "../services/switch.client.js";
import { getAggregateHealth } from "../services/health-monitor.service.js";
import type { HealthResponse } from "../types/index.js";

const startTime = Date.now();

export function createHealthRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const [dbOk, redisOk, aiOk, routerOk, frigateOk, switchOk] = await Promise.all([
      prisma.$queryRaw`SELECT 1`
        .then(() => true)
        .catch(() => false),
      isRedisHealthy(),
      aiGatewayHealth(),
      isRouterHealthy(),
      isFrigateHealthy(),
      switchHealthCheck(),
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
        router: routerOk,
        frigate: frigateOk,
        switch: switchOk,
      },
    };

    res.status(allOk ? 200 : 503).json(response);
  });

  // WARP-43: rolled-up health for Docker healthcheck + dashboard pill.
  // Returns the cached snapshot from the background poller — this endpoint
  // is cheap even under heavy polling load.
  router.get("/orchestrator/health", (_req, res) => {
    const snapshot = getAggregateHealth();
    // Return HTTP 200 for `ok`/`degraded`, 503 for `down` so Docker's
    // healthcheck restarts the container when a HARD dependency fails.
    const httpStatus = snapshot.status === "down" ? 503 : 200;
    res.status(httpStatus).json(snapshot);
  });

  return router;
}
