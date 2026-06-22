import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";
import { requestLogger } from "./middleware/request-logger.js";
import {
  authMiddleware,
  setAuthPrisma,
  requirePasswordChangeGate,
} from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createHealthRouter } from "./routes/health.js";
import { createDevicesRouter } from "./routes/devices.js";
import { createLlmRouter } from "./routes/llm.js";
import { createMemoryRouter } from "./routes/memory.js";
import { createSttRouter } from "./routes/stt.js";
import { createFilesRouter } from "./routes/files.js";
import { createFilesBrainRouter } from "./routes/files-brain.js";
import { createFilesKnowledgeRouter } from "./routes/files-knowledge.js";
import { createDeviceClientsRouter } from "./routes/device-clients.js";
import { createStorageRouter } from "./routes/storage.js";
import { createSystemResetRouter } from "./routes/system-reset.routes.js";
import { createPublicAuthRouter, createProtectedAuthRouter } from "./routes/auth.js";
import { createSsoRouter } from "./routes/sso.js";
import {
  createPublicWebAuthnRouter,
  createProtectedWebAuthnRouter,
} from "./routes/webauthn.js";
import { createSetupRouter } from "./routes/setup.js";
import { createScimRouter } from "./routes/scim.js";
import { createMatterRouter } from "./routes/matter.js";
import { createPmWebhookRouter } from "./routes/pm-webhook.js";
import { createPmOnboardRouter } from "./routes/pm-onboard.js";
import { createPmProxyRouter } from "./routes/pm-proxy.js";
import { createPmMobileRouter } from "./routes/mobile/pm.js";
import { createPmRouter } from "./routes/pm.js";
import { createPmNativeRouter } from "./routes/pm/native.js";
import { createScenesRouter, type MatterDispatcher } from "./routes/scenes.js";
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
import { createAdminChatFeedbackRouter } from "./routes/admin-chat-feedback.js";
import { createChatProjectsRouter } from "./routes/chat-projects.js";
import { createAdminCapabilitiesRouter } from "./routes/admin-capabilities.js";
import { createMeContextStatsRouter } from "./routes/me-context-stats.js";
import { createSettingsWorkspaceRouter } from "./routes/settings-workspace.js";
import { createFipsRouter } from "./routes/fips.js";
import { createActivityRouter } from "./routes/activity.js";
import { createLogsRouter } from "./routes/logs.js";
import { createPeopleRouter } from "./routes/people.js";
import {
  initScopeLoader,
  loadUserEffectiveScopes,
} from "./services/scope-loader.service.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createSettingsEmailRouter } from "./routes/settings-email.js";
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
import { outboundEmailGate } from "./services/off-lan-gate.service.js";
import {
  seedWorkspaceSettings,
  seedOffLanChannels,
} from "./services/workspace-settings.service.js";
import pino from "pino";

export function createApp(
  prisma: PrismaClient,
  // feat/scene-schedules — the Matter dispatcher is hoisted so index.ts can
  // build ONE instance and share it between the scenes router (here) and the
  // scene-schedule ticker. Tests / callers that pass only `prisma` get the
  // default inline dispatcher, preserving the WARP-474 wiring.
  matter: MatterDispatcher = {
    sendCommand: (nodeId, command, args) =>
      sendMatterCommand(nodeId, command, args),
  },
) {
  const app = express();

  // Trust the nginx reverse proxy so req.secure / X-Forwarded-Proto work
  app.set("trust proxy", 1);

  // Middleware
  // WARP-562 — credentialed CORS restricted to an explicit allowlist. Never
  // `origin: true` (which reflects any Origin and, with credentials, lets any
  // site the owner visits read the cookie-authenticated API cross-origin).
  // A request with no Origin (same-origin behind nginx, curl, native clients)
  // is allowed; a disallowed Origin gets `cb(null, false)` → no
  // Access-Control-Allow-Origin header (the browser blocks the read) WITHOUT
  // raising an Error (which would 500 and route through the error handler).
  app.use(
    cors({
      credentials: true,
      origin: (origin, cb) => {
        if (!origin || config.corsAllowedOrigins.includes(origin)) {
          return cb(null, true);
        }
        return cb(null, false);
      },
    }),
  );
  app.use(helmet());
  app.use(cookieParser());
  app.use(requestLogger);

  // WARP-566 — Plane webhook HMAC must be verified over the EXACT bytes
  // Plane signed, not a re-serialized JSON representation. Capture the raw
  // body as a Buffer for the webhook path ONLY, mounted BEFORE the global
  // express.json() so req.body stays a Buffer on that one route while every
  // other route gets parsed JSON. `type: () => true` accepts any
  // Content-Type (incl. charset suffixes) so the raw capture never misses.
  app.use(
    "/api/pm/webhook",
    express.raw({ type: () => true, limit: "1mb" }),
  );

  // Parse `application/json` AND `application/scim+json` (Okta's SCIM client
  // sends the latter for /scim/v2/* — without it, req.body would arrive empty
  // and every SCIM create/update would 400). The explicit `type` list keeps
  // the default JSON behavior intact for every other route.
  app.use(express.json({ type: ["application/json", "application/scim+json"] }));

  // Public auth routes (setup + login + invite-accept) — no authentication required.
  // Prisma is required for the WARP-217 invite-accept endpoints (token lookup).
  app.use("/api", createPublicAuthRouter(prisma));

  // ADR-013 (PR #378) — external-IdP OIDC SSO (Google / Entra / Okta).
  // Public: a user signing in via SSO has no session yet. Mounted BEFORE the
  // auth middleware so /sso/oidc/authorize + /sso/oidc/callback don't need one.
  app.use("/api", createSsoRouter(prisma));

  // PR #377 — passwordless WebAuthn / passkey authentication. The
  // authenticate/options + authenticate/verify endpoints are how a caller
  // GETs a session, so they MUST mount BEFORE authMiddleware (same posture as
  // /auth/login above). Registration lives on the PROTECTED router below.
  app.use("/api", createPublicWebAuthnRouter(prisma));

  // PR #372 — first-run setup state machine (GET/PATCH /api/setup/state).
  // PUBLIC: first-run happens before any user exists, like POST /auth/setup.
  // Mounted BEFORE the auth middleware and allow-listed in middleware/auth.ts.
  app.use("/api", createSetupRouter(prisma));

  // WARP (ADR-013) — SCIM 2.0 directory-provisioning server. Okta PUSHES
  // users/groups here (/scim/v2/*); it has no human session and authenticates
  // with its own dedicated provisioning bearer (DROPLET_SCIM_BEARER_TOKEN),
  // validated by the router's built-in scimAuthMiddleware. Mounted at root
  // (the router self-prefixes /scim/v2) and BEFORE authMiddleware — the SCIM
  // surface never touches the human-session auth path.
  app.use(createScimRouter(prisma));

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

  // WARP-455 — bind the scope-loader singleton to the same Prisma client
  // before the first request, for the same reason as setAuthPrisma above:
  // requireScope()'s injected loader (loadUserEffectiveScopes) reads
  // ScopeBinding/GuestExpiry through this singleton, and the very first
  // post-boot request to a scope-guarded route must find it populated.
  // Idempotent — a second createApp() in tests is a no-op.
  initScopeLoader(prisma);

  // Auth middleware (controlled by AUTH_ENABLED env var)
  app.use(authMiddleware);

  // WARP-824 — forced-password-change gate. Mounts AFTER authMiddleware (so
  // req.user is populated) and BEFORE every protected router so an
  // admin-created user holding a temporary password can only reach the
  // change-password / me / logout / refresh surface until they pick a new
  // one. Reads the explicit `User.mustChangePassword` flag FRESH from the
  // DB on every request — server enforcement, not a client-trusted redirect.
  app.use(requirePasswordChangeGate(prisma));

  // Protected routes — auth middleware has populated req.user
  app.use("/api", createProtectedAuthRouter(prisma));

  // PR #377 — passkey REGISTRATION. You enrol a passkey for the signed-in
  // user, so register/options + register/verify require an authenticated
  // session and mount AFTER authMiddleware.
  app.use("/api", createProtectedWebAuthnRouter(prisma));
  app.use("/api", createHealthRouter(prisma));
  app.use("/api", createDevicesRouter());
  app.use("/api", createLlmRouter(prisma));
  app.use("/api", createMemoryRouter(prisma));
  // WARP-844 — chat voice input (Wyoming STT proxy). 503s gracefully when
  // the whisper sidecar isn't deployed (macOS dev / non-linux profile).
  app.use("/api", createSttRouter());
  app.use("/api", createFilesRouter(prisma));
  app.use("/api", createFilesBrainRouter(prisma));
  app.use("/api", createFilesKnowledgeRouter(prisma));
  app.use("/api", createDeviceClientsRouter(prisma));
  app.use("/api", createStorageRouter(prisma));
  // WARP-825 — Settings Danger Zone: owner-only factory reset. Dispatches the
  // wipe through the device-bridge host executor (never a web-tier exec of
  // factory-reset.sh).
  app.use("/api", createSystemResetRouter(prisma));
  app.use("/api", createMatterRouter(prisma));
  // ADR-026 — native PM (projects, work-items, states, labels, comments).
  // Mounted BEFORE the legacy Plane proxy so the native GET /api/pm/workspaces
  // supersedes it; the embedded Plane surface is removed in P6.
  app.use("/api", createPmNativeRouter(prisma));
  // WARP-507 — Plane onboarding endpoint for the setup wizard.
  app.use(createPmOnboardRouter());
  // WARP-867 — Plane service-token mint + app-API proxies (workspace
  // list, search) for the v1 surfaces Plane CE doesn't provide.
  app.use(createPmProxyRouter());
  // ADR-026 — read-only mobile wrappers over the native PM service
  // (workspaces, projects, work-items). iOS/Android/Windows consume.
  app.use(createPmMobileRouter(prisma));
  // WARP-474 (G2): smart-home scenes CRUD + batch-run. Run dispatches
  // each action through `sendMatterCommand` — partial-failure tolerant,
  // per-action results returned to the dashboard.
  app.use("/api", createScenesRouter(prisma, matter));
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
  // WARP-844 follow-up — thumbs ratings surfaced for the eval loop.
  app.use("/api", createAdminChatFeedbackRouter(prisma));
  // WARP-845 — per-user chat projects (sidebar folders + default persona).
  app.use("/api", createChatProjectsRouter(prisma));
  // Admin capabilities probe — drives nav-gating for optional admin surfaces
  // (Activity, RAG eval) so they hide when their integration is unconfigured.
  app.use("/api", createAdminCapabilitiesRouter());
  // WARP-225: per-user context-meter (home widget + /context page).
  app.use("/api", createMeContextStatsRouter(prisma));
  // WARP-456: signed append-only activity feed + export bundle.
  app.use("/api", createActivityRouter(prisma));
  // WARP-823: owner/admin downloadable, secret-redacted diagnostics log
  // bundle. Sources host logs through the device-bridge; audits the download.
  app.use("/api", createLogsRouter());
  // WARP-455: A1 local user directory + role/scope mutations. Mutations
  // emit ActivityRow rows via recordActivity (auth kind for lifecycle,
  // system kind for permission edits).
  app.use("/api", createPeopleRouter(prisma, loadUserEffectiveScopes));
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

  // BUG-11: SMTP outbound-channel config (/api/settings/email) + the
  // failed-invite resend endpoint (/api/people/invites/:id/resend). MUST mount
  // BEFORE createSettingsRouter — that router's GET /settings/:section would
  // otherwise match the literal `email` path as a section and 404. Same
  // first-match ordering rationale as the off-lan router. No transportFactory
  // is injected, so the real nodemailer SMTP transport is used in production.
  app.use("/api", createSettingsEmailRouter(prisma));

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
  // WARP-467 is merged, so the gate now uses the typed Prisma read in
  // off-lan-gate.service.ts and FAILS CLOSED (no egress) on any DB
  // error or missing row — a sovereignty control must not default-open
  // on a transient hiccup (mirrors ai-gateway/middleware/off_lan_gating.py).
  app.use(
    "/api",
    createEmailRouter(prisma, {
      outboundEmailEnabled: () => outboundEmailGate(prisma),
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

  // Status display screen QR — context-switched display. WARP-632/ADR-017
  // adds the highest-priority claim-screen branch (mint + render the claim
  // code on the PyPortal while the box is unclaimed); once claimed it falls
  // through to setup URL on first boot, last-generated WireGuard peer for
  // ~60 s after creation, WiFi-hotspot QR otherwise. 30 s poller; calls into
  // Prisma + Nextcloud + device-bridge. Failures in any leg leave the screen
  // alone rather than blanking it.
  startScreenQRPoller(prisma);

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
