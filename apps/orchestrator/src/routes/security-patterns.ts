/**
 * WARP-2980 (ADR-059 P5, spec §7) — "what normal looks like", read-only.
 *
 *   29  GET /api/security/patterns           view
 *   30  GET /api/security/patterns/cells     view
 *   31  GET /api/security/patterns/explain   view
 *
 * S0 stub: an empty router, mounted in app.ts after createSecuritySiteRouter
 * under the same /api/security module gate. Slice A4 adds the routes.
 */
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import type { SecurityRouteDeps } from "../services/security-access.js";

export function createSecurityPatternsRouter(prisma: PrismaClient, deps: SecurityRouteDeps = {}): Router {
  void prisma;
  void deps;
  return Router();
}
