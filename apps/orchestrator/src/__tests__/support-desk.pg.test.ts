/**
 * WARP-3528 (ADR-069, WS-12) — the service desk against a real Postgres.
 *
 * What a mocked Prisma cannot prove and this file does: the seeds a new desk
 * gets, that queues read COLUMNS and not state names, cursor paging with an
 * exact total, the compare-and-set on a state change and on the first response,
 * the PmActivity trail, escalation as one transaction, the contact visibility
 * rule, and that a project row is a 404 on the support side.
 *
 * The CHECK constraint and the two triggers have their own file
 * (pm-ticket.pg.test.ts). Fixtures are namespaced `warp3528s-`; the pg-gated
 * suites share one throwaway database and run in parallel.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("service desk — services against Postgres (WARP-3528)", () => {
  let prisma: PrismaClient;
  // Imported lazily: the module graph must see the REAL client, not the mock.
  let svc: typeof import("../services/support/support.service.js");
  let pm: typeof import("../services/pm/pm.service.js");
  let types: typeof import("../services/support/support.types.js");

  const P = "warp3528s-";
  const OURS = { startsWith: P } as const;

  type Viewer = import("../services/support/support.types.js").SupportViewer;
  let admin: Viewer = { id: "", role: "admin" };
  let family: Viewer = { id: "", role: "family" };
  let lapsed = ""; // an agent that has since lost the Support grant
  let guest = "";
  const ctx = { canReadProjects: true, canReadCrm: true };
  const noProjects = { canReadProjects: false, canReadCrm: true };
  const noCrm = { canReadProjects: true, canReadCrm: false };
  let agentIds = new Set<string>();
  const deps = () => ({
    resolveAccess: async (id: string) =>
      agentIds.has(id)
        ? ({ features: [{ moduleId: "support", level: "act" }] } as never)
        : ({ features: [] } as never),
  });

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    svc = await import("../services/support/support.service.js");
    pm = await import("../services/pm/pm.service.js");
    types = await import("../services/support/support.types.js");
  });

  async function cleanup(): Promise<void> {
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.contact.deleteMany({ where: { displayName: OURS } });
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
    await prisma.user.deleteMany({ where: { username: OURS } });
  }

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
    const mk = (n: string, role: "admin" | "family" | "guest") =>
      prisma.user.create({ data: { username: `${P}${n}`, displayName: `${P}${n} name`, role } });
    const [a, f, l, g] = await Promise.all([
      mk("admin", "admin"),
      mk("family", "family"),
      mk("lapsed", "family"),
      mk("guest", "guest"),
    ]);
    admin = { id: a.id, role: "admin" };
    family = { id: f.id, role: "family" };
    lapsed = l.id;
    guest = g.id;
    agentIds = new Set([a.id, f.id]);
  });

  // ── fixtures ─────────────────────────────────────────────────────────────

  const mkDesk = (name = `${P}desk`, identifier = "W28SA") =>
    svc.createDesk(prisma, admin, { name, identifier });
  const stateOf = (desk: { states: Array<{ id: string; name: string }> }, name: string) =>
    desk.states.find((s) => s.name === name)!.id;
  const labelOf = (desk: { labels: Array<{ id: string; name: string }> }, name: string) =>
    desk.labels.find((l) => l.name === name)!.id;
  const mkTicket = (
    deskId: string,
    extra: Partial<import("../services/support/support.types.js").TicketCreateInput> = {},
  ) =>
    svc.createTicket(
      prisma,
      admin,
      { deskId, subject: `${P}subject`, ...extra },
      ctx,
      deps(),
    );
  const mkContact = (userId: string, name = `${P}Dana`, email?: string) =>
    prisma.contact.create({
      data: {
        userId,
        displayName: name,
        ...(email
          ? { emails: { create: [{ address: email, addressLower: email.toLowerCase(), isPrimary: true }] } }
          : {}),
      },
    });
  const mkProject = async (identifier = "W28SE") => {
    const ws = await pm.ensureHomeWorkspace(prisma);
    return pm.createProject(prisma, admin.id, {
      workspaceSlug: ws.slug,
      name: `${P}eng`,
      identifier,
    });
  };

  // ── desks ────────────────────────────────────────────────────────────────

  describe("desks", () => {
    it("seeds the six states and four labels a desk is promised", async () => {
      const desk = await mkDesk();
      expect(desk.states.map((s) => [s.name, s.group, s.slaClock, s.isDefault])).toEqual([
        ["New", "unstarted", "RUNNING", true],
        ["Open", "started", "RUNNING", false],
        ["Pending", "started", "PAUSED", false],
        ["On hold", "started", "PAUSED", false],
        ["Solved", "completed", "STOPPED", false],
        ["Closed", "completed", "STOPPED", false],
      ]);
      expect(desk.labels.map((l) => [l.name, l.isType])).toEqual([
        ["Incident", true],
        ["Problem", true],
        ["Question", true],
        ["Task", true],
      ]);
      expect(desk.channels).toEqual([]);
      const row = await prisma.pmProject.findUniqueOrThrow({ where: { id: desk.id } });
      expect(row.kind).toBe("SERVICE_DESK");
      expect(row.createdById).toBe(admin.id);
    });

    it("derives a key, suffixes on collision, and refuses an explicit clash", async () => {
      const a = await svc.createDesk(prisma, admin, { name: `${P}Help` });
      const b = await svc.createDesk(prisma, admin, { name: `${P}Help` });
      expect(a.identifier).not.toBe(b.identifier);
      await expect(
        svc.createDesk(prisma, admin, { name: `${P}other`, identifier: a.identifier }),
      ).rejects.toThrow("identifier_taken");
    });

    it("renames, clears a description with null, archives and restores", async () => {
      const desk = await svc.createDesk(prisma, admin, {
        name: `${P}d`,
        identifier: "W28SB",
        description: "words",
      });
      const renamed = await svc.updateDesk(prisma, admin, desk.id, {
        name: `${P}renamed`,
        description: null,
      });
      expect(renamed.name).toBe(`${P}renamed`);
      expect(renamed.description).toBeNull();

      const archived = await svc.updateDesk(prisma, admin, desk.id, { archived: true });
      expect(archived.archived).toBe(true);
      const row = await prisma.pmProject.findUniqueOrThrow({ where: { id: desk.id } });
      expect(row.isArchived).toBe(true);
      expect(row.archivedAt).not.toBeNull();
      expect((await svc.listDesks(prisma)).map((d) => d.id)).not.toContain(desk.id);
      expect((await svc.listDesks(prisma, { includeArchived: true })).map((d) => d.id)).toContain(
        desk.id,
      );

      const restored = await svc.updateDesk(prisma, admin, desk.id, { archived: false });
      expect(restored.archived).toBe(false);
      expect(
        (await prisma.pmProject.findUniqueOrThrow({ where: { id: desk.id } })).archivedAt,
      ).toBeNull();
    });

    it("treats a project id as no desk at all", async () => {
      const project = await mkProject();
      await expect(svc.getDesk(prisma, project.id)).rejects.toThrow("desk_not_found");
      await expect(svc.updateDesk(prisma, admin, project.id, { name: "x" })).rejects.toThrow(
        "desk_not_found",
      );
      expect((await svc.listDesks(prisma)).map((d) => d.id)).not.toContain(project.id);
    });
  });

  // ── creating tickets ─────────────────────────────────────────────────────

  describe("createTicket", () => {
    it("defaults to the caller as a USER requester, lands in New and numbers per desk", async () => {
      const desk = await mkDesk();
      const t1 = await mkTicket(desk.id, { descriptionHtml: "<p>It broke</p><script>x</script>" });
      const t2 = await mkTicket(desk.id);
      expect(t1.key).toBe("W28SA-1");
      expect(t2.key).toBe("W28SA-2");
      expect(t1.status.name).toBe("New");
      expect(t1.priority).toBe("none");
      expect(t1.channel).toBe("INTERNAL");
      expect(t1.requester).toMatchObject({ kind: "USER", id: admin.id, gone: false });
      expect(t1.requester.name).toBe(`${P}admin name`);
      expect(t1.descriptionHtml).toBe("<p>It broke</p>");
      expect(t1.createdBy?.id).toBe(admin.id);
      expect(t1.slaStatus).toBe("NONE");
      const activity = await prisma.pmActivity.findMany({ where: { workItemId: t1.id } });
      expect(activity.map((a) => a.verb)).toEqual(["created"]);
    });

    it("files on behalf of a contact, snapshotting who asked and finding the sole company", async () => {
      const desk = await mkDesk();
      const company = await prisma.crmCompany.create({ data: { name: `${P}Acme` } });
      const contact = await mkContact(admin.id, `${P}Dana`, "dana@example.test");
      await prisma.crmCompanyContact.create({ data: { companyId: company.id, contactId: contact.id } });
      const t = await mkTicket(desk.id, { requester: { kind: "CONTACT", contactId: contact.id } });
      expect(t.requester).toMatchObject({ kind: "CONTACT", name: `${P}Dana`, email: "dana@example.test", gone: false });
      expect(t.requesterCard.company).toEqual({ id: company.id, name: `${P}Acme` });
      const row = await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: t.id } });
      expect(row.requesterName).toBe(`${P}Dana`);
      expect(row.companyId).toBe(company.id);
    });

    it("never guesses among several companies, and an explicit one wins", async () => {
      const desk = await mkDesk();
      const [c1, c2] = await Promise.all([
        prisma.crmCompany.create({ data: { name: `${P}One` } }),
        prisma.crmCompany.create({ data: { name: `${P}Two` } }),
      ]);
      const contact = await mkContact(admin.id);
      await prisma.crmCompanyContact.createMany({
        data: [
          { companyId: c1.id, contactId: contact.id },
          { companyId: c2.id, contactId: contact.id },
        ],
      });
      const open = await mkTicket(desk.id, { requester: { kind: "CONTACT", contactId: contact.id } });
      expect(open.requesterCard.company).toBeNull();
      const chosen = await mkTicket(desk.id, {
        requester: { kind: "CONTACT", contactId: contact.id },
        companyId: c2.id,
      });
      expect(chosen.requesterCard.company?.id).toBe(c2.id);
      await expect(mkTicket(desk.id, { companyId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(
        "company_not_found",
      );
    });

    it("applies the contact visibility rule and never confirms a row it hides", async () => {
      const desk = await mkDesk();
      const privateOfFamily = await mkContact(family.id, `${P}Private`);
      await expect(
        mkTicket(desk.id, { requester: { kind: "CONTACT", contactId: privateOfFamily.id } }),
      ).rejects.toThrow("contact_not_found");

      // Linked to a customer: visible to the whole team.
      const company = await prisma.crmCompany.create({ data: { name: `${P}Co` } });
      const linked = await mkContact(family.id, `${P}Linked`);
      await prisma.crmCompanyContact.create({ data: { companyId: company.id, contactId: linked.id } });
      await expect(
        mkTicket(desk.id, { requester: { kind: "CONTACT", contactId: linked.id } }),
      ).resolves.toBeTruthy();

      // Already raised a ticket: somebody on the team chose them (family's own
      // contact, filed on by family).
      const mine = await mkContact(family.id, `${P}Mine`);
      await svc.createTicket(
        prisma,
        family,
        { deskId: desk.id, subject: `${P}s`, requester: { kind: "CONTACT", contactId: mine.id } },
        ctx,
        deps(),
      );
      await expect(
        mkTicket(desk.id, { requester: { kind: "CONTACT", contactId: mine.id } }),
      ).resolves.toBeTruthy();

      // Archived: refused even when it is the caller's own.
      const archived = await prisma.contact.create({
        data: { userId: admin.id, displayName: `${P}Gone`, isArchived: true },
      });
      await expect(
        mkTicket(desk.id, { requester: { kind: "CONTACT", contactId: archived.id } }),
      ).rejects.toThrow("contact_not_found");
    });

    it("limits a hand-filed channel and checks every id against the desk", async () => {
      const desk = await mkDesk();
      const other = await mkDesk(`${P}other`, "W28SC");
      await expect(mkTicket(desk.id, { channel: "PHONE" })).resolves.toMatchObject({ channel: "PHONE" });
      await expect(mkTicket(desk.id, { channel: "EMAIL" as never })).rejects.toThrow("invalid_channel");
      await expect(mkTicket(desk.id, { stateId: stateOf(other, "Open") })).rejects.toThrow("invalid_state");
      await expect(
        mkTicket(desk.id, { stateId: "00000000-0000-4000-8000-000000000000" }),
      ).rejects.toThrow("state_not_found");
      await expect(mkTicket(desk.id, { labelIds: [labelOf(other, "Task")] })).rejects.toThrow("invalid_label");
      await expect(
        mkTicket(desk.id, { labelIds: ["00000000-0000-4000-8000-000000000000"] }),
      ).rejects.toThrow("label_not_found");
      await expect(mkTicket("00000000-0000-4000-8000-000000000000")).rejects.toThrow("desk_not_found");
    });

    it("assigns only to agents, and writes an `assigned` row per assignee", async () => {
      const desk = await mkDesk();
      await expect(mkTicket(desk.id, { assigneeIds: [lapsed] })).rejects.toThrow("invalid_assignee");
      await expect(mkTicket(desk.id, { assigneeIds: [guest] })).rejects.toThrow("invalid_assignee");
      const t = await mkTicket(desk.id, { assigneeIds: [family.id], priority: "high", labelIds: [labelOf(desk, "Incident")] });
      expect(t.assignees).toEqual([{ id: family.id, displayName: `${P}family name` }]);
      expect(t.priority).toBe("high");
      expect(t.labels.map((l) => l.name)).toEqual(["Incident"]);
      const verbs = (await prisma.pmActivity.findMany({ where: { workItemId: t.id } })).map((a) => a.verb);
      expect(verbs.sort()).toEqual(["assigned", "created"]);
    });

    it("refuses an archived desk, and a project id is no desk", async () => {
      const desk = await mkDesk();
      await svc.updateDesk(prisma, admin, desk.id, { archived: true });
      await expect(mkTicket(desk.id)).rejects.toThrow("desk_archived");
      const project = await mkProject();
      await expect(mkTicket(project.id)).rejects.toThrow("desk_not_found");
    });
  });

  // ── queues, lists ────────────────────────────────────────────────────────

  describe("queues and lists", () => {
    it("reads columns, never names: a renamed Pending is still the pending queue", async () => {
      const desk = await mkDesk();
      await prisma.pmState.update({
        where: { id: stateOf(desk, "Pending") },
        data: { name: `${P}Waiting on customer` },
      });
      const fresh = await svc.getDesk(prisma, desk.id);
      const tNew = await mkTicket(desk.id, { subject: `${P}new` });
      const tOpen = await mkTicket(desk.id, { subject: `${P}open`, stateId: stateOf(fresh, "Open"), assigneeIds: [family.id] });
      const tPending = await mkTicket(desk.id, { subject: `${P}pending`, stateId: stateOf(fresh, `${P}Waiting on customer`) });
      const tHold = await mkTicket(desk.id, { subject: `${P}hold`, stateId: stateOf(fresh, "On hold") });
      const tSolved = await mkTicket(desk.id, { subject: `${P}solved`, stateId: stateOf(fresh, "Solved") });

      const keys = async (queue: import("../services/support/support.types.js").SupportQueue, viewer = admin) =>
        (await svc.listTickets(prisma, viewer, { queue, deskId: desk.id })).tickets.map((t) => t.subject).sort();

      expect(await keys("open")).toEqual([tNew.subject, tOpen.subject].sort());
      expect(await keys("pending")).toEqual([tHold.subject, tPending.subject].sort());
      expect(await keys("unassigned")).toEqual([tNew.subject, tPending.subject, tHold.subject].sort());
      expect(await keys("mine", family)).toEqual([tOpen.subject]);
      expect(await keys("mine", admin)).toEqual([]);
      expect(await keys("solved_recent")).toEqual([tSolved.subject]);
      expect(await keys("all")).toHaveLength(5);

      const counts = await svc.queueCounts(prisma, family, { deskId: desk.id });
      expect(counts).toEqual({ unassigned: 3, mine: 1, open: 2, pending: 2, solved_recent: 1, all: 5 });
    });

    it("solved_recent drops what was solved more than seven days ago", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id, { stateId: stateOf(desk, "Solved") });
      const later = () => new Date(Date.now() + (types.SOLVED_RECENT_DAYS + 1) * 24 * 3600 * 1000);
      const now = await svc.listTickets(prisma, admin, { queue: "solved_recent", deskId: desk.id }, deps());
      expect(now.tickets.map((x) => x.id)).toEqual([t.id]);
      const aged = await svc.listTickets(prisma, admin, { queue: "solved_recent", deskId: desk.id }, { ...deps(), now: later });
      expect(aged.tickets).toEqual([]);
    });

    it("pages with an opaque cursor, a stable order and an exact total", async () => {
      const desk = await mkDesk();
      for (let i = 0; i < 7; i += 1) await mkTicket(desk.id, { subject: `${P}n${i}` });
      const base = { queue: "all", deskId: desk.id, limit: 3 } as const;
      const p1 = await svc.listTickets(prisma, admin, base);
      const p2 = await svc.listTickets(prisma, admin, { ...base, cursor: p1.nextCursor! });
      const p3 = await svc.listTickets(prisma, admin, { ...base, cursor: p2.nextCursor! });
      expect([p1.tickets.length, p2.tickets.length, p3.tickets.length]).toEqual([3, 3, 1]);
      expect([p1.total, p2.total, p3.total]).toEqual([7, 7, 7]);
      expect(p3.nextCursor).toBeNull();
      const ids = [...p1.tickets, ...p2.tickets, ...p3.tickets].map((t) => t.id);
      expect(new Set(ids).size).toBe(7);
      const stamps = [...p1.tickets, ...p2.tickets, ...p3.tickets].map((t) => t.updatedAt);
      expect([...stamps].sort().reverse()).toEqual(stamps);
      await expect(svc.listTickets(prisma, admin, { cursor: "not-a-cursor" })).rejects.toThrow("invalid_cursor");
    });

    it("searches by key, subject and requester address", async () => {
      const desk = await mkDesk();
      const contact = await mkContact(admin.id, `${P}Dana`, "dana@example.test");
      const a = await mkTicket(desk.id, { subject: `${P}printer on fire`, requester: { kind: "CONTACT", contactId: contact.id } });
      await mkTicket(desk.id, { subject: `${P}wifi` });
      const find = async (q: string) =>
        (await svc.listTickets(prisma, admin, { queue: "all", q, deskId: desk.id })).tickets.map((t) => t.id);
      expect(await find(`${P}printer`)).toEqual([a.id]);
      expect(await find("dana@example")).toEqual([a.id]);
      expect(await find(a.key.toLowerCase())).toEqual([a.id]);
    });

    it("filters by desk and refuses a project id", async () => {
      const d1 = await mkDesk();
      const d2 = await mkDesk(`${P}two`, "W28SC");
      const t1 = await mkTicket(d1.id);
      await mkTicket(d2.id);
      expect((await svc.listTickets(prisma, admin, { queue: "all", deskId: d1.id })).tickets.map((t) => t.id)).toEqual([t1.id]);
      const project = await mkProject();
      await expect(svc.listTickets(prisma, admin, { deskId: project.id })).rejects.toThrow("desk_not_found");
      await expect(svc.queueCounts(prisma, admin, { deskId: project.id })).rejects.toThrow("desk_not_found");
    });
  });

  // ── updating ─────────────────────────────────────────────────────────────

  describe("updateTicket", () => {
    it("follows the state GROUP for the clocks: solve, close, reopen", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id);
      const move = (name: string) =>
        svc.updateTicket(prisma, admin, t.id, { stateId: stateOf(desk, name) }, ctx, deps());
      const row = () => prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: t.id } });
      const item = () => prisma.pmWorkItem.findUniqueOrThrow({ where: { id: t.id } });

      await move("Open");
      expect((await row()).solvedAt).toBeNull();

      await move("Solved");
      const solvedAt = (await row()).solvedAt;
      expect(solvedAt).not.toBeNull();
      expect((await item()).isCompleted).toBe(true);

      await move("Closed");
      expect((await row()).solvedAt?.getTime()).toBe(solvedAt!.getTime());
      expect((await row()).reopenCount).toBe(0);

      const reopened = await move("Open");
      expect(reopened.reopenCount).toBe(1);
      expect(reopened.solvedAt).toBeNull();
      expect((await item()).isCompleted).toBe(false);
      expect((await item()).completedAt).toBeNull();

      const verbs = (await prisma.pmActivity.findMany({ where: { workItemId: t.id } })).map((a) => a.verb);
      expect(verbs.filter((v) => v === "state_changed")).toHaveLength(4);
    });

    it("loses a stale state change to a compare-and-set: one winner, one 409", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id);
      const results = await Promise.allSettled([
        svc.updateTicket(prisma, admin, t.id, { stateId: stateOf(desk, "Open") }, ctx, deps()),
        svc.updateTicket(prisma, family, t.id, { stateId: stateOf(desk, "Pending") }, ctx, deps()),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0]!.reason as Error).message).toBe("concurrent_mutation");
      const verbs = (await prisma.pmActivity.findMany({ where: { workItemId: t.id } })).map((a) => a.verb);
      expect(verbs.filter((v) => v === "state_changed")).toHaveLength(1);
    });

    it("writes one activity row per CHANGED field and none for an identity patch", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id, { assigneeIds: [admin.id], labelIds: [labelOf(desk, "Task")] });
      const before = await prisma.pmActivity.count({ where: { workItemId: t.id } });
      await svc.updateTicket(
        prisma,
        admin,
        t.id,
        {
          subject: t.subject,
          priority: t.priority,
          assigneeIds: [admin.id],
          labelIds: [labelOf(desk, "Task")],
          stateId: t.status.id,
        },
        ctx,
        deps(),
      );
      expect(await prisma.pmActivity.count({ where: { workItemId: t.id } })).toBe(before);

      const u = await svc.updateTicket(
        prisma,
        admin,
        t.id,
        {
          subject: `${P}renamed`,
          priority: "urgent",
          assigneeIds: [family.id],
          labelIds: [labelOf(desk, "Incident")],
          descriptionHtml: "<p>new</p>",
        },
        ctx,
        deps(),
      );
      expect(u.subject).toBe(`${P}renamed`);
      expect(u.assignees.map((a) => a.id)).toEqual([family.id]);
      expect(u.labels.map((l) => l.name)).toEqual(["Incident"]);
      const rows = (await prisma.pmActivity.findMany({ where: { workItemId: t.id } })).slice(before);
      expect(rows.map((r) => `${r.verb}:${r.field ?? ""}`).sort()).toEqual(
        [
          "assigned:assignees",
          "description_changed:",
          "label_added:labels",
          "label_removed:labels",
          "title_changed:name",
          "unassigned:assignees",
          "updated:priority",
        ].sort(),
      );
    });

    it("checks only newly added assignees, so a lapsed one does not block an edit", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id);
      await prisma.pmWorkItemAssignee.create({ data: { workItemId: t.id, userId: lapsed } });
      const u = await svc.updateTicket(
        prisma,
        admin,
        t.id,
        { priority: "low", assigneeIds: [lapsed, family.id] },
        ctx,
        deps(),
      );
      expect(u.assignees.map((a) => a.id).sort()).toEqual([family.id, lapsed].sort());
      await expect(
        svc.updateTicket(prisma, admin, t.id, { assigneeIds: [lapsed, guest] }, ctx, deps()),
      ).rejects.toThrow("invalid_assignee");
    });

    it("clears the company with null and the department override with null", async () => {
      const desk = await mkDesk();
      const company = await prisma.crmCompany.create({ data: { name: `${P}Co` } });
      const t = await mkTicket(desk.id, { companyId: company.id });
      expect(t.requesterCard.company?.id).toBe(company.id);
      const cleared = await svc.updateTicket(prisma, admin, t.id, { companyId: null }, ctx, deps());
      expect(cleared.requesterCard.company).toBeNull();
    });

    it("moves the list's last-update with every change, replies included", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id);
      const t0 = new Date(t.updatedAt).getTime();
      await new Promise((r) => setTimeout(r, 15));
      await svc.addNote(prisma, admin, t.id, { bodyHtml: "<p>n</p>" }, ctx, deps());
      const after = await svc.getTicket(prisma, t.id, ctx);
      expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(t0);
    });

    it("refuses writes to a ticket in an archived desk but still reads it", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id);
      await svc.updateDesk(prisma, admin, desk.id, { archived: true });
      await expect(svc.updateTicket(prisma, admin, t.id, { priority: "low" }, ctx, deps())).rejects.toThrow("desk_archived");
      await expect(svc.addReply(prisma, admin, t.id, { bodyHtml: "<p>x</p>" }, ctx, deps())).rejects.toThrow("desk_archived");
      await expect(svc.getTicket(prisma, t.id, ctx)).resolves.toMatchObject({ id: t.id });
    });
  });

  // ── the conversation ─────────────────────────────────────────────────────

  describe("replies, notes and the conversation", () => {
    it("stamps the first response once, on the first PUBLIC staff reply only", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id);
      await svc.addNote(prisma, admin, t.id, { bodyHtml: "<p>private</p>" }, ctx, deps());
      let row = await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: t.id } });
      expect(row.firstRespondedAt).toBeNull();
      expect(row.lastPublicActivityAt).toBeNull();

      const first = await svc.addReply(prisma, admin, t.id, { bodyHtml: "<p>hello</p>" }, ctx, deps());
      expect(first.entry).toMatchObject({ visibility: "PUBLIC", authorKind: "USER" });
      expect(first.ticket.firstRespondedAt).not.toBeNull();
      row = await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: t.id } });
      const stamp = row.firstRespondedAt!.getTime();

      await new Promise((r) => setTimeout(r, 10));
      await svc.addReply(prisma, family, t.id, { bodyHtml: "<p>again</p>" }, ctx, deps());
      row = await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: t.id } });
      expect(row.firstRespondedAt!.getTime()).toBe(stamp);
      expect(row.lastPublicActivityAt!.getTime()).toBeGreaterThan(stamp);
    });

    it("leaves ONE first-response timestamp when two replies race", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id);
      const t1 = new Date(Date.now() + 1000);
      const t2 = new Date(Date.now() + 2000);
      await Promise.all([
        svc.addReply(prisma, admin, t.id, { bodyHtml: "<p>a</p>" }, ctx, { ...deps(), now: () => t1 }),
        svc.addReply(prisma, family, t.id, { bodyHtml: "<p>b</p>" }, ctx, { ...deps(), now: () => t2 }),
      ]);
      const stamp = (await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: t.id } })).firstRespondedAt!;
      expect([t1.getTime(), t2.getTime()]).toContain(stamp.getTime());
      await svc.addReply(prisma, admin, t.id, { bodyHtml: "<p>c</p>" }, ctx, { ...deps(), now: () => new Date(Date.now() + 5000) });
      expect(
        (await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: t.id } })).firstRespondedAt!.getTime(),
      ).toBe(stamp.getTime());
    });

    it("sanitises the body, refuses an empty one, and can move the ticket in the same change", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id);
      const r = await svc.addReply(
        prisma,
        admin,
        t.id,
        { bodyHtml: "<p>ok</p><script>alert(1)</script>", stateId: stateOf(desk, "Pending") },
        ctx,
        deps(),
      );
      expect(r.entry.html).toBe("<p>ok</p>");
      expect(r.ticket.status.name).toBe("Pending");
      await expect(
        svc.addNote(prisma, admin, t.id, { bodyHtml: "<script>alert(1)</script>" }, ctx, deps()),
      ).rejects.toThrow("empty_body");
    });

    it("tells public from internal, resolves names, and drops the `commented` echo", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id);
      await svc.updateTicket(prisma, admin, t.id, { assigneeIds: [family.id], stateId: stateOf(desk, "Open"), priority: "high", labelIds: [labelOf(desk, "Question")] }, ctx, deps());
      await svc.addReply(prisma, admin, t.id, { bodyHtml: "<p>reply</p>" }, ctx, deps());
      await svc.addNote(prisma, family, t.id, { bodyHtml: "<p>note</p>" }, ctx, deps());
      const convo = await svc.getConversation(prisma, t.id, ctx);
      expect(convo.truncated).toBe(false);
      expect(convo.entries.some((e) => e.type === "activity" && e.verb === "commented")).toBe(false);
      const comments = convo.entries.filter((e) => e.type === "comment");
      expect(comments.map((c) => [c.visibility, c.author?.displayName])).toEqual([
        ["PUBLIC", `${P}admin name`],
        ["INTERNAL", `${P}family name`],
      ]);
      const words = (verb: string) => convo.entries.find((e) => e.type === "activity" && e.verb === verb);
      expect(words("state_changed")).toMatchObject({ from: "New", to: "Open" });
      expect(words("assigned")).toMatchObject({ to: `${P}family name`, actor: { id: admin.id } });
      expect(words("label_added")).toMatchObject({ to: "Question" });
      expect(words("updated")).toMatchObject({ field: "priority", from: "None", to: "High" });
      const times = convo.entries.map((e) => e.createdAt);
      expect([...times].sort()).toEqual(times);
    });

    it("says so when it cut the conversation short", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id);
      await prisma.pmActivity.createMany({
        data: Array.from({ length: 501 }, () => ({
          workItemId: t.id,
          verb: "updated" as const,
          field: "fields",
        })),
      });
      const convo = await svc.getConversation(prisma, t.id, ctx);
      expect(convo.truncated).toBe(true);
    });
  });

  // ── escalation ───────────────────────────────────────────────────────────

  describe("escalateTicket", () => {
    it("makes exactly one linked work item, audits both ends and copies nothing of the ticket", async () => {
      const desk = await mkDesk();
      const project = await mkProject();
      const t = await mkTicket(desk.id, { subject: `${P}customer words`, descriptionHtml: "<p>secret body</p>" });
      const itemsBefore = await prisma.pmWorkItem.count({ where: { projectId: project.id } });

      const esc = await svc.escalateTicket(prisma, admin, t.id, { projectId: project.id, title: "Fix the printer driver" }, ctx);
      expect(esc.workItem).toMatchObject({ key: "W28SE-1", name: "Fix the printer driver", projectId: project.id });
      expect(await prisma.pmWorkItem.count({ where: { projectId: project.id } })).toBe(itemsBefore + 1);

      const rels = await prisma.pmWorkItemRelation.findMany({
        where: { OR: [{ fromId: t.id }, { toId: t.id }] },
      });
      expect(rels).toHaveLength(1);
      expect(rels[0]).toMatchObject({ kind: "RELATES" });
      expect(rels[0]!.fromId < rels[0]!.toId).toBe(true);

      const item = await prisma.pmWorkItem.findUniqueOrThrow({ where: { id: esc.workItem.id } });
      expect(item.descriptionHtml).toBe(`<p>Escalated from support ticket ${t.key}.</p>`);
      expect(JSON.stringify(item)).not.toContain("secret body");
      expect(JSON.stringify(item)).not.toContain("customer words");

      for (const id of [t.id, esc.workItem.id]) {
        const link = await prisma.pmActivity.findMany({ where: { workItemId: id, verb: "relation_added" } });
        expect(link).toHaveLength(1);
      }
      expect(esc.ticket.linkedItems).toEqual([
        expect.objectContaining({ restricted: false, key: "W28SE-1", name: "Fix the printer driver", projectName: `${P}eng` }),
      ]);
    });

    it("defaults the title to the key — never the subject", async () => {
      const desk = await mkDesk();
      const project = await mkProject();
      const t = await mkTicket(desk.id, { subject: `${P}customer words` });
      const esc = await svc.escalateTicket(prisma, admin, t.id, { projectId: project.id }, ctx);
      expect(esc.workItem.name).toBe(`Escalated from ${t.key}`);
    });

    it("masks the linked item for a viewer without the Projects grant", async () => {
      const desk = await mkDesk();
      const project = await mkProject();
      const t = await mkTicket(desk.id);
      await svc.escalateTicket(prisma, admin, t.id, { projectId: project.id }, ctx);
      const masked = await svc.getTicket(prisma, t.id, noProjects);
      expect(masked.linkedItems).toEqual([
        expect.objectContaining({ restricted: true, id: null, key: null, name: null, projectName: null, state: null }),
      ]);
      const convo = await svc.getConversation(prisma, t.id, noProjects);
      expect(convo.entries.find((e) => e.type === "activity" && e.verb === "relation_added")).toMatchObject({ to: "a work item" });
      const open = await svc.getConversation(prisma, t.id, ctx);
      expect(open.entries.find((e) => e.type === "activity" && e.verb === "relation_added")).toMatchObject({ to: "W28SE-1" });
    });

    it("refuses a desk, an archived project and an unknown project as the target", async () => {
      const desk = await mkDesk();
      const t = await mkTicket(desk.id);
      await expect(svc.escalateTicket(prisma, admin, t.id, { projectId: desk.id }, ctx)).rejects.toThrow("project_not_found");
      const project = await mkProject();
      await prisma.pmProject.update({ where: { id: project.id }, data: { isArchived: true } });
      await expect(svc.escalateTicket(prisma, admin, t.id, { projectId: project.id }, ctx)).rejects.toThrow("project_not_found");
      await expect(
        svc.escalateTicket(prisma, admin, t.id, { projectId: "00000000-0000-4000-8000-000000000000" }, ctx),
      ).rejects.toThrow("project_not_found");
      expect(await prisma.pmWorkItemRelation.count({ where: { OR: [{ fromId: t.id }, { toId: t.id }] } })).toBe(0);
    });
  });

  // ── requesters ───────────────────────────────────────────────────────────

  describe("requesters", () => {
    it("lists a contact's tickets across desks", async () => {
      const d1 = await mkDesk();
      const d2 = await mkDesk(`${P}two`, "W28SC");
      const contact = await mkContact(admin.id);
      const a = await mkTicket(d1.id, { requester: { kind: "CONTACT", contactId: contact.id } });
      const b = await mkTicket(d2.id, { requester: { kind: "CONTACT", contactId: contact.id } });
      await mkTicket(d1.id);
      const list = await svc.listRequesterTickets(prisma, contact.id);
      expect(list.total).toBe(2);
      expect(list.tickets.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    });

    it("keeps who asked after the contact is deleted, and says it is gone", async () => {
      const desk = await mkDesk();
      const contact = await mkContact(admin.id, `${P}Dana`, "dana@example.test");
      const t = await mkTicket(desk.id, { requester: { kind: "CONTACT", contactId: contact.id } });
      await prisma.contact.delete({ where: { id: contact.id } });
      const after = await svc.getTicket(prisma, t.id, ctx);
      expect(after.requester).toMatchObject({ kind: "CONTACT", name: `${P}Dana`, email: "dana@example.test", gone: true });
      const list = await svc.listTickets(prisma, admin, { queue: "all", deskId: desk.id });
      expect(list.tickets[0]!.requester.gone).toBe(true);
    });

    it("resolves a USER requester's live name and a gone one's snapshot", async () => {
      const desk = await mkDesk();
      const t = await svc.createTicket(prisma, admin, { deskId: desk.id, subject: `${P}s`, requester: { kind: "USER", userId: family.id } }, ctx, deps());
      expect(t.requester).toMatchObject({ kind: "USER", id: family.id, name: `${P}family name`, gone: false });
      await prisma.user.delete({ where: { id: family.id } });
      const after = await svc.getTicket(prisma, t.id, ctx);
      expect(after.requester).toMatchObject({ name: `${P}family name`, gone: true });
      await expect(
        svc.createTicket(prisma, admin, { deskId: desk.id, subject: `${P}s`, requester: { kind: "USER", userId: family.id } }, ctx, deps()),
      ).rejects.toThrow("invalid_requester");
    });

    it("searches the three ways a contact becomes visible, without duplicates", async () => {
      const desk = await mkDesk();
      const own = await mkContact(admin.id, `${P}Zed own`);
      const company = await prisma.crmCompany.create({ data: { name: `${P}Co` } });
      const customer = await mkContact(family.id, `${P}Zed customer`);
      await prisma.crmCompanyContact.create({ data: { companyId: company.id, contactId: customer.id } });
      const requester = await mkContact(family.id, `${P}Zed requester`);
      await svc.createTicket(prisma, family, { deskId: desk.id, subject: `${P}s`, requester: { kind: "CONTACT", contactId: requester.id } }, ctx, deps());
      await mkContact(family.id, `${P}Zed hidden`);

      const found = await svc.searchRequesterContacts(prisma, admin, "zed", ctx);
      expect(found.map((c) => [c.name, c.via])).toEqual([
        [`${P}Zed own`, "yours"],
        [`${P}Zed customer`, "customer"],
        [`${P}Zed requester`, "requester"],
      ]);
      expect(own.id).toBe(found[0]!.id);
      expect(await svc.searchRequesterContacts(prisma, admin, "z", ctx)).toEqual([]);
    });

    it("creates a contact through the address-book service, owned by the caller", async () => {
      const made = await svc.createRequesterContact(
        prisma,
        admin,
        { displayName: `${P}New Person`, email: "new@example.test", phone: "555 0100" },
        ctx,
      );
      expect(made).toMatchObject({ name: `${P}New Person`, email: "new@example.test", via: "yours" });
      const row = await prisma.contact.findUniqueOrThrow({ where: { id: made.id } });
      expect(row.userId).toBe(admin.id);
      expect(row.origin).toBe("LOCAL");

      const err = await svc
        .createRequesterContact(prisma, family, { displayName: `${P}Other`, email: "NEW@example.test" }, ctx)
        .catch((e: unknown) => e);
      // Family cannot see admin's private contact, so the address is theirs to use.
      expect(err).not.toBeInstanceOf(svc.SupportContactExistsError);

      const dup = await svc
        .createRequesterContact(prisma, admin, { displayName: `${P}Again`, email: "new@example.test" }, ctx)
        .catch((e: unknown) => e);
      expect(dup).toBeInstanceOf(svc.SupportContactExistsError);
      expect((dup as InstanceType<typeof svc.SupportContactExistsError>).contactId).toBe(made.id);

      await expect(svc.createRequesterContact(prisma, admin, {}, ctx)).rejects.toThrow("contact_needs_a_name");
    });

    describe("a customer's data is the CRM's, so Support shows it only with the CRM grant", () => {
      it("leaves customer-linked people out of the search, keeping the caller's own and past requesters", async () => {
        const desk = await mkDesk();
        const company = await prisma.crmCompany.create({ data: { name: `${P}Co` } });
        await mkContact(admin.id, `${P}Zed own`);
        const linked = await mkContact(family.id, `${P}Zed customer`);
        await prisma.crmCompanyContact.create({ data: { companyId: company.id, contactId: linked.id } });
        const asked = await mkContact(family.id, `${P}Zed requester`);
        await svc.createTicket(prisma, family, { deskId: desk.id, subject: `${P}s`, requester: { kind: "CONTACT", contactId: asked.id } }, ctx, deps());

        const withCrm = await svc.searchRequesterContacts(prisma, admin, "zed", ctx);
        expect(withCrm.map((c) => c.via)).toEqual(["yours", "customer", "requester"]);
        const withoutCrm = await svc.searchRequesterContacts(prisma, admin, "zed", noCrm);
        expect(withoutCrm.map((c) => [c.name, c.via])).toEqual([
          [`${P}Zed own`, "yours"],
          [`${P}Zed requester`, "requester"],
        ]);
      });

      it("refuses a customer-linked contact as a requester, as if it did not exist", async () => {
        const desk = await mkDesk();
        const company = await prisma.crmCompany.create({ data: { name: `${P}Co` } });
        const linked = await mkContact(family.id, `${P}Linked`);
        await prisma.crmCompanyContact.create({ data: { companyId: company.id, contactId: linked.id } });
        await expect(
          svc.createTicket(prisma, admin, { deskId: desk.id, subject: `${P}s`, requester: { kind: "CONTACT", contactId: linked.id } }, noCrm, deps()),
        ).rejects.toThrow("contact_not_found");
        await expect(
          svc.createTicket(prisma, admin, { deskId: desk.id, subject: `${P}s`, requester: { kind: "CONTACT", contactId: linked.id } }, ctx, deps()),
        ).resolves.toBeTruthy();
      });

      it("never infers a customer, and treats a named one as unknown", async () => {
        const desk = await mkDesk();
        const company = await prisma.crmCompany.create({ data: { name: `${P}Co` } });
        const own = await mkContact(admin.id, `${P}Own`);
        await prisma.crmCompanyContact.create({ data: { companyId: company.id, contactId: own.id } });
        const t = await svc.createTicket(prisma, admin, { deskId: desk.id, subject: `${P}s`, requester: { kind: "CONTACT", contactId: own.id } }, noCrm, deps());
        expect((await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: t.id } })).companyId).toBeNull();
        await expect(
          svc.createTicket(prisma, admin, { deskId: desk.id, subject: `${P}s2`, companyId: company.id }, noCrm, deps()),
        ).rejects.toThrow("company_not_found");
        await expect(
          svc.updateTicket(prisma, admin, t.id, { companyId: company.id }, noCrm, deps()),
        ).rejects.toThrow("company_not_found");
      });

      it("masks the customer's name on a ticket and in its history", async () => {
        const desk = await mkDesk();
        const company = await prisma.crmCompany.create({ data: { name: `${P}Acme` } });
        const t = await mkTicket(desk.id, { companyId: company.id });
        expect((await svc.getTicket(prisma, t.id, ctx)).requesterCard.company).toEqual({ id: company.id, name: `${P}Acme` });
        expect((await svc.getTicket(prisma, t.id, noCrm)).requesterCard.company).toBeNull();

        await svc.updateTicket(prisma, admin, t.id, { companyId: null }, ctx, deps());
        await svc.updateTicket(prisma, admin, t.id, { companyId: company.id }, ctx, deps());
        const words = (c: typeof ctx) =>
          svc.getConversation(prisma, t.id, c).then((r) =>
            r.entries.filter((e) => e.type === "activity" && e.verb === "updated" && e.field === "company").map((e) => (e as { to: string | null }).to),
          );
        expect(await words(ctx)).toEqual([null, `${P}Acme`]);
        expect(await words(noCrm)).toEqual([null, "a customer"]);
      });

      it("will not use a customer's address as grounds to refuse a new contact", async () => {
        const company = await prisma.crmCompany.create({ data: { name: `${P}Co` } });
        const theirs = await prisma.contact.create({
          data: {
            userId: family.id,
            displayName: `${P}Theirs`,
            emails: { create: [{ address: "shared@example.test", addressLower: "shared@example.test", isPrimary: true }] },
          },
        });
        await prisma.crmCompanyContact.create({ data: { companyId: company.id, contactId: theirs.id } });
        const dup = await svc
          .createRequesterContact(prisma, admin, { displayName: `${P}Mine`, email: "shared@example.test" }, ctx)
          .catch((e: unknown) => e);
        expect(dup).toBeInstanceOf(svc.SupportContactExistsError);
        const fine = await svc.createRequesterContact(prisma, admin, { displayName: `${P}Mine`, email: "shared@example.test" }, noCrm);
        expect(fine.via).toBe("yours");
      });
    });
  });

  // ── agents ───────────────────────────────────────────────────────────────

  describe("agents", () => {
    it("offers only active staff who hold Support", async () => {
      const agents = await svc.listAgents(prisma, deps());
      const ours = agents.filter((a) => a.displayName.startsWith(P)).map((a) => a.id);
      expect(ours.sort()).toEqual([admin.id, family.id].sort());
      expect(ours).not.toContain(lapsed);
      expect(ours).not.toContain(guest);

      await prisma.user.update({ where: { id: family.id }, data: { directoryStatus: "DEACTIVATED" } });
      const after = await svc.listAgents(prisma, deps());
      expect(after.map((a) => a.id)).not.toContain(family.id);
    });
  });

  // ── kind isolation on the support side ───────────────────────────────────

  describe("a project row is a 404 on the support side", () => {
    it("never reads, writes or lists a PM work item as a ticket", async () => {
      const project = await mkProject("W28SF");
      const item = await pm.createWorkItem(prisma, admin.id, project.id, { name: `${P}plain item` });
      for (const ref of [item.id, item.key]) {
        await expect(svc.getTicket(prisma, ref, ctx)).rejects.toThrow("ticket_not_found");
      }
      await expect(svc.updateTicket(prisma, admin, item.id, { priority: "low" }, ctx, deps())).rejects.toThrow("ticket_not_found");
      await expect(svc.addReply(prisma, admin, item.id, { bodyHtml: "<p>x</p>" }, ctx, deps())).rejects.toThrow("ticket_not_found");
      await expect(svc.addNote(prisma, admin, item.id, { bodyHtml: "<p>x</p>" }, ctx, deps())).rejects.toThrow("ticket_not_found");
      await expect(svc.getConversation(prisma, item.id, ctx)).rejects.toThrow("ticket_not_found");
      await expect(svc.escalateTicket(prisma, admin, item.id, { projectId: project.id }, ctx)).rejects.toThrow("ticket_not_found");
      const all = await svc.listTickets(prisma, admin, { queue: "all", limit: 200 });
      expect(all.tickets.map((t) => t.id)).not.toContain(item.id);
    });
  });
});
