/**
 * WARP-3522 — saved-view permissions, as pure functions. The flows that touch
 * the database (caps, uniqueness, cascades, who sees whose view) are in
 * `__tests__/pm-saved-view.pg.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { PM_BUILTIN_VIEWS } from "@droplet/shared-types";
import { builtinViews, canEditView, canManageSharedViews } from "./pm-views.service.js";

const actor = (userId: string, role: string) => ({ userId, role });

describe("canManageSharedViews", () => {
  it("owner and admin always may", () => {
    expect(canManageSharedViews(actor("u1", "owner"), null)).toBe(true);
    expect(canManageSharedViews(actor("u1", "admin"), "someone-else")).toBe(true);
  });

  it("the project's lead may, in their own project", () => {
    expect(canManageSharedViews(actor("lead", "family"), "lead")).toBe(true);
  });

  it("another family member may not", () => {
    expect(canManageSharedViews(actor("u2", "family"), "lead")).toBe(false);
  });

  it("nobody is the lead of a cross-project place or of a project with no lead", () => {
    expect(canManageSharedViews(actor("u2", "family"), null)).toBe(false);
    expect(canManageSharedViews(actor("lead", "family"), null)).toBe(false);
  });

  it("a guest or the service principal never may", () => {
    expect(canManageSharedViews(actor("g", "guest"), null)).toBe(false);
    expect(canManageSharedViews(actor("_service:mcp", "service"), null)).toBe(false);
  });
});

describe("canEditView", () => {
  it("a PERSONAL view is its owner's alone — an admin may not edit it", () => {
    const v = { scope: "PERSONAL" as const, ownerId: "u1" };
    expect(canEditView(actor("u1", "family"), v, null)).toBe(true);
    expect(canEditView(actor("u2", "admin"), v, null)).toBe(false);
    expect(canEditView(actor("u2", "owner"), v, "u2")).toBe(false);
  });

  it("a SHARED view follows canManageSharedViews, whoever created it", () => {
    const v = { scope: "SHARED" as const, ownerId: "creator" };
    expect(canEditView(actor("admin", "admin"), v, null)).toBe(true);
    expect(canEditView(actor("lead", "family"), v, "lead")).toBe(true);
    // Having created a shared view does not keep the right to change it once
    // you are no longer a lead or an admin.
    expect(canEditView(actor("creator", "family"), v, "lead")).toBe(false);
  });
});

describe("builtinViews", () => {
  it("serves the five built-ins as read-only views that belong to no project and no owner", () => {
    const views = builtinViews();
    expect(views.map((v) => v.id)).toEqual(PM_BUILTIN_VIEWS.map((v) => v.id));
    for (const v of views) {
      expect(v).toMatchObject({
        scope: "BUILTIN",
        projectId: null,
        ownerId: null,
        layout: null,
        canEdit: false,
        createdAt: null,
        updatedAt: null,
      });
    }
    expect(views.map((v) => v.sortOrder)).toEqual([0, 1, 2, 3, 4]);
  });
});
