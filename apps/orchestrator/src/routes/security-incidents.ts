/**
 * WARP-2978 (ADR-059 P3 spec §7) — incidents, acknowledgement and alert
 * routing. Mounted at "/api" in app.ts AFTER createSecuritySiteRouter, under
 * the `security` module gate mountModuleGates mounts off /api/security.
 *
 * S0: an empty router. Slice D adds routes 16–22.
 */
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import type { SecurityRouteDeps } from "../services/security-access.js";

export function createSecurityIncidentsRouter(prisma: PrismaClient, deps: SecurityRouteDeps = {}): Router {
  void prisma;
  void deps;
  return Router();
}
