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
import { createFilesBrainRouter } from "./routes/files-brain.js";
import { createFilesKnowledgeRouter } from "./routes/files-knowledge.js";
import { createDeviceClientsRouter } from "./routes/device-clients.js";
import { createStorageRouter } from "./routes/storage.js";
import { createPublicAuthRouter, createProtectedAuthRouter } from "./routes/auth.js";
import { createMatterRouter } from "./routes/matter.js";
import { createNetworkRouter } from "./routes/network.js";
import { createCamerasRouter, createCameraSharePublicRouter } from "./routes/cameras.js";
import { createSwitchRouter } from "./routes/switch.js";
import { createDisplayRouter } from "./routes/display.js";
import { createCalendarRouter, createCalendarPublicRouter } from "./routes/calendar.js";
import { createRemindersRouter } from "./routes/reminders.js";
import { createNotificationsRouter } from "./routes/notifications.js";
import { createVpnRouter } from "./routes/vpn.js";
import { createDdnsRouter } from "./routes/ddns.js";
import { startRemindersPoller } from "./services/reminders-poller.js";
import { initPushDispatch } from "./services/push-dispatch.service.js";

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

  // Public calendar ICS publish endpoint — phones subscribe via webcal://
  // without a session cookie. Token in the query string is the auth (HMAC
  // of DEVICE_SECRET + username, see routes/calendar.ts publishToken).
  // Mount BEFORE the auth middleware so it doesn't require a session.
  app.use("/api", createCalendarPublicRouter(prisma));
  // Public clip-share endpoint — recipient of a shared link doesn't have a
  // session; the HMAC-signed token in ?t=... is the authorization. Mounted
  // BEFORE auth middleware so forwarded links work without a Droplet account.
  app.use("/api", createCameraSharePublicRouter());

  // Auth middleware (controlled by AUTH_ENABLED env var)
  app.use(authMiddleware);

  // Protected routes — auth middleware has populated req.user
  app.use("/api", createProtectedAuthRouter(prisma));
  app.use("/api", createHealthRouter(prisma));
  app.use("/api", createDevicesRouter());
  app.use("/api", createLlmRouter(prisma));
  app.use("/api", createFilesRouter(prisma));
  app.use("/api", createFilesBrainRouter(prisma));
  app.use("/api", createFilesKnowledgeRouter(prisma));
  app.use("/api", createDeviceClientsRouter(prisma));
  app.use("/api", createStorageRouter());
  app.use("/api", createMatterRouter(prisma));
  app.use("/api", createNetworkRouter(prisma));
  app.use("/api", createCamerasRouter(prisma));
  app.use("/api", createSwitchRouter(prisma));
  app.use("/api", createDisplayRouter(prisma));
  app.use("/api", createCalendarRouter(prisma));
  app.use("/api", createRemindersRouter(prisma));
  app.use("/api", createNotificationsRouter(prisma));
  app.use("/api", createVpnRouter(prisma));
  app.use("/api", createDdnsRouter());

  // Reminders poller — wakes every REMINDER_POLL_INTERVAL_SEC (default 30s)
  // to dispatch due-time notifications and re-sync calendar sources.
  startRemindersPoller(prisma);

  // Web Push — initialise VAPID + log keys at startup. Idempotent;
  // safe to call before any subscribe/push attempt.
  initPushDispatch();

  // Error handling
  app.use(errorHandler);

  return app;
}
