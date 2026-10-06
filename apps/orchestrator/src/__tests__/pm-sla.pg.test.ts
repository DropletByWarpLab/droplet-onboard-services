/**
 * WARP-3530 (ADR-069 §6, WS-14) — the invariants of the SLA schema that only a
 * real database can prove.
 *
 *   * `PmTicket_sla_terms_match_status` / `PmTicket_due_needs_terms` — CHECKs that
 *     live only in migration SQL: a ticket has SLA terms exactly when its status
 *     is not NONE, and a deadline never exists without the promise it was
 *     computed from.
 *   * `pm_enforce_service_desk_project` — one TRIGGER function behind three
 *     triggers (policy, assignment rule, macro): none may hang off a PROJECT.
 *     A CHECK may not contain a subquery, so "this row's project is a desk" can
 *     only be a trigger; the service is not the only writer a future importer
 *     will bring.
 *   * RESTRICT on `PmSlaPolicy.calendarId`: deleting the calendar a desk's SLA
 *     runs on is refused, not turned into a 24/7 clock.
 *   * The `jsonb_typeof` shape CHECKs, the at-risk range, the one-rule-per-desk
 *     and one-policy-per-desk uniqueness, and the defaults that keep every
 *     existing ticket meaning what it meant.
 *
 * Gated like the other *.pg.test.ts files. Fixtures are namespaced `warp3530-`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("SLA schema — the database's own guarantees (WARP-3530)", () => {
  let prisma: PrismaClient;
  const OURS = { startsWith: "warp3530-" } as const;

  let workspaceId = "";
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
    // Policies and calendars reference each other with RESTRICT, so the policies
    // (which cascade away with their project) go first.
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.department.deleteMany({ where: { name: OURS } });
  }

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
    const ws = await prisma.pmWorkspace.create({
      data: { slug: `warp3530-ws-${Date.now()}`, name: "warp3530-ws" },
    });
    workspaceId = ws.id;
    projectId = (
      await prisma.pmProject.create({
        data: { workspaceId, name: "warp3530-project", identifier: "W30P" },
      })
    ).id;
    deskId = (
      await prisma.pmProject.create({
        data: { workspaceId, name: "warp3530-desk", identifier: "W30D", kind: "SERVICE_DESK" },
      })
    ).id;
    seq = 0;
  });

  const ticket = async (extra: Record<string, unknown> = {}) => {
    const wi = await prisma.pmWorkItem.create({
      data: { projectId: deskId, sequenceId: ++seq, name: "warp3530-item" },
    });
    return prisma.pmTicket.create({
      data: {
        workItemId: wi.id,
        requesterKind: "USER",
        requesterUserId: "warp3530-user",
        requesterName: "warp3530 Ana",
        channel: "INTERNAL",
        ...extra,
      } as never,
    });
  };

  const calendar = (name = "warp3530-hours") =>
    prisma.pmBusinessCalendar.create({
      data: {
        workspaceId,
        name,
        timezone: "UTC",
        windows: [{ day: 1, start: "09:00", end: "17:00" }],
        holidays: [],
      },
    });

  // ── the defaults ─────────────────────────────────────────────────────────

  it("leaves every existing ticket on no clock: NONE, no terms, nothing due, nothing paused", async () => {
    const t = await ticket();
    expect(t.slaStatus).toBe("NONE");
    expect(t.slaTargets).toBeNull();
    expect(t.firstResponseDueAt).toBeNull();
    expect(t.nextResponseDueAt).toBeNull();
    expect(t.resolutionDueAt).toBeNull();
    expect(t.slaPausedAt).toBeNull();
    expect(t.slaPausedMs).toBe(0n);
  });

  it("gives a policy, a rule and a macro their defaults", async () => {
    const policy = await prisma.pmSlaPolicy.create({
      data: { projectId: deskId, targets: {} },
    });
    expect(policy.enabled).toBe(true);
    expect(policy.atRiskPercent).toBe(75);
    expect(policy.calendarId).toBeNull();
    expect(policy.escalation).toEqual([]);

    const rule = await prisma.pmAssignmentRule.create({ data: { projectId: deskId } });
    expect(rule.mode).toBe("MANUAL");
    expect(rule.memberIds).toEqual([]);
    expect(rule.lastAssignedUserId).toBeNull();

    const macro = await prisma.pmMacro.create({
      data: { name: "warp3530-macro", bodyHtml: "<p>hi</p>", ownerId: "u1" },
    });
    expect(macro.visibility).toBe("PERSONAL");
    expect(macro.projectId).toBeNull();
    expect(macro.actions).toEqual({});
  });

  // ── the ticket's terms and status agree ──────────────────────────────────

  describe("PmTicket SLA CHECKs", () => {
    const terms = { firstResponseMins: 60, nextResponseMins: null, resolutionMins: 480, atRiskPercent: 75 };

    it("accepts a status together with its terms, and NONE without", async () => {
      const t = await ticket({ slaStatus: "ON_TRACK", slaTargets: terms, resolutionDueAt: new Date() });
      expect(t.slaStatus).toBe("ON_TRACK");
    });

    it("refuses terms on a ticket whose status is NONE", async () => {
      await expect(ticket({ slaStatus: "NONE", slaTargets: terms })).rejects.toThrow(/PmTicket_sla_terms_match_status/);
    });

    it("refuses a status other than NONE on a ticket with no terms", async () => {
      for (const slaStatus of ["ON_TRACK", "AT_RISK", "BREACHED", "MET", "PAUSED"]) {
        await expect(ticket({ slaStatus })).rejects.toThrow(/PmTicket_sla_terms_match_status/);
      }
    });

    it("refuses a due time on a ticket with no terms", async () => {
      await expect(ticket({ resolutionDueAt: new Date() })).rejects.toThrow(/PmTicket_due_needs_terms/);
      await expect(ticket({ firstResponseDueAt: new Date() })).rejects.toThrow(/PmTicket_due_needs_terms/);
      await expect(ticket({ nextResponseDueAt: new Date() })).rejects.toThrow(/PmTicket_due_needs_terms/);
    });

    it("refuses an UPDATE that would leave the two disagreeing, and one that strands a deadline", async () => {
      const t = await ticket({ slaStatus: "ON_TRACK", slaTargets: terms, resolutionDueAt: new Date() });
      // Dropping the terms without the status and the deadline.
      await expect(
        prisma.$executeRaw`UPDATE "PmTicket" SET "slaTargets" = NULL WHERE "workItemId" = ${t.workItemId}`,
      ).rejects.toThrow(/PmTicket_sla_terms_match_status|PmTicket_due_needs_terms/);
      // Dropping all three together is the one coherent way back to no SLA.
      await prisma.$executeRaw`UPDATE "PmTicket" SET "slaTargets" = NULL, "slaStatus" = 'NONE', "resolutionDueAt" = NULL WHERE "workItemId" = ${t.workItemId}`;
      expect((await prisma.pmTicket.findUniqueOrThrow({ where: { workItemId: t.workItemId } })).slaStatus).toBe("NONE");
    });

    it("refuses terms that are not an object, and negative paused time", async () => {
      await expect(
        ticket({ slaStatus: "ON_TRACK", slaTargets: [1, 2] }),
      ).rejects.toThrow(/PmTicket_slaTargets_is_object/);
      await expect(ticket({ slaPausedMs: -1n })).rejects.toThrow(/PmTicket_slaPausedMs_nonnegative/);
    });

    it("keeps paused time as a BigInt past 2^31 milliseconds (about 25 days)", async () => {
      const t = await ticket({ slaPausedMs: 5_000_000_000n });
      expect(t.slaPausedMs).toBe(5_000_000_000n);
    });
  });

  // ── a policy, a rule and a macro belong to a SERVICE DESK ────────────────

  describe("kind isolation (pm_enforce_service_desk_project)", () => {
    it("refuses an SLA policy on a PROJECT, and accepts one on a desk", async () => {
      await expect(
        prisma.pmSlaPolicy.create({ data: { projectId, targets: {} } }),
      ).rejects.toThrow(/must belong to a SERVICE_DESK project/);
      await expect(prisma.pmSlaPolicy.create({ data: { projectId: deskId, targets: {} } })).resolves.toBeTruthy();
    });

    it("refuses an assignment rule on a PROJECT, and accepts one on a desk", async () => {
      await expect(
        prisma.pmAssignmentRule.create({ data: { projectId } }),
      ).rejects.toThrow(/must belong to a SERVICE_DESK project/);
      await expect(prisma.pmAssignmentRule.create({ data: { projectId: deskId } })).resolves.toBeTruthy();
    });

    it("refuses a macro scoped to a PROJECT, accepts one scoped to a desk, and lets a macro be for every desk", async () => {
      await expect(
        prisma.pmMacro.create({ data: { projectId, name: "warp3530-m", bodyHtml: "x", ownerId: "u" } }),
      ).rejects.toThrow(/must belong to a SERVICE_DESK project/);
      await expect(
        prisma.pmMacro.create({ data: { projectId: deskId, name: "warp3530-m", bodyHtml: "x", ownerId: "u" } }),
      ).resolves.toBeTruthy();
      await expect(
        prisma.pmMacro.create({ data: { name: "warp3530-m", bodyHtml: "x", ownerId: "u" } }),
      ).resolves.toBeTruthy();
    });

    it("also guards a re-pointing UPDATE", async () => {
      const policy = await prisma.pmSlaPolicy.create({ data: { projectId: deskId, targets: {} } });
      await expect(
        prisma.pmSlaPolicy.update({ where: { id: policy.id }, data: { project: { connect: { id: projectId } } } }),
      ).rejects.toThrow(/must belong to a SERVICE_DESK project/);
    });
  });

  // ── uniqueness, ranges and shapes ────────────────────────────────────────

  describe("one per desk, in range, in shape", () => {
    it("allows one policy and one rule per desk", async () => {
      await prisma.pmSlaPolicy.create({ data: { projectId: deskId, targets: {} } });
      await expect(prisma.pmSlaPolicy.create({ data: { projectId: deskId, targets: {} } })).rejects.toThrow(/Unique constraint/);
      await prisma.pmAssignmentRule.create({ data: { projectId: deskId } });
      await expect(prisma.pmAssignmentRule.create({ data: { projectId: deskId } })).rejects.toThrow(/Unique constraint/);
    });

    it("holds the at-risk percent to 1-99", async () => {
      for (const atRiskPercent of [0, 100, -5, 250]) {
        const fresh = await prisma.pmProject.create({
          data: { workspaceId, name: "warp3530-d", identifier: `W3${Math.abs(atRiskPercent)}`, kind: "SERVICE_DESK" },
        });
        await expect(
          prisma.pmSlaPolicy.create({ data: { projectId: fresh.id, targets: {}, atRiskPercent } }),
        ).rejects.toThrow(/PmSlaPolicy_atRiskPercent_range/);
      }
      const ok = await prisma.pmSlaPolicy.create({ data: { projectId: deskId, targets: {}, atRiskPercent: 99 } });
      expect(ok.atRiskPercent).toBe(99);
    });

    it("holds each Json column's top-level shape", async () => {
      await expect(
        prisma.pmSlaPolicy.create({ data: { projectId: deskId, targets: [] as never } }),
      ).rejects.toThrow(/PmSlaPolicy_targets_is_object/);
      await expect(
        prisma.pmSlaPolicy.create({ data: { projectId: deskId, targets: {}, escalation: {} as never } }),
      ).rejects.toThrow(/PmSlaPolicy_escalation_is_array/);
      await expect(
        prisma.pmAssignmentRule.create({ data: { projectId: deskId, memberIds: "a,b" as never } }),
      ).rejects.toThrow(/PmAssignmentRule_memberIds_is_array/);
      await expect(
        prisma.pmMacro.create({ data: { name: "warp3530-m", bodyHtml: "x", ownerId: "u", actions: [] as never } }),
      ).rejects.toThrow(/PmMacro_actions_is_object/);
      await expect(
        prisma.pmBusinessCalendar.create({
          data: { workspaceId, name: "warp3530-c", timezone: "UTC", windows: {} as never },
        }),
      ).rejects.toThrow(/PmBusinessCalendar_windows_is_array/);
      await expect(
        prisma.pmBusinessCalendar.create({
          data: { workspaceId, name: "warp3530-c", timezone: "UTC", windows: [], holidays: "2026-12-25" as never },
        }),
      ).rejects.toThrow(/PmBusinessCalendar_holidays_is_array/);
    });

    it("keeps calendar names unique within a workspace", async () => {
      await calendar("warp3530-a");
      await expect(calendar("warp3530-a")).rejects.toThrow(/Unique constraint/);
      await expect(calendar("warp3530-b")).resolves.toBeTruthy();
    });
  });

  // ── calendars, deletion and cascades ─────────────────────────────────────

  describe("deletion", () => {
    it("refuses to delete a calendar a policy runs on, and allows it once the policy is gone", async () => {
      const cal = await calendar();
      await prisma.pmSlaPolicy.create({ data: { projectId: deskId, calendarId: cal.id, targets: {} } });
      await expect(prisma.pmBusinessCalendar.delete({ where: { id: cal.id } })).rejects.toThrow(/Foreign key constraint/);
      await prisma.pmSlaPolicy.deleteMany({ where: { projectId: deskId } });
      await expect(prisma.pmBusinessCalendar.delete({ where: { id: cal.id } })).resolves.toBeTruthy();
    });

    it("takes a desk's policy, rule and macros with the desk", async () => {
      await prisma.pmSlaPolicy.create({ data: { projectId: deskId, targets: {} } });
      await prisma.pmAssignmentRule.create({ data: { projectId: deskId } });
      await prisma.pmMacro.create({ data: { projectId: deskId, name: "warp3530-m", bodyHtml: "x", ownerId: "u" } });
      await prisma.pmProject.delete({ where: { id: deskId } });
      expect(await prisma.pmSlaPolicy.count({ where: { projectId: deskId } })).toBe(0);
      expect(await prisma.pmAssignmentRule.count({ where: { projectId: deskId } })).toBe(0);
      expect(await prisma.pmMacro.count({ where: { projectId: deskId } })).toBe(0);
    });

    it("takes a workspace's calendars with the workspace", async () => {
      await calendar();
      await prisma.pmProject.deleteMany({ where: { workspaceId } });
      await prisma.pmWorkspace.delete({ where: { id: workspaceId } });
      expect(await prisma.pmBusinessCalendar.count({ where: { workspaceId } })).toBe(0);
    });

    it("clears a rule's department when the department goes (SetNull), never blocking it", async () => {
      const dept = await prisma.department.create({
        data: { name: "warp3530-dept", slug: `warp3530-dept-${Date.now()}`, createdBy: "warp3530-admin" },
      });
      await prisma.pmAssignmentRule.create({ data: { projectId: deskId, departmentId: dept.id } });
      await prisma.department.delete({ where: { id: dept.id } });
      const rule = await prisma.pmAssignmentRule.findUniqueOrThrow({ where: { projectId: deskId } });
      expect(rule.departmentId).toBeNull();
    });
  });

  // ── the new verbs ────────────────────────────────────────────────────────

  it("accepts the three new activity verbs once the enum migration has committed", async () => {
    const t = await ticket();
    for (const verb of ["sla_at_risk", "sla_breached", "macro_applied"] as const) {
      const row = await prisma.pmActivity.create({ data: { workItemId: t.workItemId, verb } });
      expect(row.verb).toBe(verb);
      expect(row.actorId).toBeNull();
    }
  });
});
