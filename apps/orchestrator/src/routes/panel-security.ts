/**
 * WARP-2981 (ADR-059 P6, §3.8) — the rack panel's Security count. One route:
 *
 *   P6-3  GET /api/panel/security     the panel's own service principal only
 *
 * Who may call it: `requireRoleOrService("_service:display")` with NO roles —
 * the bearer display.py already presents for /api/storage
 * (SERVICE_TOKEN_DISPLAY), pinned by id AND the `service` role, as join-code
 * pins it. Every person, and every other service principal, is refused with
 * 403 and the WARP-237 auth/warn row. §3.8 puts one box-wide number on a
 * panel that faces the room; that it can reach no browser is what keeps it
 * the ADR's one narrow exception to DS-005 rather than a way around it.
 *
 * Why it is not under /api/security: it has to be able to say `off`. Behind
 * the module gate a switched-off module and a toggle that could not be read
 * are the same 404 (middleware/module-gate.ts fails closed), so the panel
 * could not tell "this box doesn't use Security" from "Droplet can't say".
 * app.ts mounts it with the egress collector, before mountModuleGates; no
 * module claims /api/panel.
 *
 * What counts (D9): state `open` — nobody has acknowledged it yet — over the
 * whole box, as the owner sees it (`panelOpenIncidents`, the one place the
 * number is defined; it equals the owner's route-17 total). `alerts` is how
 * many of those carry an alert: the panel turns its chip orange only for an
 * alert, so a backlog of notices never keeps the room's glance tier lit.
 *
 * `upToDate` (D21) is false when the number may be missing incidents, read
 * off the /security header's own pure rows: the incident engine is not
 * sorting (`incidents` not ok), or camera events or network and sign-in
 * warnings are not getting through (`camera_ingest` / `threat_mirror` down).
 * A 0 from a stalled engine is not a quiet site. `camera_system` down needs
 * nothing here: Frigate going offline is itself a `camera_offline` incident.
 *
 * A read that cannot be answered is a 503 INCIDENTS_UNAVAILABLE, never
 * `open: 0`. Bodies are built from literals, never a spread, so no future
 * column can add a key. Read-only: nothing here writes, so there is no audit
 * path, and Droplet's AI reaches nothing (§4.9).
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRoleOrService } from "../middleware/auth.js";
import { panelOpenIncidents } from "../services/security-incident-view.js";
import { incidentHealthRow, incidentHealthState } from "../services/security-incidents.service.js";
import {
  buildSecurityHealth,
  securityIngestHealthState,
  type SecurityHealthId,
  type SecurityHealthRow,
} from "../services/security-events.service.js";
import { getEffectiveModuleIds } from "../services/modules.service.js";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("panel-security-route");

/** The panel's principal (middleware/auth.ts SERVICE_PRINCIPALS). */
const DISPLAY_SERVICE_ID = "_service:display";

/** The three header rows `upToDate` is read off. */
export interface PanelHealthRows {
  incidents: SecurityHealthRow;
  cameraIngest: SecurityHealthRow;
  threatMirror: SecurityHealthRow;
}

export interface PanelSecurityDeps {
  now?: () => Date;
  /** The box-wide `security` toggle. Throws when it cannot be read (→ 503). */
  isSecurityOn?: () => Promise<boolean>;
  healthRows?: (now: Date) => PanelHealthRows;
}

/** D21 — the number is current: the engine is sorting, and neither of the feeds it counts is down. */
export function panelCountIsCurrent(rows: PanelHealthRows): boolean {
  return rows.incidents.state === "ok" && rows.cameraIngest.state !== "down" && rows.threatMirror.state !== "down";
}

/**
 * The live rows, from the same pure builders the /api/security/health handler
 * calls. Only the `down` of `camera_ingest` and `threat_mirror` is read, and
 * neither depends on the stored run times (`state: null`): camera_ingest is
 * down when Droplet is not subscribed or saves are failing, threat_mirror
 * when its jobs were never registered. The engine's row is in-process too.
 */
export function panelHealthRows(now: Date): PanelHealthRows {
  const rows = buildSecurityHealth({
    frigateConfigured: Boolean(config.FRIGATE_URL && config.FRIGATE_URL.trim()),
    ingest: securityIngestHealthState(),
    frigate: undefined,
    state: null,
    now,
  });
  // buildSecurityHealth always emits both (pinned in the route test); were one
  // ever missing, reading its `.state` would throw and the route answer 503.
  const row = (id: SecurityHealthId): SecurityHealthRow => rows.find((r) => r.id === id)!;
  return {
    incidents: incidentHealthRow(incidentHealthState(), null, now),
    cameraIngest: row("camera_ingest"),
    threatMirror: row("threat_mirror"),
  };
}

export function createPanelSecurityRouter(prisma: PrismaClient, deps: PanelSecurityDeps = {}): Router {
  const router = Router();
  const clock = (): Date => (deps.now ? deps.now() : new Date());
  // The incident engine's own expression for "is Security on" (index.ts, registerSecurityIncidentJobs).
  const isSecurityOn = deps.isSecurityOn ?? (() => getEffectiveModuleIds(prisma, config).then((ids) => ids.has("security")));
  const healthRows = deps.healthRows ?? panelHealthRows;

  // P6-3 — the one route. No person may call it, so it carries no role-guard marker (and no feature gate).
  router.get("/panel/security", requireRoleOrService(DISPLAY_SERVICE_ID), async (_req: Request, res: Response) => {
    try {
      if (!(await isSecurityOn())) {
        res.json({ security: "off" });
        return;
      }
      const counts = await panelOpenIncidents(prisma);
      const upToDate = panelCountIsCurrent(healthRows(clock()));
      res.json({ security: "on", open: counts.open, alerts: counts.alerts, upToDate });
    } catch (err) {
      logger.error({ err }, "panel security count failed");
      res.status(503).json({ error: { code: "INCIDENTS_UNAVAILABLE", message: "Incidents can't be read right now." } });
    }
  });

  return router;
}
