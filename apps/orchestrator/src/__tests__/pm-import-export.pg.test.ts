/**
 * WARP-3527 (ADR-069 WS-11) — import and export against a REAL Postgres.
 *
 * What only a database can prove here:
 *   - the three invariants the migration adds (external id pair, one active job
 *     per project, finishedAt pinned to the status);
 *   - that an import goes THROUGH the PM service: contiguous sequence numbers
 *     and a matching `seqCounter`, parents linked under the same-project
 *     trigger, `isCompleted` synced to the state group, an activity row per
 *     change attributed to the importing user and born `not_needed`;
 *   - idempotency: the same file twice writes nothing the second time, and an
 *     export re-imported lands on its own ids;
 *   - the job lifecycle: cancel mid-run, resume from the cursor, the stale
 *     sweep, the abandoned-preview purge.
 *
 * Gated like the other *.pg.test.ts files. Fixtures are namespaced `warp3527-`
 * because the pg suites share one throwaway database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PM import and export — the database's own guarantees (WARP-3527)", () => {
  let prisma: PrismaClient;
  let pm: typeof import("../services/pm/pm.service.js");
  let imp: typeof import("../services/pm/pm-import.service.js");
  let runner: typeof import("../services/pm/import/runner.js");
  let exp: typeof import("../services/pm/pm-export.service.js");
  let fx: typeof import("../services/pm/import/import.fixtures.js");

  const NAME = { startsWith: "warp3527-" } as const;
  let projectId = "";
  let identifier = "";
  const users: Record<string, string> = {};
  let seq = 0;

  const csv = (lines: string[]): Buffer => Buffer.from(lines.join("\n") + "\n", "utf8");

  async function mkUser(
    key: string,
    displayName: string,
    email: string | null,
    role: "owner" | "admin" | "family" | "guest" = "family",
    directoryStatus: "ACTIVE" | "DEACTIVATED" = "ACTIVE",
    username = `warp3527-${key}`,
  ): Promise<string> {
    const { emailWriteDataOrNull } = await import("../services/user-directory.service.js");
    const row = await prisma.user.create({
      data: { username, displayName, role, directoryStatus, ...emailWriteDataOrNull(email) },
    });
    users[key] = row.id;
    return row.id;
  }

  async function freshProject(name = "warp3527-proj"): Promise<string> {
    seq += 1;
    const p = await pm.createProject(prisma, users.owner, {
      workspaceSlug: "warp3527-ws",
      name: `${name}-${seq}`,
      identifier: `W35${seq}`,
    });
    projectId = p.id;
    identifier = p.identifier;
    return p.id;
  }

  /** upload → (mapping) → run → wait; returns the finished job. */
  async function importFile(
    buf: Buffer,
    opts: { source?: import("../services/pm/import/types.js").ImportSource; mapping?: object; actor?: string; name?: string } = {},
  ) {
    const created = await imp.createImportJob(prisma, opts.actor ?? users.owner, projectId, {
      fileName: opts.name ?? "export.csv",
      buffer: buf,
      source: opts.source,
    });
    await imp.startImportJob(prisma, created.job.id, { mapping: opts.mapping as never }, { kick: false });
    expect(await runner.runImportJob(prisma, created.job.id)).toBe(true);
    return imp.getImportJob(prisma, created.job.id);
  }

  const items = (where: object = {}) =>
    prisma.pmWorkItem.findMany({
      where: { projectId, ...where },
      include: { assignees: true, labels: { include: { label: true } }, state: true },
      orderBy: { sequenceId: "asc" },
    });
  const byExt = async (ext: string) =>
    (await prisma.pmWorkItem.findFirst({
      where: { projectId, externalId: ext },
      include: { assignees: true, labels: { include: { label: true } }, state: true },
    }))!;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    pm = await import("../services/pm/pm.service.js");
    imp = await import("../services/pm/pm-import.service.js");
    runner = await import("../services/pm/import/runner.js");
    exp = await import("../services/pm/pm-export.service.js");
    fx = await import("../services/pm/import/import.fixtures.js");
  });

  afterAll(async () => {
    await prisma.pmProject.deleteMany({ where: { name: NAME } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: NAME } });
    await prisma.user.deleteMany({ where: { OR: [{ username: NAME }, { username: "octocat" }] } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.pmProject.deleteMany({ where: { name: NAME } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: NAME } });
    await prisma.user.deleteMany({ where: { OR: [{ username: NAME }, { username: "octocat" }] } });
    for (const k of Object.keys(users)) delete users[k];
    await mkUser("owner", "Olive Owner", "owner@example.com", "owner");
    await mkUser("dana", "Dana Ortiz", "dana@example.com");
    await mkUser("sam", "Sam Lee", "sam@example.com");
    await mkUser("guest", "Pat Nobody", "pat@guest.example", "guest");
    // a GitHub login is matched against USERNAME, so this one is literally "octocat"
    await mkUser("octocat", "Octo Hub", null, "family", "ACTIVE", "octocat");
    await freshProject();
  });

  describe("Projects and Service Desk isolation", () => {
    async function desk() {
      const native = await prisma.pmProject.findUniqueOrThrow({ where: { id: projectId } });
      return prisma.pmProject.create({ data: {
        workspaceId: native.workspaceId, name: `warp3527-desk-${++seq}`,
        identifier: `W35D${seq}`, kind: "SERVICE_DESK",
      } });
    }

    it("refuses desk import/export/job reads and transitions, and never claims its queued file", async () => {
      const hidden = await desk();
      const bytes = csv(["Title", "Private customer conversation"]);
      const job = await prisma.pmImportJob.create({ data: {
        projectId: hidden.id, source: "CSV", status: "PENDING", fileName: "private.csv",
        fileBytes: bytes.length, fileSha256: "seeded", createdById: users.owner,
        file: { create: { bytes } },
      } });
      await expect(imp.createImportJob(prisma, users.owner, hidden.id, { fileName: "x.csv", buffer: bytes })).rejects.toThrow("project_not_found");
      await expect(imp.listImportJobs(prisma, hidden.id)).rejects.toThrow("project_not_found");
      await expect(imp.getImportJob(prisma, job.id)).rejects.toThrow("import_job_not_found");
      await expect(imp.updateImportJob(prisma, job.id, {})).rejects.toThrow("import_job_not_found");
      await expect(imp.startImportJob(prisma, job.id, {}, { kick: false })).rejects.toThrow("import_job_not_found");
      await expect(imp.cancelImportJob(prisma, job.id)).rejects.toThrow("import_job_not_found");
      await expect(exp.exportCsvChunks(prisma, hidden.id).next()).rejects.toThrow("project_not_found");
      await expect(exp.exportJsonChunks(prisma, hidden.id).next()).rejects.toThrow("project_not_found");
      expect(await runner.claimJob(prisma)).toBeNull();
      expect(await runner.runImportJob(prisma, job.id)).toBe(false);
      await expect(runner.executeImportJob(prisma, job)).rejects.toThrow("project_not_found");
      expect(await prisma.pmImportJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: "PENDING", heartbeatAt: null });
      expect(await prisma.pmImportJobFile.count({ where: { jobId: job.id } })).toBe(1);
      expect(await prisma.pmWorkItem.count({ where: { projectId: hidden.id } })).toBe(0);
      expect(await prisma.pmState.count({ where: { projectId: hidden.id } })).toBe(0);
      expect(await prisma.pmLabel.count({ where: { projectId: hidden.id } })).toBe(0);
    });

    it("exports native relations while excluding both directions of a Service Desk escalation", async () => {
      const first = await pm.createWorkItem(prisma, users.owner, projectId, { name: "Engineering" });
      const second = await pm.createWorkItem(prisma, users.owner, projectId, { name: "Follow-up" });
      const hidden = await desk();
      const ticket = await prisma.pmWorkItem.create({ data: { projectId: hidden.id, sequenceId: 1, name: "Private customer conversation" } });
      const native = await prisma.pmWorkItemRelation.create({ data: { fromId: first.id, toId: second.id, kind: "BLOCKS", createdById: users.owner } });
      await prisma.pmWorkItemRelation.createMany({ data: [
        { fromId: first.id, toId: ticket.id, kind: "BLOCKS", createdById: users.owner },
        { fromId: ticket.id, toId: second.id, kind: "BLOCKS", createdById: users.owner },
      ] });
      let text = "";
      for await (const chunk of exp.exportJsonChunks(prisma, projectId)) text += chunk;
      const doc = JSON.parse(text);
      expect(doc.items).toHaveLength(2);
      expect(doc.relations.map((r: { id: string }) => r.id)).toEqual([native.id]);
      expect(text).not.toContain(ticket.id);
      expect(text).not.toContain(hidden.identifier);
      expect(text).not.toContain("Private customer conversation");
    });
  });

  // ── the migration's invariants ────────────────────────────────────────────

  describe("schema invariants", () => {
    const rawItem = (extSystem: string | null, extId: string | null, project = projectId) => {
      seq += 1;
      return prisma.$executeRawUnsafe(
        `INSERT INTO "PmWorkItem" ("id","projectId","sequenceId","name","externalSystem","externalId","updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, 'x', $3, $4, now())`,
        project,
        900000 + seq,
        extSystem,
        extId,
      );
    };

    it("an external id without a system (or the reverse) is refused by the CHECK", async () => {
      await expect(rawItem("jira", null)).rejects.toThrow(/PmWorkItem_external_both_or_neither/);
      await expect(rawItem(null, "PAY-1")).rejects.toThrow(/PmWorkItem_external_both_or_neither/);
      await expect(rawItem("jira", "PAY-1")).resolves.toBe(1);
      await expect(rawItem(null, null)).resolves.toBe(1);
    });

    it("(project, system, id) is unique, but native items (both NULL) never collide", async () => {
      await rawItem("jira", "PAY-1");
      await expect(rawItem("jira", "PAY-1")).rejects.toThrow();
      await rawItem("asana", "PAY-1"); // another system
      await rawItem(null, null);
      await rawItem(null, null);
      const other = await freshProject("warp3527-other");
      await rawItem("jira", "PAY-1", other); // another project
    });

    it("at most ONE active (PENDING|RUNNING) import per project; finished ones do not count", async () => {
      const mk = (status: string, finished: boolean) =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "PmImportJob" ("id","projectId","source","status","fileName","fileBytes","fileSha256","createdById","finishedAt","updatedAt")
           VALUES (gen_random_uuid()::text, $1, 'CSV', $2::"PmImportJobStatus", 'f.csv', 1, 'x', 'u', ${finished ? "now()" : "NULL"}, now())`,
          projectId,
          status,
        );
      await mk("PENDING", false);
      // Prisma's raw-query error carries the key, not the index name: 23505 on projectId is the partial index
      await expect(mk("PENDING", false)).rejects.toThrow(/23505/);
      await expect(mk("RUNNING", false)).rejects.toThrow(/23505/);
      for (const s of ["PREVIEWED"]) await expect(mk(s, false)).resolves.toBe(1);
      for (const s of ["SUCCEEDED", "FAILED", "CANCELLED"]) await expect(mk(s, true)).resolves.toBe(1);
      await expect(mk("SUCCEEDED", true)).resolves.toBe(1);
    });

    it("finishedAt is set exactly when the status is terminal", async () => {
      const mk = (status: string, finished: boolean) =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "PmImportJob" ("id","projectId","source","status","fileName","fileBytes","fileSha256","createdById","finishedAt","updatedAt")
           VALUES (gen_random_uuid()::text, $1, 'CSV', $2::"PmImportJobStatus", 'f.csv', 1, 'x', 'u', ${finished ? "now()" : "NULL"}, now())`,
          projectId,
          status,
        );
      await expect(mk("SUCCEEDED", false)).rejects.toThrow(/PmImportJob_finished_matches_status/);
      await expect(mk("FAILED", false)).rejects.toThrow(/PmImportJob_finished_matches_status/);
      await expect(mk("PREVIEWED", true)).rejects.toThrow(/PmImportJob_finished_matches_status/);
      await expect(mk("RUNNING", true)).rejects.toThrow(/PmImportJob_finished_matches_status/);
    });

    it("deleting a project removes its jobs and their files", async () => {
      const { job } = await imp.createImportJob(prisma, users.owner, projectId, { fileName: "a.csv", buffer: csv(["Title", "A"]) });
      expect(await prisma.pmImportJobFile.count({ where: { jobId: job.id } })).toBe(1);
      await prisma.pmProject.delete({ where: { id: projectId } });
      expect(await prisma.pmImportJob.count({ where: { id: job.id } })).toBe(0);
      expect(await prisma.pmImportJobFile.count({ where: { jobId: job.id } })).toBe(0);
    });
  });

  // ── a Jira export, end to end ─────────────────────────────────────────────

  describe("Jira CSV through the PM service", () => {
    it("creates items with the service's invariants intact and reports what it could not match", async () => {
      const job = await importFile(fx.JIRA_CSV, { name: "jira.csv" });
      expect(job.status).toBe("SUCCEEDED");
      expect(job.error).toBeNull();
      expect(job.stats).toMatchObject({ totalRows: 5, toProcess: 4, processed: 4, created: 4, updated: 0, skipped: 1 });
      expect(job.stats.skippedReasons).toEqual({ missing_title: 1 });

      const rows = await items();
      expect(rows.map((r) => r.externalId)).toEqual(["PAY-1", "PAY-2", "PAY-3", "PAY-4"]);
      // sequence numbers are the service's: contiguous, and the counter agrees
      expect(rows.map((r) => r.sequenceId)).toEqual([1, 2, 3, 4]);
      expect((await prisma.pmProject.findUnique({ where: { id: projectId } }))!.seqCounter).toBe(4);
      expect(rows.every((r) => r.externalSystem === "jira")).toBe(true);

      // source facts
      const epic = rows[0];
      expect(epic.name).toBe("Checkout revamp");
      expect(epic.priority).toBe("high");
      expect(epic.createdAt.toISOString()).toBe("2024-03-12T09:41:00.000Z");
      expect(epic.dueDate!.toISOString()).toBe("2024-03-31T00:00:00.000Z");
      expect(epic.createdById).toBe(users.sam); // the Reporter, who resolved to a member
      expect(epic.descriptionHtml).toContain("<p>Rework the checkout flow.</p>");
      expect(epic.state!.name).toBe("In Progress");
      expect(epic.assignees.map((a) => a.userId)).toEqual([users.dana]);
      expect(epic.labels.map((l) => l.label.name).sort()).toEqual(["Epic", "frontend"]);

      // parents are linked (the same-project trigger would have refused a stray one)
      expect(rows[1].parentId).toBe(epic.id);
      expect(rows[3].parentId).toBe(epic.id);

      // the completion signal follows the state group, with the source's own completion time
      const crash = rows[2];
      expect(crash.state!.name).toBe("Done");
      expect(crash.isCompleted).toBe(true);
      expect(crash.completedAt!.toISOString()).toBe("2024-03-15T16:00:00.000Z");
      expect(epic.isCompleted).toBe(false);

      // a status that did not exist became a state, in the right place on the board
      const states = await prisma.pmState.findMany({ where: { projectId }, orderBy: { sortOrder: "asc" } });
      expect(states.map((s) => s.name)).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"]);
      expect(states.find((s) => s.name === "In Review")!.group).toBe("started");
      expect(rows[3].state!.name).toBe("In Review");
      expect(job.stats.createdStates).toEqual(["In Review"]);

      // an unmatched assignee is REPORTED, with the reason, and not silently dropped
      expect(rows[1].assignees).toEqual([]);
      expect(job.stats.unknownAssignees).toEqual([{ value: "Pat Nobody", count: 1, reason: "a guest account" }]);
      expect(job.stats.issues.some((i) => i.code === "assignee_ineligible" && i.key === "PAY-2")).toBe(true);
    });

    it("writes one activity row per change, as the importing user, born not_needed", async () => {
      const job = await importFile(fx.JIRA_CSV);
      const rows = await items();
      const acts = await prisma.pmActivity.findMany({ where: { workItem: { projectId } } });
      // nothing an import wrote can wake the notification sweep
      expect(acts.length).toBeGreaterThan(0);
      expect(acts.every((a) => a.notifyStatus === "not_needed" && a.notifiedAt === null)).toBe(true);
      expect(acts.every((a) => a.actorId === users.owner)).toBe(true);
      const created = acts.filter((a) => a.verb === "created");
      expect(created).toHaveLength(4);
      expect(created.every((a) => a.field === "import" && a.newValue === `JIRA_CSV:${job.id}`)).toBe(true);
      // the assignment is recorded like any other, so "who is on this" has a history
      expect(acts.filter((a) => a.verb === "assigned" && a.workItemId === rows[0].id).map((a) => a.newValue)).toEqual([users.dana]);
    });

    it("importing the same file again writes nothing at all", async () => {
      await importFile(fx.JIRA_CSV);
      const before = await items();
      const actsBefore = await prisma.pmActivity.count({ where: { workItem: { projectId } } });

      const again = await importFile(fx.JIRA_CSV);
      expect(again.stats).toMatchObject({ created: 0, updated: 0, skipped: 5 });
      expect(again.stats.skippedReasons).toEqual({ missing_title: 1, unchanged: 4 });

      const after = await items();
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id)); // no twin
      expect(after.map((r) => r.updatedAt.getTime())).toEqual(before.map((r) => r.updatedAt.getTime()));
      expect(await prisma.pmActivity.count({ where: { workItem: { projectId } } })).toBe(actsBefore);
      expect((await prisma.pmProject.findUnique({ where: { id: projectId } }))!.seqCounter).toBe(4);
      expect(await prisma.pmState.count({ where: { projectId } })).toBe(6); // "In Review" is not made twice
    });

    it("a changed export updates in place, only what changed, and a blank cell erases nothing", async () => {
      await importFile(fx.JIRA_CSV);
      const epicBefore = await byExt("PAY-1");

      const text = fx.JIRA_CSV.toString("utf8")
        // PAY-2: To Do -> Done, and a new title; PAY-1: assignee blanked in the source
        .replace('"Add Apple Pay",PAY-2,10002,Story,To Do,To Do', '"Add Apple and Google Pay",PAY-2,10002,Story,Done,Done')
        .replace("High,Dana Ortiz,Sam Lee,12/Mar/24", "High,,Sam Lee,12/Mar/24");
      const job = await importFile(Buffer.from(text, "utf8"));
      expect(job.stats).toMatchObject({ created: 0, updated: 1 });
      expect(job.stats.skippedReasons.unchanged).toBe(3);

      const pay2 = await byExt("PAY-2");
      expect(pay2.name).toBe("Add Apple and Google Pay");
      expect(pay2.state!.name).toBe("Done");
      expect(pay2.isCompleted).toBe(true); // the service's completion sync ran on the update
      // blank assignee in the file did not unassign Dana
      expect((await byExt("PAY-1")).assignees.map((a) => a.userId)).toEqual([users.dana]);
      expect((await byExt("PAY-1")).updatedAt.getTime()).toBe(epicBefore.updatedAt.getTime());

      // one row per change the service writes, plus ONE marker naming the job
      const acts = await prisma.pmActivity.findMany({ where: { workItemId: pay2.id } });
      expect(acts.filter((a) => a.verb === "state_changed")).toHaveLength(1);
      const titleChanges = acts.filter((a) => a.verb === "title_changed");
      expect(titleChanges).toHaveLength(1);
      expect(titleChanges[0]).toMatchObject({
        field: "name",
        oldValue: "Add Apple Pay",
        newValue: "Add Apple and Google Pay",
      });
      expect(acts.filter((a) => a.verb === "updated" && a.field === "fields")).toHaveLength(0);
      expect(acts.filter((a) => a.verb === "updated" && a.field === "import")).toHaveLength(1);
      expect(acts.every((a) => a.notifyStatus === "not_needed")).toBe(true);
    });

    it("an assignee who did not exist is assigned by importing again after they are added", async () => {
      const sheet = (name: string) => csv(["Key,Title,Assignee", `T-1,Thing,${name}`]);
      const first = await importFile(sheet("newhire@example.com"));
      expect(first.stats.unknownAssignees).toEqual([{ value: "newhire@example.com", count: 1, reason: "no active member matches" }]);
      expect((await byExt("T-1")).assignees).toEqual([]);

      const id = await mkUser("newhire", "New Hire", "newhire@example.com");
      const second = await importFile(sheet("newhire@example.com"));
      expect(second.stats).toMatchObject({ created: 0, updated: 1 });
      expect((await byExt("T-1")).assignees.map((a) => a.userId)).toEqual([id]);
    });

    it("create-missing-states off lands an unknown status on the default state", async () => {
      const job = await importFile(fx.JIRA_CSV, { mapping: { createMissingStates: false } });
      expect(job.stats.createdStates).toEqual([]);
      expect((await byExt("PAY-4")).state!.name).toBe("Todo");
      expect(await prisma.pmState.count({ where: { projectId } })).toBe(5);
    });
  });

  // ── the other sources ─────────────────────────────────────────────────────

  describe("the other presets", () => {
    it("Asana: sub-task by parent NAME, section synonyms, completion, an unknown email reported", async () => {
      const job = await importFile(fx.ASANA_CSV);
      expect(job.stats).toMatchObject({ created: 3, updated: 0, skipped: 0 });
      const parent = await byExt("1001");
      const sub = await byExt("1002");
      expect(sub.parentId).toBe(parent.id);
      expect(parent.state!.name).toBe("In Progress"); // "Doing" is a written synonym
      expect(sub.state!.name).toBe("Todo"); // "To do"
      expect(parent.assignees.map((a) => a.userId)).toEqual([users.dana]); // by email
      expect(sub.assignees.map((a) => a.userId)).toEqual([users.sam]);
      const done = await byExt("1003");
      expect(done.isCompleted).toBe(true);
      expect(done.completedAt!.toISOString()).toBe("2024-03-06T00:00:00.000Z");
      expect(parent.labels.map((l) => l.label.name).sort()).toEqual(["launch", "marketing"]);
    });

    it("Linear: Canceled lands on Cancelled, parent links, instants kept", async () => {
      const job = await importFile(fx.LINEAR_CSV);
      expect(job.stats).toMatchObject({ created: 3 });
      expect((await byExt("ENG-2")).state!.name).toBe("Cancelled");
      expect((await byExt("ENG-2")).isCompleted).toBe(true); // cancelled is terminal
      expect((await byExt("ENG-2")).parentId).toBe((await byExt("ENG-1")).id);
      expect((await byExt("ENG-1")).priority).toBe("urgent");
      expect((await byExt("ENG-1")).createdAt.toISOString()).toBe("2024-03-01T10:00:00.000Z");
    });

    it("GitHub: open/closed become Todo/Done, the milestone a label, a login resolves by username", async () => {
      const job = await importFile(fx.GITHUB_CSV);
      expect(job.stats).toMatchObject({ created: 2 });
      const open = await byExt("12");
      expect(open.state!.name).toBe("Todo");
      expect((await byExt("13")).state!.name).toBe("Done");
      expect(open.labels.map((l) => l.label.name).sort()).toEqual(["Milestone: v1.0", "bug", "help wanted"]);
      expect(open.assignees.map((a) => a.userId)).toEqual([users.octocat]);
      expect(job.stats.unknownAssignees).toEqual([{ value: "jdoe", count: 1, reason: "no active member matches" }]);
    });

    it("Trello: archived cards are skipped and counted, the checklist survives in the description", async () => {
      const job = await importFile(fx.TRELLO_JSON, { name: "board.json" });
      expect(job.source).toBe("TRELLO_JSON");
      expect(job.stats).toMatchObject({ totalRows: 4, created: 2, skipped: 2 });
      expect(job.stats.skippedReasons).toEqual({ archived_in_source: 2 });
      const post = await byExt("65f1b1b1b1b1b1b1b1b1b1b1");
      expect(post.externalSystem).toBe("trello");
      expect(post.descriptionHtml).toContain("[x] Proof the copy");
      expect(post.state!.name).toBe("In Progress");
      expect(post.labels.map((l) => l.label.name).sort()).toEqual(["Marketing", "purple"]);
    });

    it("a file with no id column is idempotent per FILE: the same file twice adds nothing", async () => {
      const file = csv(["Title,Status", "Order paper,Open", "Fix the lock,Closed"]);
      const first = await importFile(file);
      expect(first.stats.created).toBe(2);
      expect((await items()).map((r) => r.externalSystem)).toEqual(["csv", "csv"]);
      const second = await importFile(file);
      expect(second.stats).toMatchObject({ created: 0, updated: 0, skipped: 2 });
      expect(await items()).toHaveLength(2);
    });

    it("a child listed BEFORE its parent is still linked (the parent is created first)", async () => {
      const job = await importFile(csv(["Key,Title,Parent", "B,Child,A", "A,Parent,"]));
      expect(job.stats.created).toBe(2);
      const [first, second] = await items();
      expect(first.externalId).toBe("A");
      expect(second.parentId).toBe(first.id);
    });

    it("parent loops, repeated ids and a parent from an earlier import are all handled", async () => {
      await importFile(csv(["Key,Title", "OLD-1,Earlier import"]));
      const job = await importFile(csv(["Key,Title,Parent", "A,One,B", "B,Two,A", "B,Two again,", "C,Three,OLD-1", "D,Four,GHOST-1"]));
      expect(job.stats.created).toBe(4);
      expect(job.stats.skippedReasons).toEqual({ duplicate_id_in_file: 1 });
      expect((await byExt("A")).parentId).toBeNull(); // the loop was broken once
      expect((await byExt("B")).parentId).toBe((await byExt("A")).id);
      expect((await byExt("C")).parentId).toBe((await byExt("OLD-1")).id); // found by external id
      expect((await byExt("D")).parentId).toBeNull();
      expect(job.stats.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["parent_cycle", "parent_unresolved", "duplicate_id_in_file"]));
    });

    it("imports in batches and counts them: 60 rows = 3 batches of 25", async () => {
      const rows = Array.from({ length: 60 }, (_, i) => `K-${i + 1},Item ${i + 1},${i % 2 ? "Open" : "Closed"}`);
      const job = await importFile(csv(["Key,Title,Status", ...rows]));
      expect(job.stats).toMatchObject({ totalRows: 60, toProcess: 60, processed: 60, created: 60 });
      const all = await items();
      expect(all.map((r) => r.sequenceId)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
      expect(all.filter((r) => r.isCompleted)).toHaveLength(30);
    });
  });

  // ── the job lifecycle ─────────────────────────────────────────────────────

  describe("job lifecycle", () => {
    const sheet = (n: number) => csv(["Key,Title", ...Array.from({ length: n }, (_, i) => `K-${i + 1},Item ${i + 1}`)]);

    it("an upload supersedes the same person's earlier preview and keeps no file for it", async () => {
      const a = await imp.createImportJob(prisma, users.owner, projectId, { fileName: "a.csv", buffer: sheet(1) });
      const b = await imp.createImportJob(prisma, users.owner, projectId, { fileName: "b.csv", buffer: sheet(2) });
      expect((await imp.getImportJob(prisma, a.job.id)).status).toBe("CANCELLED");
      expect(await prisma.pmImportJobFile.count({ where: { jobId: a.job.id } })).toBe(0);
      expect((await imp.getImportJob(prisma, b.job.id)).status).toBe("PREVIEWED");
    });

    it("changing the source starts that preset's mapping over; a mapping naming a missing column is refused", async () => {
      const { job } = await imp.createImportJob(prisma, users.owner, projectId, { fileName: "j.csv", buffer: fx.JIRA_CSV });
      expect(job.source).toBe("JIRA_CSV");
      const changed = await imp.updateImportJob(prisma, job.id, { source: "CSV" });
      expect(changed.job.source).toBe("CSV");
      expect(changed.analysis.mapping.columns.name).toEqual(["Summary"]); // generic aliases find Summary too
      await expect(
        imp.updateImportJob(prisma, job.id, { mapping: { columns: { status: ["No such column"] } } }),
      ).rejects.toMatchObject({ problems: [expect.stringMatching(/no column named "No such column"/)] });
      await expect(imp.updateImportJob(prisma, job.id, { source: "TRELLO_JSON" })).rejects.toMatchObject({ code: "wrong_format" });
    });

    it("an owner's mapping choices are what runs", async () => {
      const file = csv(["Key,Task,Stage,Who", "T-1,Do it,Waiting on legal,Sam Lee"]);
      const { job } = await imp.createImportJob(prisma, users.owner, projectId, { fileName: "g.csv", buffer: file });
      await imp.updateImportJob(prisma, job.id, {
        mapping: {
          columns: { name: ["Task"], status: ["Stage"], assignee: ["Who"] },
          statuses: { waitingonlegal: { kind: "state", stateId: (await prisma.pmState.findFirstOrThrow({ where: { projectId, name: "Backlog" } })).id } },
          people: { samlee: users.dana },
        },
      });
      await imp.startImportJob(prisma, job.id, {}, { kick: false });
      await runner.runImportJob(prisma, job.id);
      const t = await byExt("T-1");
      expect(t.name).toBe("Do it");
      expect(t.state!.name).toBe("Backlog");
      expect(t.assignees.map((a) => a.userId)).toEqual([users.dana]); // pointed at Dana on purpose
    });

    it("a second Run on the same project is refused while one is waiting or running", async () => {
      const a = await imp.createImportJob(prisma, users.owner, projectId, { fileName: "a.csv", buffer: sheet(1) });
      const b = await imp.createImportJob(prisma, users.dana, projectId, { fileName: "b.csv", buffer: sheet(2) });
      await imp.startImportJob(prisma, a.job.id, {}, { kick: false });
      await expect(imp.startImportJob(prisma, b.job.id, {}, { kick: false })).rejects.toThrow("import_in_progress");
      expect((await imp.getImportJob(prisma, b.job.id)).status).toBe("PREVIEWED");
      await imp.cancelImportJob(prisma, a.job.id);
      await expect(imp.startImportJob(prisma, b.job.id, {}, { kick: false })).resolves.toMatchObject({ status: "PENDING" });
    });

    it("a finished job cannot be edited, restarted or cancelled; an unknown one is a 404", async () => {
      const job = await importFile(sheet(1));
      await expect(imp.updateImportJob(prisma, job.id, { source: "CSV" })).rejects.toThrow("import_not_editable");
      await expect(imp.startImportJob(prisma, job.id, {}, { kick: false })).rejects.toThrow("import_not_startable");
      await expect(imp.cancelImportJob(prisma, job.id)).rejects.toThrow("import_not_cancellable");
      await expect(imp.getImportJob(prisma, "00000000-0000-0000-0000-000000000000")).rejects.toThrow("import_job_not_found");
      // the uploaded bytes are gone once the import succeeded
      expect(await prisma.pmImportJobFile.count({ where: { jobId: job.id } })).toBe(0);
    });

    it("cancel stops a running import at its next batch; what was written stays, and the counts add up", async () => {
      const { job } = await imp.createImportJob(prisma, users.owner, projectId, { fileName: "big.csv", buffer: sheet(150) });
      await imp.startImportJob(prisma, job.id, {}, { kick: false });
      const done = runner.runImportJob(prisma, job.id);
      // wait for the first batch to be recorded, then cancel
      for (let i = 0; i < 400; i += 1) {
        const j = await imp.getImportJob(prisma, job.id);
        if (j.stats.processed > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await imp.cancelImportJob(prisma, job.id);
      await done;
      const j = await imp.getImportJob(prisma, job.id);
      expect(j.status).toBe("CANCELLED");
      expect(j.finishedAt).not.toBeNull();
      expect(j.stats.processed).toBeLessThan(150);
      expect(j.stats.created).toBe((await items()).length); // the final counts were saved after the stop
      expect(await prisma.pmImportJobFile.count({ where: { jobId: job.id } })).toBe(0);
    });

    it("a dead run is failed by the sweep and resumed from its cursor without duplicating", async () => {
      const file = sheet(60);
      const finished = await importFile(file);
      expect(finished.stats.created).toBe(60);

      // Rebuild "the process died after 50 rows": same file, job RUNNING, stale heartbeat, cursor 50.
      const { job } = await imp.createImportJob(prisma, users.owner, projectId, { fileName: "again.csv", buffer: file });
      await prisma.$executeRawUnsafe(
        `UPDATE "PmImportJob" SET "status"='RUNNING', "startedAt"=now(), "heartbeatAt"=now() - interval '10 minutes',
           "stats"='{"begun":true,"totalRows":60,"toProcess":60,"processed":50,"created":50}'::jsonb WHERE "id"=$1`,
        job.id,
      );
      const tick = await runner.runImportTick(prisma);
      expect(tick.failedStale).toBe(1);
      const failed = await imp.getImportJob(prisma, job.id);
      expect(failed.status).toBe("FAILED");
      expect(failed.error).toMatch(/interrupted/);
      expect(failed.finishedAt).not.toBeNull();

      await imp.startImportJob(prisma, job.id, {}, { kick: false });
      await runner.runImportJob(prisma, job.id);
      const resumed = await imp.getImportJob(prisma, job.id);
      expect(resumed.status).toBe("SUCCEEDED");
      expect(resumed.error).toBeNull();
      expect(resumed.stats.processed).toBe(60);
      expect(resumed.stats.created).toBe(50); // the first 50 were counted before the "crash"
      expect(resumed.stats.skippedReasons.unchanged).toBe(10); // the rest already existed: resumed, not repeated
      expect(await items()).toHaveLength(60);
    });

    it("the sweep leaves a live run alone, and purges an abandoned preview's bytes", async () => {
      const live = await imp.createImportJob(prisma, users.owner, projectId, { fileName: "live.csv", buffer: sheet(1) });
      await prisma.$executeRawUnsafe(
        `UPDATE "PmImportJob" SET "status"='RUNNING', "startedAt"=now(), "heartbeatAt"=now() WHERE "id"=$1`,
        live.job.id,
      );
      const stale = await imp.createImportJob(prisma, users.dana, projectId, { fileName: "stale.csv", buffer: sheet(1) });
      await prisma.$executeRawUnsafe(`UPDATE "PmImportJob" SET "updatedAt"=now() - interval '2 days' WHERE "id"=$1`, stale.job.id);

      const tick = await runner.runImportTick(prisma);
      expect(tick.failedStale).toBe(0);
      expect((await imp.getImportJob(prisma, live.job.id)).status).toBe("RUNNING");
      expect(tick.purged).toBeGreaterThanOrEqual(1);
      expect((await imp.getImportJob(prisma, stale.job.id)).status).toBe("CANCELLED");
      expect(await prisma.pmImportJobFile.count({ where: { jobId: stale.job.id } })).toBe(0);
      await prisma.pmImportJob.deleteMany({ where: { id: live.job.id } });
    });

    it("a tick claims a PENDING job and runs it to the end outside any request", async () => {
      const { job } = await imp.createImportJob(prisma, users.owner, projectId, { fileName: "t.csv", buffer: sheet(3) });
      await imp.startImportJob(prisma, job.id, {}, { kick: false });
      const tick = await runner.runImportTick(prisma);
      expect(tick.claimed).toBe(1);
      await runner.awaitRunningImports();
      expect((await imp.getImportJob(prisma, job.id)).status).toBe("SUCCEEDED");
      expect(await items()).toHaveLength(3);
    });
  });

  // ── export ────────────────────────────────────────────────────────────────

  describe("export", () => {
    const drain = async (g: AsyncGenerator<string>): Promise<string> => {
      let out = "";
      for await (const c of g) out += c;
      return out;
    };

    it("CSV: BOM, header, one row per item, names not emails, parent keys, provenance", async () => {
      await importFile(fx.JIRA_CSV);
      const text = await drain(exp.exportCsvChunks(prisma, projectId));
      const { parseCsvTable } = await import("../services/pm/import/csv.js");
      expect(text.charCodeAt(0)).toBe(0xfeff);
      const t = parseCsvTable(Buffer.from(text, "utf8"));
      expect(t.headers).toEqual([...exp.CSV_HEADERS]);
      expect(t.rows).toHaveLength(4);
      const col = (r: string[], h: string) => r[t.headers.indexOf(h)];
      const epic = t.rows.find((r) => col(r, "title") === "Checkout revamp")!;
      expect(col(epic, "key")).toBe(`${identifier}-1`);
      expect(col(epic, "state")).toBe("In Progress");
      expect(col(epic, "assignees")).toBe("Dana Ortiz");
      expect(col(epic, "labels").split(", ").sort()).toEqual(["Epic", "frontend"]);
      expect(col(epic, "due_date")).toBe("2024-03-31");
      expect(col(epic, "external_system")).toBe("jira");
      expect(col(epic, "external_id")).toBe("PAY-1");
      expect(col(epic, "description")).toBe('Rework the checkout flow.\n\nSee the design, then "ship" it.');
      const child = t.rows.find((r) => col(r, "title") === "Add Apple Pay")!;
      expect(col(child, "parent_key")).toBe(`${identifier}-1`);
      expect(text).not.toContain("@example.com");
    });

    it("CSV: a title that is a formula is neutralised in the file", async () => {
      await pm.createWorkItem(prisma, users.owner, projectId, { name: "=HYPERLINK(\"http://evil\",\"x\")" });
      await pm.createWorkItem(prisma, users.owner, projectId, { name: "@SUM(1)" });
      const text = await drain(exp.exportCsvChunks(prisma, projectId));
      expect(text).toContain("\"'=HYPERLINK(");
      expect(text).toContain(",'@SUM(1),");
      expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
    });

    it("CSV: the list filters narrow the file, and an exported file re-imports onto the same keys", async () => {
      await importFile(fx.JIRA_CSV);
      const done = (await prisma.pmState.findFirstOrThrow({ where: { projectId, name: "Done" } })).id;
      const filtered = await drain(exp.exportCsvChunks(prisma, projectId, { stateId: done }));
      expect(filtered).toContain("Crash when cart is empty");
      expect(filtered).not.toContain("Checkout revamp");
      const byName = await drain(exp.exportCsvChunks(prisma, projectId, { stateId: "done" })); // by name, like the list
      expect(byName).toBe(filtered);

      // round trip into a second project: keys, parent and people survive
      const full = await drain(exp.exportCsvChunks(prisma, projectId));
      await freshProject("warp3527-roundtrip");
      const job = await importFile(Buffer.from(full, "utf8"));
      expect(job.stats.created).toBe(4);
      const child = await prisma.pmWorkItem.findFirstOrThrow({ where: { projectId, name: "Add Apple Pay" } });
      const parent = await prisma.pmWorkItem.findFirstOrThrow({ where: { projectId, name: "Checkout revamp" } });
      expect(child.parentId).toBe(parent.id);
    });

    it("CSV pages through more than one page without losing or repeating an item", async () => {
      const total = exp.EXPORT_PAGE * 2 + 50;
      await prisma.pmWorkItem.createMany({
        data: Array.from({ length: total }, (_, i) => ({ projectId, sequenceId: i + 1, name: `bulk ${i + 1}`, sortOrder: i + 1 })),
      });
      await prisma.pmProject.update({ where: { id: projectId }, data: { seqCounter: total } });
      const text = await drain(exp.exportCsvChunks(prisma, projectId));
      const { parseCsvTable } = await import("../services/pm/import/csv.js");
      const t = parseCsvTable(Buffer.from(text, "utf8"));
      expect(t.rows).toHaveLength(total);
      expect(new Set(t.rows.map((r) => r[0])).size).toBe(total);
      expect(t.rows[0][0]).toBe(`${identifier}-1`);
      expect(t.rows[total - 1][0]).toBe(`${identifier}-${total}`);
    });

    it("JSON: the whole project — states, labels, fields, items with comments and attachment metadata, relations", async () => {
      await importFile(fx.JIRA_CSV);
      const epic = await byExt("PAY-1");
      const story = await byExt("PAY-2");
      await pm.addComment(prisma, users.dana, epic.id, "<p>Looks good</p>");
      const rel = await import("../services/pm/pm-relations.service.js");
      await rel.createRelation(prisma, users.owner, { fromId: epic.id, toId: story.id, kind: "BLOCKS" });
      await prisma.pmAttachment.create({
        data: { workItemId: epic.id, fileName: "design.png", mimeType: "image/png", sizeBytes: BigInt(1234), storageKey: `warp3527-${Date.now()}`, sha256: "a".repeat(64) },
      });
      const prop = await prisma.pmCustomProperty.create({ data: { projectId, name: "Region", type: "text" } });
      await prisma.pmWorkItemPropertyValue.create({ data: { workItemId: epic.id, propertyId: prop.id, value: { text: "EU" } } });
      await prisma.pmWorkItem.update({ where: { id: story.id }, data: { isArchived: true, archivedAt: new Date() } });

      const text = await drain(exp.exportJsonChunks(prisma, projectId));
      const doc = JSON.parse(text); // a single valid document
      expect(doc).toMatchObject({ format: "droplet.pm.export", version: 1, project: { identifier } });
      expect(doc.states.map((s: { name: string }) => s.name)).toContain("In Review");
      expect(doc.labels.map((l: { name: string }) => l.name)).toContain("frontend");
      expect(doc.fields).toEqual([expect.objectContaining({ name: "Region", type: "text" })]);
      expect(doc.items).toHaveLength(4); // archived items are in the full export
      const e = doc.items.find((i: { key: string }) => i.key === `${identifier}-1`);
      expect(e.comments).toEqual([expect.objectContaining({ commentHtml: "<p>Looks good</p>", authorName: "Dana Ortiz" })]);
      expect(e.attachments).toEqual([expect.objectContaining({ fileName: "design.png", sizeBytes: 1234 })]);
      expect(JSON.stringify(e.attachments)).not.toMatch(/storageKey|bytes/);
      expect(e.fieldValues).toEqual({ [prop.id]: { text: "EU" } });
      expect(e.assignees).toEqual([{ id: users.dana, name: "Dana Ortiz" }]);
      expect(doc.items.find((i: { archived: boolean }) => i.archived)).toBeTruthy();
      expect(doc.relations).toEqual([
        expect.objectContaining({ kind: "BLOCKS", from: expect.objectContaining({ key: `${identifier}-1` }), to: expect.objectContaining({ key: `${identifier}-2` }) }),
      ]);
      expect(text).not.toContain("@example.com");
    });

    it("JSON: an empty project is still a valid document", async () => {
      const doc = JSON.parse(await drain(exp.exportJsonChunks(prisma, projectId)));
      expect(doc.items).toEqual([]);
      expect(doc.relations).toEqual([]);
      expect(doc.states).toHaveLength(5);
    });
  });
});
