/**
 * Plane onboarding endpoint — seed first workspace + project.
 *
 * WARP-507 — per spec WARP-498 onboarding-wizard section. Setup wizard
 * (apps/web-dashboard/src/components/setup/steps/PmStep.tsx) POSTs here
 * with `{workspace_name, project_name}`; we create the workspace via
 * Plane's admin API + the first project under it; return the project
 * URL so the wizard can render a "View your Inbox" affordance.
 *
 * Idempotent: if a workspace with the same name already exists, reuse
 * it rather than 409-ing the wizard. Same for the first project.
 *
 * Fail-CLOSED on Plane errors. Wizard surfaces the failure with a
 * retry affordance.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import pino from "pino";
import { z } from "zod";

import { config } from "../config.js";

const logger = pino({ name: "pm-onboard-route" });

const HTTP_TIMEOUT_MS = 8_000;

const OnboardInput = z.object({
  workspace_name: z.string().trim().min(1).max(80),
  project_name: z.string().trim().min(1).max(80).default("Inbox"),
});

interface PlaneWorkspace {
  id: string;
  slug: string;
  name: string;
}

interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
}

async function planeApiCall<T>(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<T> {
  const url = new URL(path, config.DROPLET_PM_API_URL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), {
      method,
      headers: {
        "X-API-Key": config.DROPLET_PM_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`Plane ${method} ${path} → ${resp.status}: ${detail}`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function findWorkspaceByName(name: string): Promise<PlaneWorkspace | null> {
  const list = await planeApiCall<{ results: PlaneWorkspace[] } | PlaneWorkspace[]>(
    "/api/v1/workspaces/",
    "GET",
  );
  const all = Array.isArray(list) ? list : list.results;
  return all.find((w) => w.name === name) ?? null;
}

async function findProjectByName(
  workspaceSlug: string,
  name: string,
): Promise<PlaneProject | null> {
  const list = await planeApiCall<{ results: PlaneProject[] } | PlaneProject[]>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/`,
    "GET",
  );
  const all = Array.isArray(list) ? list : list.results;
  return all.find((p) => p.name === name) ?? null;
}

export function createPmOnboardRouter(): Router {
  const router = Router();

  router.post(
    "/api/pm/onboard",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({ error: "auth required" });
        }
        const parsed = OnboardInput.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "invalid input",
            details: parsed.error.issues,
          });
        }
        const { workspace_name, project_name } = parsed.data;

        // Idempotent workspace lookup-or-create.
        let workspace = await findWorkspaceByName(workspace_name);
        if (!workspace) {
          workspace = await planeApiCall<PlaneWorkspace>(
            "/api/v1/workspaces/",
            "POST",
            { name: workspace_name },
          );
          logger.info(
            { userId: req.user.id, workspaceSlug: workspace.slug },
            "created Plane workspace",
          );
        }

        // Idempotent project lookup-or-create.
        let project = await findProjectByName(workspace.slug, project_name);
        if (!project) {
          project = await planeApiCall<PlaneProject>(
            `/api/v1/workspaces/${encodeURIComponent(workspace.slug)}/projects/`,
            "POST",
            { name: project_name, identifier: deriveIdentifier(project_name) },
          );
          logger.info(
            { userId: req.user.id, projectId: project.id },
            "created Plane project",
          );
        }

        const url = `${config.DROPLET_PM_WEB_URL.replace(/\/$/, "")}/${encodeURIComponent(workspace.slug)}/projects/${encodeURIComponent(project.id)}/issues/`;
        return res.json({
          workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
          project: { id: project.id, name: project.name, identifier: project.identifier },
          url,
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "PM onboard failed");
        next(err);
      }
    },
  );

  return router;
}

/** Derive a Plane identifier (1-12 uppercase chars) from the project name. */
function deriveIdentifier(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return clean.slice(0, 6) || "INBOX";
}
