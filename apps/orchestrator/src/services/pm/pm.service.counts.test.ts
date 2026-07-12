import { describe, it, expect } from "vitest";
import { getSummary, listProjects } from "./pm.service.js";

/**
 * KPI / count correctness (PR #684 findings 5 & 6).
 *  - Finding 5: items with a null state must still count as open (not silently
 *    dropped) in both the per-project openCount AND the workspace itemsOpen KPI.
 *  - Finding 6: doneThisWeek must include items resolved to the `cancelled`
 *    group this week, not only `completed`.
 */

const now = new Date();
const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

describe("getSummary count correctness", () => {
  it("counts stateless items as open and includes cancelled-this-week in doneThisWeek", async () => {
    const items = [
      { dueDate: null, completedAt: null, isCompleted: false, state: { group: "started" } }, // open
      { dueDate: null, completedAt: null, isCompleted: false, state: null }, // stateless → open (finding 5)
      { dueDate: null, completedAt: null, isCompleted: false, state: null }, // stateless → open (finding 5)
      { dueDate: null, completedAt: threeDaysAgo, isCompleted: true, state: { group: "completed" } }, // done this week
      { dueDate: null, completedAt: threeDaysAgo, isCompleted: true, state: { group: "cancelled" } }, // done this week (finding 6)
      { dueDate: null, completedAt: tenDaysAgo, isCompleted: true, state: { group: "cancelled" } }, // too old → not counted
    ];
    const prisma = {
      pmProject: { findMany: async () => [{ id: "p1" }] },
      pmWorkItem: { findMany: async () => items },
    } as never;

    const summary = await getSummary(prisma);
    expect(summary.itemsOpen).toBe(3); // 1 started + 2 stateless
    expect(summary.doneThisWeek).toBe(2); // 1 completed + 1 cancelled this week
  });
});

describe("listProjects count correctness", () => {
  it("buckets stateless items into openCount rather than dropping them", async () => {
    const projectRow = {
      id: "p1",
      workspaceId: "w1",
      workspace: { slug: "home" },
      name: "P",
      identifier: "PRJ",
      description: null,
      icon: null,
      color: null,
      leadId: null,
      isArchived: false,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const items = [
      { projectId: "p1", state: { group: "started" } },
      { projectId: "p1", state: null }, // stateless → counted as open (finding 5)
      { projectId: "p1", state: { group: "completed" } },
    ];
    const prisma = {
      pmProject: { findMany: async () => [projectRow] },
      pmWorkItem: { findMany: async () => items },
    } as never;

    const result = await listProjects(prisma, { workspaceSlug: "home" });
    const p = result.find((r) => r.id === "p1");
    expect(p).toBeDefined();
    // 1 started + 1 stateless (bucketed unstarted) = 2 open; 1 completed = done.
    expect(p!.openCount).toBe(2);
    expect(p!.doneCount).toBe(1);
  });
});
