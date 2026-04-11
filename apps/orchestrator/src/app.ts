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
import { createSyncRouter } from "./routes/sync.js";
import { createStorageRouter } from "./routes/storage.js";
import { createPublicAuthRouter, createProtectedAuthRouter } from "./routes/auth.js";
import { createSmartHomeRouter } from "./routes/smart-home.js";
import { createMatterRouter } from "./routes/matter.js";
import { createNetworkRouter } from "./routes/network.js";
import { createCamerasRouter } from "./routes/cameras.js";

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
  app.use("/api", createLlmRouter());
  app.use("/api", createFilesRouter(prisma));
  app.use("/api", createSyncRouter(prisma));
  app.use("/api", createStorageRouter());
  app.use("/api", createSmartHomeRouter(prisma));
  app.use("/api", createMatterRouter(prisma));
  app.use("/api", createNetworkRouter(prisma));
  app.use("/api", createCamerasRouter(prisma));

  // Error handling
  app.use(errorHandler);

  return app;
}
