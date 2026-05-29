import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { PrismaClient } from "@prisma/client";
import { requestLogger } from "./middleware/request-logger.js";
import { authMiddleware, setAuthPrisma } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createHealthRouter } from "./routes/health.js";
import { createDevicesRouter } from "./routes/devices.js";
import { createLlmRouter } from "./routes/llm.js";
import { createMemoryRouter } from "./routes/memory.js";
import { createFilesRouter } from "./routes/files.js";
import { createFilesBrainRouter } from "./routes/files-brain.js";
import { createFilesKnowledgeRouter } from "./routes/files-knowledge.js";
import { createDeviceClientsRouter } from "./routes/device-clients.js";
import { createStorageRouter } from "./routes/storage.js";
import { createPublicAuthRouter, createProtectedAuthRouter } from "./routes/auth.js";
import { createMatterRouter } from "./routes/matter.js";
import { createPmWebhookRouter } from "./routes/pm-webhook.js";
import { createPmOnboardRouter } from "./routes/pm-onboard.js";
import { createPmMobileRouter } from "./routes/mobile/pm.js";
import { createPmRouter } from "./routes/pm.js";
import { createScenesRouter } from "./routes/scenes.js";
import { sendMatterCommand } from "./services/matter.service.js";
import { createNetworkRouter } from "./routes/network.js";
import { createNetworkThroughputRouter } from "./routes/network-throughput.js";
import { createOffLanNetworkRouter } from "./routes/off-lan-network.js";
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
import { adminFilesRouter } from "./routes/admin-files.js";
import { setPrismaForReindex } from "./services/file-reindex.service.js";
import { createAdminRagEvalRouter } from "./routes/admin-rag-eval.js";
import { createMeContextStatsRouter } from "./routes/me-context-stats.js";
import { createSettingsWorkspaceRouter } from "./routes/settings-workspace.js";
import { createFipsRouter } from "./routes/fips.js";
import { createActivityRouter } from "./routes/activity.js";
import { createPeopleRouter } from "./routes/people.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createEmailRouter, wireEmailAnalysis } from "./routes/email.js";
import { createEmailAnalysisFn } from "./services/email-analysis.service.js";
import { createToolsRouter } from "./routes/tools.js";
import { mcpClient } from "./services/mcp-client.singleton.js";
import type { StepDispatcher } from "./services/tool-spec-runner.service.js";
import { createModelsRouter } from "./routes/models.js";
import { createHardwareRouter } from "./routes/hardware.js";
import { createHomeRouter } from "./routes/home.js";
import { createDeviceIdentityClient } from "./services/device-identity.client.js";
import { startRemindersPoller } from "./services/reminders-poller.js";
import { startScreenQRPoller } from "./services/screen-qr.service.js";
import { initPushDispatch } from "./services/push-dispatch.service.js";
import {
  seedWorkspaceSettings,
  seedOffLanChannels,
} from "./services/workspace-settings.service.js";
import pino from "pino";

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

  // WARP-511 — Plane → orchestrator webhook receiver. Plane has no
  // dashboard session; HMAC-SHA256 signature over the timestamp + body is
  // the only auth. Fail-CLOSED on any mismatch. Mounted BEFORE authMiddleware.
  app.use(createPmWebhookRouter());

  // WARP-505 — Plane OIDC IdP. Five endpoints under /api/pm/oidc/*:
  //   - .well-known/openid-configuration + jwks.json (public discovery)
  //   - authorize (verifies the dashboard `droplet_session` cookie INLINE
  //     via jwt.service.ts — does NOT want authMiddleware to short-circuit
  //     it with a 401 before the OIDC redirect chain can run)
  //   - token (Plane → orchestrator server-to-server; client_secret auth)
  //   - userinfo (validates its own RS256 access token, NOT the session
  //     cookie)
  // Every endpoint handles its own auth shape, so the router mounts
  // BEFORE authMiddleware — matches the webhook + camera-share pattern
  // above. Stefan flagged this explicitly in the PR redesign comment.
  app.use(createPmRouter());

  // WARP-229: FIPS status endpoint. Mounted BEFORE auth middleware so a
  // stuck-auth incident doesn't hide the FIPS state from the operator.
  // Lives under `/_/fips` (not `/api/...`) so it sits in the
  // orchestrator's internal namespace, parallel to other operator probes.
  app.use(createFipsRouter("orchestrator"));

  // WARP-485 — wire the Prisma client into the auth middleware so the
  // OCS fallback can resolve `ocs.data.id` (Nextcloud username) to the
  // local `User.id` UUID. Must run before `app.use(authMiddleware)` so
  // the very first request after boot gets a populated singleton; pre-
  // boot requests fall into the fail-closed `USER_NOT_PROVISIONED`
  // branch instead of regressing the OCS-username-as-id leak.
  setAuthPrisma(prisma);

  // Auth middleware (controlled by AUTH_ENABLED env var)
  app.use(authMiddleware);

  // Protected routes — auth middleware has populated req.user
  app.use("/api", createProtectedAuthRouter(prisma));
  app.use("/api", createHealthRouter(prisma));
  app.use("/api", createDevicesRouter());
  app.use("/api", createLlmRouter(prisma));
  app.use("/api", createMemoryRouter(prisma));
  app.use("/api", createFilesRouter(prisma));
  app.use("/api", createFilesBrainRouter(prisma));
  app.use("/api", createFilesKnowledgeRouter(prisma));
  app.use("/api", createDeviceClientsRouter(prisma));
  app.use("/api", createStorageRouter(prisma));
  app.use("/api", createMatterRouter(prisma));
  // WARP-507 — Plane onboarding endpoint for the setup wizard.
  app.use(createPmOnboardRouter());
  // WARP-513 — read-only mobile wrappers around Plane upstream
  // (workspaces, projects, work-items). iOS/Android/Windows consume.
  app.use(createPmMobileRouter());
  // WARP-474 (G2): smart-home scenes CRUD + batch-run. Run dispatches
  // each action through `sendMatterCommand` — partial-failure tolerant,
  // per-action results returned to the dashboard.
  app.use(
    "/api",
    createScenesRouter(prisma, {
      sendCommand: (nodeId, command, args) =>
        sendMatterCommand(nodeId, command, args),
    }),
  );
  app.use("/api", createNetworkRouter(prisma));
  // WARP-470: WAN throughput sampler + KPI rollup + 24 h time-series for §2.6
  // Network page. Service-principal POST for the routing sampler push.
  app.use("/api", createNetworkThroughputRouter(prisma));
  // WARP-468: Phase E2 — off-LAN egress byte counter read + sampler push.
  // GET aggregator is admin/family/guest read; sample push is service-only.
  app.use("/api", createOffLanNetworkRouter(prisma));
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
  // WARP-287: admin re-index route — forces re-extraction of a single file
  // to upgrade legacy chunks (no metadata.anchor) without a global backfill.
  // Prisma is injected at module level so the router itself can be a
  // pre-built constant (the spec mounts it as a value, not a factory).
  setPrismaForReindex(prisma);
  app.use("/api/admin", adminFilesRouter);
  // WARP-519: rag-eval HTTP trigger proxy — ad-hoc RAGAS runs + bootstrap
  // + run listing. Auth-gated (admin/owner); 503 when the `eval` Compose
  // profile is inactive (rag-eval service unreachable). NOT prod-gated.
  app.use("/api", createAdminRagEvalRouter());
  // WARP-225: per-user context-meter (home widget + /context page).
  app.use("/api", createMeContextStatsRouter(prisma));
  // WARP-456: signed append-only activity feed + export bundle.
  app.use("/api", createActivityRouter(prisma));
  // WARP-455: A1 local user directory + role/scope mutations. Mutations
  // emit ActivityRow rows via recordActivity (auth kind for lifecycle,
  // system kind for permission edits).
  app.use("/api", createPeopleRouter(prisma));
  // ADR-007 + ADR-009: workspace-type (Home vs Business) singleton.
  // GET available to any authenticated user (drives chrome pill);
  // POST is owner-only (flip the workspace type).
  //
  // MUST mount BEFORE `createSettingsRouter` (WARP-457). The settings
  // router's `GET /settings/:section` matches `"workspace"` (it lives
  // in SECTION_VALUES) and would shadow the GET here if registered
  // first — Express is first-match on path-prefix routes. Consolidation
  // of `/settings/workspace` into the broader WARP-457 settings tree
  // is a follow-up; this ordering keeps both routers working until then.
  app.use("/api", createSettingsWorkspaceRouter(prisma));

  // WARP-457: A3 workspace settings CRUD (GET tree / GET section /
  // PATCH section with per-type validation). Mutations emit ActivityRow
  // rows via recordActivity (kind: system, severity: info — one row per
  // changed key). Reads open to owner+admin+family; writes owner+admin.
  app.use("/api", createSettingsRouter(prisma));

  // WARP-472: F4 hardware contract endpoint (admin/owner only).
  app.use("/api", createHardwareRouter(prisma));

  // WARP-466 (D2): wire the §2.4 analysis endpoint to the agent loop.
  // Single fn override at module level so createEmailRouter keeps its
  // existing (prisma, gate) signature. Tests can call wireEmailAnalysis
  // directly with a stub.
  wireEmailAnalysis(createEmailAnalysisFn(mcpClient));

  // WARP-465 (D1): email backbone — accounts list, threads list +
  // detail, draft CRUD, queue-send. Send is gated by the WARP-467/468
  // off-LAN `outbound_email` allowlist channel; refusal raises 451.
  // The OffLanAllowlistChannel model lands in WARP-467 — until that
  // PR is in main, this gate falls back to default-allow on any error
  // (missing table, missing key, etc.) so chat → reply doesn't 451 on
  // a stack that hasn't merged E1 yet.
  app.use(
    "/api",
    createEmailRouter(prisma, {
      outboundEmailEnabled: async () => {
        try {
          // Use the raw client so the type checker doesn't trip when
          // the model is absent on stacks pre-WARP-467.
          const rows = await prisma.$queryRawUnsafe<
            Array<{ enabled: boolean }>
          >(
            `SELECT enabled FROM "OffLanAllowlistChannel" WHERE key = 'outbound_email' LIMIT 1`,
          );
          if (rows.length === 0) return true;
          return rows[0].enabled === true;
        } catch {
          // Table missing (pre-WARP-467) → default-allow.
          return true;
        }
      },
    }),
  );

  // WARP-462 (C1): productized ToolSpec registry — CRUD + imperative
  // run-now. The dispatcher uses the singleton MCP client so specs
  // dispatch the same registry as chat tool calls. The walker halts
  // on the first failure; per-step trace returned to the caller.
  const toolStepDispatcher: StepDispatcher = {
    async call(tool, args) {
      const result = await mcpClient.callTool(tool, args);
      if (result.isError) {
        const detail = result.content?.[0]?.text ?? "tool reported error";
        throw new Error(typeof detail === "string" ? detail : String(detail));
      }
      const text = result.content?.[0]?.text;
      if (typeof text === "string" && text.length > 0) {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      }
      return null;
    },
  };
  app.use("/api", createToolsRouter(prisma, toolStepDispatcher));

  // WARP-471: F3 models page endpoint (READ-ONLY per one-model rule).
  app.use("/api", createModelsRouter());

  // WARP-469: F1 home aggregation. Single round-trip backing
  // FEATURES.md §2.1 (greeting + tiles + timeline + suggestions).
  // Per-user Redis cache with 30s TTL.
  app.use("/api", createHomeRouter(prisma));


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

  // WARP-457: workspace settings first-boot seeder. Idempotent
  // (insert-or-skip via createMany({skipDuplicates: true})); operator-
  // edited values survive every subsequent boot. Fire-and-forget here —
  // if the DB is wedged the orchestrator's later /api/settings calls
  // will surface the failure; we don't want to block app construction
  // on a non-critical bootstrap.
  const seedLogger = pino({ name: "app:workspace-settings" });
  seedWorkspaceSettings(prisma).catch((err) => {
    seedLogger.warn(
      { err },
      "workspace settings seeder failed (settings table may be unbootstrapped)",
    );
  });

  // WARP-467: off-LAN allowlist first-boot seeder. Same insert-or-skip
  // posture as the workspace settings seeder — operator toggles from
  // the dashboard are never clobbered on subsequent boots. Fire-and-
  // forget: a DB hiccup at boot surfaces on the first GET /api/settings/off-lan
  // rather than blocking startup.
  seedOffLanChannels(prisma).catch((err) => {
    seedLogger.warn(
      { err },
      "off-LAN allowlist seeder failed (channels table may be unbootstrapped)",
    );
  });

  // Error handling
  app.use(errorHandler);

  return app;
}
