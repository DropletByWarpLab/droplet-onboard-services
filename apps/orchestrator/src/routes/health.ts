import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { isRedisHealthy } from "../services/cache.service.js";
import { healthCheck as aiGatewayHealth } from "../services/ai-gateway.client.js";
import { isMatterInitialized } from "../services/matter.service.js";
import { isRouterHealthy } from "../services/network.service.js";
import { isFrigateHealthy } from "../services/camera.service.js";
import { switchHealthDetail } from "../services/switch.client.js";
import { getAggregateHealth } from "../services/health-monitor.service.js";
import { inferenceRuntime } from "../services/inference-runtime.js";
import type { HealthResponse } from "../types/index.js";

const startTime = Date.now();

export function createHealthRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const [dbOk, redisOk, aiOk, routerOk, frigateOk, switchDetail] = await Promise.all([
      prisma.$queryRaw`SELECT 1`
        .then(() => true)
        .catch(() => false),
      isRedisHealthy(),
      aiGatewayHealth(),
      isRouterHealthy(),
      isFrigateHealthy(),
      // DECISION 2: switchHealthDetail logs a warning when the switch service
      // reports auth_configured=false (fail-closed deploy) — `switchOk` still
      // reflects only connectivity, so a missing secret never fails /health.
      switchHealthDetail(),
    ]);
    const switchOk = switchDetail.connected;

    // WARP-165: display is sourced from the cached health-monitor snapshot
    // (refreshed every 15s) instead of a live probe per request. A hung
    // display service was taxing the eager `/api/health` latency on every
    // dashboard pill refresh; the background monitor handles it now.
    // The status display stays `true` in simulated-mode too — the FastAPI app
    // is up regardless of whether USB-serial probe found a physical device.
    // /display/status surfaces the backend (pyportal | simulated) if the
    // dashboard wants to distinguish.
    const snapshot = getAggregateHealth();
    const displayComponent = snapshot.components.find((c) => c.name === "display");
    // Default to true if the monitor hasn't run yet — same charity the
    // route used before the rename. The cached snapshot will populate
    // within one POLL_INTERVAL_MS of boot.
    const displayOk = displayComponent ? displayComponent.status === "ok" : true;

    const matterOk = isMatterInitialized();
    const allOk = dbOk && redisOk;
    const response: HealthResponse = {
      status: allOk ? "ok" : "degraded",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: "0.1.0",
      // WARP-1926 — which inference runtime this box actually serves from.
      // The dashboard had NO way to know: Settings hardcoded the string
      // "Ollama (on-device)", so every DMR box (the shipped default since
      // WARP-1870) told its owner it was running a daemon that is not
      // installed. This is the same class of deployment fact as `version`
      // and the `services` map already on this unauthenticated route — it
      // names a runtime, never an endpoint, model or credential.
      inferenceRuntime: inferenceRuntime(),
      services: {
        db: dbOk,
        redis: redisOk,
        aiGateway: aiOk,
        matter: matterOk,
        router: routerOk,
        frigate: frigateOk,
        switch: switchOk,
        display: displayOk,
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
