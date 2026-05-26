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
import { createApsRouter } from "./routes/aps.js";
import { createDdnsRouter } from "./routes/ddns.js";
import { createAdminClaudeActivityRouter } from "./routes/admin-claude-activity.js";
import { createAdminDeviceIdentityRouter } from "./routes/admin-device-identity.js";
import { createAdminRetrievalEvalRouter } from "./routes/admin-retrieval-eval.js";
import { createMeContextStatsRouter } from "./routes/me-context-stats.js";
import { createFipsRouter } from "./routes/fips.js";
import { createActivityRouter } from "./routes/activity.js";
import { createPeopleRouter } from "./routes/people.js";
import { createDeviceIdentityClient } from "./services/device-identity.client.js";
import { startRemindersPoller } from "./services/reminders-poller.js";
import { startScreenQRPoller } from "./services/screen-qr.service.js";
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

  // Public auth routes (setup + login + invite-accept) — no authentication required.
  // Prisma is required for the WARP-217 invite-accept endpoints (token lookup).
  app.use("/api", createPublicAuthRouter(prisma));

  // Public calendar ICS publish endpoint — phones subscribe via webcal://
  // without a session cookie. Token in the query string is the auth (HMAC
  // of DEVICE_SECRET + username, see routes/calendar.ts publishToken).
  // Mount BEFORE the auth middleware so it doesn't require a session.
  app.use("/api", createCalendarPublicRouter(prisma));
  // Public clip-share endpoint — recipient of a shared link doesn't have a
  // session; the HMAC-signed token in ?t=... is the authorization. Mounted
  // BEFORE auth middleware so forwarded links work without a Droplet account.
  app.use("/api", createCameraSharePublicRouter());

  // WARP-229: FIPS status endpoint. Mounted BEFORE auth middleware so a
  // stuck-auth incident doesn't hide the FIPS state from the operator.
  // Lives under `/_/fips` (not `/api/...`) so it sits in the
  // orchestrator's internal namespace, parallel to other operator probes.
  app.use(createFipsRouter("orchestrator"));

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
  app.use("/api", createStorageRouter(prisma));
  app.use("/api", createMatterRouter(prisma));
  app.use("/api", createNetworkRouter(prisma));
  app.use("/api", createCamerasRouter(prisma));
  app.use("/api", createSwitchRouter(prisma));
  app.use("/api", createDisplayRouter(prisma));
  app.use("/api", createCalendarRouter(prisma));
  app.use("/api", createRemindersRouter(prisma));
  app.use("/api", createNotificationsRouter(prisma));
  app.use("/api", createVpnRouter(prisma));
  // WARP-446: coverage extender AP onboarding (ADR-005).
  app.use("/api", createApsRouter(prisma));
  app.use("/api", createDdnsRouter());
  // WARP-279: meta-observability dashboard for admin/owner roles. Aggregates
  // session-state.json + GitHub + Jira + compliance-progress.md.
  app.use("/api", createAdminClaudeActivityRouter());
  // WARP-230: device-identity admin routes. GET /status + POST /reseal,
  // both gated by admin role; reseal additionally requires recent MFA.
  // The gRPC client is constructed once per orchestrator instance; the
  // underlying Unix-socket channel is opened lazily by grpc-js on first
  // call so process startup doesn't fail when the sidecar isn't ready.
  app.use("/api", createAdminDeviceIdentityRouter(createDeviceIdentityClient()));
  // WARP-286: retrieval-eval endpoint — exposes vector/rrf/hybrid pipelines
  // to the offline NDCG@10 harness. 404 in production.
  app.use("/api", createAdminRetrievalEvalRouter(prisma));
  // WARP-225: per-user context-meter (home widget + /context page).
  app.use("/api", createMeContextStatsRouter(prisma));
  // WARP-456: signed append-only activity feed + export bundle.
  app.use("/api", createActivityRouter(prisma));
  // WARP-455: A1 local user directory + role/scope mutations. Mutations
  // emit ActivityRow rows via recordActivity (auth kind for lifecycle,
  // system kind for permission edits).
  app.use("/api", createPeopleRouter(prisma));

  // Reminders poller — wakes every REMINDER_POLL_INTERVAL_SEC (default 30s)
  // to dispatch due-time notifications and re-sync calendar sources.
  startRemindersPoller(prisma);

  // PyPortal screen QR — context-switched display (setup URL on first boot,
  // last-generated WireGuard peer for ~60 s after creation, WiFi-hotspot QR
  // otherwise). 30 s poller; calls into Nextcloud + device-bridge.
  // Failures in any leg leave the screen alone rather than blanking it.
  startScreenQRPoller();

  // Web Push — initialise VAPID + log keys at startup. Idempotent;
  // safe to call before any subscribe/push attempt.
  initPushDispatch();

  // Error handling
  app.use(errorHandler);

  return app;
}
