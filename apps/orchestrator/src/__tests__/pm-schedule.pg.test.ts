/**
 * WARP-3523 (ADR-069 WS-7) — what only a real database can prove about the
 * Timeline window and the My Work lists.
 *
 * pm-schedule.service.test.ts pins the SHAPE of every query against a recording
 * stub. It cannot tell whether Postgres returns the right rows for those
 * predicates: the overlap rule for a span / a single date / inverted data, the
 * half-open window that keeps a late time-of-day on the last day inside it, NULL
 * semantics of `lt`/`gte` on an unscheduled item, the open-state rule for an item
 * with no state at all, the enum ordering `priority asc` relies on, and the
 * project-grouped paging order. This does.
 *
 * Gated like the other *.pg.test.ts files; fixtures are namespaced `warp3523-`
 * because the pg lane shares one throwaway database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const OURS = { startsWith: "warp3523-" } as const;
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

describe.skipIf(!RUN)("PM schedule reads against Postgres (WARP-3523)", () => {
  let prisma: PrismaClient;
  let svc: typeof import("../services/pm/pm-schedule.service.js");

  let projectA = "";
  let projectB = "";
  let projectArchived = "";
  let todo = "";
  let started = "";
  let done = "";
  let cancelled = "";
  let seq = 0;
  /** name -> id, for readable assertions */
  const id: Record<string, string> = {};

  async function mk(
    projectId: string,
    name: string,
    data: Record<string, unknown> = {},
    assignees: string[] = [],
  ) {
    const row = await prisma.pmWorkItem.create({
      data: { projectId, sequenceId: ++seq, name: `warp3523-${name}`, stateId: todo, ...data } as never,
    });
    id[name] = row.id;
    for (const userId of assignees) {
      await prisma.pmWorkItemAssignee.create({ data: { workItemId: row.id, userId } });
    }
    return row;
  }

  const namesOf = (items: Array<{ id: string }>) => {
    const byId = new Map(Object.entries(id).map(([n, i]) => [i, n]));
    return items.map((i) => byId.get(i.id) ?? `?${i.id}`);
  };

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    svc = await import("../services/pm/pm-schedule.service.js");

    // Leftovers from an aborted run.
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });

    const ws = await prisma.pmWorkspace.create({ data: { slug: "warp3523-ws", name: "warp3523-ws" } });
    const a = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3523-alpha", identifier: "W23A", sortOrder: 0 },
    });
    const b = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3523-bravo", identifier: "W23B", sortOrder: 1 },
    });
    const z = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3523-zulu-archived", identifier: "W23Z", sortOrder: 2, isArchived: true },
    });
    projectA = a.id;
    projectB = b.id;
    projectArchived = z.id;

    const st = (name: string, group: "backlog" | "unstarted" | "started" | "completed" | "cancelled") =>
      prisma.pmState.create({ data: { projectId: projectA, name: `warp3523-${name}`, group } });
    todo = (await st("todo", "unstarted")).id;
    started = (await st("started", "started")).id;
    done = (await st("done", "completed")).id;
    cancelled = (await st("cancelled", "cancelled")).id;
  });

  afterAll(async () => {
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.$disconnect();
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe("getProjectTimeline", () => {
    const range = { from: "2026-10-01", to: "2026-10-31" };

    beforeAll(async () => {
      // ── both dates: overlap with [Oct 1, Oct 31] ───────────────────────────
      await mk(projectA, "span-in", { startDate: day("2026-10-05"), dueDate: day("2026-10-10") });
      await mk(projectA, "span-overlaps-start", { startDate: day("2026-09-25"), dueDate: day("2026-10-02") });
      await mk(projectA, "span-overlaps-end", { startDate: day("2026-10-30"), dueDate: day("2026-11-05") });
      await mk(projectA, "span-around", { startDate: day("2026-09-01"), dueDate: day("2026-12-01") });
      await mk(projectA, "span-ends-on-from", { startDate: day("2026-09-20"), dueDate: day("2026-10-01") });
      await mk(projectA, "span-starts-on-to", { startDate: day("2026-10-31"), dueDate: day("2026-11-04") });
      await mk(projectA, "span-before", { startDate: day("2026-09-01"), dueDate: day("2026-09-30") });
      await mk(projectA, "span-after", { startDate: day("2026-11-01"), dueDate: day("2026-11-10") });
      // ── exactly one date ───────────────────────────────────────────────────
      await mk(projectA, "due-in", { dueDate: day("2026-10-15") });
      await mk(projectA, "due-on-from", { dueDate: day("2026-10-01") });
      await mk(projectA, "due-on-to", { dueDate: day("2026-10-31") });
      await mk(projectA, "due-late-on-to", { dueDate: new Date("2026-10-31T23:59:59.000Z") });
      await mk(projectA, "due-next-midnight", { dueDate: day("2026-11-01") });
      await mk(projectA, "due-just-before", { dueDate: new Date("2026-09-30T23:59:59.000Z") });
      await mk(projectA, "start-in", { startDate: day("2026-10-20") });
      await mk(projectA, "start-out", { startDate: day("2026-11-20") });
      // ── inverted (start after due): the span between the two ───────────────
      await mk(projectA, "inverted-in", { startDate: day("2026-10-20"), dueDate: day("2026-10-10") });
      await mk(projectA, "inverted-straddles", { startDate: day("2026-11-10"), dueDate: day("2026-09-10") });
      await mk(projectA, "inverted-out", { startDate: day("2026-11-20"), dueDate: day("2026-11-10") });
      // ── never drawn ────────────────────────────────────────────────────────
      await mk(projectA, "undated-1");
      await mk(projectA, "undated-2", { stateId: done });
      await mk(projectA, "undated-archived", { isArchived: true });
      await mk(projectA, "archived-in", { dueDate: day("2026-10-15"), isArchived: true });
      await mk(projectB, "other-project-in", { dueDate: day("2026-10-15"), stateId: null });
      // Finished work is still on the timeline.
      await mk(projectA, "done-in", { dueDate: day("2026-10-12"), stateId: done });

      // ── relations ──────────────────────────────────────────────────────────
      const edge = (from: string, to: string, kind: "BLOCKS" | "RELATES") => {
        // RELATES is stored once, smaller id first (a CHECK enforces it).
        const [f, t] = kind === "RELATES" && id[from] > id[to] ? [to, from] : [from, to];
        return prisma.pmWorkItemRelation.create({ data: { fromId: id[f], toId: id[t], kind } });
      };
      await edge("span-in", "due-in", "BLOCKS"); // both in the window -> returned
      await edge("due-in", "done-in", "BLOCKS"); // both in the window -> returned
      await edge("span-in", "span-before", "BLOCKS"); // one end outside -> not returned
      await edge("span-in", "other-project-in", "BLOCKS"); // other project -> not returned
      await edge("span-in", "start-in", "RELATES"); // not a BLOCKS edge -> not returned

      // ── modules (milestones) ───────────────────────────────────────────────
      const mod = (projectId: string, name: string, targetDate: Date | null, status = "planned") =>
        prisma.pmModule.create({ data: { projectId, name: `warp3523-${name}`, targetDate, status: status as never } });
      await mod(projectA, "ms-on-from", day("2026-10-01"));
      await mod(projectA, "ms-mid", day("2026-10-15"), "in_progress");
      await mod(projectA, "ms-on-to", day("2026-10-31"), "completed");
      await mod(projectA, "ms-before", day("2026-09-30"));
      await mod(projectA, "ms-after", day("2026-11-01"));
      await mod(projectA, "ms-no-date", null);
      await mod(projectB, "ms-other-project", day("2026-10-15"));
    });

    it("returns exactly the items whose schedule overlaps the window", async () => {
      const res = await svc.getProjectTimeline(prisma, projectA, range);
      expect(namesOf(res.items).sort()).toEqual(
        [
          "span-in",
          "span-overlaps-start",
          "span-overlaps-end",
          "span-around",
          "span-ends-on-from",
          "span-starts-on-to",
          "due-in",
          "due-on-from",
          "due-on-to",
          "due-late-on-to",
          "start-in",
          "inverted-in",
          "inverted-straddles",
          "done-in",
        ].sort(),
      );
      expect(res.truncated).toBe(false);
    });

    it("never returns undated, archived or other-project items, and counts the undated ones it hides", async () => {
      const res = await svc.getProjectTimeline(prisma, projectA, range);
      const names = namesOf(res.items);
      for (const hidden of ["undated-1", "undated-2", "undated-archived", "archived-in", "other-project-in"]) {
        expect(names).not.toContain(hidden);
      }
      // undated-1 and undated-2 are live and dateless; undated-archived is archived.
      expect(res.unscheduledCount).toBe(2);
    });

    it("keeps the window half-open on the far side: late on the last day is in, the next midnight is out", async () => {
      const names = namesOf((await svc.getProjectTimeline(prisma, projectA, range)).items);
      expect(names).toContain("due-late-on-to");
      expect(names).not.toContain("due-next-midnight");
      expect(names).not.toContain("due-just-before");
    });

    it("a one-day window returns what sits on that day, whichever way it is scheduled", async () => {
      const res = await svc.getProjectTimeline(prisma, projectA, { from: "2026-10-15", to: "2026-10-15" });
      // Oct 15 sits inside a long span, on a due date, and between the two ends of
      // each inverted pair that straddles it.
      expect(namesOf(res.items).sort()).toEqual(["due-in", "inverted-in", "inverted-straddles", "span-around"]);
    });

    it("a window with nothing in it is empty, with no relations and no truncation", async () => {
      const res = await svc.getProjectTimeline(prisma, projectA, { from: "2030-01-01", to: "2030-01-31" });
      expect(res).toMatchObject({ items: [], relations: [], milestones: [], truncated: false });
    });

    it("returns BLOCKS edges only when both ends are in the returned items", async () => {
      const res = await svc.getProjectTimeline(prisma, projectA, range);
      const shape = res.relations.map((r) => [namesOf([{ id: r.fromId }])[0], namesOf([{ id: r.toId }])[0], r.kind]);
      expect(shape.sort()).toEqual(
        [
          ["span-in", "due-in", "BLOCKS"],
          ["due-in", "done-in", "BLOCKS"],
        ].sort(),
      );
      expect(res.relations.every((r) => typeof r.id === "string" && r.id.length > 0)).toBe(true);
    });

    it("returns this project's milestones inside the window, boundary days included, in date order", async () => {
      const res = await svc.getProjectTimeline(prisma, projectA, range);
      expect(res.milestones.map((m) => [m.name, m.targetDate, m.status])).toEqual([
        ["warp3523-ms-on-from", "2026-10-01", "planned"],
        ["warp3523-ms-mid", "2026-10-15", "in_progress"],
        ["warp3523-ms-on-to", "2026-10-31", "completed"],
      ]);
    });

    it("emits the board's ApiWorkItem (key, state, assignees, ISO dates)", async () => {
      const res = await svc.getProjectTimeline(prisma, projectA, range);
      const span = res.items.find((i) => i.id === id["span-in"])!;
      expect(span).toMatchObject({
        projectId: projectA,
        startDate: "2026-10-05T00:00:00.000Z",
        dueDate: "2026-10-10T00:00:00.000Z",
        priority: "none",
        assignees: [],
        labels: [],
        state: { group: "unstarted" },
      });
      expect(span.key).toMatch(/^W23A-\d+$/);
    });

    it("truncates to the item cap and says so", async () => {
      const res = await svc.getProjectTimeline(prisma, projectA, range, { itemLimit: 3 });
      expect(res.items).toHaveLength(3);
      expect(res.truncated).toBe(true);
    });

    it("truncates relations to their cap and says so", async () => {
      const res = await svc.getProjectTimeline(prisma, projectA, range, { relationLimit: 1 });
      expect(res.relations).toHaveLength(1);
      expect(res.truncated).toBe(true);
    });

    it("404s an unknown project", async () => {
      await expect(svc.getProjectTimeline(prisma, "00000000-0000-0000-0000-000000000000", range)).rejects.toThrow(
        "project_not_found",
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  describe("getMyWork", () => {
    const ME = "warp3523-me";
    const OTHER = "warp3523-other";
    const today = "2026-10-03";

    beforeAll(async () => {
      // Project A, assigned to me.
      await mk(projectA, "m-nodue", {}, [ME]);
      await mk(projectA, "m-overdue", { dueDate: day("2026-10-02"), priority: "low" }, [ME]);
      await mk(projectA, "m-overdue-urgent", { dueDate: day("2026-10-02"), priority: "urgent" }, [ME]);
      await mk(projectA, "m-overdue-older", { dueDate: day("2026-09-20"), priority: "none" }, [ME]);
      await mk(projectA, "m-due-today", { dueDate: day("2026-10-03"), stateId: started }, [ME]);
      await mk(projectA, "m-due-plus6", { dueDate: day("2026-10-09") }, [ME]);
      await mk(projectA, "m-due-plus7", { dueDate: day("2026-10-10") }, [ME]);
      await mk(projectA, "m-stateless-overdue", { dueDate: day("2026-10-02"), stateId: null, priority: "high" }, [ME]);
      await mk(projectA, "m-high-nodue", { priority: "high" }, [ME]);
      await mk(projectA, "m-urgent-nodue", { priority: "urgent" }, [ME]);
      // Not open, or not live: never listed.
      await mk(projectA, "m-done-overdue", { dueDate: day("2026-10-01"), stateId: done }, [ME]);
      await mk(projectA, "m-cancelled-overdue", { dueDate: day("2026-10-01"), stateId: cancelled }, [ME]);
      await mk(projectA, "m-archived-item", { dueDate: day("2026-10-02"), isArchived: true }, [ME]);
      // Someone else's, and one both of us are on.
      await mk(projectA, "o-assigned", { dueDate: day("2026-10-02") }, [OTHER]);
      await mk(projectA, "shared-overdue", { dueDate: day("2026-10-02") }, [ME, OTHER]);
      // Created by me.
      await mk(projectA, "c-created", { createdById: ME });
      await mk(projectA, "c-created-and-mine", { createdById: ME, dueDate: day("2026-10-04") }, [ME]);
      await mk(projectA, "c-created-done", { createdById: ME, stateId: done });
      await mk(projectA, "c-created-by-other", { createdById: OTHER });
      // Second project, then an archived project.
      await mk(projectB, "b-overdue", { dueDate: day("2026-10-02"), stateId: null }, [ME]);
      await mk(projectB, "b-nodue", { stateId: null }, [ME]);
      await mk(projectArchived, "z-overdue", { dueDate: day("2026-10-02"), stateId: null }, [ME]);
    });

    const list = (section: "assigned" | "created" | "overdue" | "due_this_week", extra = {}, user = ME) =>
      svc.getMyWork(prisma, user, { section, today, ...extra });

    it("assigned: open, live items of live projects the caller is on", async () => {
      const res = await list("assigned");
      expect(namesOf(res.items).sort()).toEqual(
        [
          "m-nodue", "m-overdue", "m-overdue-urgent", "m-overdue-older", "m-due-today", "m-due-plus6",
          "m-due-plus7", "m-stateless-overdue", "m-high-nodue", "m-urgent-nodue", "shared-overdue",
          "c-created-and-mine", "b-overdue", "b-nodue",
        ].sort(),
      );
      expect(res.total).toBe(res.counts.assigned);
    });

    it("overdue: assigned and due strictly before today; due today is not overdue; finished work is not", async () => {
      const res = await list("overdue");
      expect(namesOf(res.items).sort()).toEqual(
        [
          "m-overdue", "m-overdue-urgent", "m-overdue-older", "m-stateless-overdue", "shared-overdue", "b-overdue",
        ].sort(),
      );
      expect(namesOf(res.items)).not.toContain("m-due-today");
      expect(namesOf(res.items)).not.toContain("m-done-overdue");
      expect(namesOf(res.items)).not.toContain("m-cancelled-overdue");
    });

    it("due_this_week: today through today + 6; today + 7 and later are out; overdue is out", async () => {
      const res = await list("due_this_week");
      expect(namesOf(res.items).sort()).toEqual(["m-due-today", "m-due-plus6", "c-created-and-mine"].sort());
    });

    it("the window moves with the viewer's today", async () => {
      const res = await list("due_this_week", { today: "2026-10-04" });
      expect(namesOf(res.items).sort()).toEqual(["c-created-and-mine", "m-due-plus6", "m-due-plus7"].sort());
      const overdue = await list("overdue", { today: "2026-10-04" });
      expect(namesOf(overdue.items)).toContain("m-due-today");
    });

    it("created: open items the caller authored, whether or not they are on them", async () => {
      const res = await list("created");
      expect(namesOf(res.items).sort()).toEqual(["c-created", "c-created-and-mine"].sort());
    });

    it("counts carry all four sections and agree with the lists", async () => {
      const res = await list("assigned");
      const [overdue, week, created] = await Promise.all([list("overdue"), list("due_this_week"), list("created")]);
      expect(res.counts).toEqual({
        assigned: res.total,
        created: created.total,
        overdue: overdue.total,
        dueThisWeek: week.total,
      });
      expect(res.counts.overdue).toBe(6);
      expect(res.counts.dueThisWeek).toBe(3);
      expect(res.counts.created).toBe(2);
    });

    it("never leaks another user's work, and a user with none gets empty lists", async () => {
      const mine = new Set(namesOf((await list("assigned")).items));
      expect(mine.has("o-assigned")).toBe(false);
      expect(mine.has("c-created-by-other")).toBe(false);
      const nobody = await list("assigned", {}, "warp3523-nobody");
      expect(nobody).toMatchObject({ items: [], projects: [], total: 0, nextOffset: null });
      expect(nobody.counts).toEqual({ assigned: 0, created: 0, overdue: 0, dueThisWeek: 0 });
    });

    it("groups by project in board order and lists each project once", async () => {
      const res = await list("assigned");
      const projectsSeen = res.items.map((i) => i.projectId);
      // Alpha's items, then Bravo's — contiguous.
      const firstB = projectsSeen.indexOf(projectB);
      expect(firstB).toBeGreaterThan(0);
      expect(projectsSeen.slice(0, firstB).every((p) => p === projectA)).toBe(true);
      expect(projectsSeen.slice(firstB).every((p) => p === projectB)).toBe(true);
      expect(res.projects.map((p) => [p.id, p.identifier, p.name])).toEqual([
        [projectA, "W23A", "warp3523-alpha"],
        [projectB, "W23B", "warp3523-bravo"],
      ]);
    });

    it("excludes items of an archived project", async () => {
      expect(namesOf((await list("assigned")).items)).not.toContain("z-overdue");
      expect(namesOf((await list("overdue")).items)).not.toContain("z-overdue");
    });

    it("overdue is ordered oldest due date first, then by priority (urgent first)", async () => {
      const names = namesOf((await list("overdue")).items);
      const a = names.filter((n) => n !== "b-overdue");
      expect(a[0]).toBe("m-overdue-older");
      // Same due day (Oct 2): urgent, then high, then the rest.
      expect(a.indexOf("m-overdue-urgent")).toBeLessThan(a.indexOf("m-stateless-overdue"));
      expect(a.indexOf("m-stateless-overdue")).toBeLessThan(a.indexOf("m-overdue"));
      expect(names[names.length - 1]).toBe("b-overdue");
    });

    it("assigned is ordered by priority (the enum's own order), then due date with no date last", async () => {
      const names = namesOf((await list("assigned")).items).filter((n) => n !== "b-overdue" && n !== "b-nodue");
      expect(names[0]).toBe("m-overdue-urgent"); // urgent with the earliest due date
      expect(names[1]).toBe("m-urgent-nodue"); // urgent with no due date sorts after it
      expect(names.indexOf("m-high-nodue")).toBeGreaterThan(names.indexOf("m-urgent-nodue"));
      expect(names.indexOf("m-stateless-overdue")).toBeLessThan(names.indexOf("m-high-nodue")); // high, dated before high, undated
      expect(names.indexOf("m-overdue")).toBeGreaterThan(names.indexOf("m-high-nodue")); // low after high
    });

    it("pages walk the whole list once, in a stable order, and end at null", async () => {
      const everything = namesOf((await list("assigned", { limit: 500 })).items);
      const seen: string[] = [];
      let offset: number | null = 0;
      let pages = 0;
      while (offset !== null && pages < 20) {
        const page = await list("assigned", { limit: 4, offset });
        seen.push(...namesOf(page.items));
        offset = page.nextOffset;
        pages += 1;
      }
      expect(seen).toEqual(everything);
      expect(new Set(seen).size).toBe(seen.length);
      expect(pages).toBe(Math.ceil(everything.length / 4));
    });
  });
});
