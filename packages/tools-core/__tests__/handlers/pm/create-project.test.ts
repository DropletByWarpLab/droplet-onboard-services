/**
 * WARP-2058 — `pm_create_project`.
 *
 * Mocks `ctx.http.orchestrator` the same way `pm-handlers.test.ts` does and
 * asserts the endpoint + body, the native → contract shape mapping, the
 * confirmation tier, and that the input guards mirror the route's zod
 * schema so a malformed value never becomes an opaque 400.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "../../../src/types.js";

import pmCreateProject from "../../../src/handlers/pm/create-project.js";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
const ctx = {
  http: { orchestrator: { get, post, patch, delete: del } },
} as unknown as ToolContext;

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

const apiProject = {
  id: "p1",
  name: "Roof Replacement",
  identifier: "ROOF",
  workspaceSlug: "home",
};

beforeEach(() => vi.clearAllMocks());

describe("pm_create_project", () => {
  // A project is a durable, user-visible container. A tool that creates
  // one off the back of an extracted document must not be able to litter
  // the tracker without the owner seeing it first.
  it("is a write tool that requires confirmation, like pm_create_work_item", () => {
    expect(pmCreateProject.name).toBe("pm_create_project");
    expect(pmCreateProject.requiresWrite).toBe(true);
    expect(pmCreateProject.requiresConfirmation).toBe(true);
  });

  it("posts to the native project endpoint and maps the response", async () => {
    post.mockResolvedValueOnce(res(true, 201, { project: apiProject }));
    const r = await pmCreateProject.handler(
      {
        name: "Roof Replacement",
        workspace_slug: "home",
        identifier: "ROOF",
        description: "From the surveyor's report",
      },
      ctx,
    );
    expect(post).toHaveBeenCalledWith(
      "/api/pm/projects",
      {
        workspace_slug: "home",
        name: "Roof Replacement",
        identifier: "ROOF",
        description: "From the surveyor's report",
      },
      expect.anything(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        project: {
          id: "p1",
          name: "Roof Replacement",
          identifier: "ROOF",
          workspace: "home",
        },
      });
    }
  });

  it("works with only a name — workspace and identifier are server-derived", async () => {
    post.mockResolvedValueOnce(res(true, 201, { project: apiProject }));
    const r = await pmCreateProject.handler({ name: "Roof Replacement" }, ctx);
    expect(r.ok).toBe(true);
    expect(post).toHaveBeenCalledWith(
      "/api/pm/projects",
      expect.objectContaining({
        name: "Roof Replacement",
        workspace_slug: undefined,
        identifier: undefined,
      }),
      expect.anything(),
    );
  });

  it("trims the name before sending it", async () => {
    post.mockResolvedValueOnce(res(true, 201, { project: apiProject }));
    await pmCreateProject.handler({ name: "  Roof Replacement  " }, ctx);
    expect(post).toHaveBeenCalledWith(
      "/api/pm/projects",
      expect.objectContaining({ name: "Roof Replacement" }),
      expect.anything(),
    );
  });

  it("rejects malformed input locally, before any orchestrator call", async () => {
    for (const args of [
      {},
      { name: "" },
      { name: "   " },
      { name: "x".repeat(201) },
      { name: "ok", identifier: "TOO-LONG-AND-HYPHENATED" },
      { name: "ok", identifier: "has space" },
      { name: "ok", identifier: "" },
      { name: "ok", description: "d".repeat(10001) },
    ]) {
      const r = await pmCreateProject.handler(args, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("accepts an identifier at the schema boundary (10 alphanumerics)", async () => {
    post.mockResolvedValueOnce(res(true, 201, { project: apiProject }));
    const r = await pmCreateProject.handler(
      { name: "ok", identifier: "ABCDE12345" },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it("maps an orchestrator failure to PM_API_ERROR", async () => {
    post.mockResolvedValueOnce(res(false, 409, { error: "duplicate_identifier" }));
    const r = await pmCreateProject.handler({ name: "Roof" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PM_API_ERROR");
  });
});
