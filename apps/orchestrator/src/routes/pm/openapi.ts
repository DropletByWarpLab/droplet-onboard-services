/**
 * WARP-3533 — GET /api/pm/openapi.json: the OpenAPI 3.1 description of `/api/pm`.
 *
 * Auth: mounted AFTER authMiddleware and under the `/api/pm` prefix, so it is
 * served only to a signed-in person or a personal API token with `pm:read`, and
 * the `projects` module gate and tier floor answer for it like any PM read.
 *
 * Why a checked-in document and not one generated from the zod schemas: the repo
 * has no generator (no zod-to-openapi, and ADR-008 deferred OpenAPI), and the
 * request schemas are module-private constants in routes/pm/native.ts, a file
 * several slices edit at once. So the document is written by hand and KEPT HONEST
 * by `openapi.test.ts`, which walks the routers' stacks and fails when a mounted
 * route is undocumented or a documented one is gone.
 *
 * Two copies, deliberately: `docs/openapi/pm.openapi.json` is canonical (what
 * people and code generators read in the repo), and the copy beside this file is
 * what the orchestrator serves, because the production image ships the compiled
 * `dist/` and never `docs/`. The same test pins them byte-identical; to change the
 * API description, edit the docs copy and copy it over this one.
 */
import { Router } from "express";
import pmOpenApi from "./pm.openapi.json";

export function createPmOpenApiRouter(): Router {
  const router = Router();
  router.get("/pm/openapi.json", (_req, res) => {
    res.json(pmOpenApi);
  });
  return router;
}
