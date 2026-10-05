/**
 * WARP-3532 — the invariants of PmWebhook / PmWebhookDelivery that only a real
 * database can prove.
 *
 * Seven of them live nowhere in TypeScript: five CHECK constraints, a partial
 * index and the cascade chain are all migration SQL (Prisma has no syntax for
 * the first two). A mocked Prisma happily accepts every row they reject, so a
 * green unit suite says nothing about them. Gated like the other
 * `*.pg.test.ts` files.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { fanOutActivity } from "../services/pm/webhook-fanout.js";
import { getWebhook, listDeliveries, PM_WEBHOOK_ERRORS } from "../services/pm/pm-webhook.service.js";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PmWebhook / PmWebhookDelivery — the database's own guarantees (WARP-3532)", () => {
  let prisma: PrismaClient;
  // The pg-gated suites share one throwaway database: scope every fixture.
  const OURS = { startsWith: "warp3532-hk-" } as const;
  let workspaceId = "";
  let projectId = "";

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    const ws = await prisma.pmWorkspace.create({
      data: { slug: `warp3532-hk-ws-${Date.now()}`, name: "warp3532-hk-ws" },
    });
    const project = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3532-hk-project", identifier: "W32" },
    });
    workspaceId = ws.id;
    projectId = project.id;
  });

  const webhook = (over: Record<string, unknown> = {}) =>
    prisma.pmWebhook.create({
      data: {
        workspaceId,
        name: "warp3532-hk-hook",
        urlEnc: "dcv1:sealed-webhook-url",
        secretEnc: "dcv1:test",
        events: ["work_item.created"],
        ...over,
      } as never,
    });

  const delivery = (webhookId: string, over: Record<string, unknown> = {}) =>
    prisma.pmWebhookDelivery.create({
      data: { webhookId, event: "work_item.created", payload: { id: "evt" }, ...over } as never,
    });

  // ── PmWebhook CHECK constraints ──────────────────────────────────────────

  describe("PmWebhook_enabled_matches_status — enabled ⇔ ACTIVE", () => {
    it.each([
      ["enabled but PAUSED", { enabled: true, status: "PAUSED" }],
      ["enabled but DISABLED_FAILING", { enabled: true, status: "DISABLED_FAILING" }],
      ["disabled but ACTIVE", { enabled: false, status: "ACTIVE" }],
    ])("rejects %s", async (_label, over) => {
      await expect(webhook(over)).rejects.toThrow(/PmWebhook_enabled_matches_status/);
    });

    it.each([
      ["enabled and ACTIVE", { enabled: true, status: "ACTIVE" }],
      ["disabled and PAUSED", { enabled: false, status: "PAUSED" }],
      ["disabled and DISABLED_FAILING", { enabled: false, status: "DISABLED_FAILING" }],
    ])("accepts %s", async (_label, over) => {
      await expect(webhook(over)).resolves.toBeTruthy();
    });

    it("holds on UPDATE too — flipping one column alone is refused", async () => {
      const hook = await webhook();
      await expect(
        prisma.pmWebhook.update({ where: { id: hook.id }, data: { enabled: false } }),
      ).rejects.toThrow(/PmWebhook_enabled_matches_status/);
      await expect(
        prisma.pmWebhook.update({ where: { id: hook.id }, data: { enabled: false, status: "PAUSED" } }),
      ).resolves.toBeTruthy();
    });
  });

  it("PmWebhook_events_not_empty — a webhook subscribed to nothing can never fire", async () => {
    await expect(webhook({ events: [] })).rejects.toThrow(/PmWebhook_events_not_empty/);
    await expect(webhook({ events: ["work_item.created", "sla.breached"] })).resolves.toBeTruthy();
  });

  it("PmWebhook_urlEnc_is_encrypted — plaintext destinations cannot be stored", async () => {
    await expect(webhook({ urlEnc: "https://hooks.example.com/services/plaintext-secret" })).rejects.toThrow(
      /PmWebhook_urlEnc_is_encrypted/,
    );
    await expect(webhook({ urlEnc: "dcv1:sealed-webhook-url" })).resolves.toBeTruthy();
  });

  it("PmWebhook_consecutiveFailures_nonnegative", async () => {
    await expect(webhook({ consecutiveFailures: -1 })).rejects.toThrow(
      /PmWebhook_consecutiveFailures_nonnegative/,
    );
  });

  // ── PmWebhookDelivery CHECK constraints ──────────────────────────────────

  describe("PmWebhookDelivery_deliveredAt_matches_status", () => {
    it("rejects DELIVERED without a time, and a time on anything that was not delivered", async () => {
      const hook = await webhook();
      await expect(delivery(hook.id, { status: "DELIVERED" })).rejects.toThrow(
        /PmWebhookDelivery_deliveredAt_matches_status/,
      );
      for (const status of ["PENDING", "FAILED", "GIVEN_UP"]) {
        await expect(delivery(hook.id, { status, deliveredAt: new Date() }), status).rejects.toThrow(
          /PmWebhookDelivery_deliveredAt_matches_status/,
        );
      }
    });

    it("accepts DELIVERED with a time and every other status without one", async () => {
      const hook = await webhook();
      await expect(delivery(hook.id, { status: "DELIVERED", deliveredAt: new Date() })).resolves.toBeTruthy();
      for (const status of ["PENDING", "FAILED", "GIVEN_UP"]) {
        await expect(delivery(hook.id, { status }), status).resolves.toBeTruthy();
      }
    });
  });

  it("PmWebhookDelivery_attempts_nonnegative", async () => {
    const hook = await webhook();
    await expect(delivery(hook.id, { attempts: -1 })).rejects.toThrow(/PmWebhookDelivery_attempts_nonnegative/);
  });

  // ── idempotence of the fan-out ───────────────────────────────────────────

  describe("(webhookId, sourceKey) is unique — what makes a replayed outbox row harmless", () => {
    it("refuses a second delivery of one activity to one webhook", async () => {
      const hook = await webhook();
      await delivery(hook.id, { sourceKey: "activity:warp3532-hk-1" });
      await expect(delivery(hook.id, { sourceKey: "activity:warp3532-hk-1" })).rejects.toThrow();
    });

    it("createMany with skipDuplicates makes the replay a no-op rather than an error", async () => {
      const hook = await webhook();
      const rows = [{ webhookId: hook.id, event: "work_item.created", payload: {}, sourceKey: "activity:warp3532-hk-2" }];
      expect((await prisma.pmWebhookDelivery.createMany({ data: rows, skipDuplicates: true })).count).toBe(1);
      expect((await prisma.pmWebhookDelivery.createMany({ data: rows, skipDuplicates: true })).count).toBe(0);
      expect(await prisma.pmWebhookDelivery.count({ where: { webhookId: hook.id } })).toBe(1);
    });

    it("the same activity may go to two different webhooks", async () => {
      const a = await webhook({ name: "warp3532-hk-a" });
      const b = await webhook({ name: "warp3532-hk-b" });
      await delivery(a.id, { sourceKey: "activity:warp3532-hk-3" });
      await expect(delivery(b.id, { sourceKey: "activity:warp3532-hk-3" })).resolves.toBeTruthy();
    });

    it("rows with no source (test pings, re-deliveries) are not deduplicated against each other", async () => {
      // NULL is distinct from NULL in a unique index — which is exactly what a
      // re-delivery needs, and why `sourceKey` is nullable rather than "".
      const hook = await webhook();
      await delivery(hook.id, { sourceKey: null });
      await expect(delivery(hook.id, { sourceKey: null })).resolves.toBeTruthy();
      await expect(delivery(hook.id, { sourceKey: null })).resolves.toBeTruthy();
    });
  });

  // ── cascades ─────────────────────────────────────────────────────────────

  describe("cascades", () => {
    it("deleting a webhook takes its delivery log with it", async () => {
      const hook = await webhook();
      await delivery(hook.id);
      await prisma.pmWebhook.delete({ where: { id: hook.id } });
      expect(await prisma.pmWebhookDelivery.count({ where: { webhookId: hook.id } })).toBe(0);
    });

    it("deleting a project takes ITS webhooks and their deliveries, and nobody else's", async () => {
      const scoped = await webhook({ projectId, name: "warp3532-hk-scoped" });
      const wide = await webhook({ projectId: null, name: "warp3532-hk-wide" });
      await delivery(scoped.id);
      await delivery(wide.id);

      await prisma.pmProject.delete({ where: { id: projectId } });

      expect(await prisma.pmWebhook.findUnique({ where: { id: scoped.id } })).toBeNull();
      expect(await prisma.pmWebhookDelivery.count({ where: { webhookId: scoped.id } })).toBe(0);
      // A workspace-wide webhook is not a project's to lose.
      expect(await prisma.pmWebhook.findUnique({ where: { id: wide.id } })).not.toBeNull();
      expect(await prisma.pmWebhookDelivery.count({ where: { webhookId: wide.id } })).toBe(1);
    });

    it("deleting a workspace takes every webhook in it", async () => {
      const hook = await webhook();
      await prisma.pmWorkspace.delete({ where: { id: workspaceId } });
      expect(await prisma.pmWebhook.findUnique({ where: { id: hook.id } })).toBeNull();
    });
  });

  it("a workspace Projects webhook queues a project event without a matching private ticket", async () => {
    const desk = await prisma.pmProject.create({ data: { workspaceId, kind: "SERVICE_DESK", name: "warp3532-hk-private", identifier: "W32D" } });
    const hook = await webhook();
    const events = [];
    for (const scope of [projectId, desk.id]) {
      const item = await prisma.pmWorkItem.create({ data: { projectId: scope, sequenceId: 1, name: "same matching subject", createdById: "warp3532-hk-owner" } });
      events.push(await prisma.pmActivity.create({ data: { workItemId: item.id, verb: "created" } }));
    }
    const deps = { origin: async () => "https://droplet.example" };
    expect(await fanOutActivity(prisma, events[0]!, deps)).toBe(1);
    expect(await fanOutActivity(prisma, events[1]!, deps)).toBe(0);
    const rows = await prisma.pmWebhookDelivery.findMany({ where: { webhookId: hook.id } });
    expect(rows.map((r) => r.sourceKey)).toEqual([`activity:${events[0]!.id}`]);
    expect(JSON.stringify(rows)).not.toContain(desk.id);
  });

  it("legacy desk-scoped hooks cannot expose their settings or delivery log through Projects", async () => {
    const desk = await prisma.pmProject.create({ data: { workspaceId, kind: "SERVICE_DESK", name: "warp3532-hk-private", identifier: "W32D" } });
    const hook = await webhook({ projectId: desk.id });
    await delivery(hook.id, { payload: { private: "customer conversation" } });
    await expect(getWebhook(prisma, hook.id)).rejects.toThrow(PM_WEBHOOK_ERRORS.NOT_FOUND);
    await expect(listDeliveries(prisma, hook.id)).rejects.toThrow(PM_WEBHOOK_ERRORS.NOT_FOUND);
  });

  // ── indexes ──────────────────────────────────────────────────────────────

  describe("indexes", () => {
    it("PmWebhookDelivery_due_idx is partial: DELIVERED and GIVEN_UP rows are not in it", async () => {
      const [row] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'PmWebhookDelivery' AND indexname = 'PmWebhookDelivery_due_idx'`;
      expect(row?.indexdef).toMatch(/\("nextAttemptAt"\)/);
      expect(row?.indexdef).toMatch(/WHERE .*status.*(PENDING|FAILED)/s);
      expect(row?.indexdef).not.toMatch(/DELIVERED|GIVEN_UP/);
    });

    it("the worker's due-scan can use it", async () => {
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
          `EXPLAIN SELECT "id" FROM "PmWebhookDelivery"
           WHERE "status" IN ('PENDING', 'FAILED') AND "nextAttemptAt" <= now()
           ORDER BY "nextAttemptAt" LIMIT 20`,
        );
      });
      expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain("PmWebhookDelivery_due_idx");
    });

    it("PmActivity_createdAt_id_idx serves the outbox cursor's read", async () => {
      const [index] = await prisma.$queryRaw<Array<{ indexdef: string; valid: boolean; ready: boolean }>>`
        SELECT pg_get_indexdef(indexrelid) AS indexdef, indisvalid AS valid, indisready AS ready
        FROM pg_index
        WHERE indexrelid = to_regclass('"PmActivity_createdAt_id_idx"')
          AND indrelid = '"PmActivity"'::regclass`;
      expect(index).toEqual({
        indexdef: expect.stringMatching(/USING btree \("createdAt", id\)$/),
        valid: true,
        ready: true,
      });
      const plan = await prisma.$transaction(async (tx) => {
        // Prove the index can supply the cursor's ORDER BY without a sort.
        // Tiny fixtures may otherwise favor a different index plus a cheap
        // sort; that cost choice says nothing about the outbox index's support.
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        await tx.$executeRawUnsafe("SET LOCAL enable_sort = off");
        await tx.$executeRawUnsafe("SET LOCAL enable_incremental_sort = off");
        return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
          `EXPLAIN SELECT * FROM "PmActivity"
           WHERE ("createdAt" > now() - interval '1 day'
             OR ("createdAt" = now() - interval '1 day' AND "id" > 'x'))
             AND "createdAt" <= now() - interval '6 seconds'
           ORDER BY "createdAt" ASC, "id" ASC LIMIT 100`,
        );
      });
      const explain = plan.map((r) => r["QUERY PLAN"]).join("\n");
      expect(explain).toContain("PmActivity_createdAt_id_idx");
      expect(explain).not.toMatch(/\bSort\b/);
    });
  });
});
