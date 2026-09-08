/**
 * WARP-2833 — the connect-time write opt-in, over the route that can actually
 * reach a REST-track provider with it.
 *
 * ### Why this file mounts the REAL service
 *
 * The other two route suites (`integrations.lan-provisioning`,
 * `integrations.concurrency`) stub `createIntegrationsService`, because their
 * subject is which provider the ROUTE hands the service and how its errors are
 * mapped. Neither can see this defect: the refusal lives in the service, and a
 * stubbed service resolves whatever the mock was told to. So this suite wires
 * the real router to the real service over a stub Prisma, and asserts on the
 * wire response AND on what reached the database.
 *
 * ### Why the DEPRECATED alias and not `/integrations/:provider/connect`
 *
 * The parameterised route is gated by `requireLanProvider`, so a REST vendor
 * 404s there and cannot carry an opt-in at all. `POST
 * /api/integrations/eaglesoft/connect` is the one that is still live, validates
 * only against `connectSchema`, and takes its provider from the BODY — which is
 * how `eaglesoft-api` is selected today and, unchanged, how `{ provider:
 * "square", enableWrites: true }` used to reach `persistBase()`. The literal in
 * the URL is Eaglesoft; the row that got written was Square's.
 *
 * `requireRole` is NOT stubbed — these are admin-gated routes and a
 * hand-written stand-in would pass whether or not that survived.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { providerDescriptor } from "@droplet/shared-types";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

// The consent record `connect()` writes. Mocked so "nothing was persisted"
// can be asserted about the activity feed as well as about the row.
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { KNOWN_ERP_PROVIDERS } from "../services/erp-provider.js";
import { createIntegrationsRouter } from "./integrations.js";

/**
 * A rest-track provider, taken from the live registry rather than hardcoded to
 * `square`, so this suite cannot quietly stop covering the track if the
 * fixture vendor is ever renamed. Asserted non-empty below — an empty pick
 * would make every expectation here vacuous.
 */
const REST_PROVIDERS = KNOWN_ERP_PROVIDERS.filter(
  (p) => providerDescriptor(p)?.track === "rest",
);

/** Minimal Prisma: the two models `connect()` touches, and a transaction seam
 *  that hands the same object back. Deliberately NOT a mock database — every
 *  assertion below is about a call that either happened or did not. */
function stubPrisma() {
  const rows: Array<Record<string, unknown>> = [];
  const self = {
    integrationConnection: {
      findFirst: vi.fn(async (args?: { where?: { provider?: string } }) => {
        const hit = rows.find((r) => r.provider === args?.where?.provider);
        return hit ? { ...hit } : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `conn_${rows.length + 1}`, ...data };
        rows.push(created);
        return { ...created };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const hit = rows.find((r) => r.id === args.where.id);
        if (hit) Object.assign(hit, args.data);
        return { ...(hit ?? {}) };
      }),
    },
    erpAuditLog: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
    erpSyncCursor: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(self)),
    rows,
  };
  return self;
}

/** Blocked on every live call — the shipped stub shape, so no test dials out. */
function blockedConnector() {
  return {
    connect: vi.fn(async () => {
      throw Object.assign(new Error("blocked"), { name: "ConnectorBlockedError" });
    }),
    introspect: vi.fn(async () => ({}) as never),
    health: vi.fn(async () => ({}) as never),
    close: vi.fn(async () => {}),
  } as never;
}

function app(prisma: ReturnType<typeof stubPrisma>) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: "u-owner", role: "owner" };
    next();
  });
  a.use("/api", createIntegrationsRouter(prisma as never, {
    connectorFor: () => blockedConnector(),
  }));
  return a;
}

beforeEach(() => {
  recordActivityMock.mockClear();
});

describe("the deprecated /integrations/eaglesoft/connect alias and the write opt-in", () => {
  it("has at least one rest-track provider to test, or this suite proves nothing", () => {
    expect(REST_PROVIDERS.length).toBeGreaterThan(0);
  });

  it.each(REST_PROVIDERS)(
    "refuses { provider: %s, enableWrites: true } with a 400 and persists no row",
    async (provider) => {
      // The shipped defect, end to end: the URL names Eaglesoft, the body
      // names a REST vendor, and the row that came back carried
      // `writeEnabled: true` on a connector whose `applyWrite` throws
      // unconditionally (ADR-046 §4).
      //
      // Mutation: remove `requireWritableTrack` from `connect()` → 200, and
      // `create` is called with `writeEnabled: true`.
      const prisma = stubPrisma();
      const res = await request(app(prisma))
        .post("/api/integrations/eaglesoft/connect")
        .send({ provider, host: "connect.example", enableWrites: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/read-only by construction/);
      // Nothing reached the database, and nothing reached the activity feed —
      // a guard that ran AFTER `persistBase()` would satisfy the status
      // assertion above and fail these three.
      expect(prisma.integrationConnection.create).not.toHaveBeenCalled();
      expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
      expect(recordActivityMock).not.toHaveBeenCalled();
    },
  );

  it.each(REST_PROVIDERS)(
    "still connects %s READ-ONLY through the same route",
    async (provider) => {
      // The guard refuses the OPT-IN, not the vendor. Without this, closing
      // the hole would un-ship every REST connector's connect path.
      const prisma = stubPrisma();
      const res = await request(app(prisma))
        .post("/api/integrations/eaglesoft/connect")
        .send({ provider, host: "connect.example" });

      expect(res.status).toBe(200);
      expect(prisma.integrationConnection.create).toHaveBeenCalledTimes(1);
      expect(prisma.rows[0]).toMatchObject({ provider, writeEnabled: false });
    },
  );

  it("leaves the write-capable default provider's opt-in working", async () => {
    // The literal route with no `provider` in the body still means Eaglesoft,
    // which is a LAN track and can write. Pinned so the guard cannot widen
    // into "no connect may ever enable writes".
    const prisma = stubPrisma();
    const res = await request(app(prisma))
      .post("/api/integrations/eaglesoft/connect")
      .send({ host: "10.0.0.5", enableWrites: true });

    expect(res.status).toBe(200);
    expect(prisma.rows[0]).toMatchObject({ provider: "eaglesoft", writeEnabled: true });
  });
});
