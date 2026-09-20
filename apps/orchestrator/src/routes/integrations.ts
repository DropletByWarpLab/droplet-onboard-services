/**
 * WARP-1137 — the integrations control-plane API (brief §13).
 *
 *   GET  /api/integrations                       Hub list (no PHI, no secret).
 *   GET  /api/integrations/eaglesoft             Connection detail + status.
 *   POST /api/integrations/eaglesoft/connect     Run/verify provisioning.
 *   POST /api/integrations/eaglesoft/test        Reachability test (no save).
 *
 * WARP-2500 — the lifecycle verbs are provider-scoped:
 *
 *   POST /api/integrations/:provider/disconnect     Purge credentials+cursors.
 *   POST /api/integrations/:provider/write-enable   Per-practice write opt-in.
 *   POST /api/integrations/:provider/write-disable  Kill-switch (default off).
 *
 * WARP-2520 — and so are the LAN provisioning verbs:
 *
 *   POST /api/integrations/:provider/connect        Run/verify provisioning.
 *   POST /api/integrations/:provider/test           Reachability test (no save).
 *
 * WARP-2842 — the SAME connect URL admits a cloud / REST track, with an empty
 * body: it probes the credential `PATCH /:provider/credentials` already sealed
 * onto the row and writes the verdict (CONNECTED / NEEDS_RECONNECT / DEGRADED /
 * CAPABILITY_LIMITED / ERROR / NOT_CONFIGURED). Idempotent — the dashboard's
 * "check again". Until this, nothing could move a pasted key out of
 * PROVISIONING: the only connect admission was `lanProvisioning`.
 *
 * The five `/api/integrations/eaglesoft/{connect,test,disconnect,write-enable,
 * write-disable}` spellings remain as DEPRECATED aliases for one release, so a
 * dashboard bundle cached from before this deploy keeps working. See the
 * comment above their registration for the removal condition. They were the
 * only spellings until now, which is the bug: `connect()` admits every
 * provider `isKnownErpProvider` allows, so WARP-2466 could create a Stripe /
 * HubSpot / Mailchimp / QuickBooks row that no URL could ever purge — and the
 * descriptor-driven wizard already posts `/integrations/${provider}/connect`
 * for whichever provider its tile is for, so a second LAN vendor's four-step
 * flow ended at a 404 the moment WARP-2451 made the wizard generic.
 *
 * DB-INDEPENDENT: the connector's live calls are stubbed, so connect/test
 * degrade honestly (PROVISIONING / ERP_NOT_CONNECTED) — never a fake CONNECTED.
 * RBAC via the shared requireRole middleware; ErpError → its own HTTP status.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { providerDescriptor } from "@droplet/shared-types";
import { requireRole } from "../middleware/auth.js";
import { actorFromRequest } from "../services/activity.service.js";
import {
  createIntegrationsService,
  type ConnectInput,
  type IntegrationsServiceDeps,
} from "../services/integrations.service.js";
import { ErpError } from "../services/erp-error.js";
import { isConcurrencyConflict } from "../services/role-mutation-guard.service.js";

type AuthedRequest = { user?: { id?: string; role?: string } };

/** Render an ErpError with its typed HTTP status; return false for others. */
function handleErpError(res: Response, err: unknown): boolean {
  if (err instanceof ErpError) {
    res.status(err.status).json(err.toJSON());
    return true;
  }
  // `connect()`'s reconnect branch and `disconnect()` both run SERIALIZABLE
  // transactions and neither retries. Postgres answers a genuine write-write
  // race with P2034, and an optimistic-write miss arrives as P2025; both mean
  // "nothing was applied, retry", which is a 409 — not the redacted 500 an
  // unmapped Prisma error becomes. Every other SERIALIZABLE call site
  // (routes/people.ts, routes/auth.ts) already maps it this way, and a
  // double-clicked Disconnect is the ordinary way to reach it.
  //
  // It lives in the shared funnel so every lifecycle route inherits it at
  // once. The body is this route's own `{ error, code }` shape rather than
  // `RoleMutationRefusedError`, whose copy is about changing a PERSON.
  if (isConcurrencyConflict(err)) {
    res.status(409).json({
      error: "Another change to this integration is still in flight. Nothing was applied — try again.",
      code: "CONCURRENT_MUTATION",
    });
    return true;
  }
  return false;
}

/** Connect / test body. The backend owns the credential (the wizard shows a
 *  generated password for the DBA to run the GRANT), so `secretRef` is optional
 *  and minted server-side; `scopes` / `enableWrites` carry the wizard choices. */
const connectSchema = z.object({
  host: z.string().min(1),
  databaseName: z.string().min(1).default("PattersonPM"),
  secretRef: z.string().min(1).optional(),
  serverName: z.string().optional(),
  port: z.number().int().positive().optional(),
  scopes: z.array(z.string()).optional(),
  enableWrites: z.boolean().optional(),
  /** "eaglesoft" (direct SQL, the default) | "eaglesoft-api" (Patterson REST).
   *  Validated against the known-provider list in the service, which rejects an
   *  unrecognized value rather than routing it to a surprise transport. */
  provider: z.string().min(1).optional(),

  // --- REST-track material. Ignored by the direct-SQL provider. -------------

  /** Vendor key + Eaglesoft Provider login. Accepted ONLY here, on the way in;
   *  stored encrypted and never echoed back by any read path. */
  apiCredentials: z
    .object({
      integrationKey: z.string().min(1),
      userId: z.string().min(1),
      password: z.string().min(1),
    })
    .optional(),
  /** The route contract discovered from the box's /help page. Shape-checked in
   *  the service (`parseRouteMap`), not here — the per-operation validity rule
   *  lives in the connector and duplicating it in a zod schema would create a
   *  second copy to keep in sync. */
  apiRouteMap: z.record(z.string(), z.unknown()).optional(),
  /** PEM of the CA to trust for this box's certificate. */
  apiCaCert: z.string().min(1).optional(),
});

export function createIntegrationsRouter(
  prisma: PrismaClient,
  /** WARP-2659 — the remote MCP lifecycle `disconnect()` tears down for an
   *  `mcp` track. Optional so every existing test and mount is unchanged. */
  deps: IntegrationsServiceDeps = {},
): Router {
  const router = Router();
  const svc = createIntegrationsService(prisma, deps);

  router.get(
    "/integrations",
    requireRole("owner", "admin", "family", "guest", "service"),
    async (_req, res, next) => {
      try {
        // Bare array — the dashboard hub maps it by provider (api.erp.ts).
        res.json(await svc.list());
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    },
  );

  router.get(
    "/integrations/eaglesoft",
    requireRole("owner", "admin", "family"),
    async (_req, res, next) => {
      try {
        // The dashboard's EaglesoftDetail nests the connection plus the
        // at-a-glance snapshot. kpis/schedule are null/empty until the live
        // read path lands (WARP-1095+); the dashboard fetches those separately.
        const connection = await svc.getEaglesoft();
        res.json({ connection, kpis: null, schedule: [] });
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    },
  );

  /**
   * WARP-2842 — the deprecated literal alias takes its provider from the
   * BODY, and that body is the LAN shape (a required `host`). A body naming a
   * DESCRIBED non-LAN track is refused here rather than resolved: `{ provider:
   * "stripe", host: "x" }` used to reach `connect()` with a ConnectInput and
   * no row material, the probe rejected CONNECTOR_BLOCKED, and a Stripe row
   * holding a perfectly good key was driven PROVISIONING → NOT_CONFIGURED.
   * Cloud and REST tracks have `/integrations/:provider/connect` below.
   *
   * Only a provider WITH a descriptor is judged: the export-drop keys
   * (`<vendor>-export`) declare none and are still connected through this
   * alias with a body — `resolveProvider` in the service keeps admitting or
   * refusing those exactly as before.
   */
  const refusesNonLanBodyProvider = (provider: string | undefined): string | null => {
    if (provider === undefined) return null;
    const descriptor = providerDescriptor(provider);
    if (!descriptor || descriptor.track === "lan") return null;
    // Names the right door for each track: cloud / REST have the empty-body
    // connect; an MCP track's paste IS its connection and has no connect at all.
    const door =
      descriptor.track === "mcp"
        ? `PATCH /api/integrations/${provider}/credentials`
        : `POST /api/integrations/${provider}/connect with an empty body`;
    return (
      `provider "${provider}" is a ${descriptor.track} track — it is connected by ` +
      `${door}, not through this alias`
    );
  };

  const provisionBody =
    (fn: (input: ConnectInput, req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: (e?: unknown) => void) => {
      try {
        const parsed = connectSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid request", details: parsed.error.flatten() });
          return;
        }
        const refused = refusesNonLanBodyProvider(parsed.data.provider);
        if (refused) {
          res.status(400).json({ error: "Invalid request", details: refused });
          return;
        }
        res.json(await fn(parsed.data as ConnectInput, req));
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    };

  /**
   * WARP-2520 — the LAN provisioning verbs, taking their provider from the URL.
   *
   * ### Why the admission rule is `lanProvisioning`, not `isKnownErpProvider`
   *
   * These two URLs are the four-step LAN flow: point Droplet at a host and
   * port, run the provisioning script, verify. That flow only means anything
   * for a provider whose descriptor declares {@link LanProvisioning} — the
   * same field `ConnectWizard` selects it with, so the browser and the box
   * agree on which providers have it by reading ONE declaration.
   *
   * `isKnownErpProvider` would be the wrong gate here even though it is the
   * right one for the lifecycle verbs. It admits Stripe, HubSpot and every
   * other cloud track, and a `POST /integrations/stripe/connect` carrying a
   * `host` would then reach a code path that tries to open a database session
   * against whatever that host is. A cloud provider is connected by pasting a
   * credential (`PATCH /integrations/:provider/credentials`); there is nothing
   * for it to provision, and 404 is the honest answer.
   *
   * Read through the live registry, so a descriptor registered at runtime is
   * admitted without a restart — same reasoning as `requireKnownProvider`.
   */
  const requireLanProvider = (provider: string): string => {
    if (!providerDescriptor(provider)?.lanProvisioning) {
      throw ErpError.notFound(`LAN provisioning for provider "${provider}"`);
    }
    return provider;
  };

  /**
   * WARP-2842 — the sibling admission for the tracks `connect()` PROBES.
   *
   * `cloud` and `rest` are the two tracks whose credential is pasted
   * (`PATCH /:provider/credentials`) and lands PROVISIONING, and the two
   * `integrations.service.ts` builds from the row and probes. `mcp` is
   * deliberately NOT here — the paste IS the connection for that track and
   * `isKnownErpProvider` refuses it — and neither is `lan`, which needs a
   * body this branch does not take. A provider that is neither falls through
   * to `requireLanProvider`, which 404s it with the message it always has.
   *
   * Read through the live registry, like its sibling.
   */
  const isCloudProvider = (provider: string): boolean => {
    const track = providerDescriptor(provider)?.track;
    return track === "cloud" || track === "rest";
  };

  /**
   * The cloud connect body: NOTHING. Strict, so the LAN shape posted at a
   * cloud provider is a 400 rather than silently ignored — a `host` sent to
   * Stripe is a caller that misunderstands which track it is on, and the
   * honest answer names that. No `enableWrites` either: the write opt-in for
   * these tracks is `/:provider/write-enable`, and a probe that also toggled
   * writes would couple two consent events into one request.
   */
  const cloudConnectSchema = z.object({}).strict();

  /**
   * The cloud-track sibling of {@link lanProvisionBody}.
   *
   * The URL is the only source of the provider, and the ConnectInput the
   * service receives carries nothing but that provider: the credential is
   * on the ROW and the service reads it from there. `host: ""` because the
   * input type requires one and a cloud track has none — the service does
   * not write it for these tracks.
   */
  const cloudProbeBody =
    (fn: (input: ConnectInput, req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: (e?: unknown) => void) => {
      try {
        const provider = String(req.params.provider);
        const parsed = cloudConnectSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid request",
            details:
              `a ${providerDescriptor(provider)?.track} track is connected by pasting a ` +
              "credential; POST an empty body here to check it",
          });
          return;
        }
        res.json(await fn({ provider, host: "" }, req));
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    };

  /**
   * The parameterised sibling of {@link provisionBody}.
   *
   * The URL is the ONLY source of the provider. A body that names a different
   * one is refused rather than resolved: silently preferring either would mean
   * a request could provision a provider its own URL does not name, which is
   * the class of defect WARP-2500 removed from the lifecycle verbs. Omitting
   * `provider` from the body is the normal case and stays legal — the wizard
   * has never sent it — and an equal value is a harmless echo, not an error.
   */
  const lanProvisionBody =
    (fn: (input: ConnectInput, req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: (e?: unknown) => void) => {
      try {
        const provider = requireLanProvider(String(req.params.provider));
        const parsed = connectSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid request", details: parsed.error.flatten() });
          return;
        }
        if (parsed.data.provider !== undefined && parsed.data.provider !== provider) {
          res.status(400).json({
            error: "Invalid request",
            // Names the two providers, never the body — nothing a caller sent
            // beyond the key it disagreed about reaches the response.
            details: `body provider "${parsed.data.provider}" does not match the URL provider "${provider}"`,
          });
          return;
        }
        res.json(await fn({ ...parsed.data, provider } as ConnectInput, req));
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    };

  /**
   * ## The `eaglesoft` literal connect/test routes — DEPRECATED, one release
   *
   * Registered FIRST so `/integrations/eaglesoft/{connect,test}` keeps matching
   * the literal, exactly as the lifecycle aliases below do. They are NOT a
   * behavioural no-op the way those are: the literal handler takes its provider
   * from the BODY (defaulting to `EAGLESOFT_PROVIDER`), which is how the REST
   * track is selected today — `{ provider: "eaglesoft-api" }` posted here. The
   * parameterised route deliberately refuses that shape, because `eaglesoft-api`
   * declares no `lanProvisioning` and its own URL would not name it.
   *
   * REMOVE THEM once the REST track has a URL of its own; until then this pair
   * is the only way to reach `eaglesoft-api`'s connect, so removing it on the
   * lifecycle aliases' schedule would drop a live capability.
   */
  router.post(
    "/integrations/eaglesoft/connect",
    requireRole("owner", "admin"),
    // WARP-2283: the actor is threaded through so `connect()`'s consent record
    // names who connected, not just that something did.
    provisionBody((input, req) =>
      svc.connect(input, { actor: actorFromRequest(req as never) }),
    ),
  );
  router.post(
    "/integrations/eaglesoft/test",
    requireRole("owner", "admin"),
    provisionBody((input) => svc.test(input)),
  );

  /**
   * WARP-2500 — the lifecycle verbs, taking their provider from the URL.
   *
   * `providerFromParams` is the ONLY source: there is no body field and no
   * fallback constant, so a request that reaches a handler has already been
   * routed by a provider the URL named. The service validates the value
   * against `isKnownErpProvider` and 404s an unknown one — deliberately not
   * re-validated here, because two copies of an admission rule is how the two
   * copies come to disagree.
   */
  const providerFromParams = (req: Request): string => String(req.params.provider);

  const toggleWrites =
    (provider: (req: Request) => string, enabled: boolean) =>
    async (req: Request, res: Response, next: (e?: unknown) => void) => {
      try {
        const actor = (req as AuthedRequest).user?.id ?? "unknown";
        res.json(await svc.setWriteEnabled({ actor }, provider(req), enabled));
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    };

  const disconnectHandler =
    (provider: (req: Request) => string) =>
    async (req: Request, res: Response, next: (e?: unknown) => void) => {
      try {
        const actor = (req as AuthedRequest).user?.id ?? "unknown";
        res.json(await svc.disconnect({ actor }, provider(req)));
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    };

  /**
   * ## The `eaglesoft` literal aliases — DEPRECATED, one release
   *
   * These three routes predate the parameterised ones and are registered
   * FIRST, so `/integrations/eaglesoft/disconnect` keeps matching the literal.
   * That is a no-op in behaviour — the literal handler passes the same
   * `EAGLESOFT_PROVIDER` string the parameterised one would extract — and the
   * point of keeping them is purely that a dashboard bundle cached from before
   * this deploy keeps working for one release.
   *
   * REMOVE THEM in the release after the dashboard change below has shipped
   * (`api.erp.ts` now sends the provider-scoped URL for every provider,
   * Eaglesoft included). Nothing server-side depends on them.
   *
   * Registering them first, rather than relying on Express preferring a
   * literal over a `:param`, is deliberate: Express 4 matches in registration
   * order and has no literal-beats-parameter preference, so the ordering here
   * IS the behaviour.
   */
  const EAGLESOFT_ALIAS = () => "eaglesoft";

  router.post(
    "/integrations/eaglesoft/write-enable",
    requireRole("owner", "admin"),
    toggleWrites(EAGLESOFT_ALIAS, true),
  );
  router.post(
    "/integrations/eaglesoft/write-disable",
    requireRole("owner", "admin"),
    toggleWrites(EAGLESOFT_ALIAS, false),
  );
  router.post(
    "/integrations/eaglesoft/disconnect",
    requireRole("owner", "admin"),
    disconnectHandler(EAGLESOFT_ALIAS),
  );

  /**
   * The provider-scoped lifecycle routes.
   *
   * ### Why `:provider` cannot shadow `credentials` or `drift`
   *
   * Three routers share the `/api/integrations` prefix (`app.ts`), so a
   * pattern here that could match one of THEIR URLs would silently take it
   * over — the failure `integrations-prefix.mount.test.ts` (WARP-2485, PR
   * #1834) exists to catch. These three are safe by construction because the
   * parameter is in the MIDDLE and the last segment is a literal verb:
   *
   *   this router   POST  /integrations/:provider/disconnect
   *                 POST  /integrations/:provider/write-enable
   *                 POST  /integrations/:provider/write-disable
   *                 POST  /integrations/:provider/connect     (WARP-2520)
   *                 POST  /integrations/:provider/test        (WARP-2520)
   *   credentials   GET   /integrations/credentials          (2 segments)
   *                 GET   /integrations/:provider/credentials
   *                 PATCH /integrations/:provider/credentials
   *   drift         GET   /integrations/:connectionId/drift
   *
   * `/integrations/credentials` has a different ARITY, so no concrete URL
   * reaches both. The three-segment neighbours agree on the parameter but
   * differ on the final literal (`credentials` / `drift` vs the five verbs),
   * and no URL can end in two different literals at once. They also differ on
   * method — but arity and the final literal are what make the disjointness
   * hold, and relying on the method would make adding `POST
   * /integrations/:provider/credentials` a silent hijack rather than a red
   * test.
   *
   * What would NOT be safe, and is therefore deliberately not added here: a
   * bare `GET /integrations/:provider` detail route. Two segments, parameter
   * last — it swallows `GET /integrations/credentials` whole. The Eaglesoft
   * detail route stays a literal for exactly that reason.
   */
  router.post(
    "/integrations/:provider/disconnect",
    requireRole("owner", "admin"),
    disconnectHandler(providerFromParams),
  );
  router.post(
    "/integrations/:provider/write-enable",
    requireRole("owner", "admin"),
    toggleWrites(providerFromParams, true),
  );
  router.post(
    "/integrations/:provider/write-disable",
    requireRole("owner", "admin"),
    toggleWrites(providerFromParams, false),
  );

  // WARP-2520 — the same shape, and safe for the same reason: parameter in the
  // middle, literal verb last.
  //
  // WARP-2842 — ONE route, branched on the descriptor's track, so the URL
  // stays the one `api.erp.ts` already posts to. Both branches call the same
  // `svc.connect` with the same actor, so the consent record (`auditConnect`
  // in the service) has one shape whichever track it was written for.
  const connectHandler = (input: ConnectInput, req: Request) =>
    svc.connect(input, { actor: actorFromRequest(req as never) });
  const lanConnect = lanProvisionBody(connectHandler);
  const cloudConnect = cloudProbeBody(connectHandler);
  router.post(
    "/integrations/:provider/connect",
    requireRole("owner", "admin"),
    (req: Request, res: Response, next: (e?: unknown) => void) =>
      isCloudProvider(String(req.params.provider))
        ? cloudConnect(req, res, next)
        : lanConnect(req, res, next),
  );
  router.post(
    "/integrations/:provider/test",
    requireRole("owner", "admin"),
    lanProvisionBody((input) => svc.test(input)),
  );

  return router;
}
