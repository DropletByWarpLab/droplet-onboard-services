import { type Router, type Request, type Response, type RequestHandler } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import * as settings from "../../services/support/support.service.js";
import { assignmentSchema, macroSchema, policySchema, SLA_ERRORS } from "../../services/support/sla-schemas.js";
import type { SupportCtx, SupportViewer } from "../../services/support/support.types.js";
import type { SupportDeps } from "../../services/support/requester.service.js";
interface Guards {
  staff: RequestHandler; admins: RequestHandler; canAct: RequestHandler; canManage: RequestHandler;
  viewerOf(req: Request): SupportViewer; ctxOf(req: Request): Promise<SupportCtx>;
  fail(err: unknown, res: Response, next: (e?: unknown) => void): void;
  svcDeps: SupportDeps;
}
/** Inherits the Support module gate and the caller's existing role/access resolver. */
export function installSlaRoutes(router: Router, prisma: PrismaClient, g: Guards): void {
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
  router.get("/support/calendars", g.staff, handle(async (_req, res) => res.json({ calendars: await settings.listBusinessCalendars(prisma) })));
  router.post("/support/calendars", g.admins, g.canManage, handle(async (req, res) => res.status(201).json({ calendar: await settings.saveBusinessCalendar(prisma, null, req.body) })));
  router.put("/support/calendars/:id", g.admins, g.canManage, handle(async (req, res) => res.json({ calendar: await settings.saveBusinessCalendar(prisma, req.params.id!, req.body) })));
  router.delete("/support/calendars/:id", g.admins, g.canManage, handle(async (req, res) => { await settings.deleteBusinessCalendar(prisma, req.params.id!); res.status(204).end(); }));
  router.get("/support/desks/:id/sla", g.staff, handle(async (req, res) => res.json(await settings.getDeskSla(prisma, req.params.id!))));
  router.put("/support/desks/:id/sla", g.admins, g.canManage, handle(async (req, res) => {
    const input = z.object({ policy: policySchema, assignment: assignmentSchema }).strict().parse(req.body);
    res.json(await settings.saveDeskSla(prisma, req.params.id!, input, g.svcDeps));
  }));
  router.get("/support/desks/:id/sla/report", g.staff, handle(async (req, res) => {
    const input = z.object({ from: z.string(), to: z.string() }).strict().parse(req.query);
    res.json(await settings.getSlaReport(prisma, req.params.id!, input));
  }));
  router.get("/support/macros", g.staff, handle(async (req, res) => {
    const { deskId } = z.object({ deskId: z.string().min(1).max(64) }).strict().parse(req.query);
    res.json({ macros: await settings.listMacros(prisma, g.viewerOf(req), deskId) });
  }));
  router.post("/support/macros", g.staff, g.canAct, handle(async (req, res) => res.status(201).json({ macro: await settings.saveMacro(prisma, g.viewerOf(req), null, macroSchema.parse(req.body)) })));
  router.put("/support/macros/:id", g.staff, g.canAct, handle(async (req, res) => res.json({ macro: await settings.saveMacro(prisma, g.viewerOf(req), req.params.id!, macroSchema.parse(req.body)) })));
  router.delete("/support/macros/:id", g.staff, g.canAct, handle(async (req, res) => { await settings.deleteMacro(prisma, g.viewerOf(req), req.params.id!); res.status(204).end(); }));
  router.post("/support/tickets/:id/macros/:macroId/preview", g.staff, g.canAct, handle(async (req, res) => res.json(await settings.previewMacro(prisma, g.viewerOf(req), req.params.id!, req.params.macroId!, g.svcDeps))));
  router.post("/support/tickets/:id/macros/:macroId/apply", g.staff, g.canAct, handle(async (req, res) => res.json(await settings.applyMacro(prisma, g.viewerOf(req), req.params.id!, req.params.macroId!, await g.ctxOf(req), g.svcDeps))));
}
