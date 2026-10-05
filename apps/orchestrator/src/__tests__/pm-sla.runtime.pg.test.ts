import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTicket, updateTicket } from "../services/support/ticket.service.js";
import { addNote, addReply } from "../services/support/conversation.service.js";
import { applyMacro, getDeskSla, listMacros } from "../services/support/sla-settings.service.js";
import { syncTicketSla } from "../services/support/sla-clock.service.js";
import { grants } from "./helpers/support-routes.js";
vi.unmock("@prisma/client");
const RUN = process.env.RUN_PG_INTEGRATION === "1" && !!process.env.DATABASE_URL;
describe.skipIf(!RUN)("SLA transactions and concurrent assignment (real PostgreSQL)", () => {
  let prisma: PrismaClient;
  let deskId: string, projectId: string, runningId: string, pausedId: string, stoppedId: string, agentId: string, secondId: string, inactiveId: string;
  let now = new Date("2026-10-05T09:00:00Z");
  const ctx = { canReadProjects: false, canReadCrm: false };
  const deps = { now: () => now, resolveAccess: async () => grants([["support", "act"]]) };
  const OURS = { startsWith: "warp3530r-" };
  const viewer = () => ({ id: agentId, role: "family" as const });
  beforeAll(async () => { const { PrismaClient: Client } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client"); prisma = new Client(); await prisma.$connect(); });
  async function clean() {
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.user.deleteMany({ where: { username: OURS } });
  }
  afterAll(async () => { await clean(); await prisma.$disconnect(); });
  beforeEach(async () => {
    await clean(); now = new Date("2026-10-05T09:00:00Z");
    const workspace = await prisma.pmWorkspace.create({ data: { slug: "warp3530r-ws", name: "warp3530r-ws" } });
    projectId = (await prisma.pmProject.create({ data: { workspaceId: workspace.id, identifier: "S30P", name: "warp3530r-project" } })).id;
    const desk = await prisma.pmProject.create({ data: { workspaceId: workspace.id, identifier: "S30D", name: "warp3530r-desk", kind: "SERVICE_DESK", states: { create: [
      { name: "Running", group: "started", slaClock: "RUNNING", isDefault: true },
      { name: "Paused", group: "started", slaClock: "PAUSED" },
      { name: "Solved", group: "completed", slaClock: "STOPPED" },
    ] } }, include: { states: true } });
    deskId = desk.id; runningId = desk.states.find((s) => s.slaClock === "RUNNING")!.id; pausedId = desk.states.find((s) => s.slaClock === "PAUSED")!.id; stoppedId = desk.states.find((s) => s.slaClock === "STOPPED")!.id;
    agentId = (await prisma.user.create({ data: { username: "warp3530r-agent", displayName: "Agent", role: "family" } })).id;
    secondId = (await prisma.user.create({ data: { username: "warp3530r-second", displayName: "Second", role: "family" } })).id;
    inactiveId = (await prisma.user.create({ data: { username: "warp3530r-inactive", displayName: "Inactive", role: "family", directoryStatus: "DEACTIVATED" } })).id;
    await prisma.pmSlaPolicy.create({ data: { projectId: deskId, targets: { high: { firstResponseMins: 60, nextResponseMins: 30, resolutionMins: 240 } } } });
  });
  const ticket = () => createTicket(prisma, viewer(), { deskId, subject: "warp3530r-ticket", priority: "high" }, ctx, deps);
  it("materialises creation, explicit pause/resume, staff reply and solved clocks in their own transactions", async () => {
    const created = await ticket();
    expect((await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: created.id } })).firstResponseDueAt?.toISOString()).toBe("2026-10-05T10:00:00.000Z");
    now = new Date("2026-10-05T09:20:00Z"); await updateTicket(prisma, viewer(), created.id, { stateId: pausedId }, ctx, deps);
    now = new Date("2026-10-05T11:20:00Z"); await updateTicket(prisma, viewer(), created.id, { stateId: runningId }, ctx, deps);
    const resumed = await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: created.id } });
    expect(resumed.slaPausedMs).toBe(120n * 60000n); expect(resumed.firstResponseDueAt?.toISOString()).toBe("2026-10-05T12:00:00.000Z");
    await addNote(prisma, viewer(), created.id, { bodyHtml: "Internal" }, ctx, deps);
    expect((await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: created.id } })).firstRespondedAt).toBeNull();
    await addReply(prisma, viewer(), created.id, { bodyHtml: "Public" }, ctx, deps);
    now = new Date("2026-10-05T12:00:00Z"); await updateTicket(prisma, viewer(), created.id, { stateId: stoppedId }, ctx, deps);
    expect((await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: created.id } })).slaStatus).toBe("MET");
  });
  it("concurrent round robin skips inactive people and never reuses an uncommitted cursor", async () => {
    await prisma.pmAssignmentRule.create({ data: { projectId: deskId, mode: "ROUND_ROBIN", memberIds: [agentId, inactiveId, secondId] } });
    const tickets = await Promise.all(Array.from({ length: 6 }, () => ticket()));
    const assignments = await prisma.pmWorkItemAssignee.findMany({ where: { workItemId: { in: tickets.map((t) => t.id) } } });
    expect(assignments).toHaveLength(6);
    expect(assignments.filter((a) => a.userId === agentId)).toHaveLength(3); expect(assignments.filter((a) => a.userId === secondId)).toHaveLength(3);
    expect(assignments.some((a) => a.userId === inactiveId)).toBe(false);
    expect(new Set(tickets.map((t) => t.key)).size).toBe(6);
  });
  it("serialises competing clock ticks so exactly one transition activity commits", async () => {
    const created = await ticket(); now = new Date("2026-10-05T09:45:00Z");
    await Promise.all(Array.from({ length: 4 }, () => prisma.$transaction((tx) => syncTicketSla(tx, created.id, now, "tick", deps))));
    expect(await prisma.pmActivity.count({ where: { workItemId: created.id, verb: "sla_at_risk" } })).toBe(1);
  });
  it("applies a macro's fields and audit in one transaction and leaves sending the reply explicit", async () => {
    const created = await ticket();
    const macro = await prisma.pmMacro.create({ data: { projectId: deskId, ownerId: agentId, name: "warp3530r-macro", bodyHtml: "Hi {{requester.firstName}}", actions: { priority: "low", stateId: pausedId, assignee: { userId: secondId } } } });
    const applied = await applyMacro(prisma, viewer(), created.id, macro.id, ctx, deps);
    expect(applied.ticket.priority).toBe("low"); expect(applied.ticket.status.id).toBe(pausedId); expect(applied.ticket.assignees.map((a) => a.id)).toEqual([secondId]);
    expect(await prisma.pmActivity.count({ where: { workItemId: created.id, verb: "macro_applied" } })).toBe(1);
    expect(await prisma.pmComment.count({ where: { workItemId: created.id } })).toBe(0);
  });
  it("a failed macro audit rolls back every proposed field change", async () => {
    const created = await ticket();
    const macro = await prisma.pmMacro.create({ data: { projectId: deskId, ownerId: agentId, name: "warp3530r-macro", bodyHtml: "Hi", actions: { priority: "low", stateId: pausedId } } });
    const failing = prisma.$extends({ query: { pmActivity: { async create({ args, query }) { if (args.data.verb === "macro_applied") throw new Error("injected audit failure"); return query(args); } } } });
    await expect(applyMacro(failing as unknown as PrismaClient, viewer(), created.id, macro.id, ctx, deps)).rejects.toThrow("injected audit failure");
    const row = await prisma.pmWorkItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.priority).toBe("high"); expect(row.stateId).toBe(runningId);
    expect(await prisma.pmActivity.count({ where: { workItemId: created.id, verb: { in: ["macro_applied", "state_changed"] } } })).toBe(0);
  });
  it("native Projects cannot reach policy or macro reads", async () => {
    await expect(getDeskSla(prisma, projectId)).rejects.toThrow("desk_not_found");
    await expect(listMacros(prisma, viewer(), projectId)).rejects.toThrow("desk_not_found");
  });
});
