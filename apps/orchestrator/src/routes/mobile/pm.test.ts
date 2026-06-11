/**
 * WARP-860 — mobile /api/mobile/pm/* routes on the runtime-provisioned
 * Plane service token.
 *
 * Before this ticket the routes forwarded `config.DROPLET_PM_ADMIN_TOKEN`
 * as the X-API-Key — a token registered nowhere in Plane (every call
 * 401'd on a stock CE box). Now:
 *
 *   - /workspaces uses `listPlaneWorkspaces()` (session app API) because
 *     Plane CE v0.24.1 has no `/api/v1/workspaces/` at all (404).
 *   - /projects + /work-items(+/:id) wrap their pm.client call in
 *     `withPmServiceToken`, treating PlaneApiError(401) as the
 *     invalidate-and-retry-once signal.
 *   - Provisioning failures surface as 503 PM_NOT_READY (the PM stack
 *     isn't onboarded/reachable yet) instead of a misleading 502.
 *
 * Wire shapes stay byte-identical to docs/mobile-api-contract.md.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// --- Mock the orchestrator-side Plane client; keep the real error class. ---
const mockPmClient = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listWorkItems: vi.fn(),
  getWorkItem: vi.fn(),
}));

vi.mock("../../services/pm.client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/pm.client.js")
  >("../../services/pm.client.js");
  return {
    PlaneApiError: actual.PlaneApiError,
    ...mockPmClient,
  };
});

// --- Mock the service-token module; keep the real error class and give
// withPmServiceToken the real invalidate-retry-once semantics so the
// routes' isAuthError predicate is exercised. ---
const mockTokenSvc = vi.hoisted(() => ({
  getPmServiceToken: vi.fn(),
  listPlaneWorkspaces: vi.fn(),
  invalidatePmServiceToken: vi.fn(),
}));

vi.mock("../../services/pm-service-token.service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/pm-service-token.service.js")
  >("../../services/pm-service-token.service.js");
  return {
    ...actual,
    getPmServiceToken: mockTokenSvc.getPmServiceToken,
    listPlaneWorkspaces: mockTokenSvc.listPlaneWorkspaces,
    invalidatePmServiceToken: mockTokenSvc.invalidatePmServiceToken,
    withPmServiceToken: vi.fn(
      async (
        fn: (token: string) => Promise<unknown>,
        isAuthError: (err: unknown) => boolean,
      ) => {
        const token = (await mockTokenSvc.getPmServiceToken()) as string;
        try {
          return await fn(token);
        } catch (err) {
          if (!isAuthError(err)) throw err;
          mockTokenSvc.invalidatePmServiceToken();
          return fn((await mockTokenSvc.getPmServiceToken()) as string);
        }
      },
    ),
  };
});

import { PlaneApiError } from "../../services/pm.client.js";
import {
  PmServiceTokenError,
} from "../../services/pm-service-token.service.js";
import { PmBootstrapError } from "../../services/pm-bootstrap.service.js";
import { createPmMobileRouter } from "./pm.js";

const TOKEN = "plane_api_provisioned";

function buildApp(role?: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as unknown as { user?: object }).user = {
        id: "u1",
        username: "owner1",
        role,
      };
    }
    next();
  });
  app.use(createPmMobileRouter());
  // The routes call next(err) for unexpected errors — keep supertest
  // from hanging on those.
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "internal" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTokenSvc.getPmServiceToken.mockResolvedValue(TOKEN);
});

describe("GET /api/mobile/pm/workspaces", () => {
  it("serves the workspace list from listPlaneWorkspaces (session app API)", async () => {
    mockTokenSvc.listPlaneWorkspaces.mockResolvedValueOnce([
      { id: "w1", slug: "droplet-home", name: "Droplet Home" },
    ]);

    const res = await request(buildApp("owner")).get("/api/mobile/pm/workspaces");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workspaces: [{ id: "w1", slug: "droplet-home", name: "Droplet Home" }],
    });
  });

  it("maps a PmServiceTokenError to 503 PM_NOT_READY", async () => {
    mockTokenSvc.listPlaneWorkspaces.mockRejectedValueOnce(
      new PmServiceTokenError("workspace list failed", "WORKSPACE_LIST_FAILED"),
    );

    const res = await request(buildApp("owner")).get("/api/mobile/pm/workspaces");

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PM_NOT_READY");
  });

  it("keeps the service role excluded (Romain PR #321 review §3)", async () => {
    const res = await request(buildApp("service")).get("/api/mobile/pm/workspaces");
    expect(res.status).toBe(403);
  });

  it("403s with no user at all", async () => {
    const res = await request(buildApp(undefined)).get("/api/mobile/pm/workspaces");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/mobile/pm/projects", () => {
  it("forwards the provisioned token to listProjects", async () => {
    mockPmClient.listProjects.mockResolvedValueOnce([
      { id: "p1", name: "Inbox", identifier: "INBOX", workspace: "w1" },
    ]);

    const res = await request(buildApp("family")).get(
      "/api/mobile/pm/projects?workspace=droplet-home&per_page=10",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projects: [{ id: "p1", name: "Inbox", identifier: "INBOX" }],
    });
    expect(mockPmClient.listProjects).toHaveBeenCalledWith(TOKEN, "droplet-home", 10);
  });

  it("retries once with a fresh token on a Plane 401", async () => {
    mockTokenSvc.getPmServiceToken
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");
    mockPmClient.listProjects
      .mockRejectedValueOnce(new PlaneApiError("unauth", 401, "401"))
      .mockResolvedValueOnce([
        { id: "p1", name: "Inbox", identifier: "INBOX", workspace: "w1" },
      ]);

    const res = await request(buildApp("owner")).get(
      "/api/mobile/pm/projects?workspace=droplet-home",
    );

    expect(res.status).toBe(200);
    expect(mockTokenSvc.invalidatePmServiceToken).toHaveBeenCalledTimes(1);
    expect(mockPmClient.listProjects).toHaveBeenNthCalledWith(
      2,
      "fresh-token",
      "droplet-home",
      50,
    );
  });

  it("maps a provisioning failure to 503 PM_NOT_READY", async () => {
    mockTokenSvc.getPmServiceToken.mockRejectedValueOnce(
      new PmServiceTokenError(
        "Plane has no workspace yet — run the wizard PM step (POST /api/pm/onboard) first",
        "PM_NOT_ONBOARDED",
      ),
    );

    const res = await request(buildApp("owner")).get(
      "/api/mobile/pm/projects?workspace=droplet-home",
    );

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PM_NOT_READY");
  });

  it("maps a PmBootstrapError (Plane unreachable) to 503 PM_NOT_READY", async () => {
    mockTokenSvc.getPmServiceToken.mockRejectedValueOnce(
      new PmBootstrapError("Plane /auth/sign-in/ timed out", "PM_UNREACHABLE"),
    );

    const res = await request(buildApp("owner")).get(
      "/api/mobile/pm/projects?workspace=droplet-home",
    );

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PM_NOT_READY");
  });

  it("keeps the contextual 404 mapping (PM_PROJECT_NOT_FOUND)", async () => {
    mockPmClient.listProjects.mockRejectedValueOnce(
      new PlaneApiError("missing", 404, "404"),
    );

    const res = await request(buildApp("owner")).get(
      "/api/mobile/pm/projects?workspace=nope",
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PM_PROJECT_NOT_FOUND");
  });

  it("still 400s without the workspace param", async () => {
    const res = await request(buildApp("owner")).get("/api/mobile/pm/projects");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/mobile/pm/work-items", () => {
  it("forwards the provisioned token and projects the contract shape", async () => {
    mockPmClient.listWorkItems.mockResolvedValueOnce([
      {
        id: "i1",
        name: "Bug",
        description_html: "<p>internal — must not leak</p>",
        state: "todo",
        assignees: ["u1"],
        labels: [],
        created_at: "2026-06-10T00:00:00Z",
        updated_at: "2026-06-11T00:00:00Z",
      },
    ]);

    const res = await request(buildApp("guest")).get(
      "/api/mobile/pm/work-items?workspace=droplet-home&project_id=p1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      work_items: [
        {
          id: "i1",
          name: "Bug",
          state: "todo",
          assignees: ["u1"],
          labels: [],
          created_at: "2026-06-10T00:00:00Z",
          updated_at: "2026-06-11T00:00:00Z",
        },
      ],
    });
    expect(mockPmClient.listWorkItems).toHaveBeenCalledWith(
      TOKEN,
      "droplet-home",
      "p1",
      { perPage: 50, state: undefined, assignee: undefined },
    );
  });

  it("maps a provisioning failure to 503 PM_NOT_READY", async () => {
    mockTokenSvc.getPmServiceToken.mockRejectedValueOnce(
      new PmServiceTokenError("nope", "PROVISION_FAILED"),
    );

    const res = await request(buildApp("owner")).get(
      "/api/mobile/pm/work-items?workspace=droplet-home&project_id=p1",
    );

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PM_NOT_READY");
  });
});

describe("GET /api/mobile/pm/work-items/:id", () => {
  it("forwards the provisioned token", async () => {
    mockPmClient.getWorkItem.mockResolvedValueOnce({
      id: "i1",
      name: "Bug",
      state: "todo",
      assignees: [],
      labels: [],
      created_at: "t",
      updated_at: "t",
    });

    const res = await request(buildApp("admin")).get(
      "/api/mobile/pm/work-items/i1?workspace=droplet-home&project_id=p1",
    );

    expect(res.status).toBe(200);
    expect(mockPmClient.getWorkItem).toHaveBeenCalledWith(
      TOKEN,
      "droplet-home",
      "p1",
      "i1",
    );
  });

  it("keeps the 404 mapping (PM_WORK_ITEM_NOT_FOUND)", async () => {
    mockPmClient.getWorkItem.mockRejectedValueOnce(
      new PlaneApiError("missing", 404, "404"),
    );

    const res = await request(buildApp("owner")).get(
      "/api/mobile/pm/work-items/nope?workspace=droplet-home&project_id=p1",
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PM_WORK_ITEM_NOT_FOUND");
  });
});
