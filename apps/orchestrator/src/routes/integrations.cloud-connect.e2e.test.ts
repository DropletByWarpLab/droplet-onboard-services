/**
 * WARP-2842 — the paste-then-connect flow, end to end over the wire.
 *
 *   PATCH /api/integrations/stripe/credentials { fields: { apiKey } }   → PROVISIONING
 *   POST  /api/integrations/stripe/connect     {}                       → probe
 *   GET   /api/integrations                                             → the verdict
 *
 * Both routers are mounted on ONE in-memory Prisma stub, exactly as `app.ts`
 * shares the real client between them, so the row the credential route
 * sealed the key into is the row the connect route builds from. Nothing is
 * stubbed between the route and the vendor except `globalThis.fetch`.
 *
 * `saas-credentials.route.test.ts` already pins the PATCH → PROVISIONING half;
 * this suite pins the hop that was missing — no route drove the row out of
 * PROVISIONING — and the two verdicts a probe can return.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    ROUTING_MODE: "disabled",
    corsAllowedOrigins: ["https://droplet-ai.local"],
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { matchesWhere } from "../__tests__/helpers/integration-connection-where.js";
import { __resetCallBudgetsForTest } from "../services/erp-provider.js";
import { createIntegrationsRouter } from "./integrations.js";
import { createSaasCredentialsRouter } from "./saas-credentials.js";

/** Composed from parts, never one literal (WARP-2379 — push protection). */
const FAKE_STRIPE_KEY = "rk_live_" + "EXAMPLE" + "FIXTURE" + "NOTAREALKEY";

/**
 * Prisma with Prisma's semantics for the two calls that matter: `update`
 * applies only the keys present in `data`, and `findMany` returns copies. A
 * stub that replaced whole rows would hide the over-wide write the service
 * test pins byte-identical.
 */
function stubPrisma() {
  const rows: Array<Record<string, unknown>> = [];
  let seq = 0;
  const integrationConnection = {
    findFirst: vi.fn(async (args?: { where?: { provider?: string } }) => {
      const hit = rows.find((r) => r.provider === args?.where?.provider);
      return hit ? { ...hit } : null;
    }),
    findUnique: vi.fn(async (args: { where: { id: string } }) => {
      const hit = rows.find((r) => r.id === args.where.id);
      return hit ? { ...hit } : null;
    }),
    findMany: vi.fn(async () => rows.map((r) => ({ ...r }))),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      seq += 1;
      const created = {
        id: `conn_${seq}`,
        providerTokensEnc: null,
        providerConfig: null,
        apiCredentialsEnc: null,
        lastHealthyAt: null,
        writeEnabled: false,
        updatedAt: new Date(),
        ...data,
      };
      rows.push(created);
      return { ...created };
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const hit = rows.find((r) => r.id === args.where.id);
      if (hit) Object.assign(hit, args.data, { updatedAt: new Date() });
      return { ...(hit ?? {}) };
    }),
    // The verdict write. Prisma matches EVERY key in `where`; so does this,
    // which is what lets the race case below see the guard at all
    // (`matchesWhere`: a Json `{ equals }` filter is matched by value).
    updateMany: vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.find((r) => matchesWhere(r, args.where));
        if (!hit) return { count: 0 };
        Object.assign(hit, args.data, { updatedAt: new Date() });
        return { count: 1 };
      },
    ),
  };
  const self = {
    integrationConnection,
    erpAuditLog: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
    erpSyncCursor: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(self)),
    rows,
  };
  return self;
}

function app(
  prisma: ReturnType<typeof stubPrisma>,
  user: { id: string; username: string; role: string } = {
    id: "11111111-1111-4111-8111-111111111111",
    username: "romain",
    role: "owner",
  },
) {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...user };
    next();
  });
  // Same prefix, same client — the mount `app.ts` makes.
  a.use("/api", createSaasCredentialsRouter(prisma as never));
  a.use("/api", createIntegrationsRouter(prisma as never));
  return a;
}

function stripeOk() {
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  recordActivityMock.mockClear();
  fetchMock.mockReset().mockImplementation(async () => stripeOk());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetCallBudgetsForTest();
});

async function stripeStatus(a: express.Express): Promise<string | undefined> {
  const list = await request(a).get("/api/integrations");
  expect(list.status).toBe(200);
  return (list.body as Array<{ provider: string; status: string }>).find(
    (c) => c.provider === "stripe",
  )?.status;
}

describe("PATCH credentials → POST connect → GET list, for a cloud provider", () => {
  it("lands CONNECTED when the vendor accepts the key — and dialed the vendor with it", async () => {
    // The whole ticket in one case. Against `origin/stage` the POST is a 404
    // and the GET still says PROVISIONING. Mutation: remove the cloud branch
    // from `/integrations/:provider/connect` → 404 on the POST; remove the
    // `cloudMaterialFromRow` merge → the POST answers 200 with
    // NOT_CONFIGURED and `fetch` is never called.
    const prisma = stubPrisma();
    const a = app(prisma);

    const patched = await request(a)
      .patch("/api/integrations/stripe/credentials")
      .send({ fields: { apiKey: FAKE_STRIPE_KEY } });
    expect(patched.status).toBe(200);
    expect(patched.body.state).toBe("PROVISIONING");
    expect(await stripeStatus(a)).toBe("PROVISIONING");

    const probed = await request(a).post("/api/integrations/stripe/connect").send({});
    expect(probed.status).toBe(200);
    expect(probed.body).toMatchObject({ provider: "stripe", status: "CONNECTED" });

    expect(await stripeStatus(a)).toBe("CONNECTED");
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.stripe\.com\//);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_STRIPE_KEY}`);
  });

  it("lands NEEDS_RECONNECT when the vendor answers 401 — never CONNECTED, never NOT_CONFIGURED", async () => {
    // The classification `cloud-connection-state.ts` already owned, now
    // reachable from the wire: a 401 is "paste a new key", which the hub
    // renders as exactly that. NOT_CONFIGURED here would be the OLD failure
    // (a blocked resolver) wearing a new route.
    fetchMock.mockImplementation(
      async () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } }),
    );
    const prisma = stubPrisma();
    const a = app(prisma);

    await request(a)
      .patch("/api/integrations/stripe/credentials")
      .send({ fields: { apiKey: FAKE_STRIPE_KEY } });
    const probed = await request(a).post("/api/integrations/stripe/connect").send({});

    expect(probed.status).toBe(200);
    expect(probed.body.status).toBe("NEEDS_RECONNECT");
    expect(await stripeStatus(a)).toBe("NEEDS_RECONNECT");
  });

  it("is safe to call again — a second connect re-probes and changes nothing but the verdict", async () => {
    const prisma = stubPrisma();
    const a = app(prisma);
    await request(a)
      .patch("/api/integrations/stripe/credentials")
      .send({ fields: { apiKey: FAKE_STRIPE_KEY } });
    await request(a).post("/api/integrations/stripe/connect").send({});
    const sealed = prisma.rows[0].providerTokensEnc;

    const again = await request(a).post("/api/integrations/stripe/connect").send({});

    expect(again.status).toBe(200);
    expect(again.body.status).toBe("CONNECTED");
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].providerTokensEnc).toBe(sealed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("writes the same consent record the LAN connect writes", async () => {
    // `auditConnect` in the service is ONE function for every track; the
    // route pins that the cloud path reaches it with the actor threaded.
    const prisma = stubPrisma();
    const a = app(prisma);
    await request(a)
      .patch("/api/integrations/stripe/credentials")
      .send({ fields: { apiKey: FAKE_STRIPE_KEY } });
    recordActivityMock.mockClear();

    await request(a).post("/api/integrations/stripe/connect").send({});

    const connected = recordActivityMock.mock.calls
      .map((c) => c[0] as { what: string; sub: string; actor: { id: string | null }; refs: Record<string, unknown> })
      .filter((p) => p.what === "Integration connected");
    expect(connected).toHaveLength(1);
    expect(connected[0].sub).toBe("stripe");
    expect(connected[0].actor.id).toBe("11111111-1111-4111-8111-111111111111");
    // `hasSecret` says whether a credential was in play. On this path it is
    // the sealed column, not a body field — so TRUE, and never the key.
    expect(connected[0].refs).toMatchObject({ provider: "stripe", status: "CONNECTED", hasSecret: true });
    expect(JSON.stringify(connected[0])).not.toContain(FAKE_STRIPE_KEY);
  });

  it("does not land a verdict on a row whose credential was cleared while the probe was in flight", async () => {
    // The PATCH / connect race, over the wire. The vendor round-trip is the
    // one point strictly between "connector built from the row" and "verdict
    // written", so the clear is issued from inside `fetch`: a second tab
    // emptying the field while the first tab's check is out. Without the
    // guard the row ends CONNECTED with `providerTokensEnc: null` — pollable,
    // credential-less, and the resolver parks every cursor on it.
    // Mutation: key the verdict on `id` alone → CONNECTED lands → red.
    const prisma = stubPrisma();
    const a = app(prisma);
    await request(a)
      .patch("/api/integrations/stripe/credentials")
      .send({ fields: { apiKey: FAKE_STRIPE_KEY } });
    fetchMock.mockImplementationOnce(async () => {
      const cleared = await request(a)
        .patch("/api/integrations/stripe/credentials")
        .send({ fields: { apiKey: "" } });
      expect(cleared.status).toBe(200);
      expect(cleared.body.state).toBe("NOT_CONFIGURED");
      return stripeOk();
    });

    const probed = await request(a).post("/api/integrations/stripe/connect").send({});

    expect(probed.status).toBe(200);
    expect(probed.body.status).toBe("NOT_CONFIGURED");
    expect(await stripeStatus(a)).toBe("NOT_CONFIGURED");
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].providerTokensEnc).toBeNull();
    expect(prisma.rows[0].lastHealthyAt).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("400s a LAN-shaped body posted at a cloud provider — names the empty body, dials nothing", async () => {
    // `cloudConnectSchema` is `z.object({}).strict()` on purpose: a `host`
    // sent to Stripe is a caller on the wrong track, and swallowing it would
    // let the LAN wizard's shape "succeed" against a cloud row. Mutation:
    // drop `.strict()` → this POST is a 200 and the vendor is dialed.
    const prisma = stubPrisma();
    const a = app(prisma);
    await request(a)
      .patch("/api/integrations/stripe/credentials")
      .send({ fields: { apiKey: FAKE_STRIPE_KEY } });
    fetchMock.mockClear();

    const res = await request(a)
      .post("/api/integrations/stripe/connect")
      .send({ host: "10.0.0.5", databaseName: "PattersonPM" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
    expect(String(res.body.details)).toMatch(/empty body/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.rows[0].status).toBe("PROVISIONING");
    expect(prisma.rows[0].host).toBe("");
    expect(prisma.rows[0].databaseName).toBe("");
  });

  it("403s a family caller on the connect, with the credential untouched", async () => {
    const prisma = stubPrisma();
    await request(app(prisma))
      .patch("/api/integrations/stripe/credentials")
      .send({ fields: { apiKey: FAKE_STRIPE_KEY } });

    const res = await request(
      app(prisma, { id: "22222222-2222-4222-8222-222222222222", username: "sam", role: "family" }),
    )
      .post("/api/integrations/stripe/connect")
      .send({});

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.rows[0].status).toBe("PROVISIONING");
  });
});
