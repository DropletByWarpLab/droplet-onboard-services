import express from "express";
import cors from "cors";
import helmet from "helmet";
import { PrismaClient } from "@prisma/client";
import { requestLogger } from "./middleware/request-logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createHealthRouter } from "./routes/health.js";
import { createDevicesRouter } from "./routes/devices.js";
import { createLlmRouter } from "./routes/llm.js";
import { createFilesRouter } from "./routes/files.js";
import { createSyncRouter } from "./routes/sync.js";

export function createApp(prisma: PrismaClient) {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(helmet());
  app.use(requestLogger);
  app.use(express.json());

  // Routes
  app.use("/api", createHealthRouter(prisma));
  app.use("/api", createDevicesRouter());
  app.use("/api", createLlmRouter());
  app.use("/api", createFilesRouter(prisma));
  app.use("/api", createSyncRouter(prisma));

  // Error handling
  app.use(errorHandler);

  return app;
}
