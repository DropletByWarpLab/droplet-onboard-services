import { describe, expect, it, vi } from "vitest";
import { syncTicketSla, sweepTicketSlas } from "./sla-clock.service.js";
const at = (time: string) => new Date(`2026-10-05T${time}:00Z`);
function fixture() {
  const ticket: any = { slaTargets: null, slaStatus: "NONE", firstRespondedAt: null, solvedAt: null, slaPausedMs: 0n, slaPausedAt: null };
  const row: any = { id: "t1", projectId: "d1", project: { kind: "SERVICE_DESK" }, priority: "high", createdAt: at("09:00"), state: { slaClock: "RUNNING" }, ticket, assignees: [] };
  const policy: any = { enabled: true, calendarId: null, targets: { high: { firstResponseMins: 60, nextResponseMins: 30, resolutionMins: 240 }, urgent: { resolutionMins: 120 } }, atRiskPercent: 75, escalation: [], calendar: null };
  const activities: any[] = [];
  const tx: any = {
    $queryRaw: vi.fn(async () => []),
    pmWorkItem: { findFirst: vi.fn(async (args) => row.project.kind === args.where.project.kind ? row : null), update: vi.fn(async ({ data }) => { Object.assign(row, data); }) },
    pmTicket: { update: vi.fn(async ({ data }) => { Object.assign(ticket, data); }) },
    pmSlaPolicy: { findUnique: vi.fn(async () => policy) },
    pmActivity: { create: vi.fn(async ({ data }) => { activities.push(data); }) },
    pmWorkItemAssignee: { deleteMany: vi.fn(), create: vi.fn() },
  };
  return { tx, ticket, row, policy, activities };
}
describe("transactional ticket SLA materialisation", () => {
  it("freezes policy terms: editing a policy never moves an existing promise", async () => {
    const f = fixture(); await syncTicketSla(f.tx, "t1", at("09:00"), "create");
    f.policy.targets.high.firstResponseMins = 120;
    await syncTicketSla(f.tx, "t1", at("09:30"));
    expect(f.ticket.firstResponseDueAt.toISOString()).toBe("2026-10-05T10:00:00.000Z");
    expect(f.ticket.slaTargets.firstResponseMins).toBe(60);
  });
  it("recomputes terms on an explicit priority change", async () => {
    const f = fixture(); await syncTicketSla(f.tx, "t1", at("09:00"), "create");
    f.row.priority = "urgent"; await syncTicketSla(f.tx, "t1", at("09:20"), "priority");
    expect(f.ticket.firstResponseDueAt).toBeNull();
    expect(f.ticket.resolutionDueAt.toISOString()).toBe("2026-10-05T11:00:00.000Z");
  });
  it("emits one risk and one breach despite repeated ticks and a pause/resume", async () => {
    const f = fixture(); await syncTicketSla(f.tx, "t1", at("09:00"), "create");
    await syncTicketSla(f.tx, "t1", at("09:45")); await syncTicketSla(f.tx, "t1", at("09:46"));
    f.row.state.slaClock = "PAUSED"; await syncTicketSla(f.tx, "t1", at("09:46"), "state");
    f.row.state.slaClock = "RUNNING"; await syncTicketSla(f.tx, "t1", at("10:46"), "state");
    await syncTicketSla(f.tx, "t1", at("11:00")); await syncTicketSla(f.tx, "t1", at("11:01"));
    expect(f.activities.map((a) => a.verb)).toEqual(["sla_at_risk", "sla_breached"]);
    expect(f.activities.every((a) => a.actorId === null)).toBe(true);
  });
  it("does not let repeated requester messages reset an unanswered-response deadline", async () => {
    const f = fixture(); await syncTicketSla(f.tx, "t1", at("09:00"), "create");
    f.ticket.firstRespondedAt = at("09:05"); await syncTicketSla(f.tx, "t1", at("09:05"), "reply");
    await syncTicketSla(f.tx, "t1", at("10:00"), "requester"); await syncTicketSla(f.tx, "t1", at("10:15"), "requester");
    expect(f.ticket.nextResponseDueAt.toISOString()).toBe("2026-10-05T10:30:00.000Z");
  });
  it("a newly waiting next-response cycle can emit its own risk transition after an on-time first reply", async () => {
    const f = fixture(); await syncTicketSla(f.tx, "t1", at("09:00"), "create");
    await syncTicketSla(f.tx, "t1", at("09:45"));
    f.ticket.firstRespondedAt = at("09:50"); await syncTicketSla(f.tx, "t1", at("09:50"), "reply");
    expect(f.ticket.slaStatus).toBe("ON_TRACK");
    await syncTicketSla(f.tx, "t1", at("10:00"), "requester"); await syncTicketSla(f.tx, "t1", at("10:23")); await syncTicketSla(f.tx, "t1", at("10:24"));
    expect(f.activities.filter((a) => a.verb === "sla_at_risk")).toHaveLength(2);
    expect(f.activities.at(-1).field).toBe("nextResponse");
  });
  it("repeated intake before the first staff response uses only the first-response promise", async () => {
    const f = fixture(); await syncTicketSla(f.tx, "t1", at("09:00"), "create");
    await syncTicketSla(f.tx, "t1", at("09:05"), "requester");
    expect(f.ticket.nextResponseDueAt).toBeNull(); expect(f.ticket.firstResponseDueAt.toISOString()).toBe("2026-10-05T10:00:00.000Z");
  });
  it("records a late next reply even if no timer ran before the reply", async () => {
    const f = fixture(); await syncTicketSla(f.tx, "t1", at("09:00"), "create");
    f.ticket.firstRespondedAt = at("09:05"); await syncTicketSla(f.tx, "t1", at("09:05"), "reply");
    await syncTicketSla(f.tx, "t1", at("10:00"), "requester"); await syncTicketSla(f.tx, "t1", at("10:31"), "reply");
    expect(f.ticket.nextResponseDueAt).toBeNull(); expect(f.ticket.slaStatus).toBe("BREACHED");
    expect(f.activities).toContainEqual(expect.objectContaining({ verb: "sla_breached", field: "nextResponse" }));
  });
  it("a customer message received during Pending excludes the earlier paused interval", async () => {
    const f = fixture(); await syncTicketSla(f.tx, "t1", at("09:00"), "create");
    f.ticket.firstRespondedAt = at("09:05"); await syncTicketSla(f.tx, "t1", at("09:05"), "reply");
    f.row.state.slaClock = "PAUSED"; await syncTicketSla(f.tx, "t1", at("09:10"), "state");
    await syncTicketSla(f.tx, "t1", at("10:00"), "requester");
    f.row.state.slaClock = "RUNNING"; await syncTicketSla(f.tx, "t1", at("11:00"), "state");
    expect(f.ticket.nextResponseDueAt.toISOString()).toBe("2026-10-05T11:30:00.000Z");
  });
  it("applies a priority escalation exactly once and keeps the breached promise", async () => {
    const f = fixture(); f.policy.escalation = [{ on: "BREACHED", metric: "any", actions: [{ type: "raise_priority" }] }];
    await syncTicketSla(f.tx, "t1", at("09:00"), "create"); await syncTicketSla(f.tx, "t1", at("10:01")); await syncTicketSla(f.tx, "t1", at("10:02"));
    expect(f.row.priority).toBe("urgent"); expect(f.tx.pmWorkItem.update).toHaveBeenCalledTimes(1);
    expect(f.activities.filter((a) => a.verb === "sla_breached")).toHaveLength(1);
  });
  it("never touches a native Project row", async () => {
    const f = fixture(); f.row.project.kind = "PROJECT"; await syncTicketSla(f.tx, "t1", at("09:00"), "create");
    expect(f.tx.pmTicket.update).not.toHaveBeenCalled(); expect(f.tx.pmSlaPolicy.findUnique).not.toHaveBeenCalled();
  });
  it("rejects an unreadable frozen clock before overwriting it", async () => {
    const f = fixture(); f.ticket.slaTargets = { resolutionMins: -1 };
    await expect(syncTicketSla(f.tx, "t1", at("09:00"))).rejects.toThrow(); expect(f.tx.pmTicket.update).not.toHaveBeenCalled();
  });
  it("continues after a persisted scan cursor and wraps only after exhausting the tail", async () => {
    const prisma: any = { systemFlag: { findUnique: vi.fn(async () => ({ valueJson: "t099" })), upsert: vi.fn() }, pmTicket: { findMany: vi.fn(async () => []) }, $transaction: vi.fn() };
    await sweepTicketSlas(prisma, { now: () => at("09:00") });
    expect(prisma.pmTicket.findMany.mock.calls[0][0].where.workItemId).toEqual({ gt: "t099" });
    expect(prisma.systemFlag.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { valueJson: "" } }));
  });
});
