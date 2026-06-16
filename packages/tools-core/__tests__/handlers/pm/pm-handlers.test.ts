/**
 * TOOLS-07 — behavioural unit tests for the nine `pm_*` handlers
 * (WARP-508 reads + WARP-509 writes). Before this file the entire `pm`
 * domain had zero per-handler coverage, violating the area rule "each
 * tool has a unit test"; only `registry.test.ts` spot-checked the
 * write/confirm flags (not the handler logic, arg forwarding, or
 * PlaneApiError → tool-result mapping).
 *
 * Strategy: mock the single `pm-client.js` module the handlers funnel
 * through, preserving the REAL `PlaneApiError` class (via importActual) so
 * the handlers' `instanceof PlaneApiError` branch is exercised faithfully.
 * Each test asserts (a) the client is called with the forwarded args,
 * (b) the success shape, (c) the error-code mapping, and (d) that a
 * non-PlaneApiError bubbles (handlers deliberately rethrow those to the
 * agent loop).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "../../../src/types.js";

// --- Mock the Plane client; keep the real PlaneApiError class. ---
// `vi.hoisted` so the fns exist when the (hoisted) vi.mock factory runs.
const mockClient = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listWorkItems: vi.fn(),
  getWorkItem: vi.fn(),
  createWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
  addWorkItemComment: vi.fn(),
  transitionWorkItem: vi.fn(),
  setPlaneApiToken: vi.fn(),
}));

vi.mock("../../../src/handlers/pm/pm-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/handlers/pm/pm-client.js")
  >("../../../src/handlers/pm/pm-client.js");
  return {
    // Real class so `err instanceof PlaneApiError` holds in the handlers.
    PlaneApiError: actual.PlaneApiError,
    ...mockClient,
  };
});

import { PlaneApiError } from "../../../src/handlers/pm/pm-client.js";
import pmListWorkspaces from "../../../src/handlers/pm/list-workspaces.js";
import pmListProjects from "../../../src/handlers/pm/list-projects.js";
import pmListWorkItems from "../../../src/handlers/pm/list-work-items.js";
import pmGetWorkItem from "../../../src/handlers/pm/get-work-item.js";
import pmSearchWorkItems from "../../../src/handlers/pm/search-work-items.js";
import pmCreateWorkItem from "../../../src/handlers/pm/create-work-item.js";
import pmUpdateWorkItem from "../../../src/handlers/pm/update-work-item.js";
import pmAddWorkItemComment from "../../../src/handlers/pm/add-work-item-comment.js";
import pmTransitionWorkItem from "../../../src/handlers/pm/transition-work-item.js";

// WARP-867: handlers now touch ctx.http.orchestrator — the v1-backed ones
// via ensurePlaneToken (best-effort, failure-tolerant), and
// pm_list_workspaces / pm_search_work_items as their primary data path
// (Plane CE's /api/v1/ has neither route, so they proxy through the
// orchestrator's app-API endpoints).
const orchestratorGet = vi.fn();
const ctx = {
  http: { orchestrator: { get: orchestratorGet } },
} as unknown as ToolContext;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Read tools (WARP-508)
// ---------------------------------------------------------------------------

describe("pm_list_workspaces", () => {
  it("is read-only", () => {
    expect(pmListWorkspaces.name).toBe("pm_list_workspaces");
    expect(pmListWorkspaces.requiresWrite).toBe(false);
    expect(pmListWorkspaces.requiresConfirmation).toBe(false);
  });

  it("returns the workspace list from the orchestrator proxy", async () => {
    const workspaces = [{ id: "w1", slug: "acme", name: "Acme" }];
    orchestratorGet.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workspaces }),
    });
    const res = await pmListWorkspaces.handler({}, ctx);
    expect(orchestratorGet).toHaveBeenCalledWith(
      "/api/pm/workspaces",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ workspaces });
  });

  it("maps a non-OK proxy response to PM_API_ERROR with the upstream message", async () => {
    orchestratorGet.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: "Plane is not ready yet" }),
    });
    const res = await pmListWorkspaces.handler({}, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("PM_API_ERROR");
      expect(res.error.message).toBe("Plane is not ready yet");
    }
  });
});

describe("pm_list_projects", () => {
  it("is read-only", () => {
    expect(pmListProjects.name).toBe("pm_list_projects");
    expect(pmListProjects.requiresWrite).toBe(false);
    expect(pmListProjects.requiresConfirmation).toBe(false);
  });

  it("forwards workspace_slug + per_page and returns projects", async () => {
    const projects = [{ id: "p1", name: "Web", identifier: "WEB", workspace: "w1" }];
    mockClient.listProjects.mockResolvedValueOnce(projects);
    const res = await pmListProjects.handler(
      { workspace_slug: "acme", per_page: 25 },
      ctx,
    );
    expect(mockClient.listProjects).toHaveBeenCalledWith("acme", 25);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ projects });
  });

  it("maps PlaneApiError to PM_API_ERROR", async () => {
    mockClient.listProjects.mockRejectedValueOnce(new PlaneApiError("nope", 500));
    const res = await pmListProjects.handler({ workspace_slug: "acme" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PM_API_ERROR");
  });
});

describe("pm_list_work_items", () => {
  it("is read-only", () => {
    expect(pmListWorkItems.requiresWrite).toBe(false);
    expect(pmListWorkItems.requiresConfirmation).toBe(false);
  });

  it("forwards filters under the options object", async () => {
    mockClient.listWorkItems.mockResolvedValueOnce([]);
    await pmListWorkItems.handler(
      {
        workspace_slug: "acme",
        project_id: "p1",
        state: "in_progress",
        assignee: "u9",
        per_page: 10,
      },
      ctx,
    );
    expect(mockClient.listWorkItems).toHaveBeenCalledWith("acme", "p1", {
      perPage: 10,
      state: "in_progress",
      assignee: "u9",
    });
  });

  it("maps PlaneApiError to PM_API_ERROR", async () => {
    mockClient.listWorkItems.mockRejectedValueOnce(new PlaneApiError("x", 403));
    const res = await pmListWorkItems.handler(
      { workspace_slug: "acme", project_id: "p1" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PM_API_ERROR");
  });
});

describe("pm_get_work_item", () => {
  it("is read-only", () => {
    expect(pmGetWorkItem.requiresWrite).toBe(false);
    expect(pmGetWorkItem.requiresConfirmation).toBe(false);
  });

  it("forwards ids and returns the work_item", async () => {
    const work_item = { id: "i1", name: "Bug", created_at: "t", updated_at: "t" };
    mockClient.getWorkItem.mockResolvedValueOnce(work_item);
    const res = await pmGetWorkItem.handler(
      { workspace_slug: "acme", project_id: "p1", work_item_id: "i1" },
      ctx,
    );
    expect(mockClient.getWorkItem).toHaveBeenCalledWith("acme", "p1", "i1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ work_item });
  });

  it("maps a 404 to PM_WORK_ITEM_NOT_FOUND", async () => {
    mockClient.getWorkItem.mockRejectedValueOnce(new PlaneApiError("missing", 404));
    const res = await pmGetWorkItem.handler(
      { workspace_slug: "acme", project_id: "p1", work_item_id: "nope" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PM_WORK_ITEM_NOT_FOUND");
  });

  it("maps a non-404 PlaneApiError to PM_API_ERROR", async () => {
    mockClient.getWorkItem.mockRejectedValueOnce(new PlaneApiError("server", 500));
    const res = await pmGetWorkItem.handler(
      { workspace_slug: "acme", project_id: "p1", work_item_id: "i1" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PM_API_ERROR");
  });

  it("rethrows a non-PlaneApiError", async () => {
    mockClient.getWorkItem.mockRejectedValueOnce(new TypeError("boom"));
    await expect(
      pmGetWorkItem.handler(
        { workspace_slug: "acme", project_id: "p1", work_item_id: "i1" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("pm_search_work_items", () => {
  it("is read-only", () => {
    expect(pmSearchWorkItems.requiresWrite).toBe(false);
    expect(pmSearchWorkItems.requiresConfirmation).toBe(false);
  });

  it("forwards workspace_slug + query to the proxy and caps with per_page", async () => {
    orchestratorGet.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ work_items: [1, 2, 3, 4, 5, 6] }),
    });
    const res = await pmSearchWorkItems.handler(
      { workspace_slug: "acme", query: "login bug", per_page: 5 },
      ctx,
    );
    expect(orchestratorGet).toHaveBeenCalledWith(
      "/api/pm/search?workspace_slug=acme&query=login+bug",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ work_items: [1, 2, 3, 4, 5] });
  });

  it("maps a non-OK proxy response to PM_API_ERROR", async () => {
    orchestratorGet.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ error: "Plane unreachable" }),
    });
    const res = await pmSearchWorkItems.handler(
      { workspace_slug: "acme", query: "q" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PM_API_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Write tools (WARP-509) — all four are requiresWrite + requiresConfirmation.
// ---------------------------------------------------------------------------

describe("pm_create_work_item", () => {
  it("is a write tool requiring confirmation", () => {
    expect(pmCreateWorkItem.name).toBe("pm_create_work_item");
    expect(pmCreateWorkItem.requiresWrite).toBe(true);
    expect(pmCreateWorkItem.requiresConfirmation).toBe(true);
  });

  it("forwards the create fields and returns the work_item", async () => {
    const created = { id: "new1" };
    mockClient.createWorkItem.mockResolvedValueOnce(created);
    const res = await pmCreateWorkItem.handler(
      {
        workspace_slug: "acme",
        project_id: "p1",
        name: "New ticket",
        description_html: "<p>hi</p>",
        assignees: ["u1"],
        labels: ["l1"],
      },
      ctx,
    );
    expect(mockClient.createWorkItem).toHaveBeenCalledWith("acme", "p1", {
      name: "New ticket",
      description_html: "<p>hi</p>",
      assignees: ["u1"],
      labels: ["l1"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ work_item: created });
  });

  it("maps any PlaneApiError to PM_API_ERROR (create has no 404 case)", async () => {
    mockClient.createWorkItem.mockRejectedValueOnce(new PlaneApiError("bad", 400));
    const res = await pmCreateWorkItem.handler(
      { workspace_slug: "acme", project_id: "p1", name: "x" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PM_API_ERROR");
  });
});

describe("pm_update_work_item", () => {
  it("is a write tool requiring confirmation", () => {
    expect(pmUpdateWorkItem.requiresWrite).toBe(true);
    expect(pmUpdateWorkItem.requiresConfirmation).toBe(true);
  });

  it("strips the id fields and forwards only the mutable fields", async () => {
    mockClient.updateWorkItem.mockResolvedValueOnce({ id: "i1" });
    await pmUpdateWorkItem.handler(
      {
        workspace_slug: "acme",
        project_id: "p1",
        work_item_id: "i1",
        name: "Renamed",
        labels: ["l2"],
      },
      ctx,
    );
    expect(mockClient.updateWorkItem).toHaveBeenCalledWith("acme", "p1", "i1", {
      name: "Renamed",
      labels: ["l2"],
    });
  });

  it("maps a 404 to PM_WORK_ITEM_NOT_FOUND", async () => {
    mockClient.updateWorkItem.mockRejectedValueOnce(new PlaneApiError("gone", 404));
    const res = await pmUpdateWorkItem.handler(
      { workspace_slug: "acme", project_id: "p1", work_item_id: "nope", name: "x" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PM_WORK_ITEM_NOT_FOUND");
  });
});

describe("pm_add_work_item_comment", () => {
  it("is a write tool requiring confirmation", () => {
    expect(pmAddWorkItemComment.requiresWrite).toBe(true);
    expect(pmAddWorkItemComment.requiresConfirmation).toBe(true);
  });

  it("forwards the comment body and returns the comment", async () => {
    const comment = { id: "c1" };
    mockClient.addWorkItemComment.mockResolvedValueOnce(comment);
    const res = await pmAddWorkItemComment.handler(
      {
        workspace_slug: "acme",
        project_id: "p1",
        work_item_id: "i1",
        comment_html: "<p>note</p>",
      },
      ctx,
    );
    expect(mockClient.addWorkItemComment).toHaveBeenCalledWith(
      "acme",
      "p1",
      "i1",
      "<p>note</p>",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ comment });
  });

  it("maps a 404 to PM_WORK_ITEM_NOT_FOUND", async () => {
    mockClient.addWorkItemComment.mockRejectedValueOnce(new PlaneApiError("gone", 404));
    const res = await pmAddWorkItemComment.handler(
      {
        workspace_slug: "acme",
        project_id: "p1",
        work_item_id: "nope",
        comment_html: "x",
      },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PM_WORK_ITEM_NOT_FOUND");
  });
});

describe("pm_transition_work_item", () => {
  it("is a write tool requiring confirmation", () => {
    expect(pmTransitionWorkItem.requiresWrite).toBe(true);
    expect(pmTransitionWorkItem.requiresConfirmation).toBe(true);
  });

  it("forwards the target state_id", async () => {
    mockClient.transitionWorkItem.mockResolvedValueOnce({ id: "i1" });
    await pmTransitionWorkItem.handler(
      {
        workspace_slug: "acme",
        project_id: "p1",
        work_item_id: "i1",
        state_id: "done",
      },
      ctx,
    );
    expect(mockClient.transitionWorkItem).toHaveBeenCalledWith(
      "acme",
      "p1",
      "i1",
      "done",
    );
  });

  it("maps a 404 to PM_WORK_ITEM_NOT_FOUND", async () => {
    mockClient.transitionWorkItem.mockRejectedValueOnce(new PlaneApiError("gone", 404));
    const res = await pmTransitionWorkItem.handler(
      {
        workspace_slug: "acme",
        project_id: "p1",
        work_item_id: "nope",
        state_id: "done",
      },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PM_WORK_ITEM_NOT_FOUND");
  });

  it("maps a non-404 PlaneApiError to PM_API_ERROR", async () => {
    mockClient.transitionWorkItem.mockRejectedValueOnce(new PlaneApiError("server", 500));
    const res = await pmTransitionWorkItem.handler(
      {
        workspace_slug: "acme",
        project_id: "p1",
        work_item_id: "i1",
        state_id: "done",
      },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PM_API_ERROR");
  });
});
