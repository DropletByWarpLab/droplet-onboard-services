/**
 * WARP-3532 — the delivery worker, against an in-memory Prisma that interprets
 * exactly the statements it issues. What only Postgres can prove — `FOR UPDATE
 * SKIP LOCKED` really keeps two claimers apart, the CHECKs hold — is
 * `__tests__/pm-webhook.pg.test.ts` and `pm-webhook-delivery.pg.test.ts`.
 *
 * The rows that carry the ticket's acceptance criteria:
 *   - signature verified under the documented algorithm;
 *   - egress switch off: an off-LAN delivery stays PENDING with a clear
 *     "Blocked by egress setting", a LAN one proceeds;
 *   - the retry ladder 1m, 5m, 30m, 2h, 6h, 12h, 24h, and the 20-failure disable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { PmWebhook, PmWebhookDelivery } from "@prisma/client";
import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import {
  BLOCKED_RECHECK_MS,
  DELIVERY_ERRORS,
  DELIVERY_EXPIRY_MS,
  DELIVERY_LEASE_MS,
  DELIVERY_RETENTION_MS,
  DISABLE_AFTER_FAILURES,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  attemptDelivery,
  claimDueDeliveries,
  describeFailure,
  pruneWebhookDeliveries,
  resolveDeliveryDeps,
  runWebhookDeliveries,
  type DeliveryDeps,
  type DeliveryWithWebhook,
} from "./webhook-delivery.service.js";
import { OutboundUrlBlockedError, resolvePinnedDestination, type PinnedDestination } from "../../lib/outbound-url-guard.js";
import { buildWorkItemPayload } from "./webhook-payload.js";
import { renderWebhookBody } from "./webhook-formats.js";
import { sealWebhookSecret } from "./webhook-secret.js";
import { sealWebhookUrl } from "./webhook-url.js";

const KEY = Buffer.alloc(32, 3).toString("base64");
const SECRET = "whsec_unit-test-secret";
const T0 = new Date("2026-10-04T12:00:00.000Z");

// ── an in-memory Prisma for exactly these statements ────────────────────────

type Where = Record<string, unknown>;

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
    const c = cond as Record<string, unknown>;
    if ("in" in c) return (c.in as unknown[]).includes(actual);
    if ("gte" in c) return (actual as number) >= (c.gte as number);
    if ("gt" in c) return (actual as number) > (c.gt as number);
    if ("lt" in c) return (actual as Date).getTime() < (c.lt as Date).getTime();
    if ("lte" in c) return (actual as Date).getTime() <= (c.lte as Date).getTime();
  }
  return actual === cond;
}
const matches = (row: object, where: Where): boolean =>
  Object.entries(where).every(([k, v]) => matchValue((row as Record<string, unknown>)[k], v));

function applyData(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === "object" && !(v instanceof Date) && "increment" in (v as object)) {
      row[k] = (row[k] as number) + ((v as { increment: number }).increment);
    } else {
      row[k] = v;
    }
  }
}

function makeHook(over: Partial<PmWebhook> = {}): PmWebhook {
  const id = over.id ?? "hook-1";
  return {
    id,
    workspaceId: "ws-1",
    projectId: null,
    name: "Team chat",
    urlEnc: sealWebhookUrl(id, "https://hooks.example.com/services/T0/B0/xyz"),
    format: "JSON",
    secretEnc: sealWebhookSecret(id, SECRET),
    events: ["work_item.created"],
    enabled: true,
    status: "ACTIVE",
    consecutiveFailures: 0,
    createdById: "u-1",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  } as PmWebhook;
}

const PAYLOAD = buildWorkItemPayload({
  eventId: "evt-1",
  event: "work_item.created",
  occurredAt: T0,
  origin: "https://droplet.example",
  workspace: { id: "ws-1", slug: "home", name: "Home" },
  project: { id: "p-1", identifier: "ENG", name: "Engineering" },
  item: {
    id: "wi-1", sequenceId: 12, name: "Fix the login bug", priority: "high",
    startDate: null, dueDate: null, state: null, assignees: [],
  },
  actor: { id: "u-1", name: "Ana Cruz" },
  activity: { field: null, oldValue: null, newValue: null },
  userNames: new Map(),
  stateNames: new Map(),
});

function makeDelivery(over: Partial<PmWebhookDelivery> = {}): PmWebhookDelivery {
  return {
    id: over.id ?? "d-1",
    webhookId: "hook-1",
    event: "work_item.created",
    sourceKey: "activity:evt-1",
    payload: PAYLOAD as never,
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: T0,
    lastStatusCode: null,
    lastError: null,
    createdAt: T0,
    deliveredAt: null,
    ...over,
  } as PmWebhookDelivery;
}

function makePrisma(hooks: PmWebhook[], deliveries: PmWebhookDelivery[]) {
  const hookRows = hooks.map((h) => ({ ...h })) as unknown as Array<Record<string, unknown>>;
  const deliveryRows = deliveries.map((d) => ({ ...d })) as unknown as Array<Record<string, unknown>>;
  const deliveryTable = {
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      const hit = deliveryRows.filter((r) => matches(r, where));
      hit.forEach((r) => applyData(r, data));
      return { count: hit.length };
    }),
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      deliveryRows
        .filter((r) => matches(r, where))
        .map((r) => ({ ...r, webhook: { ...hookRows.find((h) => h.id === r.webhookId) } })),
    ),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const keep = deliveryRows.filter((r) => !matches(r, where));
      const count = deliveryRows.length - keep.length;
      deliveryRows.splice(0, deliveryRows.length, ...keep);
      return { count };
    }),
  };
  const tx = {
    // `$queryRaw` tagged template: (strings, now, limit). The real SQL is the pg test's.
    $queryRaw: vi.fn(async (_s: TemplateStringsArray, now: Date, limit: number) =>
      deliveryRows
        .filter((r) => (r.status === "PENDING" || r.status === "FAILED") && (r.nextAttemptAt as Date) <= now)
        .sort((a, b) => (a.nextAttemptAt as Date).getTime() - (b.nextAttemptAt as Date).getTime())
        .slice(0, limit)
        .map((r) => ({ id: r.id as string })),
    ),
    pmWebhookDelivery: deliveryTable,
  };
  const prisma = {
    hookRows,
    deliveryRows,
    pmWebhook: {
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const hit = hookRows.filter((r) => matches(r, where));
        hit.forEach((r) => applyData(r, data));
        return { count: hit.length };
      }),
    },
    pmWebhookDelivery: deliveryTable,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return prisma;
}

const hookOf = (p: ReturnType<typeof makePrisma>, id = "hook-1") =>
  p.hookRows.find((h) => h.id === id) as unknown as PmWebhook;
const deliveryOf = (p: ReturnType<typeof makePrisma>, id = "d-1") =>
  p.deliveryRows.find((d) => d.id === id) as unknown as PmWebhookDelivery;
const claimed = (p: ReturnType<typeof makePrisma>, id = "d-1"): DeliveryWithWebhook =>
  ({ ...deliveryOf(p, id), webhook: hookOf(p) }) as DeliveryWithWebhook;

// ── dependencies ─────────────────────────────────────────────────────────────

const destination = (scope: "lan" | "public", url = "https://hooks.example.com/services/T0/B0/xyz"): PinnedDestination => ({
  url: new URL(url),
  hostname: new URL(url).hostname,
  addresses: [{ address: scope === "lan" ? "192.168.1.20" : "93.184.216.34", family: 4 }],
  scope,
});

function deps(over: Partial<DeliveryDeps> & { scope?: "lan" | "public"; at?: () => Date } = {}) {
  const send = vi.fn(async () => ({ status: 200 }));
  const gate = vi.fn(async () => true);
  const notifyAdmins = vi.fn(async () => undefined);
  const logger = { warn: vi.fn(), error: vi.fn() };
  const { scope = "public", at, ...rest } = over;
  const all: DeliveryDeps = {
    now: at ?? (() => T0),
    resolveDestination: async () => destination(scope),
    send: send as never,
    gate,
    notifyAdmins,
    logger,
    ...rest,
  };
  // Hand back what is ACTUALLY wired in, so a test that overrides `gate` or
  // `send` asserts on its own mock rather than the unused default.
  return {
    all,
    send: all.send as unknown as typeof send,
    gate: all.gate as unknown as typeof gate,
    notifyAdmins: all.notifyAdmins as unknown as typeof notifyAdmins,
    logger,
  };
}

const run = (prisma: ReturnType<typeof makePrisma>, d: DeliveryDeps, delivery = claimed(prisma), mode: { test?: boolean } = {}) =>
  attemptDelivery(prisma as never, delivery, mode, resolveDeliveryDeps(prisma as never, d));

beforeEach(() => __setColumnCryptoKeyForTest(KEY));
afterEach(() => __setColumnCryptoKeyForTest(null));

// ── delivery and signature ───────────────────────────────────────────────────

describe("a delivery that works", () => {
  it("signs the exact body under the documented algorithm and marks the row DELIVERED", async () => {
    const prisma = makePrisma([makeHook()], [makeDelivery()]);
    const { all, send } = deps();

    expect(await run(prisma, all)).toBe("delivered");

    expect(send).toHaveBeenCalledTimes(1);
    const [dest, req] = send.mock.calls[0] as unknown as [PinnedDestination, { headers: Record<string, string>; body: string }];
    expect(dest.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    // Documented: X-Droplet-Signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>
    const t = Math.floor(T0.getTime() / 1000);
    const mac = createHmac("sha256", SECRET).update(`${t}.${req.body}`).digest("hex");
    expect(req.headers["x-droplet-signature"]).toBe(`t=${t},v1=${mac}`);
    expect(req.headers["x-droplet-event"]).toBe("work_item.created");
    expect(req.headers["x-droplet-delivery"]).toBe("d-1");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toBe(JSON.stringify(PAYLOAD));

    expect(deliveryOf(prisma)).toMatchObject({
      status: "DELIVERED", attempts: 1, lastStatusCode: 200, lastError: null, deliveredAt: T0,
    });
  });

  it("renders the stored payload into the webhook's chat format at send time", async () => {
    const prisma = makePrisma([makeHook({ format: "SLACK" })], [makeDelivery()]);
    const { all, send } = deps();
    await run(prisma, all);
    const req = (send.mock.calls[0] as unknown as [unknown, { body: string }])[1];
    expect(req.body).toBe(renderWebhookBody("SLACK", PAYLOAD));
    expect(req.body).toContain("ENG-12");
  });

  it("accepts any 2xx", async () => {
    for (const status of [200, 201, 202, 204]) {
      const prisma = makePrisma([makeHook()], [makeDelivery()]);
      const { all } = deps({ send: (async () => ({ status })) as never });
      expect(await run(prisma, all), String(status)).toBe("delivered");
    }
  });

  it("forgives the webhook's failure streak", async () => {
    const prisma = makePrisma([makeHook({ consecutiveFailures: 7 })], [makeDelivery()]);
    await run(prisma, deps().all);
    expect(hookOf(prisma).consecutiveFailures).toBe(0);
  });
});

// ── the egress switch ────────────────────────────────────────────────────────

describe("the work_integrations egress switch", () => {
  it("off, destination OFF the LAN: stays PENDING with a clear error, nothing is attempted or counted", async () => {
    const prisma = makePrisma([makeHook()], [makeDelivery()]);
    const { all, send } = deps({ scope: "public", gate: async () => false });

    expect(await run(prisma, all)).toBe("blocked");

    expect(send).not.toHaveBeenCalled();
    expect(deliveryOf(prisma)).toMatchObject({
      status: "PENDING",
      attempts: 0,
      lastError: "Blocked by egress setting",
      nextAttemptAt: new Date(T0.getTime() + BLOCKED_RECHECK_MS),
    });
    expect(hookOf(prisma).consecutiveFailures).toBe(0);
  });

  it("off, destination on the LAN: proceeds, and never even asks the switch", async () => {
    const prisma = makePrisma([makeHook({ urlEnc: sealWebhookUrl("hook-1", "http://192.168.1.20:5678/webhook/x") })], [makeDelivery()]);
    const { all, send, gate } = deps({ scope: "lan", gate: vi.fn(async () => false) });

    expect(await run(prisma, all)).toBe("delivered");

    expect(send).toHaveBeenCalledTimes(1);
    expect(gate).not.toHaveBeenCalled();
  });

  it("on: an off-LAN destination is delivered", async () => {
    const prisma = makePrisma([makeHook()], [makeDelivery()]);
    const { all, send, gate } = deps({ scope: "public", gate: vi.fn(async () => true) });
    expect(await run(prisma, all)).toBe("delivered");
    expect(gate).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a blocked row delivers within a minute of the switch going on — it was never put on the retry ladder", async () => {
    const prisma = makePrisma([makeHook()], [makeDelivery()]);
    let open = false;
    let now = T0;
    const d = deps({ at: () => now, scope: "public", gate: async () => open });

    await run(prisma, d.all);
    expect(deliveryOf(prisma).status).toBe("PENDING");

    open = true;
    now = new Date(T0.getTime() + BLOCKED_RECHECK_MS);
    const second = await run(prisma, d.all, claimed(prisma));
    expect(second).toBe("delivered");
    expect(deliveryOf(prisma)).toMatchObject({ status: "DELIVERED", attempts: 1, lastError: null });
  });

  it("a blocked attempt on a row that had already failed leaves it FAILED (the history is kept)", async () => {
    const prisma = makePrisma([makeHook()], [makeDelivery({ status: "FAILED", attempts: 2, lastError: "Timed out" })]);
    await run(prisma, deps({ scope: "public", gate: async () => false }).all);
    expect(deliveryOf(prisma)).toMatchObject({ status: "FAILED", attempts: 2, lastError: "Blocked by egress setting" });
  });

  it("is read once per sweep, however many deliveries need it", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => makeDelivery({ id: `d-${i}` }));
    const prisma = makePrisma([makeHook()], rows);
    const { all, gate } = deps({ scope: "public", gate: vi.fn(async () => true) });
    const result = await runWebhookDeliveries(prisma as never, all);
    expect(result).toMatchObject({ claimed: 8, delivered: 8 });
    expect(gate).toHaveBeenCalledTimes(1);
  });
});

// ── the SSRF guard is in the dial path ───────────────────────────────────────

describe("the SSRF guard", () => {
  const withRealGuard = (resolve?: () => Promise<Array<{ address: string; family: number }>>) =>
    deps({
      resolveDestination: (url) =>
        resolvePinnedDestination(url, {
          local: () => ({ addresses: ["172.18.0.5"], cidrs: ["172.18.0.5/16"] }),
          resolve: resolve ?? (async () => []),
        }),
    });

  it.each([
    ["loopback", "http://127.0.0.1:8080/x"],
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["the compose gateway", "http://172.18.0.1:8080/x"],
    ["an IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/x"],
  ])("refuses %s, never dials, and records a fixed sentence", async (_label, url) => {
    // The row was written before the rule existed, or by something that skipped
    // the service: the dial site checks again.
    const prisma = makePrisma([makeHook({ urlEnc: sealWebhookUrl("hook-1", url) })], [makeDelivery()]);
    const { all, send, gate } = withRealGuard();

    expect(await run(prisma, all)).toBe("retry");

    expect(send).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(deliveryOf(prisma).lastError).toBe("Destination not allowed");
    expect(JSON.stringify(deliveryOf(prisma))).not.toContain("127.0.0.1");
  });

  it("refuses a public name that resolves to loopback — the rebind case", async () => {
    const prisma = makePrisma([makeHook({ urlEnc: sealWebhookUrl("hook-1", "https://innocent.example.com/x") })], [makeDelivery()]);
    const { all, send } = withRealGuard(async () => [{ address: "127.0.0.1", family: 4 }]);
    await run(prisma, all);
    expect(send).not.toHaveBeenCalled();
    expect(deliveryOf(prisma).lastError).toBe("Destination not allowed");
  });

  it("says so when the name does not resolve", async () => {
    const prisma = makePrisma([makeHook({ urlEnc: sealWebhookUrl("hook-1", "https://nope.example.com/x") })], [makeDelivery()]);
    const { all } = withRealGuard(async () => {
      throw new Error("ENOTFOUND");
    });
    await run(prisma, all);
    expect(deliveryOf(prisma).lastError).toBe("Could not find that host");
  });
});

// ── the retry ladder and the circuit breaker ─────────────────────────────────

describe("retries", () => {
  it("is 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h — then gives up on the eighth failure", async () => {
    expect(RETRY_DELAYS_MS.map((ms) => ms / 60_000)).toEqual([1, 5, 30, 120, 360, 720, 1440]);
    expect(MAX_ATTEMPTS).toBe(8);

    const prisma = makePrisma([makeHook()], [makeDelivery()]);
    let now = T0;
    const d = deps({ at: () => now, send: (async () => ({ status: 500 })) as never });
    const seen: Array<{ status: string; attempts: number; waitedMs: number }> = [];
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const outcome = await run(prisma, d.all, claimed(prisma));
      const row = deliveryOf(prisma);
      seen.push({ status: row.status, attempts: row.attempts, waitedMs: row.nextAttemptAt.getTime() - now.getTime() });
      expect(outcome).toBe(i === MAX_ATTEMPTS - 1 ? "gave_up" : "retry");
      expect(row.lastStatusCode).toBe(500);
      expect(row.lastError).toBe("HTTP 500");
      now = row.nextAttemptAt;
    }
    expect(seen.slice(0, 7)).toEqual(
      RETRY_DELAYS_MS.map((ms, i) => ({ status: "FAILED", attempts: i + 1, waitedMs: ms })),
    );
    expect(seen[7]).toMatchObject({ status: "GIVEN_UP", attempts: 8 });
  });

  it("counts a refusal, a timeout and a reset like any other failed attempt", async () => {
    for (const [err, message] of [
      [Object.assign(new Error("x"), { name: "TimeoutError" }), "Timed out"],
      [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), "Connection refused"],
      [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }), "Connection reset"],
    ] as const) {
      const prisma = makePrisma([makeHook()], [makeDelivery()]);
      const d = deps({ send: (async () => { throw err; }) as never });
      expect(await run(prisma, d.all)).toBe("retry");
      expect(deliveryOf(prisma)).toMatchObject({ status: "FAILED", attempts: 1, lastStatusCode: null, lastError: message });
      expect(hookOf(prisma).consecutiveFailures).toBe(1);
    }
  });

  it("does not follow a redirect: a 3xx is a failed attempt", async () => {
    const prisma = makePrisma([makeHook()], [makeDelivery()]);
    expect(await run(prisma, deps({ send: (async () => ({ status: 302 })) as never }).all)).toBe("retry");
    expect(deliveryOf(prisma).lastError).toBe("HTTP 302");
  });

  it("fails an attempt whose signing secret cannot be read, rather than send it unsigned", async () => {
    const prisma = makePrisma([makeHook({ secretEnc: "dcv1:not-a-real-blob" })], [makeDelivery()]);
    const { all, send } = deps();
    expect(await run(prisma, all)).toBe("retry");
    expect(send).not.toHaveBeenCalled();
    expect(deliveryOf(prisma).lastError).toBe("Signing secret could not be read");
  });
});

describe("turning a failing webhook off", () => {
  it(`after ${DISABLE_AFTER_FAILURES} failed attempts in a row: disabled, and the admins are told exactly once`, async () => {
    const prisma = makePrisma([makeHook({ consecutiveFailures: DISABLE_AFTER_FAILURES - 1 })], [makeDelivery(), makeDelivery({ id: "d-2" })]);
    const { all, notifyAdmins } = deps({ send: (async () => ({ status: 503 })) as never });

    await run(prisma, all, claimed(prisma, "d-1"));
    expect(hookOf(prisma)).toMatchObject({ status: "DISABLED_FAILING", enabled: false, consecutiveFailures: DISABLE_AFTER_FAILURES });
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    const [title, body] = notifyAdmins.mock.calls[0] as unknown as [string, string];
    expect(title).toBe("Work notifications turned off: Team chat");
    expect(body).toContain(String(DISABLE_AFTER_FAILURES));
    expect(body).not.toMatch(/hooks\.example\.com|whsec_/);

    // A second delivery failing at the same moment finds it already off: no second alert.
    await run(prisma, all, claimed(prisma, "d-2"));
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
  });

  it("is not triggered below the threshold, and a success in between restarts the count", async () => {
    const prisma = makePrisma([makeHook({ consecutiveFailures: DISABLE_AFTER_FAILURES - 2 })], [makeDelivery(), makeDelivery({ id: "d-2" })]);
    const fail = deps({ send: (async () => ({ status: 500 })) as never });
    await run(prisma, fail.all, claimed(prisma, "d-1"));
    expect(hookOf(prisma).status).toBe("ACTIVE");
    await run(prisma, deps().all, claimed(prisma, "d-2"));
    expect(hookOf(prisma).consecutiveFailures).toBe(0);
    expect(fail.notifyAdmins).not.toHaveBeenCalled();
  });

  it("still disables when telling the admins fails", async () => {
    const prisma = makePrisma([makeHook({ consecutiveFailures: DISABLE_AFTER_FAILURES - 1 })], [makeDelivery()]);
    const d = deps({
      send: (async () => ({ status: 500 })) as never,
      notifyAdmins: async () => { throw new Error("push down"); },
    });
    await run(prisma, d.all);
    expect(hookOf(prisma).status).toBe("DISABLED_FAILING");
    expect(d.logger.error).toHaveBeenCalled();
  });

  it("gives up what a turned-off webhook still had queued, rather than hold it for the day it comes back", async () => {
    for (const status of ["PAUSED", "DISABLED_FAILING"] as const) {
      const prisma = makePrisma([makeHook({ status, enabled: false })], [makeDelivery()]);
      const { all, send } = deps();
      expect(await run(prisma, all)).toBe("webhook_off");
      expect(send).not.toHaveBeenCalled();
      expect(deliveryOf(prisma)).toMatchObject({ status: "GIVEN_UP", lastError: "Webhook was turned off" });
    }
  });
});

describe("expiry", () => {
  it("drops a delivery older than 48 hours whatever state it is in — even one the egress switch was holding", async () => {
    const old = new Date(T0.getTime() - DELIVERY_EXPIRY_MS - 1000);
    const prisma = makePrisma([makeHook()], [makeDelivery({ createdAt: old })]);
    const { all, send, gate } = deps({ gate: vi.fn(async () => false) });
    expect(await run(prisma, all)).toBe("expired");
    expect(send).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(deliveryOf(prisma)).toMatchObject({ status: "GIVEN_UP", lastError: "Expired before it could be delivered" });
  });
});

// ── test messages ────────────────────────────────────────────────────────────

describe("a test message", () => {
  it("is one attempt: a failure is GIVEN_UP, never queued, and never counts against the webhook", async () => {
    const prisma = makePrisma([makeHook({ consecutiveFailures: 3 })], [makeDelivery({ event: "webhook.test", sourceKey: null })]);
    const { all } = deps({ send: (async () => ({ status: 500 })) as never });
    expect(await run(prisma, all, claimed(prisma), { test: true })).toBe("gave_up");
    expect(deliveryOf(prisma)).toMatchObject({ status: "GIVEN_UP", attempts: 1, lastStatusCode: 500 });
    expect(hookOf(prisma).consecutiveFailures).toBe(3);
  });

  it("works on a paused webhook — debugging one is the point — and a success does not resume it", async () => {
    const prisma = makePrisma([makeHook({ status: "PAUSED", enabled: false, consecutiveFailures: 5 })], [makeDelivery({ event: "webhook.test" })]);
    expect(await run(prisma, deps().all, claimed(prisma), { test: true })).toBe("delivered");
    expect(hookOf(prisma)).toMatchObject({ status: "PAUSED", enabled: false, consecutiveFailures: 5 });
  });

  it("blocked by the egress switch settles at once, with the reason, instead of waiting to be sent later", async () => {
    const prisma = makePrisma([makeHook()], [makeDelivery({ event: "webhook.test" })]);
    expect(await run(prisma, deps({ gate: async () => false }).all, claimed(prisma), { test: true })).toBe("blocked");
    expect(deliveryOf(prisma)).toMatchObject({ status: "GIVEN_UP", lastError: "Blocked by egress setting" });
  });

  it("is not subject to the 48-hour expiry (it is sent the moment it is made)", async () => {
    const prisma = makePrisma([makeHook()], [makeDelivery({ event: "webhook.test", createdAt: new Date(T0.getTime() - DELIVERY_EXPIRY_MS * 2) })]);
    expect(await run(prisma, deps().all, claimed(prisma), { test: true })).toBe("delivered");
  });
});

// ── the sweep, the claim, the lease ──────────────────────────────────────────

describe("claimDueDeliveries", () => {
  it("claims only what is due and owed, oldest first, and leases it", async () => {
    const prisma = makePrisma(
      [makeHook()],
      [
        makeDelivery({ id: "late", nextAttemptAt: new Date(T0.getTime() + 60_000) }),
        makeDelivery({ id: "b", nextAttemptAt: new Date(T0.getTime() - 1000) }),
        makeDelivery({ id: "a", nextAttemptAt: new Date(T0.getTime() - 5000) }),
        makeDelivery({ id: "done", status: "DELIVERED", deliveredAt: T0, nextAttemptAt: new Date(T0.getTime() - 9000) }),
        makeDelivery({ id: "dead", status: "GIVEN_UP", nextAttemptAt: new Date(T0.getTime() - 9000) }),
      ],
    );
    const first = await claimDueDeliveries(prisma as never, T0, 10);
    expect(first.map((d) => d.id).sort()).toEqual(["a", "b"]);
    expect(first[0]?.webhook.id).toBe("hook-1");
    // Leased: a second claim at the same instant finds nothing…
    expect(await claimDueDeliveries(prisma as never, T0, 10)).toEqual([]);
    // …until the lease runs out, which is how a worker that died mid-send is retried.
    const later = await claimDueDeliveries(prisma as never, new Date(T0.getTime() + DELIVERY_LEASE_MS + 1), 10);
    expect(later.map((d) => d.id).sort()).toEqual(["a", "b", "late"]);
  });

  it("takes at most `limit`", async () => {
    const prisma = makePrisma([makeHook()], Array.from({ length: 5 }, (_, i) => makeDelivery({ id: `d-${i}` })));
    expect(await claimDueDeliveries(prisma as never, T0, 2)).toHaveLength(2);
  });
});

describe("runWebhookDeliveries", () => {
  it("does nothing, and says so, when nothing is due", async () => {
    const prisma = makePrisma([makeHook()], []);
    expect(await runWebhookDeliveries(prisma as never, deps().all)).toEqual({
      claimed: 0, delivered: 0, retried: 0, gaveUp: 0, blocked: 0, expired: 0, webhookOff: 0, errored: 0,
    });
  });

  it("tallies mixed outcomes and keeps going when one attempt throws something unexpected", async () => {
    const prisma = makePrisma(
      [makeHook(), makeHook({ id: "hook-2", status: "PAUSED", enabled: false, secretEnc: sealWebhookSecret("hook-2", SECRET) })],
      [
        makeDelivery({ id: "ok" }),
        makeDelivery({ id: "bad", webhookId: "hook-1" }),
        makeDelivery({ id: "off", webhookId: "hook-2" }),
      ],
    );
    let calls = 0;
    const { all, logger } = deps({
      send: (async () => {
        calls += 1;
        return { status: calls === 2 ? 500 : 200 };
      }) as never,
    });
    // Make the "off" row's webhook lookup the only difference: it is given up before any dial.
    const result = await runWebhookDeliveries(prisma as never, all);
    expect(result.claimed).toBe(3);
    expect(result.webhookOff).toBe(1);
    expect(result.delivered + result.retried).toBe(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("contains a database error on one row and still handles the rest", async () => {
    const prisma = makePrisma([makeHook()], [makeDelivery({ id: "a" }), makeDelivery({ id: "b" })]);
    const original = prisma.pmWebhookDelivery.updateMany.getMockImplementation()!;
    let failed = false;
    prisma.pmWebhookDelivery.updateMany.mockImplementation(async (args: { where: Where; data: Record<string, unknown> }) => {
      if (!failed && args.where.id === "a" && args.data.status === "DELIVERED") {
        failed = true;
        throw new Error("connection reset");
      }
      return original(args);
    });
    const { all, logger } = deps();
    const result = await runWebhookDeliveries(prisma as never, all);
    expect(result).toMatchObject({ claimed: 2, delivered: 1, errored: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("pruneWebhookDeliveries", () => {
  it("removes finished rows past retention and nothing else", async () => {
    const old = new Date(T0.getTime() - DELIVERY_RETENTION_MS - 1000);
    const prisma = makePrisma(
      [makeHook()],
      [
        makeDelivery({ id: "old-done", status: "DELIVERED", deliveredAt: old, createdAt: old }),
        makeDelivery({ id: "old-dead", status: "GIVEN_UP", createdAt: old }),
        makeDelivery({ id: "old-pending", status: "PENDING", createdAt: old }),
        makeDelivery({ id: "old-failed", status: "FAILED", createdAt: old }),
        makeDelivery({ id: "new-done", status: "DELIVERED", deliveredAt: T0, createdAt: T0 }),
      ],
    );
    expect(await pruneWebhookDeliveries(prisma as never, T0)).toBe(2);
    expect(prisma.deliveryRows.map((r) => r.id).sort()).toEqual(["new-done", "old-failed", "old-pending"]);
  });
});

describe("describeFailure — fixed sentences only", () => {
  it.each([
    [new OutboundUrlBlockedError("private_host", "10.0.0.1"), "Destination not allowed"],
    [new OutboundUrlBlockedError("scheme", "file"), "Destination not allowed"],
    [new OutboundUrlBlockedError("unresolvable", "x.example"), "Could not find that host"],
    [Object.assign(new Error(), { name: "AbortError" }), "Timed out"],
    [Object.assign(new Error(), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), "Timed out"],
    [Object.assign(new Error(), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }), "Timed out"],
    [Object.assign(new Error(), { cause: { code: "ECONNREFUSED" } }), "Connection refused"],
    [Object.assign(new Error(), { cause: { code: "ECONNRESET" } }), "Connection reset"],
    [Object.assign(new Error(), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }), "TLS certificate not trusted"],
    [Object.assign(new Error(), { cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } }), "TLS certificate not trusted"],
    [Object.assign(new Error(), { cause: { code: "ENOTFOUND" } }), "Could not find that host"],
    [Object.assign(new Error(), { cause: { code: "EHOSTUNREACH" } }), "Host unreachable"],
    [new Error("anything else, including 10.0.0.9:22"), "Could not connect"],
    [null, "Could not connect"],
  ])("maps %#", (err, sentence) => {
    expect(describeFailure(err)).toBe(sentence);
  });

  it("is built from nothing in the error: no address, host or message survives", () => {
    const sentence = describeFailure(Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:5432"), { cause: { code: "ECONNREFUSED" } }));
    expect(Object.values(DELIVERY_ERRORS)).toContain(sentence);
    expect(sentence).not.toMatch(/10\.0\.0\.9|5432/);
  });
});
