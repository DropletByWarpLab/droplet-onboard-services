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
 * ### The two routes a REST vendor could reach, and what each refuses
 *
 * When WARP-2833 landed, the parameterised route was gated by
 * `requireLanProvider`, so a REST vendor 404'd there and the DEPRECATED alias
 * `POST /api/integrations/eaglesoft/connect` — provider from the BODY — was
 * the only way to connect one, and the way `{ provider: "square",
 * enableWrites: true }` reached `persistBase()`. The literal in the URL was
 * Eaglesoft; the row that got written was Square's.
 *
 * WARP-2842 re-drew that map. The alias now refuses a body naming a described
 * non-LAN track at the ROUTE, before the service — it could also drive a
 * credentialed cloud row to NOT_CONFIGURED — and `/integrations/:provider/
 * connect` admits the REST track with an EMPTY body: no `enableWrites`, so
 * the connect-time opt-in has no route that can carry it to a REST vendor at
 * all. The service guard (`requireWritableTrack`) stays, pinned at the
 * service in `integrations.disconnect-purge.test.ts`; this suite pins the
 * two routes.
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

import { matchesWhere } from "../__tests__/helpers/integration-connection-where.js";
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
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const hit = rows.find((r) => r.id === args.where.id);
        return hit ? { ...hit } : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        // `providerTokensEnc: null` as Prisma returns it on a row created
        // without one — the WARP-2842 verdict guard keys on that column.
        const created = { id: `conn_${rows.length + 1}`, providerTokensEnc: null, ...data };
        rows.push(created);
        return { ...created };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const hit = rows.find((r) => r.id === args.where.id);
        if (hit) Object.assign(hit, args.data);
        return { ...(hit ?? {}) };
      }),
      // WARP-2842 — the cloud verdict write; EVERY key in `where` must match
      // (`matchesWhere`: a Json `{ equals }` filter is matched by value).
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const hit = rows.find((r) => matchesWhere(r, args.where));
          if (!hit) return { count: 0 };
          Object.assign(hit, args.data);
          return { count: 1 };
        },
      ),
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
      // WARP-2842 — refused one layer earlier now, at the route: the alias no
      // longer admits a body naming a non-LAN track at all, with or without
      // the opt-in. Mutation: drop `refusesNonLanBodyProvider` from
      // `provisionBody` → the service's `requireWritableTrack` still answers
      // 400 here, but the READ-ONLY case below goes 200 and writes a row.
      const prisma = stubPrisma();
      const res = await request(app(prisma))
        .post("/api/integrations/eaglesoft/connect")
        .send({ provider, host: "connect.example", enableWrites: true });

      expect(res.status).toBe(400);
      expect(res.body.details).toMatch(new RegExp(`POST /api/integrations/${provider}/connect`));
      // Nothing reached the database, and nothing reached the activity feed —
      // a guard that ran AFTER `persistBase()` would satisfy the status
      // assertion above and fail these three.
      expect(prisma.integrationConnection.create).not.toHaveBeenCalled();
      expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
      expect(recordActivityMock).not.toHaveBeenCalled();
    },
  );

  it.each(REST_PROVIDERS)(
    "no longer connects %s through the alias at all — even read-only",
    async (provider) => {
      // WARP-2842. This case used to pin the opposite ("still connects
      // READ-ONLY through the same route"), because the alias was the only
      // URL that could reach a REST vendor. It is not any more, and leaving
      // it open let `{ provider: "square", host: "x" }` drive a credentialed
      // row PROVISIONING → NOT_CONFIGURED: the alias builds the connector
      // from the body, which carries no row material.
      const prisma = stubPrisma();
      const res = await request(app(prisma))
        .post("/api/integrations/eaglesoft/connect")
        .send({ provider, host: "connect.example" });

      expect(res.status).toBe(400);
      expect(prisma.integrationConnection.create).not.toHaveBeenCalled();
      expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
      expect(recordActivityMock).not.toHaveBeenCalled();
    },
  );

  it.each(REST_PROVIDERS)(
    "connects %s READ-ONLY through its own URL, with an empty body",
    async (provider) => {
      // Where the REST track's connect lives now. The guard refuses the
      // OPT-IN, not the vendor: closing the alias must not un-ship every
      // REST connector's connect path.
      const prisma = stubPrisma();
      const res = await request(app(prisma))
        .post(`/api/integrations/${provider}/connect`)
        .send({});

      expect(res.status).toBe(200);
      expect(prisma.integrationConnection.create).toHaveBeenCalledTimes(1);
      expect(prisma.rows[0]).toMatchObject({ provider, writeEnabled: false });
      // The audit row is written for the cloud path too — same
      // `auditConnect` as the LAN path. The row names the VERDICT (WARP-2842):
      // the stub above rejects with an Error carrying no `code`, which the
      // classifier can only call ERROR, and a failed probe is not
      // "Integration connected".
      expect(recordActivityMock).toHaveBeenCalledTimes(1);
      expect(recordActivityMock.mock.calls[0][0]).toMatchObject({
        what: "Integration probe: ERROR",
        severity: "warn",
        sub: provider,
        refs: expect.objectContaining({ provider, writeEnabled: false, hasSecret: false }),
      });
    },
  );

  it.each(REST_PROVIDERS)(
    "refuses { enableWrites: true } on %s's own URL — the probe carries no opt-in",
    async (provider) => {
      // The cloud body is strict and empty by design: a probe that could
      // also toggle writes would couple two consent events into one request,
      // and for a REST track there is no write path to enable anyway.
      // Mutation: loosen `cloudConnectSchema` to accept `enableWrites` → red.
      const prisma = stubPrisma();
      const res = await request(app(prisma))
        .post(`/api/integrations/${provider}/connect`)
        .send({ enableWrites: true });

      expect(res.status).toBe(400);
      expect(prisma.integrationConnection.create).not.toHaveBeenCalled();
      expect(recordActivityMock).not.toHaveBeenCalled();
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
