/**
 * WARP-3532 — the whole chain against a real Postgres and a real socket:
 *
 *   pm.service mutation → PmActivity → outbox sweep → fan-out → PmWebhookDelivery
 *     → delivery worker → signed POST → a receiver that verifies it
 *
 * plus the two things only a database can say about the queue: `FOR UPDATE SKIP
 * LOCKED` really does skip a row another transaction holds (instead of waiting
 * on it), and replaying a fan-out creates nothing.
 *
 * The SSRF guard refuses loopback, as it should, so these tests hand the worker a
 * `resolveDestination` that points at their own 127.0.0.1 receiver. What it does
 * with a real guard is `webhook-delivery.service.test.ts` and
 * `outbound-url-guard.pinned.test.ts`; what the socket does is
 * `outbound-pinned-fetch.test.ts`. This file is the integration of the rest.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PmActivity, PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

/** The documented receiver-side check (docs/work-webhooks.md). */
function verify(secret: string, body: string, header: string, nowSeconds: number): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > 300) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  const given = Buffer.from(parts.v1 ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

describe.skipIf(!RUN)("work webhooks, end to end (WARP-3532)", () => {
  let prisma: PrismaClient;
  let pm: typeof import("../services/pm/pm.service.js");
  let outbox: typeof import("../services/pm/pm-outbox.js");
  let fanout: typeof import("../services/pm/webhook-fanout.js");
  let worker: typeof import("../services/pm/webhook-delivery.service.js");
  let service: typeof import("../services/pm/pm-webhook.service.js");
  let crypto: typeof import("../services/column-crypto.service.js");

  const OURS = { startsWith: "warp3532-wh-" } as const;
  const CONSUMER = "warp3532-wh";
  let projectId = "";
  let workItemId = "";
  let stateTodo = "";
  let stateDoing = "";
  let received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    pm = await import("../services/pm/pm.service.js");
    outbox = await import("../services/pm/pm-outbox.js");
    fanout = await import("../services/pm/webhook-fanout.js");
    worker = await import("../services/pm/webhook-delivery.service.js");
    service = await import("../services/pm/pm-webhook.service.js");
    crypto = await import("../services/column-crypto.service.js");
    crypto.__setColumnCryptoKeyForTest(Buffer.alloc(32, 11).toString("base64"));

    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    crypto.__setColumnCryptoKeyForTest(null);
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await prisma.systemFlag.deleteMany({ where: { key: { startsWith: `pm-outbox:${CONSUMER}` } } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    received = [];
    await prisma.systemFlag.deleteMany({ where: { key: { startsWith: `pm-outbox:${CONSUMER}` } } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    const ws = await prisma.pmWorkspace.create({ data: { slug: `warp3532-wh-ws-${Date.now()}`, name: "warp3532-wh" } });
    const project = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3532-wh-project", identifier: "W32H" },
    });
    projectId = project.id;
    const todo = await prisma.pmState.create({ data: { projectId, name: "Todo", group: "unstarted", sortOrder: 0, isDefault: true } });
    const doing = await prisma.pmState.create({ data: { projectId, name: "Doing", group: "started", sortOrder: 1 } });
    stateTodo = todo.id;
    stateDoing = doing.id;
    const item = await prisma.pmWorkItem.create({
      data: { projectId, sequenceId: 1, name: "warp3532-wh item", stateId: stateTodo },
    });
    workItemId = item.id;
    // History before the consumer existed: it must never be replayed.
    await prisma.systemFlag.create({
      data: { key: `pm-outbox:${CONSUMER}`, valueJson: { createdAt: new Date(Date.now() - 1000).toISOString(), id: "" } },
    });
  });

  afterEach(() => outbox.stopOutbox());

  const dial = (): import("../services/pm/webhook-delivery.service.js").DeliveryDeps => ({
    resolveDestination: async (url) => ({
      url: new URL(url),
      hostname: new URL(url).hostname,
      addresses: [{ address: "127.0.0.1", family: 4 }],
      scope: "lan",
    }),
  });

  const consumer = () => ({
    ...fanout.createWebhookFanOutConsumer(prisma, { origin: async () => "https://droplet.test" }),
    name: CONSUMER,
    settleMs: 0,
  });

  const makeWebhook = (events = ["work_item.state_changed", "work_item.updated", "work_item.commented"]) =>
    service.createWebhook(prisma, "warp3532-actor", {
      name: "warp3532-wh-hook",
      // A name that does not resolve: the worker is handed the address.
      url: `http://receiver.warp3532.example:${port}/hook`,
      format: "JSON",
      events,
      projectId,
    });

  it("a change in the work reaches the receiver, signed, as payload v1 — once", async () => {
    const { webhook, secret } = await makeWebhook();

    await pm.transitionWorkItem(prisma, "warp3532-actor", workItemId, stateDoing);
    await pm.addComment(prisma, "warp3532-actor", workItemId, "<p>on it</p>");
    await pm.updateWorkItem(prisma, "warp3532-actor", workItemId, { priority: "high" });

    // 1. outbox → fan-out
    const swept = await outbox.runOutboxSweep(prisma, consumer());
    expect(swept.handled).toBeGreaterThanOrEqual(3);
    const queued = await prisma.pmWebhookDelivery.findMany({ where: { webhookId: webhook.id }, orderBy: { createdAt: "asc" } });
    expect(queued.map((d) => d.event).sort()).toEqual(["work_item.commented", "work_item.state_changed", "work_item.updated"]);
    expect(queued.every((d) => d.status === "PENDING" && d.sourceKey?.startsWith("activity:"))).toBe(true);

    // 2. worker → receiver
    const result = await worker.runWebhookDeliveries(prisma, dial());
    // The worker drains the whole shared table; this suite's three are among them.
    expect(result.delivered).toBeGreaterThanOrEqual(3);

    expect(received).toHaveLength(3);
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const req of received) {
      expect(verify(secret, req.body, String(req.headers["x-droplet-signature"]), nowSeconds)).toBe(true);
      expect(req.headers["host"]).toBe(`receiver.warp3532.example:${port}`);
      expect(req.headers["content-type"]).toBe("application/json");
      const payload = JSON.parse(req.body) as { version: number; id: string; event: string; workItem: { key: string; url: string }; project: { identifier: string } };
      expect(payload).toMatchObject({ version: 1, project: { identifier: "W32H" }, workItem: { key: "W32H-1" } });
      expect(payload.workItem.url).toBe("https://droplet.test/projects?p=W32H&item=W32H-1");
      expect(req.headers["x-droplet-event"]).toBe(payload.event);
    }
    const moved = received.map((r) => JSON.parse(r.body) as { event: string; changes: unknown[] }).find((p) => p.event === "work_item.state_changed");
    expect(moved?.changes).toEqual([{ field: "state", from: stateTodo, to: stateDoing, fromLabel: "Todo", toLabel: "Doing" }]);

    const done = await prisma.pmWebhookDelivery.findMany({ where: { webhookId: webhook.id } });
    expect(done.every((d) => d.status === "DELIVERED" && d.deliveredAt && d.attempts === 1 && d.lastStatusCode === 204)).toBe(true);

    // 3. nothing is delivered twice by running either stage again
    await outbox.runOutboxSweep(prisma, consumer());
    await worker.runWebhookDeliveries(prisma, dial());
    expect(received).toHaveLength(3);
    expect(await prisma.pmWebhookDelivery.count({ where: { webhookId: webhook.id } })).toBe(3);
  });

  it("an event nobody subscribed to creates nothing, and a disabled webhook hears nothing", async () => {
    const { webhook } = await makeWebhook(["work_item.created"]);
    await pm.transitionWorkItem(prisma, "warp3532-actor", workItemId, stateDoing);
    await outbox.runOutboxSweep(prisma, consumer());
    expect(await prisma.pmWebhookDelivery.count({ where: { webhookId: webhook.id } })).toBe(0);

    await service.updateWebhook(prisma, webhook.id, { events: ["work_item.commented"] });
    await service.updateWebhook(prisma, webhook.id, { enabled: false });
    await pm.addComment(prisma, "warp3532-actor", workItemId, "<p>x</p>");
    await outbox.runOutboxSweep(prisma, consumer());
    expect(await prisma.pmWebhookDelivery.count({ where: { webhookId: webhook.id } })).toBe(0);
  });

  it("replaying the fan-out for a row the consumer already handled creates nothing the second time", async () => {
    const { webhook } = await makeWebhook();
    await pm.transitionWorkItem(prisma, "warp3532-actor", workItemId, stateDoing);
    const [row] = await prisma.pmActivity.findMany({ where: { workItemId, verb: "state_changed" } });
    const deps = { origin: async () => "https://droplet.test" };
    expect(await fanout.fanOutActivity(prisma, row as PmActivity, deps)).toBe(1);
    expect(await fanout.fanOutActivity(prisma, row as PmActivity, deps)).toBe(0);
    expect(await prisma.pmWebhookDelivery.count({ where: { webhookId: webhook.id } })).toBe(1);
  });

  it("send-test reaches the receiver signed, and says so", async () => {
    const { webhook, secret } = await makeWebhook();
    const result = await service.sendTestDelivery(prisma, webhook.id, { id: "warp3532-actor", name: null }, dial());
    expect(result).toMatchObject({ event: "webhook.test", status: "DELIVERED", lastStatusCode: 204 });
    expect(received).toHaveLength(1);
    expect(verify(secret, received[0]!.body, String(received[0]!.headers["x-droplet-signature"]), Math.floor(Date.now() / 1000))).toBe(true);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ version: 1, event: "webhook.test", workItem: null });
  });

  it("a test in flight is not claimed by the worker: one POST however the sweep lands (review of WARP-3532)", async () => {
    const { webhook, secret } = await makeWebhook();
    const { pinnedFetch } = await import("../lib/outbound-pinned-fetch.js");

    // Hold the test's own dial open — the window in which a worker tick used to
    // find the row PENDING and due, and dial it a second time.
    let release!: () => void;
    let dialling!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (dialling = r));
    const heldSend: NonNullable<import("../services/pm/webhook-delivery.service.js").DeliveryDeps["send"]> = async (dest, req) => {
      dialling();
      await gate;
      return pinnedFetch(dest, req);
    };

    const testing = service.sendTestDelivery(prisma, webhook.id, { id: "warp3532-actor", name: null }, { ...dial(), send: heldSend });
    await started;

    const [testRow] = await prisma.pmWebhookDelivery.findMany({ where: { webhookId: webhook.id } });
    expect(testRow).toMatchObject({ event: "webhook.test", status: "PENDING" });

    // A worker sweep right now: it takes nothing of this webhook's…
    const workerSends: string[] = [];
    const sweep = await worker.runWebhookDeliveries(prisma, {
      ...dial(),
      send: (async (dest: unknown, req: { headers: Record<string, string> }) => {
        workerSends.push(req.headers["x-droplet-delivery"] ?? "");
        return pinnedFetch(dest as never, req as never);
      }) as never,
    });
    expect(workerSends).not.toContain(testRow!.id);
    // …and the claim itself, asked directly, agrees (the shared database may hold
    // other suites' due rows; only this webhook's matter).
    const claimedNow = await worker.claimDueDeliveries(prisma, new Date(), 100);
    expect(claimedNow.filter((d) => d.webhookId === webhook.id)).toEqual([]);
    expect(sweep.claimed).toBeGreaterThanOrEqual(0);

    release();
    const result = await testing;

    expect(result).toMatchObject({ event: "webhook.test", status: "DELIVERED", lastStatusCode: 204 });
    // Exactly one POST reached the receiver, and the webhook's failure streak is untouched.
    expect(received).toHaveLength(1);
    expect(verify(secret, received[0]!.body, String(received[0]!.headers["x-droplet-signature"]), Math.floor(Date.now() / 1000))).toBe(true);
    expect((await prisma.pmWebhook.findUniqueOrThrow({ where: { id: webhook.id } })).consecutiveFailures).toBe(0);
  });

  it("rotating the secret takes effect for the very next delivery", async () => {
    const { webhook, secret } = await makeWebhook();
    const rotated = await service.rotateWebhookSecret(prisma, webhook.id);
    await service.sendTestDelivery(prisma, webhook.id, { id: null, name: null }, dial());
    const header = String(received[0]!.headers["x-droplet-signature"]);
    const now = Math.floor(Date.now() / 1000);
    expect(verify(rotated.secret, received[0]!.body, header, now)).toBe(true);
    expect(verify(secret, received[0]!.body, header, now)).toBe(false);
  });

  describe("the claim, in a real database", () => {
    /** A claim takes whatever is due in the shared database; assert only on ours. */
    const ours = (claimed: Array<{ id: string; webhookId: string }>, webhookId: string) =>
      claimed.filter((d) => d.webhookId === webhookId).map((d) => d.id);

    async function seedDue(webhookId: string, n: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const row = await prisma.pmWebhookDelivery.create({
          // An hour overdue: ahead of anything another suite sharing this database
          // has made due "now", so a claim's ORDER BY reaches ours first.
          data: { webhookId, event: "work_item.created", payload: {}, nextAttemptAt: new Date(Date.now() - 3_600_000 + i) },
        });
        ids.push(row.id);
      }
      return ids;
    }

    it("SKIP LOCKED skips a row another transaction holds, instead of waiting on it", async () => {
      const { webhook } = await makeWebhook();
      const ids = await seedDue(webhook.id, 12);
      const held = ids.slice(0, 5);

      let release!: () => void;
      let locked!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const holding = new Promise<void>((r) => (locked = r));
      const other = prisma.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(`SELECT "id" FROM "PmWebhookDelivery" WHERE "id" = ANY($1::text[]) FOR UPDATE`, held);
          locked();
          await gate;
        },
        { timeout: 30_000 },
      );
      try {
        await holding;
        const started = Date.now();
        const claimed = await worker.claimDueDeliveries(prisma, new Date(), 20);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(ours(claimed, webhook.id).sort()).toEqual(ids.slice(5).sort());
        expect(claimed.some((d) => held.includes(d.id))).toBe(false);
      } finally {
        release();
        await other;
      }
    });

    it("two claimers racing never take the same row, and between them take every due row", async () => {
      const { webhook } = await makeWebhook();
      const ids = await seedDue(webhook.id, 30);
      const [a, b] = await Promise.all([
        worker.claimDueDeliveries(prisma, new Date(), 20),
        worker.claimDueDeliveries(prisma, new Date(), 20),
      ]);
      const ga = ours(a, webhook.id);
      const gb = ours(b, webhook.id);
      expect(ga.filter((id) => gb.includes(id))).toEqual([]);
      expect([...ga, ...gb].sort()).toEqual([...ids].sort());
    });

    it("a claimed row is leased: not due again until the lease ends", async () => {
      const { webhook } = await makeWebhook();
      await seedDue(webhook.id, 3);
      expect(ours(await worker.claimDueDeliveries(prisma, new Date(), 50), webhook.id)).toHaveLength(3);
      expect(ours(await worker.claimDueDeliveries(prisma, new Date(), 50), webhook.id)).toHaveLength(0);
      const later = new Date(Date.now() + worker.DELIVERY_LEASE_MS + 5_000);
      expect(ours(await worker.claimDueDeliveries(prisma, later, 50), webhook.id)).toHaveLength(3);
    });

    it("DELIVERED and GIVEN_UP rows are never claimed", async () => {
      const { webhook } = await makeWebhook();
      const [a, b] = await seedDue(webhook.id, 2);
      await prisma.pmWebhookDelivery.update({ where: { id: a! }, data: { status: "DELIVERED", deliveredAt: new Date() } });
      await prisma.pmWebhookDelivery.update({ where: { id: b! }, data: { status: "GIVEN_UP" } });
      expect(ours(await worker.claimDueDeliveries(prisma, new Date(), 50), webhook.id)).toHaveLength(0);
    });
  });
});
