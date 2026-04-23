import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { PrismaClient } from "@prisma/client";
import { requestLogger } from "./middleware/request-logger.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createHealthRouter } from "./routes/health.js";
import { createDevicesRouter } from "./routes/devices.js";
import { createLlmRouter } from "./routes/llm.js";
import { createFilesRouter } from "./routes/files.js";
import { createDeviceClientsRouter } from "./routes/device-clients.js";
import { createStorageRouter } from "./routes/storage.js";
import { createPublicAuthRouter, createProtectedAuthRouter } from "./routes/auth.js";
import { createSmartHomeRouter } from "./routes/smart-home.js";
import { createMatterRouter } from "./routes/matter.js";
import { createNetworkRouter } from "./routes/network.js";
import { createCamerasRouter } from "./routes/cameras.js";
import { createSwitchRouter } from "./routes/switch.js";
import { createDisplayRouter } from "./routes/display.js";
import { createMcpRouter } from "./routes/mcp.js";
import { bootstrapRemoteMcpServers } from "./services/mcp-registry.js";

export function createApp(prisma: PrismaClient) {
  const app = express();

  // Trust the nginx reverse proxy so req.secure / X-Forwarded-Proto work
  app.set("trust proxy", 1);

  // Middleware
  app.use(cors({ credentials: true, origin: true }));
  app.use(helmet());
  app.use(cookieParser());
  app.use(requestLogger);
  app.use(express.json());

  // Public auth routes (setup + login) — no authentication required
  app.use("/api", createPublicAuthRouter());

  // Auth middleware (controlled by AUTH_ENABLED env var)
  app.use(authMiddleware);

  // Protected routes — auth middleware has populated req.user
  app.use("/api", createProtectedAuthRouter());
  app.use("/api", createHealthRouter(prisma));
  app.use("/api", createDevicesRouter());
  app.use("/api", createLlmRouter(prisma));
  app.use("/api", createFilesRouter(prisma));
  app.use("/api", createDeviceClientsRouter(prisma));
  app.use("/api", createStorageRouter());
  app.use("/api", createSmartHomeRouter(prisma));
  app.use("/api", createMatterRouter(prisma));
  app.use("/api", createNetworkRouter(prisma));
  app.use("/api", createCamerasRouter(prisma));
  app.use("/api", createSwitchRouter(prisma));
  app.use("/api", createDisplayRouter(prisma));
  // PR #7: Model Context Protocol surface — exposes TOOL_REGISTRY to
  // external MCP clients (Claude Desktop, Continue, etc.) so they can
  // use Droplet's tools too. Same auth + role gate as /api/llm/agent.
  app.use("/api", createMcpRouter(prisma));

  // Discover and register tools from external MCP servers configured via
  // MCP_SERVERS env var. Fire-and-forget — failures are logged and skipped
  // so the orchestrator boots even if a remote server is down.
  void bootstrapRemoteMcpServers();

  // Error handling
  app.use(errorHandler);

  return app;
}
