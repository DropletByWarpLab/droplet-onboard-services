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

  router.post("/network/schedules", async (req, res, next) => {
    try {
      const schedule = await scheduleApi.createSchedule(req.body);
      res.status(201).json({ schedule });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.patch("/network/schedules/:id", async (req, res, next) => {
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

  router.delete("/network/schedules/:id", async (req, res, next) => {
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

  router.post("/network/overrides", async (req, res, next) => {
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
      res.status(201).json({ override });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.delete("/network/overrides/:id", async (req, res, next) => {
    try {
      await scheduleApi.cancelOverride(req.params.id);
      res.status(204).end();
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.get("/network/schedule-events", async (req, res, next) => {
    try {
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

  router.post("/network/devices/:mac/manualBlock", async (req, res, next) => {
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
