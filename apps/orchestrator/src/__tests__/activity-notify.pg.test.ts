/**
 * WARP-2587 (ADR-045 slice I) — the notify sweep against REAL Postgres.
 *
 * WHY THESE CASES RUN HERE AND NOT IN THE MOCKED LANE
 *
 *   claim        — the pending→sent claim is a real
 *                  `UPDATE ... WHERE "notifyStatus" = 'pending'`. A mocked
 *                  Prisma proves the code CALLS updateMany; only Postgres
 *                  proves the guard actually excludes a claimed row, so the
 *                  sweep is run TWICE and exactly ONE NotificationLog row must
 *                  exist.
 *   CHECK        — `PmActivity_notifiedAt_matches_status` lives in raw
 *                  migration SQL because Prisma's schema language cannot
 *                  express it (the CrmActivity_subject_exactly_one precedent).
 *                  A mocked client cannot prove a database constraint.
 *   terminal     — a non-notifiable verb reaches `not_needed` with
 *                  `notifiedAt` still NULL, under the constraint, in one
 *                  statement.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, exactly like
 * team-chat-meetings.pg.test.ts. Local: scripts/test-orchestrator-pg.sh. CI:
 * the `pg-integration` job in .github/workflows/orchestrator-tests.yml.
 *
 * FIXTURE SCOPING — this DB is shared by the pg suites running in parallel.
 * Every row this file mints is namespaced `warp2560-` and every cleanup is
 * scoped to that prefix — never an unscoped deleteMany, never a TRUNCATE
 * (the access-role.pg.test.ts rule).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

// Leaf EFFECT only. Every DECISION and every write stays real — the
// NotificationLog rows this suite counts are written by the real service.
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));

import { runActivityNotifySweep, SETTLE_MS } from "../services/activity-notify.service.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const PREFIX = "warp2587-";
const OURS = { startsWith: PREFIX } as const;

describe.skipIf(!RUN)("activity notify sweep — real Postgres (WARP-2587)", () => {
  let prisma: PrismaClient;
  let actorId = "";
  let assigneeId = "";
  let workItemId = "";

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  async function cleanupOurRows() {
    const ws = await prisma.pmWorkspace.findMany({
      where: { slug: OURS },
      select: { id: true },
    });
    if (ws.length > 0) {
      await prisma.pmWorkspace.deleteMany({ where: { id: { in: ws.map((w) => w.id) } } });
    }
    await prisma.notificationLog.deleteMany({ where: { userId: OURS } });
    await prisma.user.deleteMany({ where: { username: OURS } });
  }

  beforeEach(async () => {
    await cleanupOurRows();
    const actor = await prisma.user.create({
      data: { username: `${PREFIX}actor`, displayName: "Actor" },
    });
    const assignee = await prisma.user.create({
      data: { username: `${PREFIX}assignee`, displayName: "Assignee" },
    });
    actorId = actor.id;
    assigneeId = assignee.id;

    const workspace = await prisma.pmWorkspace.create({
      data: { slug: `${PREFIX}ws`, name: "Sweep fixtures" },
    });
    const project = await prisma.pmProject.create({
      data: { workspaceId: workspace.id, name: "Sweep", identifier: "SWEEP" },
    });
    const item = await prisma.pmWorkItem.create({
      data: { projectId: project.id, sequenceId: 1, name: "Fix the leak" },
    });
    workItemId = item.id;
    await prisma.pmWorkItemAssignee.create({
      data: { workItemId, userId: assigneeId },
    });
  });

  afterAll(async () => {
    await cleanupOurRows();
    await prisma.$disconnect();
  });

  /** Backdated past the settle window so the row is a candidate immediately. */
  function settled(): Date {
    return new Date(Date.now() - SETTLE_MS - 60_000);
  }

  it("claims exactly once — two sweeps, ONE NotificationLog row", async () => {
    await prisma.pmActivity.create({
      data: {
        workItemId,
        actorId,
        verb: "assigned",
        newValue: assigneeId,
        createdAt: settled(),
      },
    });

    const first = await runActivityNotifySweep(prisma);
    expect(first.notificationsSent).toBe(1);

    // The whole point: the second run's UPDATE ... WHERE notifyStatus='pending'
    // matches nothing, so nothing is recorded. Mutation: drop the guard from
    // the claim's `where` and this goes red with 2 rows.
    const second = await runActivityNotifySweep(prisma);
    expect(second.notificationsSent).toBe(0);

    const logs = await prisma.notificationLog.findMany({
      where: { userId: `${PREFIX}assignee` },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("event");
    expect(logs[0].title).toBe("Assigned to you");

    const row = await prisma.pmActivity.findFirstOrThrow({ where: { workItemId } });
    expect(row.notifyStatus).toBe("sent");
    expect(row.notifiedAt).not.toBeNull();
  });

  it("the actor gets nothing, and the row still reaches an explicit terminal", async () => {
    // The assignee IS the actor: nobody to tell, but the row must not be left
    // pending to be rescanned every minute for the life of the table.
    await prisma.pmActivity.create({
      data: {
        workItemId,
        actorId: assigneeId,
        verb: "assigned",
        createdAt: settled(),
      },
    });
    const res = await runActivityNotifySweep(prisma);
    expect(res.notificationsSent).toBe(0);
    expect(res.pmSkipped).toBe(1);
    const row = await prisma.pmActivity.findFirstOrThrow({ where: { workItemId } });
    expect(row.notifyStatus).toBe("not_needed");
    expect(row.notifiedAt).toBeNull();
  });

  it("a non-notifiable verb reaches not_needed with notifiedAt NULL", async () => {
    await prisma.pmActivity.create({
      data: { workItemId, actorId, verb: "updated", field: "fields", createdAt: settled() },
    });
    await runActivityNotifySweep(prisma);
    const row = await prisma.pmActivity.findFirstOrThrow({ where: { workItemId } });
    expect(row.notifyStatus).toBe("not_needed");
    expect(row.notifiedAt).toBeNull();
  });

  it("PmActivity_notifiedAt_matches_status rejects 'sent' with a NULL notifiedAt", async () => {
    // Prisma cannot express this; only the database enforces it. Without the
    // CHECK, `notifiedAt` silently becomes a second, disagreeing source of
    // truth about whether a row was notified.
    const row = await prisma.pmActivity.create({
      data: { workItemId, actorId, verb: "assigned", createdAt: settled() },
    });
    await expect(
      prisma.pmActivity.update({
        where: { id: row.id },
        data: { notifyStatus: "sent" },
      }),
    ).rejects.toThrow();
  });

  it("PmActivity_notifiedAt_matches_status rejects a stamped notifiedAt on a pending row", async () => {
    const row = await prisma.pmActivity.create({
      data: { workItemId, actorId, verb: "assigned", createdAt: settled() },
    });
    await expect(
      prisma.pmActivity.update({
        where: { id: row.id },
        data: { notifiedAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});
