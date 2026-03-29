import express from "express";
import cors from "cors";
import helmet from "helmet";
import { PrismaClient } from "@prisma/client";
import { requestLogger } from "./middleware/request-logger.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createHealthRouter } from "./routes/health.js";
import { createDevicesRouter } from "./routes/devices.js";
import { createLlmRouter } from "./routes/llm.js";
import { createFilesRouter } from "./routes/files.js";
import { createSyncRouter } from "./routes/sync.js";
import { createAuthRouter } from "./routes/auth.js";

export function createApp(prisma: PrismaClient) {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(helmet());
  app.use(requestLogger);
  app.use(express.json());

  // Auth routes (mounted BEFORE auth middleware — setup/login must be public)
  app.use("/api", createAuthRouter());

  // Auth middleware (controlled by AUTH_ENABLED env var)
  app.use(authMiddleware);

  // Protected routes
  app.use("/api", createHealthRouter(prisma));
  app.use("/api", createDevicesRouter());
  app.use("/api", createLlmRouter());
  app.use("/api", createFilesRouter(prisma));
  app.use("/api", createSyncRouter(prisma));

  // Error handling
  app.use(errorHandler);

  return app;
}
