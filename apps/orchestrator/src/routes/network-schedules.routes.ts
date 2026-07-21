/**
 * WARP-94: schedules + overrides + schedule-event + manualBlock REST
 * surface. Thin HTTP shell over `scheduleApi`; the service layer owns
 * subject/window/range invariants, this file only marshals args and
 * guards ISO-date parsing.
 */

import type { Router } from "express";
import type { createScheduleApiService } from "../services/schedule-api.service.js";
import { DeviceRegistryError } from "../types/device-registry-error.js";
import { handleRegistryError } from "./network-error-handler.js";
import { requireRoleOrMcpService } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";

export interface ScheduleDeps {
  scheduleApi: ReturnType<typeof createScheduleApiService>;
}

export function registerScheduleRoutes(router: Router, deps: ScheduleDeps): void {
  const { scheduleApi } = deps;

  // --- WARP-94: schedules + overrides + schedule events ---
  // Everything below is a thin HTTP shell over `scheduleApi`. The service
  // is the one enforcing subject/window/range invariants; the only
  // marshalling these handlers do is ISO-string → Date for the override
  // endpoints.

  router.get("/network/schedules", async (_req, res, next) => {
    try {
      // WARP-111: SWR-friendly caching for the dashboard's polling reads.
      res.set("Cache-Control", "private, max-age=5, stale-while-revalidate=10");
      const schedules = await scheduleApi.listSchedules();
      res.json({ schedules });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.get("/network/schedules/:id", async (req, res, next) => {
    try {
      const schedule = await scheduleApi.getSchedule(req.params.id);
      res.json({ schedule });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  // WARP-171: per-route guard. owner + admin — schedules are
  // parental-controls / time-of-day rules that cut household member
  // connectivity, so they're admin-tier.
  //
  // WARP-1443: every schedules/overrides/manualBlock guard below is
  // requireRoleOrMcpService — the MCP service principal (`_service:mcp`)
  // is admitted so the set_device_schedule LLM tool reaches this surface.
  // The tool enforces the human caller's forwarded role (owner/admin)
  // before dispatching; human RBAC on these routes is byte-identical.
  router.post("/network/schedules", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const schedule = await scheduleApi.createSchedule(req.body);
      res.status(201).json({ schedule });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.patch("/network/schedules/:id", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const schedule = await scheduleApi.updateSchedule(
        req.params.id,
        req.body ?? {},
      );
      res.json({ schedule });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.delete("/network/schedules/:id", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      await scheduleApi.deleteSchedule(req.params.id);
      res.status(204).end();
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.get("/network/overrides", async (req, res, next) => {
    try {
      const overrides = await scheduleApi.listOverrides({
        active: req.query.active === "1",
        deviceMac:
          typeof req.query.deviceMac === "string"
            ? req.query.deviceMac
            : undefined,
        groupId:
          typeof req.query.groupId === "string"
            ? req.query.groupId
            : undefined,
      });
      res.json({ overrides });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.post("/network/overrides", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const body = { ...(req.body ?? {}) };
      // Guard against `new Date("not-a-date")` silently yielding Invalid Date —
      // `getTime()` on Invalid Date returns NaN, which makes every range
      // comparison in the service layer (`endAt <= startAt`) resolve false
      // and write a corrupt row. Reject at the edge before the service sees it.
      if (body.startAt !== undefined) {
        const d = new Date(body.startAt);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: DeviceRegistryError.invalidDate(
              "startAt",
              String(body.startAt),
            ).toJSON(),
          });
        }
        body.startAt = d;
      }
      if (body.endAt !== undefined) {
        const d = new Date(body.endAt);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: DeviceRegistryError.invalidDate(
              "endAt",
              String(body.endAt),
            ).toJSON(),
          });
        }
        body.endAt = d;
      }
      const override = await scheduleApi.createOverride(body);
      // WARP-181 (AC4): schedule overrides lift/impose connectivity rules
      // on a device or group — a privileged op that must land on the
      // signed activity chain with the authed caller as actor.
      // `recordActivity` swallows its own failures; the override result
      // is never blocked on the audit write.
      await recordActivity({
        kind: "network",
        severity: "ok",
        sourceIcon: "clock",
        what: "Schedule override created",
        sub: `${override.action} • ${override.deviceMac ?? override.groupId ?? "unknown"}`,
        refs: {
          deviceId: override.deviceMac ?? null,
          groupId: override.groupId ?? null,
          overrideId: override.id,
          startAt: override.startAt.toISOString(),
          endAt: override.endAt.toISOString(),
        },
        actor: actorFromRequest(req),
      });
      res.status(201).json({ override });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.delete("/network/overrides/:id", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const removed = await scheduleApi.cancelOverride(req.params.id);
      // WARP-181 (AC4): mirror row for the delete path.
      await recordActivity({
        kind: "network",
        severity: "ok",
        sourceIcon: "clock",
        what: "Schedule override removed",
        sub: `${removed.action} • ${removed.deviceMac ?? removed.groupId ?? "unknown"}`,
        refs: {
          deviceId: removed.deviceMac ?? null,
          groupId: removed.groupId ?? null,
          overrideId: removed.id,
          startAt: removed.startAt.toISOString(),
          endAt: removed.endAt.toISOString(),
        },
        actor: actorFromRequest(req),
      });
      res.status(204).end();
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.get("/network/schedule-events", async (req, res, next) => {
    try {
      // WARP-111: the event log is append-only and tolerates a slightly
      // longer plain max-age (no SWR window).
      res.set("Cache-Control", "private, max-age=15");
      let since: Date | undefined;
      if (typeof req.query.since === "string") {
        const d = new Date(req.query.since);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({
            error: DeviceRegistryError.invalidDate(
              "since",
              req.query.since,
            ).toJSON(),
          });
        }
        since = d;
      }
      const events = await scheduleApi.listScheduleEvents({
        since,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ events });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.post("/network/devices/:mac/manualBlock", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      if (typeof req.body?.blocked !== "boolean") {
        return res
          .status(400)
          .json({ error: "Body must be { blocked: boolean }" });
      }
      const result = await scheduleApi.setManualBlock(
        req.params.mac,
        req.body.blocked,
      );
      res.json(result);
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });
}
