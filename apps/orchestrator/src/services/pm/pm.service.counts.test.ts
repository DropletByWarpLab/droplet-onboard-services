import { describe, it, expect } from "vitest";
import { getSummary, listProjects } from "./pm.service.js";

/**
 * KPI / count correctness (PR #684 findings 5 & 6).
 *  - Finding 5: items with a null state must still count as open (not silently
 *    dropped) in both the per-project openCount AND the workspace itemsOpen KPI.
 *  - Finding 6: doneThisWeek must include items resolved to the `cancelled`
 *    group this week, not only `completed`.
 */

const now = new Date("2026-10-04T12:00:00.000Z");
const weekAgo = new Date("2026-09-27T12:00:00.000Z");

describe("getSummary count correctness", () => {
  // The numbers themselves are proved against Postgres in
  // __tests__/pm-insights.pg.test.ts (stateless item, cancelled-this-week,
  // unassigned, archived project). What a mock can pin is the QUESTION each
  // count asks, so the rules findings 5 and 6 established cannot drift.
  it("asks the database four questions and maps each answer to its field", async () => {
    const wheres: Array<Record<string, unknown>> = [];
    const answers = [11, 2, 5, 3]; // itemsOpen, overdue, doneThisWeek, unassigned — in call order
    const prisma = {
      pmProject: { findMany: async () => [{ id: "p1" }, { id: "p2" }] },
      pmWorkItem: {
        count: async ({ where }: { where: Record<string, unknown> }) => {
          wheres.push(where);
          return answers[wheres.length - 1];
        },
      },
    } as never;

    const summary = await getSummary(prisma, "home", "2026-10-04", now);

    expect(summary).toEqual({ activeProjects: 2, itemsOpen: 11, overdue: 2, doneThisWeek: 5, unassigned: 3 });
    expect(wheres).toHaveLength(4);
    const [itemsOpen, overdue, doneThisWeek, unassigned] = wheres;
    for (const where of wheres) {
      expect(where).toMatchObject({ projectId: { in: ["p1", "p2"] }, isArchived: false });
    }
    // Open = a started-ish group OR no state at all (finding 5: stateless counts as open).
    const open = { OR: [{ stateId: null }, { state: { group: { in: ["backlog", "unstarted", "started"] } } }] };
    expect(itemsOpen).toMatchObject(open);
    expect(overdue).toMatchObject({ ...open, dueDate: { lt: new Date("2026-10-04T00:00:00.000Z") } });
    expect(unassigned).toMatchObject({ ...open, assignees: { none: {} } });
    // Done = isCompleted, whatever the group: cancelled counts (finding 6). No open filter here.
    expect(doneThisWeek).toMatchObject({ isCompleted: true, completedAt: { gte: weekAgo } });
    expect(doneThisWeek).not.toHaveProperty("OR");
  });

  it("is all zeros, and asks no count, for a workspace with no live project", async () => {
    const count = async () => {
      throw new Error("must not be called");
    };
    const prisma = {
      pmProject: { findMany: async () => [] },
      pmWorkItem: { count },
    } as never;
    expect(await getSummary(prisma, "home", "2026-10-04", now)).toEqual({
      activeProjects: 0,
      itemsOpen: 0,
      doneThisWeek: 0,
      overdue: 0,
      unassigned: 0,
    });
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
