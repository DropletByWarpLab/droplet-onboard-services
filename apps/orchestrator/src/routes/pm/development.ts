/** WARP-3535 — administration and item reads for external development links. */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { RestCredentialRejectedError, RestRateLimitedError } from "@droplet/erp-connector";
import { DevelopmentEgressBlockedError, DevelopmentConnectionChangedError } from "../../services/pm/pm-dev-egress.js";
import { requireRole } from "../../middleware/auth.js";
import { guestAssignedWorkItem } from "../../middleware/guest-share.js";
import {
  connectDevelopmentRepository,
  listConfiguredDevelopmentRepositories,
  listDevelopmentRepositories,
  listWorkItemDevelopment,
  mapDevelopmentRepository,
  removeDevelopmentRepository,
} from "../../services/pm/pm-development.service.js";

const provider = z.enum(["github", "gitlab"]);
const repoSchema = z.object({ externalId: z.string().min(1).max(128), apiRef: z.string().min(1).max(200), projectIds: z.array(z.string().min(1)).max(100) });
const mappingSchema = z.object({
  projectId: z.string().min(1),
  onOpenedStateId: z.string().min(1).nullable().optional(),
  onMergedStateId: z.string().min(1).nullable().optional(),
});

function fail(res: Response, err: unknown) {
  const code = err instanceof Error ? err.message : "development_sync_failed";
  if (err instanceof DevelopmentConnectionChangedError) return res.status(409).json({ error: "integration_connection_changed" });
  if (err instanceof RestCredentialRejectedError && err.status === 401) return res.status(409).json({ error: "integration_needs_reconnect" });
  if (err instanceof RestCredentialRejectedError && err.status === 403) return res.status(403).json({ error: "repository_access_denied" });
  if (err instanceof RestRateLimitedError) return res.status(429).json({ error: "code_host_rate_limited", retryAfter: err.resetAt?.toISOString() ?? null });
  if (err instanceof DevelopmentEgressBlockedError) return res.status(403).json({ error: err.reason === "egress_switch_off" ? "work_integrations_egress_disabled" : "development_destination_blocked" });
  if (code === "provider_not_supported" || code === "unsafe_vendor_url") return res.status(422).json({ error: code });
  if (code === "integration_not_connected" || code === "repository_not_found" || code === "project_not_found" || code === "state_not_found") return res.status(404).json({ error: code });
  return res.status(500).json({ error: "development_sync_failed" });
}

export function createPmDevelopmentRouter(prisma: PrismaClient) {
  const router = Router();
  const admin = requireRole("owner", "admin");

  router.get("/pm/development/repositories", admin, async (_req, res, next) => {
    try { res.json({ repositories: await listConfiguredDevelopmentRepositories(prisma) }); } catch (err) { next(err); }
  });
  router.get("/pm/development/repositories/:provider/available", admin, async (req, res) => {
    const parsedProvider = provider.safeParse(req.params.provider);
    if (!parsedProvider.success) return res.status(404).json({ error: "provider_not_supported" });
    try { res.json(await listDevelopmentRepositories(prisma, parsedProvider.data)); } catch (err) { fail(res, err); }
  });
  router.post("/pm/development/repositories/:provider", admin, async (req, res) => {
    const parsedProvider = provider.safeParse(req.params.provider);
    const parsedBody = repoSchema.safeParse(req.body);
    if (!parsedProvider.success || !parsedBody.success) return res.status(400).json({ error: "invalid_request" });
    try {
      const user = (req as Request & { user?: { id?: string } }).user;
      const repository = await connectDevelopmentRepository(prisma, parsedProvider.data, parsedBody.data, user?.id ?? "system");
      res.status(201).json({ repository });
    } catch (err) { fail(res, err); }
  });
  router.put("/pm/development/repositories/:id/projects", admin, async (req, res) => {
    const parsed = mappingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
    try {
      const repository = await prisma.pmDevRepository.findUnique({ where: { id: req.params.id }, select: { id: true } });
      if (!repository) return res.status(404).json({ error: "repository_not_found" });
      const mapping = await mapDevelopmentRepository(prisma, repository.id, parsed.data.projectId, parsed.data);
      res.json({ mapping });
    } catch (err) { fail(res, err); }
  });
  router.delete("/pm/development/repositories/:id/projects/:projectId", admin, async (req, res) => {
    try {
      await prisma.pmDevRepositoryProject.delete({ where: { repositoryId_projectId: { repositoryId: req.params.id, projectId: req.params.projectId } } });
      res.status(204).end();
    } catch (err) { fail(res, err); }
  });
  router.delete("/pm/development/repositories/:id", admin, async (req, res) => {
    try { await removeDevelopmentRepository(prisma, req.params.id); res.status(204).end(); } catch (err) { fail(res, err); }
  });
  router.get("/pm/work-items/:id/development", guestAssignedWorkItem(prisma), async (req, res) => {
    try { res.json({ links: await listWorkItemDevelopment(prisma, req.params.id) }); } catch (err) { fail(res, err); }
  });
  return router;
}
