/**
 * Plane onboarding endpoint — bootstrap instance, seed first workspace + project.
 *
 * WARP-507 (original) / WARP-860 (rewrite). Setup wizard
 * (apps/web-dashboard/src/components/setup/steps/PmStep.tsx) POSTs here
 * with `{workspace_name, project_name}`.
 *
 * WARP-860 — ground truth from a live Plane CE v0.24.1: the `/api/v1/`
 * token API this route used to call has NO workspace create/list (404),
 * the admin token was registered nowhere, and a fresh instance blocks
 * everything behind the god-mode "set up your instance" wall. So this
 * route now:
 *
 *   1. Completes Plane's instance setup if needed (pm-bootstrap.service —
 *      creates the instance admin, flips is_setup_done; the wall is gone).
 *   2. Signs that admin in via the regular app flow → `session-id` cookie.
 *   3. Creates the workspace + project through the session-authenticated
 *      app API (`POST /api/workspaces/`, `POST /api/workspaces/:slug/projects/`)
 *      — the same surface Plane's own frontend uses.
 *   4. Returns the project URL plus the Plane sign-in credentials so the
 *      wizard can hand the owner a working login (Plane CE has no OIDC;
 *      email+password is its only auth).
 *
 * Idempotent: an existing workspace (by name) and project (by name) are
 * reused rather than 409-ing the wizard.
 *
 * Owner/admin only — the response carries Plane admin credentials.
 *
 * Fail-CLOSED on Plane errors. Wizard surfaces the failure with a
 * retry affordance.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import pino from "pino";
import { z } from "zod";

import { config } from "../config.js";
import { requireRole } from "../middleware/auth.js";
import {
  ensureInstanceSetup,
  getAppSessionCookie,
  planeAdminEmail,
  planeAdminPassword,
  planeAppApi,
  PmBootstrapError,
} from "../services/pm-bootstrap.service.js";

const logger = pino({ name: "pm-onboard-route" });

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

async function findWorkspaceByName(
  sessionCookie: string,
  name: string,
): Promise<PlaneWorkspace | null> {
  // NOT `GET /api/workspaces/` — that list 400s ("The required key does not
  // exist", a cache-decorator quirk; observed live on v0.24.1). The
  // user-scoped list is what Plane's own sidebar uses and works reliably.
  const { status, body } = await planeAppApi<PlaneWorkspace[] | { results: PlaneWorkspace[] }>(
    "/api/users/me/workspaces/",
    sessionCookie,
  );
  if (status !== 200) {
    throw new Error(`Plane GET /api/users/me/workspaces/ → ${status}`);
  }
  const all = Array.isArray(body) ? body : body.results ?? [];
  return all.find((w) => w.name === name) ?? null;
}

async function createWorkspace(
  sessionCookie: string,
  name: string,
): Promise<PlaneWorkspace> {
  // Plane slugs: <= 48 chars, slugified, must dodge the RESTRICTED list
  // (api, admin, onboarding, ...). On a slug collision (410 GONE) retry
  // with a numeric suffix — same-name reuse was already handled upstream.
  const base = deriveSlug(name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = attempt === 0 ? base : `${base.slice(0, 45)}-${attempt + 1}`;
    const { status, body } = await planeAppApi<PlaneWorkspace & { error?: string }>(
      "/api/workspaces/",
      sessionCookie,
      { method: "POST", body: { name, slug } },
    );
    if (status === 201) return body;
    if (status !== 410) {
      throw new Error(`Plane POST /api/workspaces/ → ${status}: ${JSON.stringify(body)}`);
    }
  }
  throw new Error(`Plane workspace slug '${base}' is taken (3 attempts)`);
}

async function findProjectByName(
  sessionCookie: string,
  workspaceSlug: string,
  name: string,
): Promise<PlaneProject | null> {
  const { status, body } = await planeAppApi<PlaneProject[] | { results: PlaneProject[] }>(
    `/api/workspaces/${encodeURIComponent(workspaceSlug)}/projects/`,
    sessionCookie,
  );
  if (status !== 200) {
    throw new Error(`Plane GET projects → ${status}`);
  }
  const all = Array.isArray(body) ? body : body.results ?? [];
  return all.find((p) => p.name === name) ?? null;
}

async function createProject(
  sessionCookie: string,
  workspaceSlug: string,
  name: string,
): Promise<PlaneProject> {
  const { status, body } = await planeAppApi<PlaneProject & { identifier?: string }>(
    `/api/workspaces/${encodeURIComponent(workspaceSlug)}/projects/`,
    sessionCookie,
    { method: "POST", body: { name, identifier: deriveIdentifier(name) } },
  );
  if (status !== 201) {
    throw new Error(`Plane POST projects → ${status}: ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Clear Plane's USER-level onboarding flags for the bootstrap admin so the
 * first browser sign-in lands in the workspace, not Plane's profile /
 * create-workspace walkthrough. Best-effort — a failure here still leaves
 * a usable (if one-extra-wizard) Plane.
 */
async function completeAdminOnboarding(sessionCookie: string): Promise<void> {
  await planeAppApi("/api/users/me/onboard/", sessionCookie, {
    method: "PATCH",
    body: { is_onboarded: true },
  });
  await planeAppApi("/api/users/me/tour-completed/", sessionCookie, {
    method: "PATCH",
    body: { is_tour_completed: true },
  });
}

export function createPmOnboardRouter(): Router {
  const router = Router();

  router.post(
    "/api/pm/onboard",
    // WARP-860: the response carries the Plane admin credentials — owner
    // and admin only (the wizard runs as the owner).
    requireRole("owner", "admin"),
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

        // 1. Kill the god-mode wall (idempotent).
        await ensureInstanceSetup();

        // 2. App session for the bootstrap admin.
        const session = await getAppSessionCookie();

        // 3. Idempotent workspace lookup-or-create.
        let workspace = await findWorkspaceByName(session, workspace_name);
        if (!workspace) {
          workspace = await createWorkspace(session, workspace_name);
          logger.info(
            { userId: req.user.id, workspaceSlug: workspace.slug },
            "created Plane workspace",
          );
        }

        // 4. Idempotent project lookup-or-create.
        let project = await findProjectByName(session, workspace.slug, project_name);
        if (!project) {
          project = await createProject(session, workspace.slug, project_name);
          logger.info(
            { userId: req.user.id, projectId: project.id },
            "created Plane project",
          );
        }

        // 5. Best-effort: skip Plane's user-level onboarding walkthrough.
        await completeAdminOnboarding(session).catch((err: unknown) => {
          logger.warn(
            { err: (err as Error).message },
            "could not clear Plane user onboarding flags (non-fatal)",
          );
        });

        const url = `${config.DROPLET_PM_WEB_URL.replace(/\/$/, "")}/${encodeURIComponent(workspace.slug)}/projects/${encodeURIComponent(project.id)}/issues/`;
        return res.json({
          workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
          project: { id: project.id, name: project.name, identifier: project.identifier },
          url,
          // Plane CE's only auth is email+password — hand the owner the
          // bootstrap credentials so the embedded Plane is actually usable.
          auth: {
            email: planeAdminEmail(),
            password: planeAdminPassword(),
            signInUrl: config.DROPLET_PM_WEB_URL.replace(/\/$/, ""),
          },
        });
      } catch (err) {
        if (err instanceof PmBootstrapError) {
          logger.warn({ err: err.message, code: err.code }, "PM onboard failed");
          return res.status(502).json({ error: err.message, code: err.code });
        }
        logger.warn({ err: (err as Error).message }, "PM onboard failed");
        next(err);
      }
    },
  );

  return router;
}

/** Derive a Plane workspace slug (<= 48 chars, lowercase, dash-separated). */
function deriveSlug(name: string): string {
  // Trim leading/trailing dashes AFTER slicing so a 48-char boundary that
  // lands on a dash (produced by the [^a-z0-9]→"-" substitution) does not
  // leave a trailing dash that Plane rejects.
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return slug || "droplet";
}

/** Derive a Plane identifier (1-12 uppercase chars) from the project name. */
function deriveIdentifier(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return clean.slice(0, 6) || "INBOX";
}
