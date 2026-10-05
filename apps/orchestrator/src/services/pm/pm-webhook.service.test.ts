/**
 * WARP-3532 — webhook management: what a read shows, what a write refuses, and
 * what is returned exactly once. In-memory Prisma.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PmWebhook, PmWebhookDelivery } from "@prisma/client";
import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import {
  PM_WEBHOOK_ERRORS,
  PM_WEBHOOK_LIMIT,
  createWebhook,
  deleteWebhook,
  destinationOf,
  getWebhook,
  listDeliveries,
  listWebhooks,
  redeliver,
  rotateWebhookSecret,
  sendTestDelivery,
  updateWebhook,
} from "./pm-webhook.service.js";
import { openWebhookSecret } from "./webhook-secret.js";
import { openWebhookUrl } from "./webhook-url.js";
import { DELIVERY_LEASE_MS, type DeliveryDeps } from "./webhook-delivery.service.js";

const KEY = Buffer.alloc(32, 5).toString("base64");
const T0 = new Date("2026-10-04T12:00:00.000Z");
const WS = { id: "ws-1", slug: "home", name: "Home", createdAt: T0, updatedAt: T0 };

beforeEach(() => __setColumnCryptoKeyForTest(KEY));
afterEach(() => __setColumnCryptoKeyForTest(null));

function makePrisma(opts: { projects?: Record<string, string>; deliveries?: PmWebhookDelivery[] } = {}) {
  const hooks: PmWebhook[] = [];
  const deliveries: PmWebhookDelivery[] = [...(opts.deliveries ?? [])];
  let seq = 0;
  const prisma = {
    hooks,
    deliveries,
    pmWorkspace: {
      upsert: vi.fn(async () => WS),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === WS.id ? WS : null)),
    },
    pmProject: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        opts.projects?.[where.id] ? { workspaceId: opts.projects[where.id] } : null,
      ),
    },
    pmWebhook: {
      count: vi.fn(async ({ where }: { where: { workspaceId: string } }) =>
        hooks.filter((h) => h.workspaceId === where.workspaceId).length,
      ),
      create: vi.fn(async ({ data }: { data: Partial<PmWebhook> }) => {
        const row = {
          enabled: true, status: "ACTIVE", consecutiveFailures: 0, createdAt: T0, updatedAt: T0,
          ...data,
        } as PmWebhook;
        hooks.push(row);
        return row;
      }),
      findMany: vi.fn(async () => [...hooks]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => hooks.find((h) => h.id === where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = hooks.find((h) => h.id === where.id) as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(data)) {
          if (k === "project") row.projectId = (v as { connect?: { id: string } }).connect?.id ?? null;
          else row[k] = v;
        }
        return row as unknown as PmWebhook;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        hooks.splice(hooks.findIndex((h) => h.id === where.id), 1);
      }),
    },
    pmWebhookDelivery: {
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
        deliveries
          .filter((d) => d.webhookId === where.webhookId)
          .filter((d) => {
            const or = where.OR as Array<Record<string, unknown>> | undefined;
            if (!or) return true;
            const lt = (or[0]!.createdAt as { lt: Date }).lt;
            return d.createdAt < lt || (d.createdAt.getTime() === lt.getTime() && d.id < (or[1]!.id as { lt: string }).lt);
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
          .slice(0, take),
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string; webhookId: string } }) =>
        deliveries.find((d) => d.id === where.id && d.webhookId === where.webhookId) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Partial<PmWebhookDelivery> }) => {
        seq += 1;
        const row = {
          id: `new-${seq}`, status: "PENDING", attempts: 0, lastStatusCode: null, lastError: null,
          createdAt: T0, deliveredAt: null, sourceKey: null, ...data,
        } as PmWebhookDelivery;
        deliveries.push(row);
        return row;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = deliveries.find((d) => d.id === where.id);
        if (!row) throw new Error("missing");
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = deliveries.find((d) => d.id === where.id) as unknown as Record<string, unknown> | undefined;
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      }),
    },
    $queryRaw: vi.fn(async () => [] as unknown[]),
  };
  return prisma;
}

const good = {
  name: "Team chat",
  url: "https://hooks.example.com/services/T0/B0/very-secret-token",
  format: "SLACK" as const,
  events: ["work_item.created", "work_item.state_changed"],
};

describe("createWebhook", () => {
  it("returns the signing secret once and seals both credentials at rest", async () => {
    const prisma = makePrisma();
    const { webhook, secret } = await createWebhook(prisma as never, "u-1", good);

    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const row = prisma.hooks[0]!;
    expect(row.secretEnc.startsWith("dcv1:")).toBe(true);
    expect(row.urlEnc.startsWith("dcv1:")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain("very-secret-token");
    expect(openWebhookSecret(row.id, row.secretEnc)).toBe(secret);
    expect(openWebhookUrl(row.id, row.urlEnc)).toBe(good.url);
    expect(() => openWebhookUrl("different-webhook", row.urlEnc)).toThrow();
    expect(webhook).not.toHaveProperty("secret");
    expect(webhook).not.toHaveProperty("secretEnc");
    expect(row).toMatchObject({ workspaceId: "ws-1", projectId: null, createdById: "u-1", format: "SLACK" });
  });

  it("shows the destination, never the path — a chat app's webhook URL is the credential", async () => {
    const prisma = makePrisma();
    const { webhook } = await createWebhook(prisma as never, null, good);
    expect(webhook.destination).toBe("https://hooks.example.com");
    expect(JSON.stringify(webhook)).not.toContain("very-secret-token");
    expect(JSON.stringify(await getWebhook(prisma as never, webhook.id))).not.toContain("very-secret-token");
    expect(JSON.stringify(await listWebhooks(prisma as never))).not.toContain("very-secret-token");
  });

  it.each([
    ["loopback", "http://127.0.0.1:8080/x"],
    ["localhost", "http://localhost:3000/x"],
    ["the metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["IPv6 loopback", "http://[::1]/x"],
    ["a file URL", "file:///etc/passwd"],
    ["credentials in the URL", "https://user:pass@hooks.example.com/x"],
    ["not a URL", "hooks.example.com/x"],
    ["an .internal name", "http://metadata.google.internal/x"],
  ])("refuses %s with one fixed code that names no rule", async (_label, url) => {
    const prisma = makePrisma();
    await expect(createWebhook(prisma as never, null, { ...good, url })).rejects.toThrow(
      PM_WEBHOOK_ERRORS.BLOCKED_DESTINATION,
    );
    expect(prisma.hooks).toHaveLength(0);
  });

  it("accepts a destination on the LAN", async () => {
    const { webhook } = await createWebhook(makePrisma() as never, null, {
      ...good,
      url: "http://192.168.1.20:5678/webhook/abc",
    });
    expect(webhook.destination).toBe("http://192.168.1.20:5678");
  });

  it.each([
    ["no events", []],
    ["an unknown event", ["work_item.exploded"]],
    ["a reserved ticket event", ["ticket.created"]],
    ["a reserved SLA event", ["sla.breached"]],
    ["a known event beside an unknown one", ["work_item.created", "nope"]],
  ])("refuses %s", async (_label, events) => {
    await expect(createWebhook(makePrisma() as never, null, { ...good, events })).rejects.toThrow(
      PM_WEBHOOK_ERRORS.INVALID_EVENTS,
    );
  });

  it("stores each event once", async () => {
    const prisma = makePrisma();
    const { webhook } = await createWebhook(prisma as never, null, {
      ...good,
      events: ["work_item.created", "work_item.created"],
    });
    expect(webhook.events).toEqual(["work_item.created"]);
  });

  it("scopes to a project, taking its workspace from the project", async () => {
    const prisma = makePrisma({ projects: { "p-1": "ws-9" } });
    const { webhook } = await createWebhook(prisma as never, null, { ...good, projectId: "p-1" });
    expect(webhook).toMatchObject({ projectId: "p-1", workspaceId: "ws-9" });
  });

  it("refuses a project that does not exist", async () => {
    await expect(
      createWebhook(makePrisma() as never, null, { ...good, projectId: "ghost" }),
    ).rejects.toThrow(PM_WEBHOOK_ERRORS.PROJECT_NOT_FOUND);
  });

  it(`stops at ${PM_WEBHOOK_LIMIT} per workspace`, async () => {
    const prisma = makePrisma();
    prisma.pmWebhook.count.mockResolvedValue(PM_WEBHOOK_LIMIT);
    await expect(createWebhook(prisma as never, null, good)).rejects.toThrow(PM_WEBHOOK_ERRORS.LIMIT_REACHED);
  });
});

describe("updateWebhook", () => {
  async function seeded() {
    const prisma = makePrisma({ projects: { "p-1": "ws-1", "p-9": "ws-9" } });
    const { webhook } = await createWebhook(prisma as never, null, good);
    return { prisma, id: webhook.id };
  }

  it("pauses and resumes with enabled and status moving together (the table holds enabled ⇔ ACTIVE)", async () => {
    const { prisma, id } = await seeded();
    expect(await updateWebhook(prisma as never, id, { enabled: false })).toMatchObject({ enabled: false, status: "PAUSED" });
    prisma.hooks[0]!.consecutiveFailures = 12;
    const resumed = await updateWebhook(prisma as never, id, { enabled: true });
    expect(resumed).toMatchObject({ enabled: true, status: "ACTIVE", consecutiveFailures: 0 });
  });

  it("resuming a webhook the box turned off forgives its failure count", async () => {
    const { prisma, id } = await seeded();
    Object.assign(prisma.hooks[0]!, { status: "DISABLED_FAILING", enabled: false, consecutiveFailures: 20 });
    expect(await updateWebhook(prisma as never, id, { enabled: true })).toMatchObject({
      status: "ACTIVE", enabled: true, consecutiveFailures: 0,
    });
  });

  it("re-vets a new address, and leaves the old one alone when none is sent", async () => {
    const { prisma, id } = await seeded();
    await expect(updateWebhook(prisma as never, id, { url: "http://127.0.0.1/x" })).rejects.toThrow(
      PM_WEBHOOK_ERRORS.BLOCKED_DESTINATION,
    );
    const before = prisma.hooks[0]!.urlEnc;
    await updateWebhook(prisma as never, id, { name: "Renamed" });
    expect(prisma.hooks[0]!.urlEnc).toBe(before);
    expect(prisma.hooks[0]!.name).toBe("Renamed");
    await updateWebhook(prisma as never, id, { url: "https://other.example.com/hook" });
    expect(destinationOf(openWebhookUrl(id, prisma.hooks[0]!.urlEnc))).toBe("https://other.example.com");
  });

  it("validates events on edit too", async () => {
    const { prisma, id } = await seeded();
    await expect(updateWebhook(prisma as never, id, { events: ["ticket.created"] })).rejects.toThrow(
      PM_WEBHOOK_ERRORS.INVALID_EVENTS,
    );
  });

  it("narrows to a project in its own workspace and widens back with null", async () => {
    const { prisma, id } = await seeded();
    expect((await updateWebhook(prisma as never, id, { projectId: "p-1" })).projectId).toBe("p-1");
    expect((await updateWebhook(prisma as never, id, { projectId: null })).projectId).toBeNull();
  });

  it("will not re-scope to another workspace's project — that is moving it, not editing it", async () => {
    const { prisma, id } = await seeded();
    await expect(updateWebhook(prisma as never, id, { projectId: "p-9" })).rejects.toThrow(
      PM_WEBHOOK_ERRORS.PROJECT_NOT_FOUND,
    );
  });

  it("404s on a webhook that is not there", async () => {
    await expect(updateWebhook(makePrisma() as never, "ghost", { name: "x" })).rejects.toThrow(
      PM_WEBHOOK_ERRORS.NOT_FOUND,
    );
  });
});

describe("rotateWebhookSecret and deleteWebhook", () => {
  it("rotation returns a new secret once; the old one stops opening", async () => {
    const prisma = makePrisma();
    const created = await createWebhook(prisma as never, null, good);
    const { secret } = await rotateWebhookSecret(prisma as never, created.webhook.id);
    expect(secret).not.toBe(created.secret);
    const row = prisma.hooks[0]!;
    expect(openWebhookSecret(row.id, row.secretEnc)).toBe(secret);
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("delete removes it and hands back what it removed (for the audit row)", async () => {
    const prisma = makePrisma();
    const { webhook } = await createWebhook(prisma as never, null, good);
    expect((await deleteWebhook(prisma as never, webhook.id)).name).toBe("Team chat");
    expect(prisma.hooks).toHaveLength(0);
    await expect(deleteWebhook(prisma as never, webhook.id)).rejects.toThrow(PM_WEBHOOK_ERRORS.NOT_FOUND);
  });
});

describe("listWebhooks", () => {
  it("attaches each webhook's latest delivery from ONE query", async () => {
    const prisma = makePrisma();
    const a = (await createWebhook(prisma as never, null, good)).webhook;
    await createWebhook(prisma as never, null, { ...good, name: "Second" });
    prisma.$queryRaw.mockResolvedValue([
      { webhookId: a.id, status: "DELIVERED", createdAt: T0, lastStatusCode: 200 },
    ]);
    const list = await listWebhooks(prisma as never);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(list.map((w) => w.lastDelivery)).toEqual([
      { status: "DELIVERED", at: T0.toISOString(), statusCode: 200 },
      null,
    ]);
  });

  it("is empty without touching the delivery table when there are no webhooks", async () => {
    const prisma = makePrisma();
    expect(await listWebhooks(prisma as never)).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

function delivery(over: Partial<PmWebhookDelivery>): PmWebhookDelivery {
  return {
    id: "d", webhookId: "w", event: "work_item.created", sourceKey: null,
    payload: { workItem: { key: "ENG-12", name: "Fix  the\nlogin bug" } } as never,
    status: "DELIVERED", attempts: 1, nextAttemptAt: T0, lastStatusCode: 200, lastError: null,
    createdAt: T0, deliveredAt: T0, ...over,
  } as PmWebhookDelivery;
}

describe("listDeliveries", () => {
  async function withLog(n: number) {
    const rows = Array.from({ length: n }, (_, i) =>
      delivery({ id: `d-${String(i).padStart(2, "0")}`, webhookId: "", createdAt: new Date(T0.getTime() + i * 1000) }),
    );
    const prisma = makePrisma({ deliveries: rows });
    const { webhook } = await createWebhook(prisma as never, null, good);
    rows.forEach((r) => (r.webhookId = webhook.id));
    return { prisma, id: webhook.id };
  }

  it("pages newest first with a cursor that resumes exactly where it stopped", async () => {
    const { prisma, id } = await withLog(5);
    const first = await listDeliveries(prisma as never, id, { limit: 2 });
    expect(first.deliveries.map((d) => d.id)).toEqual(["d-04", "d-03"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listDeliveries(prisma as never, id, { limit: 2, cursor: first.nextCursor! });
    expect(second.deliveries.map((d) => d.id)).toEqual(["d-02", "d-01"]);
    const third = await listDeliveries(prisma as never, id, { limit: 2, cursor: second.nextCursor! });
    expect(third.deliveries.map((d) => d.id)).toEqual(["d-00"]);
    expect(third.nextCursor).toBeNull();
  });

  it("summarises the subject on one line, and never returns the payload", async () => {
    const { prisma, id } = await withLog(1);
    const [row] = (await listDeliveries(prisma as never, id)).deliveries;
    expect(row?.subject).toBe("ENG-12 · Fix the login bug");
    expect(row).not.toHaveProperty("payload");
  });

  it("ignores a cursor that is not one", async () => {
    const { prisma, id } = await withLog(2);
    expect((await listDeliveries(prisma as never, id, { cursor: "nonsense" })).deliveries).toHaveLength(2);
  });

  it("404s for a webhook that is not there", async () => {
    await expect(listDeliveries(makePrisma() as never, "ghost")).rejects.toThrow(PM_WEBHOOK_ERRORS.NOT_FOUND);
  });
});

describe("redeliver", () => {
  it("queues the same event again as a NEW row, leaving the original in the log", async () => {
    const original = delivery({ id: "orig", webhookId: "", status: "GIVEN_UP", payload: { id: "evt-9", version: 1 } as never });
    const prisma = makePrisma({ deliveries: [original] });
    const { webhook } = await createWebhook(prisma as never, null, good);
    original.webhookId = webhook.id;

    const again = await redeliver(prisma as never, webhook.id, "orig");

    expect(again.id).not.toBe("orig");
    expect(again.status).toBe("PENDING");
    expect(prisma.deliveries).toHaveLength(2);
    expect(prisma.deliveries[0]).toMatchObject({ id: "orig", status: "GIVEN_UP" });
    expect(prisma.deliveries[1]).toMatchObject({ event: "work_item.created", payload: { id: "evt-9", version: 1 }, sourceKey: null });
  });

  it("will not redeliver another webhook's row", async () => {
    const prisma = makePrisma({ deliveries: [delivery({ id: "orig", webhookId: "other" })] });
    const { webhook } = await createWebhook(prisma as never, null, good);
    await expect(redeliver(prisma as never, webhook.id, "orig")).rejects.toThrow(PM_WEBHOOK_ERRORS.DELIVERY_NOT_FOUND);
  });
});

describe("sendTestDelivery", () => {
  const okDeps = (over: Partial<DeliveryDeps> = {}): DeliveryDeps => ({
    now: () => T0,
    resolveDestination: async () => ({
      url: new URL("https://hooks.example.com/x"),
      hostname: "hooks.example.com",
      addresses: [{ address: "93.184.216.34", family: 4 }],
      scope: "public",
    }),
    send: (async () => ({ status: 200 })) as never,
    gate: async () => true,
    notifyAdmins: async () => undefined,
    logger: { warn: vi.fn(), error: vi.fn() },
    ...over,
  });

  it("sends now, through the same dial as a real delivery, and reports the result", async () => {
    const prisma = makePrisma();
    const { webhook } = await createWebhook(prisma as never, null, good);
    const send = vi.fn(async () => ({ status: 200 }));

    const result = await sendTestDelivery(prisma as never, webhook.id, { id: "u-1", name: "Ana Cruz" }, okDeps({ send: send as never }));

    expect(send).toHaveBeenCalledTimes(1);
    const body = (send.mock.calls[0] as unknown as [unknown, { body: string }])[1].body;
    expect(body).toContain("Work notifications is connected"); // Slack rendering of the test message
    expect(result).toMatchObject({ event: "webhook.test", status: "DELIVERED", lastStatusCode: 200, subject: null });
    expect(prisma.deliveries[0]).toMatchObject({ event: "webhook.test", sourceKey: null });
  });

  it("says why when the egress switch is off, and queues nothing for later", async () => {
    const prisma = makePrisma();
    const { webhook } = await createWebhook(prisma as never, null, good);
    const result = await sendTestDelivery(prisma as never, webhook.id, { id: null, name: null }, okDeps({ gate: async () => false }));
    expect(result).toMatchObject({ status: "GIVEN_UP", lastError: "Blocked by egress setting" });
  });

  it("reports a refusal from the receiver without retrying it", async () => {
    const prisma = makePrisma();
    const { webhook } = await createWebhook(prisma as never, null, good);
    const result = await sendTestDelivery(prisma as never, webhook.id, { id: null, name: null }, okDeps({ send: (async () => ({ status: 404 })) as never }));
    expect(result).toMatchObject({ status: "GIVEN_UP", attempts: 1, lastStatusCode: 404, lastError: "HTTP 404" });
  });
});

describe("sendTestDelivery and the delivery worker (review of WARP-3532)", () => {
  it("creates the test row already leased, so the worker's claim cannot take it while the test is in flight", async () => {
    const prisma = makePrisma();
    const { webhook } = await createWebhook(prisma as never, null, good);
    await sendTestDelivery(prisma as never, webhook.id, { id: null, name: null }, {
      now: () => T0,
      resolveDestination: async () => ({
        url: new URL("https://hooks.example.com/x"),
        hostname: "hooks.example.com",
        addresses: [{ address: "93.184.216.34", family: 4 }],
        scope: "public",
      }),
      send: (async () => ({ status: 200 })) as never,
      gate: async () => true,
      notifyAdmins: async () => undefined,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    // The claim selects `nextAttemptAt <= now`: a row due "now" is claimable, a row
    // due one lease from now is not. Read what the insert asked for — the settle
    // that follows rewrites the field.
    const asked = prisma.pmWebhookDelivery.create.mock.calls[0]![0] as { data: { nextAttemptAt: Date } };
    expect(asked.data.nextAttemptAt).toEqual(new Date(T0.getTime() + DELIVERY_LEASE_MS));
  });
});
