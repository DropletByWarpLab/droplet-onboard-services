/**
 * Behavioural unit tests for the nine `pm_*` handlers (ADR-026).
 *
 * The handlers now reach the orchestrator's NATIVE PM surface via
 * `ctx.http.orchestrator` (no Plane, no token mint). These tests mock that
 * client and assert (a) the right native endpoint + body, (b) the native →
 * contract shape mapping, (c) the error-code mapping (404 →
 * PM_WORK_ITEM_NOT_FOUND, else PM_API_ERROR), and (d) that a non-OrchPmError
 * throwable bubbles to the agent loop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "../../../src/types.js";

import pmListWorkspaces from "../../../src/handlers/pm/list-workspaces.js";
import pmListProjects from "../../../src/handlers/pm/list-projects.js";
import pmListWorkItems from "../../../src/handlers/pm/list-work-items.js";
import pmGetWorkItem from "../../../src/handlers/pm/get-work-item.js";
import pmSearchWorkItems from "../../../src/handlers/pm/search-work-items.js";
import pmCreateWorkItem from "../../../src/handlers/pm/create-work-item.js";
import pmUpdateWorkItem from "../../../src/handlers/pm/update-work-item.js";
import pmAddWorkItemComment from "../../../src/handlers/pm/add-work-item-comment.js";
import pmTransitionWorkItem from "../../../src/handlers/pm/transition-work-item.js";
import { runConfirmed } from "../../helpers/approve.js";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
const ctx = {
  http: { orchestrator: { get, post, patch, delete: del } },
} as unknown as ToolContext;

/** Fake fetch Response with a JSON body. */
function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

/** A native ApiWorkItem fixture (rich camelCase). */
function apiItem(over: Record<string, unknown> = {}) {
  return {
    id: "i1",
    name: "Bug",
    descriptionHtml: "<p>x</p>",
    stateId: "st1",
    state: { name: "In Progress" },
    assignees: ["u1"],
    labels: [{ name: "bug" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("pm_list_workspaces", () => {
  it("is read-only", () => {
    expect(pmListWorkspaces.name).toBe("pm_list_workspaces");
    expect(pmListWorkspaces.requiresWrite).toBe(false);
    expect(pmListWorkspaces.requiresConfirmation).toBe(false);
  });

  it("returns the native workspace list", async () => {
    const workspaces = [{ id: "w1", slug: "home", name: "Home" }];
    get.mockResolvedValueOnce(res(true, 200, { workspaces }));
    const r = await pmListWorkspaces.handler({}, ctx);
    expect(get).toHaveBeenCalledWith("/api/pm/workspaces", expect.anything());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ workspaces });
  });

  it("maps a non-OK response to PM_API_ERROR", async () => {
    get.mockResolvedValueOnce(res(false, 503, { error: "not ready" }));
    const r = await pmListWorkspaces.handler({}, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("PM_API_ERROR");
      expect(r.error.message).toBe("not ready");
    }
  });
});

describe("pm_list_projects", () => {
  it("queries by workspace and maps to the contract shape", async () => {
    get.mockResolvedValueOnce(
      res(true, 200, {
        projects: [{ id: "p1", name: "Inbox", identifier: "INBOX", workspaceSlug: "home" }],
      }),
    );
    const r = await pmListProjects.handler({ workspace_slug: "home" }, ctx);
    expect(get).toHaveBeenCalledWith("/api/pm/projects?workspace=home", expect.anything());
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.data).toEqual({
        projects: [{ id: "p1", name: "Inbox", identifier: "INBOX", workspace: "home" }],
      });
  });

  it("maps an error to PM_API_ERROR", async () => {
    get.mockResolvedValueOnce(res(false, 500, { error: "boom" }));
    const r = await pmListProjects.handler({ workspace_slug: "home" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PM_API_ERROR");
  });
});

describe("pm_list_work_items", () => {
  it("forwards filters and maps work items", async () => {
    get.mockResolvedValueOnce(res(true, 200, { work_items: [apiItem()] }));
    const r = await pmListWorkItems.handler(
      { workspace_slug: "home", project_id: "p1", state: "st1", assignee: "u1", per_page: 10 },
      ctx,
    );
    expect(get).toHaveBeenCalledWith(
      "/api/pm/projects/p1/work-items?state=st1&assignee=u1&per_page=10",
      expect.anything(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const items = (r.data as { work_items: unknown[] }).work_items as Array<Record<string, unknown>>;
      expect(items[0]).toMatchObject({
        id: "i1",
        name: "Bug",
        description_html: "<p>x</p>",
        state: "In Progress",
        assignees: ["u1"],
        labels: ["bug"],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      });
    }
  });
});

describe("pm_get_work_item", () => {
  it("maps the work item", async () => {
    get.mockResolvedValueOnce(res(true, 200, { work_item: apiItem() }));
    const r = await pmGetWorkItem.handler(
      { workspace_slug: "home", project_id: "p1", work_item_id: "i1" },
      ctx,
    );
    expect(get).toHaveBeenCalledWith("/api/pm/work-items/i1", expect.anything());
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { work_item: { state: string } }).work_item.state).toBe("In Progress");
  });

  it("maps a 404 to PM_WORK_ITEM_NOT_FOUND", async () => {
    get.mockResolvedValueOnce(res(false, 404, { error: "work_item_not_found" }));
    const r = await pmGetWorkItem.handler(
      { workspace_slug: "home", project_id: "p1", work_item_id: "nope" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PM_WORK_ITEM_NOT_FOUND");
  });

  it("maps a non-404 to PM_API_ERROR", async () => {
    get.mockResolvedValueOnce(res(false, 500, { error: "server" }));
    const r = await pmGetWorkItem.handler(
      { workspace_slug: "home", project_id: "p1", work_item_id: "i1" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PM_API_ERROR");
  });

  it("rethrows a non-OrchPmError (e.g. a network throw)", async () => {
    get.mockRejectedValueOnce(new TypeError("boom"));
    await expect(
      pmGetWorkItem.handler({ workspace_slug: "home", project_id: "p1", work_item_id: "i1" }, ctx),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("pm_search_work_items", () => {
  it("searches by workspace + query and caps with per_page", async () => {
    get.mockResolvedValueOnce(
      res(true, 200, { work_items: [apiItem({ id: "a" }), apiItem({ id: "b" }), apiItem({ id: "c" })] }),
    );
    const r = await pmSearchWorkItems.handler(
      { workspace_slug: "home", query: "login bug", per_page: 2 },
      ctx,
    );
    expect(get).toHaveBeenCalledWith(
      "/api/pm/work-items?workspace=home&q=login+bug&per_page=2",
      expect.anything(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { work_items: unknown[] }).work_items).toHaveLength(2);
  });
});

describe("pm_create_work_item", () => {
  it("is a write tool requiring confirmation", () => {
    expect(pmCreateWorkItem.requiresWrite).toBe(true);
    expect(pmCreateWorkItem.requiresConfirmation).toBe(true);
  });

  it("posts to the project work-items route, mapping labels → label_ids", async () => {
    post.mockResolvedValueOnce(res(true, 201, { work_item: apiItem({ id: "new1" }) }));
    const r = await runConfirmed(pmCreateWorkItem, 
      {
        workspace_slug: "home",
        project_id: "p1",
        name: "New ticket",
        description_html: "<p>hi</p>",
        assignees: ["u1"],
        labels: ["l1"],
      },
      ctx,
    );
    expect(post).toHaveBeenCalledWith(
      "/api/pm/projects/p1/work-items",
      { name: "New ticket", description_html: "<p>hi</p>", assignees: ["u1"], label_ids: ["l1"] },
      expect.anything(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { work_item: { id: string } }).work_item.id).toBe("new1");
  });
});

describe("pm_update_work_item", () => {
  it("patches the work item and maps a 404", async () => {
    patch.mockResolvedValueOnce(res(false, 404, { error: "work_item_not_found" }));
    const r = await runConfirmed(pmUpdateWorkItem, 
      { workspace_slug: "home", project_id: "p1", work_item_id: "nope", name: "x", labels: ["l2"] },
      ctx,
    );
    expect(patch).toHaveBeenCalledWith(
      "/api/pm/work-items/nope",
      { name: "x", description_html: undefined, assignees: undefined, label_ids: ["l2"] },
      expect.anything(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PM_WORK_ITEM_NOT_FOUND");
  });
});

describe("pm_add_work_item_comment", () => {
  it("posts the comment body", async () => {
    post.mockResolvedValueOnce(res(true, 201, { comment: { id: "c1" } }));
    const r = await runConfirmed(pmAddWorkItemComment, 
      { workspace_slug: "home", project_id: "p1", work_item_id: "i1", comment_html: "<p>note</p>" },
      ctx,
    );
    expect(post).toHaveBeenCalledWith(
      "/api/pm/work-items/i1/comments",
      { comment_html: "<p>note</p>" },
      expect.anything(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { comment: { id: string } }).comment.id).toBe("c1");
  });
});

describe("pm_transition_work_item", () => {
  it("is a write tool requiring confirmation", () => {
    expect(pmTransitionWorkItem.requiresWrite).toBe(true);
    expect(pmTransitionWorkItem.requiresConfirmation).toBe(true);
  });

  it("posts the target state_id and maps a 404", async () => {
    post.mockResolvedValueOnce(res(false, 404, { error: "work_item_not_found" }));
    const r = await runConfirmed(pmTransitionWorkItem, 
      { workspace_slug: "home", project_id: "p1", work_item_id: "nope", state_id: "done" },
      ctx,
    );
    expect(post).toHaveBeenCalledWith(
      "/api/pm/work-items/nope/transition",
      { state_id: "done" },
      expect.anything(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PM_WORK_ITEM_NOT_FOUND");
  });
});
