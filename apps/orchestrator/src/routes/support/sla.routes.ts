import { type Router, type Request, type Response, type RequestHandler } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import * as settings from "../../services/support/support.service.js";
import { assignmentSchema, macroSchema, policySchema, SLA_ERRORS } from "../../services/support/sla-schemas.js";
import type { SupportCtx, SupportViewer } from "../../services/support/support.types.js";
import type { SupportDeps } from "../../services/support/requester.service.js";
import { recordActivity } from "../../services/activity.singleton.js";
import { actorFromRequest } from "../../services/activity.service.js";
import { resolveEffectiveAccessForRequest } from "../../middleware/feature-gate.js";
import { resolveEffectiveAccess } from "../../services/effective-access.service.js";
interface Guards {
  staff: RequestHandler; admins: RequestHandler; canAct: RequestHandler; canManage: RequestHandler;
  viewerOf(req: Request): SupportViewer; ctxOf(req: Request): Promise<SupportCtx>;
  fail(err: unknown, res: Response, next: (e?: unknown) => void): void;
  svcDeps: SupportDeps;
}
/** Inherits the Support module gate and the caller's existing role/access resolver. */
export function installSlaRoutes(router: Router, prisma: PrismaClient, g: Guards): void {
  const canManageFor = async (req: Request) => {
    if (!req.user || !["owner", "admin"].includes(req.user.role)) return false;
    const access = await resolveEffectiveAccessForRequest(req, g.svcDeps.resolveAccess ?? resolveEffectiveAccess);
    return access?.features.some((f) => f.moduleId === "support" && f.level === "manage") ?? false;
  };
  const written = async (req: Request, res: Response, payload: unknown, status = 200) => {
    await recordActivity({ kind: "system", severity: "ok", sourceIcon: "life-buoy", what: "Service desk settings updated",
      refs: { route: req.route.path, method: req.method }, actor: actorFromRequest(req) });
    if (status === 204) res.status(status).end(); else res.status(status).json(payload);
  };
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => async (req, res, next) => {
    try { await fn(req, res); }
    catch (error) {
      if (error instanceof z.ZodError || error instanceof RangeError) { res.status(400).json({ error: SLA_ERRORS.INVALID }); return; }
      const code = error instanceof Error ? error.message : "";
      if (code === SLA_ERRORS.CALENDAR_NOT_FOUND || code === SLA_ERRORS.MACRO_NOT_FOUND) { res.status(404).json({ error: code }); return; }
      if (code === SLA_ERRORS.CALENDAR_IN_USE) { res.status(409).json({ error: code }); return; }
      if (code === SLA_ERRORS.INVALID || code === "invalid_report_range") { res.status(422).json({ error: code }); return; }
      g.fail(error, res, next);
    }
  };
  router.get("/support/calendars", g.staff, handle(async (req, res) => res.json({ calendars: await settings.listBusinessCalendars(prisma), canManage: await canManageFor(req) })));
  router.post("/support/calendars", g.admins, g.canManage, handle(async (req, res) => written(req, res, { calendar: await settings.saveBusinessCalendar(prisma, null, req.body) }, 201)));
  router.put("/support/calendars/:id", g.admins, g.canManage, handle(async (req, res) => written(req, res, { calendar: await settings.saveBusinessCalendar(prisma, req.params.id!, req.body) })));
  router.delete("/support/calendars/:id", g.admins, g.canManage, handle(async (req, res) => { await settings.deleteBusinessCalendar(prisma, req.params.id!); await written(req, res, undefined, 204); }));
  router.get("/support/desks/:id/sla", g.staff, handle(async (req, res) => res.json({ ...await settings.getDeskSla(prisma, req.params.id!), canManage: await canManageFor(req) })));
  router.put("/support/desks/:id/sla", g.admins, g.canManage, handle(async (req, res) => {
    const input = z.object({ policy: policySchema, assignment: assignmentSchema }).strict().parse(req.body);
    await written(req, res, await settings.saveDeskSla(prisma, req.params.id!, input, g.svcDeps));
  }));
  router.get("/support/desks/:id/sla/report", g.staff, handle(async (req, res) => {
    const input = z.object({ from: z.string(), to: z.string() }).strict().parse(req.query);
    res.json(await settings.getSlaReport(prisma, req.params.id!, input));
  }));
  router.get("/support/macros", g.staff, handle(async (req, res) => {
    const { deskId } = z.object({ deskId: z.string().min(1).max(64) }).strict().parse(req.query);
    res.json({ macros: await settings.listMacros(prisma, g.viewerOf(req), deskId), canManageShared: await canManageFor(req) });
  }));
  router.post("/support/macros", g.staff, g.canAct, handle(async (req, res) => written(req, res, { macro: await settings.saveMacro(prisma, g.viewerOf(req), null, macroSchema.parse(req.body), g.svcDeps) }, 201)));
  router.put("/support/macros/:id", g.staff, g.canAct, handle(async (req, res) => written(req, res, { macro: await settings.saveMacro(prisma, g.viewerOf(req), req.params.id!, macroSchema.parse(req.body), g.svcDeps) })));
  router.delete("/support/macros/:id", g.staff, g.canAct, handle(async (req, res) => { await settings.deleteMacro(prisma, g.viewerOf(req), req.params.id!, g.svcDeps); await written(req, res, undefined, 204); }));
  router.post("/support/tickets/:id/macros/:macroId/preview", g.staff, g.canAct, handle(async (req, res) => res.json(await settings.previewMacro(prisma, g.viewerOf(req), req.params.id!, req.params.macroId!, g.svcDeps))));
  router.post("/support/tickets/:id/macros/:macroId/apply", g.staff, g.canAct, handle(async (req, res) => res.json(await settings.applyMacro(prisma, g.viewerOf(req), req.params.id!, req.params.macroId!, await g.ctxOf(req), g.svcDeps))));
}
