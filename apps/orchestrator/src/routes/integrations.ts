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
 * The three `/api/integrations/eaglesoft/{disconnect,write-enable,
 * write-disable}` spellings remain as DEPRECATED aliases for one release, so a
 * dashboard bundle cached from before this deploy keeps working. See the
 * comment above their registration for the removal condition. They were the
 * only spellings until now, which is the bug: `connect()` admits every
 * provider `isKnownErpProvider` allows, so WARP-2466 could create a Stripe /
 * HubSpot / Mailchimp / QuickBooks row that no URL could ever purge.
 *
 * DB-INDEPENDENT: the connector's live calls are stubbed, so connect/test
 * degrade honestly (PROVISIONING / ERP_NOT_CONNECTED) — never a fake CONNECTED.
 * RBAC via the shared requireRole middleware; ErpError → its own HTTP status.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { actorFromRequest } from "../services/activity.service.js";
import {
  createIntegrationsService,
  type ConnectInput,
} from "../services/integrations.service.js";
import { ErpError } from "../services/erp-error.js";

type AuthedRequest = { user?: { id?: string; role?: string } };

/** Render an ErpError with its typed HTTP status; return false for others. */
function handleErpError(res: Response, err: unknown): boolean {
  if (err instanceof ErpError) {
    res.status(err.status).json(err.toJSON());
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

export function createIntegrationsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const svc = createIntegrationsService(prisma);

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
        res.json(await fn(parsed.data as ConnectInput, req));
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    };

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
   *   credentials   GET   /integrations/credentials          (2 segments)
   *                 GET   /integrations/:provider/credentials
   *                 PATCH /integrations/:provider/credentials
   *   drift         GET   /integrations/:connectionId/drift
   *
   * `/integrations/credentials` has a different ARITY, so no concrete URL
   * reaches both. The three-segment neighbours agree on the parameter but
   * differ on the final literal (`credentials` / `drift` vs the three verbs),
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

  return router;
}
