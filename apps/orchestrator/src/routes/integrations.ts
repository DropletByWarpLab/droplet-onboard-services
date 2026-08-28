/**
 * WARP-1137 — the integrations control-plane API (brief §13).
 *
 *   GET  /api/integrations                       Hub list (no PHI, no secret).
 *   GET  /api/integrations/eaglesoft             Connection detail + status.
 *   POST /api/integrations/eaglesoft/connect     Run/verify provisioning.
 *   POST /api/integrations/eaglesoft/test        Reachability test (no save).
 *   POST /api/integrations/eaglesoft/write-enable   Per-practice write opt-in.
 *   POST /api/integrations/eaglesoft/write-disable  Kill-switch (default off).
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

  const toggleWrites =
    (enabled: boolean) =>
    async (req: Request, res: Response, next: (e?: unknown) => void) => {
      try {
        const actor = (req as AuthedRequest).user?.id ?? "unknown";
        res.json(await svc.setWriteEnabled(enabled, { actor }));
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    };

  router.post(
    "/integrations/eaglesoft/write-enable",
    requireRole("owner", "admin"),
    toggleWrites(true),
  );
  router.post(
    "/integrations/eaglesoft/write-disable",
    requireRole("owner", "admin"),
    toggleWrites(false),
  );

  router.post(
    "/integrations/eaglesoft/disconnect",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const actor = (req as AuthedRequest).user?.id ?? "unknown";
        res.json(await svc.disconnect({ actor }));
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    },
  );

  return router;
}
