/**
 * WARP-3528 (ADR-069, WS-12) — the invariants of the service-desk schema that
 * only a real database can prove.
 *
 * Four guarantees rest on nothing in TypeScript:
 *
 *   * `PmTicket_requester_matches_kind` is a CHECK that lives only in migration
 *     SQL: exactly the requester id `requesterKind` names is set, never both,
 *     never neither. A mocked Prisma accepts the rows it rejects.
 *   * `pmticket_item_in_service_desk` and `pmcomment_public_only_on_tickets` are
 *     TRIGGERS. A CHECK may not contain a subquery, so "this row's work item
 *     lives in a SERVICE_DESK project" — a fact about another row — can only be
 *     a trigger. They are the database's own opinion about kind isolation: the
 *     service is not the only writer a future importer or automation will bring.
 *   * Neither requester column is a foreign key. That is a decision, not an
 *     omission (see the PmTicket model comment), and it is pinned here so a
 *     later "add the missing FK" cleanup has to read why it is absent: a Contact
 *     is deleted by paths — an address-book source's cascade, the connector
 *     purge walker, the filing undo — that must neither fail on nor silently
 *     eat a customer's ticket.
 *   * The defaults that keep every existing row meaning what it meant:
 *     projects stay PROJECT, comments stay INTERNAL, states keep a RUNNING clock.
 *
 * Gated the same way the other *.pg.test.ts files are.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PmTicket — the database's own guarantees (WARP-3528)", () => {
  let prisma: PrismaClient;

  // Every fixture is namespaced `warp3528-`: the pg-gated suites share one
  // throwaway database and run in the same lane, so an unscoped deleteMany()
  // would eat another suite's rows.
  const OURS = { startsWith: "warp3528-" } as const;

  let projectId = "";
  let deskId = "";
  let seq = 0;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  async function cleanup(): Promise<void> {
    // Projects cascade to their work items, which cascade to tickets, comments
    // and activity; the workspace goes last.
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.contact.deleteMany({ where: { displayName: OURS } });
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
  }

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
    const ws = await prisma.pmWorkspace.create({
      data: { slug: `warp3528-ws-${Date.now()}`, name: "warp3528-ws" },
    });
    const project = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3528-project", identifier: "W28P" },
    });
    const desk = await prisma.pmProject.create({
      data: {
        workspaceId: ws.id,
        name: "warp3528-desk",
        identifier: "W28D",
        kind: "SERVICE_DESK",
      },
    });
    projectId = project.id;
    deskId = desk.id;
    seq = 0;
  });

  const item = (inProject: string, name = "item") =>
    prisma.pmWorkItem.create({
      data: { projectId: inProject, sequenceId: ++seq, name: `warp3528-${name}` },
    });

  const ticketFor = (
    workItemId: string,
    extra: Record<string, unknown> = {},
  ) =>
    prisma.pmTicket.create({
      data: {
        workItemId,
        requesterKind: "USER",
        requesterUserId: "warp3528-user",
        requesterName: "warp3528 Ana",
        channel: "INTERNAL",
        ...extra,
      } as never,
    });

  // ── the defaults ─────────────────────────────────────────────────────────

  it("leaves every existing row meaning what it meant: PROJECT, RUNNING, INTERNAL, USER", async () => {
    const project = await prisma.pmProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.kind).toBe("PROJECT");

    const state = await prisma.pmState.create({
      data: { projectId, name: "warp3528-todo" },
    });
    expect(state.slaClock).toBe("RUNNING");

    const wi = await item(projectId);
    const comment = await prisma.pmComment.create({
      data: { workItemId: wi.id, commentHtml: "<p>hi</p>" },
    });
    expect(comment.visibility).toBe("INTERNAL");
    expect(comment.authorKind).toBe("USER");
    expect(comment.contactId).toBeNull();
  });

  it("gives a new ticket its clock defaults: no SLA, never reopened, no satisfaction", async () => {
    const wi = await item(deskId);
    const t = await ticketFor(wi.id);
    expect(t.slaStatus).toBe("NONE");
    expect(t.reopenCount).toBe(0);
    expect(t.satisfaction).toBeNull();
    expect(t.firstRespondedAt).toBeNull();
    expect(t.solvedAt).toBeNull();
    expect(t.lastPublicActivityAt).toBeNull();
  });

  // ── PmTicket_requester_matches_kind ──────────────────────────────────────

  it("accepts exactly the requester id that matches the kind", async () => {
    const a = await item(deskId, "contact");
    await expect(
      ticketFor(a.id, {
        requesterKind: "CONTACT",
        requesterContactId: "warp3528-contact",
        requesterUserId: null,
      }),
    ).resolves.toBeTruthy();

    const b = await item(deskId, "user");
    await expect(
      ticketFor(b.id, {
        requesterKind: "USER",
        requesterUserId: "warp3528-user",
        requesterContactId: null,
      }),
    ).resolves.toBeTruthy();
  });

  it.each([
    ["CONTACT with only a user id", { requesterKind: "CONTACT", requesterContactId: null, requesterUserId: "u" }],
    ["CONTACT with both ids", { requesterKind: "CONTACT", requesterContactId: "c", requesterUserId: "u" }],
    ["CONTACT with neither id", { requesterKind: "CONTACT", requesterContactId: null, requesterUserId: null }],
    ["USER with only a contact id", { requesterKind: "USER", requesterContactId: "c", requesterUserId: null }],
    ["USER with both ids", { requesterKind: "USER", requesterContactId: "c", requesterUserId: "u" }],
    ["USER with neither id", { requesterKind: "USER", requesterContactId: null, requesterUserId: null }],
  ])("rejects %s (PmTicket_requester_matches_kind)", async (_label, shape) => {
    const wi = await item(deskId);
    await expect(ticketFor(wi.id, shape)).rejects.toThrow(/PmTicket_requester_matches_kind/);
  });

  it("holds the CHECK on UPDATE too — a ticket cannot be flipped into an inconsistent requester", async () => {
    const wi = await item(deskId);
    await ticketFor(wi.id);
    await expect(
      prisma.pmTicket.update({
        where: { workItemId: wi.id },
        data: { requesterContactId: "warp3528-contact" },
      }),
    ).rejects.toThrow(/PmTicket_requester_matches_kind/);
  });

  // ── pmticket_item_in_service_desk ────────────────────────────────────────

  it("refuses a ticket row on a work item that lives in a project (pmticket_item_in_service_desk)", async () => {
    const wi = await item(projectId, "plain");
    await expect(ticketFor(wi.id)).rejects.toThrow(/SERVICE_DESK/);
  });

  it("refuses re-pointing a ticket row at a project work item", async () => {
    const onDesk = await item(deskId, "desk");
    const onProject = await item(projectId, "plain");
    await ticketFor(onDesk.id);
    await expect(
      prisma.pmTicket.update({
        where: { workItemId: onDesk.id },
        data: { workItemId: onProject.id },
      }),
    ).rejects.toThrow(/SERVICE_DESK/);
  });

  it("deleting the work item takes its ticket row with it", async () => {
    const wi = await item(deskId);
    await ticketFor(wi.id);
    await prisma.pmWorkItem.delete({ where: { id: wi.id } });
    expect(await prisma.pmTicket.count({ where: { workItemId: wi.id } })).toBe(0);
  });

  // ── pmcomment_public_only_on_tickets ─────────────────────────────────────

  it("accepts a PUBLIC comment on a ticket and an INTERNAL one anywhere", async () => {
    const onDesk = await item(deskId, "desk");
    const onProject = await item(projectId, "plain");
    await ticketFor(onDesk.id);

    await expect(
      prisma.pmComment.create({
        data: { workItemId: onDesk.id, commentHtml: "<p>reply</p>", visibility: "PUBLIC" },
      }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.pmComment.create({
        data: { workItemId: onProject.id, commentHtml: "<p>note</p>", visibility: "INTERNAL" },
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses a PUBLIC comment on a project work item — project work never has public comments", async () => {
    const onProject = await item(projectId, "plain");
    await expect(
      prisma.pmComment.create({
        data: { workItemId: onProject.id, commentHtml: "<p>reply</p>", visibility: "PUBLIC" },
      }),
    ).rejects.toThrow(/PUBLIC PmComment/);
  });

  it("refuses promoting an existing project comment to PUBLIC", async () => {
    const onProject = await item(projectId, "plain");
    const c = await prisma.pmComment.create({
      data: { workItemId: onProject.id, commentHtml: "<p>note</p>" },
    });
    await expect(
      prisma.pmComment.update({ where: { id: c.id }, data: { visibility: "PUBLIC" } }),
    ).rejects.toThrow(/PUBLIC PmComment/);
  });

  // ── the decisions the schema comments defend ─────────────────────────────

  it("neither requester column is a foreign key — deleting the Contact leaves the ticket and its snapshot", async () => {
    const contact = await prisma.contact.create({
      data: { userId: "warp3528-owner", displayName: "warp3528-contact" },
    });
    const wi = await item(deskId);
    await ticketFor(wi.id, {
      requesterKind: "CONTACT",
      requesterContactId: contact.id,
      requesterUserId: null,
      requesterName: "Dana Reyes",
      requesterEmail: "dana@example.test",
    });

    // The contact goes the way an address-book source's cascade would take it.
    await prisma.contact.delete({ where: { id: contact.id } });

    const t = await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: wi.id } });
    expect(t.requesterContactId).toBe(contact.id);
    expect(t.requesterName).toBe("Dana Reyes");
    expect(t.requesterEmail).toBe("dana@example.test");

    // Pinned structurally too: the only foreign keys on PmTicket are its work
    // item and its company.
    const fks = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"PmTicket"'::regclass AND contype = 'f'
      ORDER BY conname`;
    expect(fks.map((r) => r.conname)).toEqual([
      "PmTicket_companyId_fkey",
      "PmTicket_workItemId_fkey",
    ]);
  });

  it("deleting a customer record keeps the conversations with them (companyId SetNull)", async () => {
    const company = await prisma.crmCompany.create({ data: { name: "warp3528-acme" } });
    const wi = await item(deskId);
    await ticketFor(wi.id, { companyId: company.id });

    await prisma.crmCompany.delete({ where: { id: company.id } });

    const t = await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: wi.id } });
    expect(t.companyId).toBeNull();
  });

  it("a desk keeps the service-desk vocabulary on its states", async () => {
    const st = await prisma.pmState.create({
      data: {
        projectId: deskId,
        name: "warp3528-pending",
        group: "started",
        slaClock: "PAUSED",
      },
    });
    expect(st.slaClock).toBe("PAUSED");
  });
});
