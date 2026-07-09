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

/** Connect / test body. `secretRef` is a POINTER — never a cleartext password. */
const connectSchema = z.object({
  host: z.string().min(1),
  databaseName: z.string().min(1).default("PattersonPM"),
  secretRef: z.string().min(1),
  serverName: z.string().optional(),
  port: z.number().int().positive().optional(),
});

export function createIntegrationsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const svc = createIntegrationsService(prisma);

  router.get(
    "/integrations",
    requireRole("owner", "admin", "family", "guest", "service"),
    async (_req, res, next) => {
      try {
        res.json({ integrations: await svc.list() });
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
        res.json(await svc.getEaglesoft());
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    },
  );

  const provisionBody =
    (fn: (input: ConnectInput) => Promise<unknown>) =>
    async (req: Request, res: Response, next: (e?: unknown) => void) => {
      try {
        const parsed = connectSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid request", details: parsed.error.flatten() });
          return;
        }
        res.json(await fn(parsed.data as ConnectInput));
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    };

  router.post(
    "/integrations/eaglesoft/connect",
    requireRole("owner", "admin"),
    provisionBody((input) => svc.connect(input)),
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

  return router;
}
