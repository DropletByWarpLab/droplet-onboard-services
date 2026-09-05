import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";
import { requestLogger } from "./middleware/request-logger.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import {
  authMiddleware,
  setAuthPrisma,
  requirePasswordChangeGate,
} from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createRateLimit } from "./middleware/rate-limit.js";
import { createHealthRouter } from "./routes/health.js";
import { createDevicesRouter } from "./routes/devices.js";
import { createLlmRouter } from "./routes/llm.js";
import { createTeamChatRouter } from "./routes/team-chat.js";
import { createMemoryRouter } from "./routes/memory.js";
import { createPersonaRouter } from "./routes/persona.js";
import { createBusinessProfileRouter } from "./routes/business-profile.js";
import { createBusinessOnboardingRouter } from "./routes/business-onboarding.js";
import { createIntegrationsRouter } from "./routes/integrations.js";
import { createSaasCredentialsRouter } from "./routes/saas-credentials.js";
import { createErpDriftRouter } from "./routes/erp-drift.js";
import { createM365Router } from "./routes/m365.js";
import { createErpRouter } from "./routes/erp.js";
import { createSttRouter } from "./routes/stt.js";
import { createVoiceRouter } from "./routes/voice.js";
import { createVoiceProfilesRouter } from "./routes/voice-profiles.js";
import { createFilesRouter } from "./routes/files.js";
import { createFilesBrainRouter } from "./routes/files-brain.js";
import { createFilesKnowledgeRouter } from "./routes/files-knowledge.js";
import {
  createDeviceClientsRouter,
  createDeviceSelfRevokeRouter,
} from "./routes/device-clients.js";
import { createStorageRouter } from "./routes/storage.js";
import { createAppDownloadsRouter } from "./routes/app-downloads.js";
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
import { createPmMobileRouter } from "./routes/mobile/pm.js";
import { createPmNativeRouter } from "./routes/pm/native.js";
import { createPmRelationsRouter } from "./routes/pm/relations.js";
import { createCrmRouter } from "./routes/crm.js";
import { createMoneyRouter } from "./routes/money.js";
import { createCrmEntityLinksRouter } from "./routes/crm-entity-links.js";
import { createContactsRouter } from "./routes/contacts.js";
import { createScenesRouter, type MatterDispatcher } from "./routes/scenes.js";
import { sendMatterCommand } from "./services/matter.service.js";
import { createNetworkRouter } from "./routes/network.js";
import { createNetworkThroughputRouter } from "./routes/network-throughput.js";
import { createOffLanNetworkRouter } from "./routes/off-lan-network.js";
import { createEgressAuditRouter } from "./routes/egress-audit.js";
import { createWebRouter } from "./routes/web.js";
import { createCamerasRouter, createCameraSharePublicRouter } from "./routes/cameras.js";
import { createSwitchRouter } from "./routes/switch.js";
import { createDisplayRouter } from "./routes/display.js";
import { createCalendarRouter, createCalendarPublicRouter } from "./routes/calendar.js";
import { createNotesRouter } from "./routes/notes.js";
import { createRemindersRouter } from "./routes/reminders.js";
import { createNotificationsRouter } from "./routes/notifications.js";
import { createVpnRouter } from "./routes/vpn.js";
import { createApsRouter } from "./routes/aps.js";
import { createAdminClaudeActivityRouter } from "./routes/admin-claude-activity.js";
import { createAdminDeviceIdentityRouter } from "./routes/admin-device-identity.js";
import { createAdminRetrievalEvalRouter } from "./routes/admin-retrieval-eval.js";
import { adminFilesRouter, createAdminFilesUsageRouter } from "./routes/admin-files.js";
import { setPrismaForReindex } from "./services/file-reindex.service.js";
import { createAdminRagEvalRouter } from "./routes/admin-rag-eval.js";
import { createAdminChatFeedbackRouter } from "./routes/admin-chat-feedback.js";
import { createChatProjectsRouter } from "./routes/chat-projects.js";
import { createAdminCapabilitiesRouter } from "./routes/admin-capabilities.js";
import { createCapabilitiesRouter } from "./routes/capabilities.js";
import { createMeContextStatsRouter } from "./routes/me-context-stats.js";
import { createSettingsWorkspaceRouter } from "./routes/settings-workspace.js";
import { createModulesRouter } from "./routes/modules.routes.js";
import { createModuleGate } from "./middleware/module-gate.js";
import { mountModuleGates } from "./modules/module-mounts.js";
import { createFipsRouter } from "./routes/fips.js";
import { createActivityRouter } from "./routes/activity.js";
import { createAuditRootsRouter } from "./routes/audit-roots.js";
import { createLogsRouter } from "./routes/logs.js";
import { createPeopleRouter } from "./routes/people.js";
import { createAccessRouter } from "./routes/access.js";
import { createDepartmentsRouter } from "./routes/departments.js";
import { createWorkspaceLocationsRouter } from "./routes/workspace-locations.js";
import {
  initScopeLoader,
  loadUserEffectiveScopes,
} from "./services/scope-loader.service.js";
import { initEffectiveAccess } from "./services/effective-access.service.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createSettingsEmailRouter } from "./routes/settings-email.js";
import { createUpdatesRouter } from "./routes/updates.js";
import { createEmailRouter, wireEmailAnalysis } from "./routes/email.js";
import { createEmailAnalysisFn } from "./services/email-analysis.service.js";
import { createToolsRouter } from "./routes/tools.js";
import { mcpClient } from "./services/mcp-client.singleton.js";
import type { StepDispatcher } from "./services/tool-spec-runner.service.js";
import { createModelsRouter } from "./routes/models.js";
import { createHardwareRouter } from "./routes/hardware.js";
import { createHomeRouter } from "./routes/home.js";
import { createTlsStatusPublicRouter } from "./routes/tls-status.public.route.js";
import { createDeviceIdentityClient } from "./services/device-identity.client.js";
import { startRemindersPoller } from "./services/reminders-poller.js";
import { startScreenQRPoller } from "./services/screen-qr.service.js";
import { initPushDispatch } from "./services/push-dispatch.service.js";
import { outboundEmailGate } from "./services/off-lan-gate.service.js";
import {
  seedWorkspaceSettings,
  seedOffLanChannels,
} from "./services/workspace-settings.service.js";
import { revokePendingOwnerInvites } from "./services/owner-invite-sweep.service.js";
import { createLogger } from "./lib/logger.js";

// One limiter for the process (module scope, not per createApp): tests build
// several apps and express-rate-limit warns when a MemoryStore is created
// repeatedly from the same call site.
const authenticatedApiRateLimit = createRateLimit("authenticated-api", {
  windowMs: 60_000,
  limit: 1_200,
});

export function createApp(
  prisma: PrismaClient,
  // feat/scene-schedules — the Matter dispatcher is hoisted so index.ts can
  // build ONE instance and share it between the scenes router (here) and the
  // scene-schedule ticker. Tests / callers that pass only `prisma` get the
  // default inline dispatcher, preserving the WARP-474 wiring.
  matter: MatterDispatcher = {
    sendCommand: (nodeId, command, actor, args) =>
      sendMatterCommand(nodeId, command, actor, args),
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
  app.use(requestIdMiddleware);
  app.use(requestLogger);

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

  // WARP-349 — device self-revoke on "Forget this Droplet". A paired native
  // client presents `Authorization: Basic <ncUsername:appPassword>` on
  // DELETE /api/devices/clients/:id; the credential is verified against the
  // target row's own stored app password, so the path can only revoke the
  // device it authenticates as. Mounted BEFORE the auth middleware (which
  // only understands Bearer/cookie); anything that isn't a session-less
  // Basic request falls through to the protected session-path handler.
  app.use("/api", createDeviceSelfRevokeRouter(prisma));

  // Warning-free droplet.local: the gateway's plain-HTTP status page polls
  // this before any session exists — public, read-only, secret-free.
  app.use("/api", createTlsStatusPublicRouter(prisma));

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

  // WARP-1527 / ADR-032 §3 — bind the effective-access resolver beside the
  // scope loader (same singleton discipline, same reason): layer-2
  // per-person access resolution (features / tools / cloud / connectors /
  // usage) is a DB-read per request with no cache in v1, and the first
  // post-boot read must find the client bound. Availability config rides
  // along for the workspace-module intersection (modules.service).
  initEffectiveAccess(prisma, config);

  // CodeQL js/missing-rate-limiting — per-client ceiling on the whole
  // authenticated surface, mounted right before authMiddleware so the public
  // routers above keep their own tighter presets. Keyed on the real client:
  // nginx sets X-Forwarded-For on the /api leg and `trust proxy` is 1. The
  // budget is a DoS backstop, NOT a policy limit: 1,200/min = 20 req/s
  // sustained per IP, ~10x the dashboard's steady state (widgets poll at
  // 10-60 s) and comfortably above its worst legitimate burst (page-load
  // fan-out, a folder of thumbnails ≈ 100 requests). Each internal service
  // principal (mcp-server, email-indexer, routing, …) comes from its own
  // container IP so they don't share a bucket with a browser.
  app.use(authenticatedApiRateLimit);

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

  // Module gates — both layers, data-driven from the registry:
  //   layer 1  requireModuleEnabled  — the WORKSPACE capability gate: 404 a
  //            DISABLED module's `/api/*` routes before they reach the
  //            module's router (a disabled module reads as absent, not
  //            forbidden). Core modules (chat) are never gated.
  //   layer 2  requireFeatureAccess  — ADR-032 §3(a): whether THIS PERSON may
  //            open it. Same 404, so a narrowed person sees a smaller Droplet
  //            rather than a wall of locked doors.
  // Registered here — after auth, before the module routers below — so the
  // gates precede what they guard. The `/api/modules` + `/api/business-types`
  // control-plane mounts alongside.
  //
  // WARP-1585 moved the composition into `mountModuleGates` so it can be
  // tested: the bug it fixes was in the COMPOSITION (a gate at `/api/files`
  // prefix-matching `/api/files/knowledge` and `/api/files/docs`, collapsing
  // three independent toggles onto one enforcement), not in either gate.
  // Specs: docs/superpowers/specs/2026-07-07-module-toggles-design.md, ADR-032.
  const moduleGate = createModuleGate(prisma, config);
  mountModuleGates(app, moduleGate);

  app.use("/api", createModulesRouter(prisma, config, moduleGate));

  // PR #377 — passkey REGISTRATION. You enrol a passkey for the signed-in
  // user, so register/options + register/verify require an authenticated
  // session and mount AFTER authMiddleware.
  app.use("/api", createProtectedWebAuthnRouter(prisma));
  app.use("/api", createHealthRouter(prisma));
  app.use("/api", createDevicesRouter());
  app.use("/api", createLlmRouter(prisma));
  // WARP-1683 — team chat (member-to-member Messages). Humans only; the
  // `team_chat` module gate is mounted by mountModuleGates above off the
  // registry's /api/team-chat prefix.
  app.use("/api", createTeamChatRouter(prisma));
  app.use("/api", createMemoryRouter(prisma));
  // WARP-1118 — personality API (GET role-split read + PATCH owner/admin).
  app.use("/api", createPersonaRouter(prisma));
  // WARP-1120 — business-knowledge API (GET role-split read + PATCH owner/admin;
  // manual fill transitions onboarding state → completed).
  app.use("/api", createBusinessProfileRouter(prisma));
  // WARP-1121 — onboarding-interview lifecycle (start/skip/commit, owner/admin;
  // atomic conditional transitions, 409 on race).
  app.use("/api", createBusinessOnboardingRouter(prisma));
  // WARP-1137 — Eaglesoft ERP integration control plane + data API. Reads
  // degrade honestly (ERP_NOT_CONNECTED) until the connector's live driver
  // lands (WARP-1095+); writes stage an outbox request confirmed by a human.
  app.use("/api", createIntegrationsRouter(prisma));
  // WARP-2275 — the admin-only SaaS credential configurator. Descriptor-driven
  // (WARP-2217), so it adds no per-vendor routes: one generic surface renders
  // and validates whatever `credentialFields` a provider declares.
  //
  // WARP-2485 — this shares the /api/integrations prefix with
  // `createIntegrationsRouter` above, and with nothing else: `createErpRouter`
  // below owns /api/erp, a different prefix. Mount order is NOT what keeps the
  // two apart, and neither mount is load-bearing on being second. The invariant
  // is that their path sets are disjoint — no single URL can match a route in
  // both — and while that holds either order behaves identically.
  // `/integrations/:provider/credentials` ends in a literal `credentials`;
  // the Eaglesoft routes are `/integrations`, `/integrations/eaglesoft`, and
  // `/integrations/eaglesoft/<literal verb>`. If a route is ever added that one
  // URL could match in both, mount order silently picks the winner and the
  // loser becomes unreachable, so the disjointness is checked rather than
  // asserted here: `routes/integrations-prefix.mount.test.ts` enumerates both
  // routers' stacks and fails on any such pair.
  app.use("/api", createSaasCredentialsRouter(prisma));
  // WARP-2463 — admin-only read over the reconciliation sweep's STORED drift
  // report. Its own factory rather than a route on the integrations router:
  // that router's floor is family-and-up, this surface is owner/admin, and a
  // route whose guard is narrower than its neighbours' is safer as its own
  // registration than as an exception inside someone else's file.
  //
  // `/integrations/:connectionId/drift` is match-disjoint from every other
  // route under /api/integrations — it is the only one whose LAST segment is
  // `drift`, and the two-segment routes differ in arity — so this mount's
  // POSITION is not load-bearing and reordering this block cannot change which
  // handler serves a request. See the table in routes/erp-drift.ts. WARP-2485
  // adds a test for exactly that property; `createErpDriftRouter` should join
  // its ROUTERS list.
  app.use("/api", createErpDriftRouter(prisma));
  app.use("/api", createErpRouter(prisma));
  // WARP-2115 / ADR-041 — Microsoft 365 cloud connector control plane. Ships
  // OFF: with no M365_CLIENT_ID the routes report unavailable and connect 503s.
  // Every route is scoped to the requester's OWN link — no :userId parameter,
  // because delegated authorization makes a person's mailbox connection theirs.
  app.use("/api", createM365Router(prisma));
  // WARP-844 — chat voice input (Wyoming STT proxy). 503s gracefully when
  // the whisper sidecar isn't deployed (macOS dev / non-linux profile).
  app.use("/api", createSttRouter());
  // WARP-1036 — voice-assistant proxy (status / devices / speaker test).
  // Owner+admin only; 503s voice_unavailable when voice-io isn't deployed
  // (macOS dev / non-linux profile) so the setup wizard can auto-skip.
  app.use("/api", createVoiceRouter());
  // WARP-1056 — per-person voiceprints (Flow B enrollment + profile
  // rows). Same owner/admin wall + voice_unavailable contract as the
  // voice router; enrollment validates the person EXISTS in Prisma
  // before the box records anyone (never creates a person).
  app.use("/api", createVoiceProfilesRouter(prisma));
  app.use("/api", createFilesRouter(prisma));
  app.use("/api", createFilesBrainRouter(prisma));
  app.use("/api", createFilesKnowledgeRouter(prisma));
  app.use("/api", createDeviceClientsRouter(prisma));
  // Client-app downloads (installer + its signature + updater manifest),
  // staged inside the appliance image. Sits next to device-clients on
  // purpose: install the app, then pair it — one flow, adjacent routes.
  // No module gate and no role gate — see the header of the route file.
  app.use("/api", createAppDownloadsRouter());
  app.use("/api", createStorageRouter(prisma));
  // WARP-825 — Settings Danger Zone: owner-only factory reset. Dispatches the
  // wipe through the device-bridge host executor (never a web-tier exec of
  // factory-reset.sh).
  app.use("/api", createSystemResetRouter(prisma));
  app.use("/api", createMatterRouter(prisma));
  // ADR-026 — native PM (projects, work-items, states, labels, comments).
  // The Droplet-owned project-management surface: state in the orchestrator's
  // own Postgres, dashboard session is the auth, no embedded third-party stack.
  app.use("/api", createPmNativeRouter(prisma));
  // WARP-2586 (ADR-045 slice G) — cross-project work-item relations
  // (blocks / relates / duplicates). Its own router on the same prefix; the
  // paths are disjoint from the native router's, so neither shadows the other.
  app.use("/api", createPmRelationsRouter(prisma));
  // WARP-2117 — the CRM, which lives inside the Projects surface. Mounted
  // AFTER the PM router but on a disjoint prefix (`/api/crm`), so neither
  // shadows the other; the `crm` module gate comes from the registry.
  app.use("/api", createCrmRouter(prisma));
  // WARP-2581 — money: invoices and bills landed from a cloud ledger. Its own
  // disjoint prefix (`/api/money`) and its own `money` module gate; read-only,
  // because the vendor stays the system of record.
  app.use("/api", createMoneyRouter(prisma));
  // WARP-2585 (ADR-045) — file ↔ business record links. Same `/api/crm`
  // prefix, so `mountModuleGates` covers it with the `crm` module gate already
  // registered above; no registry edit and no second gate vocabulary. Order
  // against createCrmRouter does not matter: nothing in routes/crm.ts uses a
  // path parameter in the first segment after `/crm`, so neither can shadow
  // the other (the mount-order hazard this file documents elsewhere).
  app.use("/api", createCrmEntityLinksRouter(prisma));
  // WARP-2018/WARP-2032 — the one address book. Owner-scoped, unlike PM/CRM.
  app.use("/api", createContactsRouter(prisma));
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
  // WARP-268: runtime egress-audit collector pushes unlisted-destination /
  // allowlist-unavailable anomalies here (service-principal only) → signed
  // activity log → /admin/audit.
  app.use("/api", createEgressAuditRouter());
  // WARP-1436: ambient web data (weather / currency rates). Gate on the
  // `ambient_data` off-LAN channel, Redis-cached, audited per request;
  // proxies the services/web-fetch allowlisted fetcher.
  app.use("/api", createWebRouter(prisma));
  app.use("/api", createCamerasRouter(prisma));
  app.use("/api", createSwitchRouter(prisma));
  app.use("/api", createDisplayRouter(prisma));
  app.use("/api", createCalendarRouter(prisma));
  app.use("/api", createNotesRouter(prisma));
  app.use("/api", createRemindersRouter(prisma));
  app.use("/api", createNotificationsRouter(prisma));
  app.use("/api", createVpnRouter(prisma));
  // WARP-446: coverage extender AP onboarding (ADR-005).
  app.use("/api", createApsRouter(prisma));
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
  // WARP-1271 (T19a): admin usage roster (per-user + per-department
  // storage). Factory-based (needs Prisma), mounted separately from the
  // module-level adminFilesRouter above but under the same "/api/admin" base.
  app.use("/api/admin", createAdminFilesUsageRouter(prisma));
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
  // WARP-1154/WARP-1155 — module-capability probe for every authenticated
  // principal. The dashboard drives the Projects nav entry + /projects route
  // off this explicit flag (never off request errors). WARP-1306: the flag
  // now mirrors the module-toggles effective state (same resolution the
  // module gate above enforces), so the probe and the gate can never
  // disagree about whether Projects is on.
  app.use("/api", createCapabilitiesRouter(prisma, config));
  // WARP-225: per-user context-meter (home widget + /context page).
  app.use("/api", createMeContextStatsRouter(prisma));
  // WARP-456: signed append-only activity feed + export bundle.
  app.use("/api", createActivityRouter(prisma));
  // WARP-237: device-key-signed daily-root read surface.
  app.use("/api", createAuditRootsRouter(prisma));
  // WARP-823: owner/admin downloadable, secret-redacted diagnostics log
  // bundle. Sources host logs through the device-bridge; audits the download.
  app.use("/api", createLogsRouter());
  // WARP-455: A1 local user directory + role/scope mutations. Mutations
  // emit ActivityRow rows via recordActivity (auth kind for lifecycle,
  // system kind for permission edits).
  app.use("/api", createPeopleRouter(prisma, loadUserEffectiveScopes));
  // WARP-1527 / ADR-032 §5 (RBAC v2 T3): custom access roles — CRUD,
  // duplicate, archive, delete (reassign-first), and bulk assignment.
  // owner/admin only; every mutation through the T2 role-mutation guard.
  app.use("/api", createAccessRouter(prisma));
  // WARP-1258 (T6): departments/teams CRUD. Manages department/team lifecycle,
  // membership, and integration with Nextcloud groupfolders. Provisioning is
  // async (reconciler converges NC state).
  app.use("/api", createDepartmentsRouter(prisma));
  // WARP-1906: premade business locations (buildings + named conference
  // rooms). Reads member-wide (feeds the event-form location suggestions via
  // /calendar/places); writes owner/admin from Settings → Locations.
  app.use("/api", createWorkspaceLocationsRouter(prisma));
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

  // WARP-540: OTA update operator surface (/api/updates/*) — status,
  // history, check-now, apply-now, skip, and the WARP-538 settings knobs.
  // Owner+admin only (reads included, voice-proxy posture); every mutation
  // writes an activity row via recordActivity.
  app.use("/api", createUpdatesRouter(prisma));

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
  app.use("/api", createModelsRouter(prisma));

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
  const seedLogger = createLogger("app:workspace-settings");
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

  // WARP-1565: revoke any pending `role="owner"` invite. Rail 7 stopped new
  // ones being minted; rows written before that narrowing are still pending,
  // and the accept path honours an invite's canonical role by design
  // (WARP-1051), so the input is what has to go. On every boot rather than
  // once in a migration: this box is reflashed and restored from backup, and
  // a pre-narrowing dump would otherwise put such a row back. Idempotent and
  // a no-op on a converged box; same fire-and-forget posture as the seeders
  // above — a DB hiccup here must not block app construction, and the next
  // boot sweeps again.
  revokePendingOwnerInvites(prisma).catch((err) => {
    seedLogger.warn(
      { err },
      "pending owner-invite sweep failed (invites table may be unbootstrapped)",
    );
  });

  // Error handling
  app.use(errorHandler);

  return app;
}
