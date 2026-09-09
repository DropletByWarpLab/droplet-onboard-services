/**
 * WARP-2520 — the LAN connect/test verbs, addressed by provider.
 *
 * The defect these pin: `ConnectWizard` has been descriptor-driven since
 * WARP-2451 and posts `/api/integrations/${descriptor.id}/{connect,test}` for
 * whichever tile opened it, while the orchestrator registered those two verbs
 * ONLY as `eaglesoft` literals. Eaglesoft is the one provider whose id makes
 * that URL match a literal, so the generic wizard looked like it worked and a
 * second LAN vendor's four-step flow ended at a 404 — invisible until a second
 * LAN descriptor exists, which is exactly why the fixture below registers one
 * rather than testing Eaglesoft twice.
 *
 * `createIntegrationsService` is stubbed: the subject is which provider the
 * ROUTE hands the service, and a real service would answer that question with
 * a database. `requireRole` is NOT stubbed — the routes are admin-gated and a
 * hand-written stand-in would pass whether or not that survived.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import {
  registerProviderDescriptor,
  __resetRegisteredProvidersForTest,
  type ProviderDescriptor,
} from "@droplet/shared-types";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { connectMock, testMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  testMock: vi.fn(),
}));

vi.mock("../services/integrations.service.js", () => ({
  createIntegrationsService: () => ({
    connect: connectMock,
    test: testMock,
    list: vi.fn(),
    getEaglesoft: vi.fn(),
    disconnect: vi.fn(),
    setWriteEnabled: vi.fn(),
  }),
}));

import { createIntegrationsRouter } from "./integrations.js";

/**
 * A SECOND LAN provider. Load-bearing, not convenience: with only Eaglesoft in
 * the registry every assertion below could be satisfied by the literal route
 * that already existed, so the fix would be untestable against the shipped
 * catalog. `lanProvisioning` is the whole declaration under test — its
 * contents are never read by the route, only its presence.
 */
const ACME_LAN: ProviderDescriptor = {
  id: "acme-pms",
  displayName: "Acme PMS",
  category: "Practice management",
  track: "lan",
  credentialFields: [],
  egressHosts: [],
  datasets: [],
  lanProvisioning: {
    accountName: "droplet_ro",
    databaseName: "AcmeDB",
    defaultPort: 2638,
    hostPlaceholder: "10.0.1.9",
    reachableLabel: "an Acme database",
    script: ["-- provision"],
    scopes: [{ id: "schedule", label: "Schedule" }],
  },
};

/** `user` is injected the way the auth middleware would, so the REAL
 *  `requireRole` runs. Omit it to exercise the guard itself. */
function app(user: { id?: string; role?: string } | undefined = { id: "u-1", role: "admin" }) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (user) (req as unknown as { user?: unknown }).user = user;
    next();
  });
  a.use("/api", createIntegrationsRouter({} as never));
  return a;
}

const BODY = { host: "10.0.1.9", port: 2638, databaseName: "AcmeDB" };

beforeEach(() => {
  connectMock.mockReset().mockImplementation(async (input) => ({
    connection: { provider: input.provider, status: "PROVISIONING", writeEnabled: false },
  }));
  testMock.mockReset().mockResolvedValue({ ok: true });
  registerProviderDescriptor(ACME_LAN);
});

afterEach(() => {
  __resetRegisteredProvidersForTest();
});

describe("POST /api/integrations/:provider/connect", () => {
  /**
   * The headline. Against `origin/stage` this is a 404: no route matches.
   *
   * Mutation: delete the `/integrations/:provider/connect` registration → red
   * with a 404, which IS the shipped defect.
   */
  it("provisions a LAN provider the URL names, not the one the literal route meant", async () => {
    const res = await request(app())
      .post("/api/integrations/acme-pms/connect")
      .send(BODY);

    expect(res.status).toBe(200);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock.mock.calls[0][0]).toMatchObject({
      provider: "acme-pms",
      host: "10.0.1.9",
    });
  });

  /**
   * The admission rule is `lanProvisioning`, not "any known provider".
   *
   * A cloud track is connected by pasting a credential; there is nothing for
   * it to provision, and a `host` posted at one would otherwise reach a code
   * path that opens a database session against whatever that host is.
   *
   * Mutation: swap `requireLanProvider` for `isKnownErpProvider` → red, because
   * Stripe is a known provider and the call reaches the service.
   */
  it("404s a cloud provider, and never reaches the service", async () => {
    const res = await request(app()).post("/api/integrations/stripe/connect").send(BODY);

    expect(res.status).toBe(404);
    expect(connectMock).not.toHaveBeenCalled();
  });

  /**
   * Mutation: drop the `providerDescriptor(...)` guard entirely → red, because
   * an unknown provider then reaches `svc.connect`, which is a 404 the service
   * would have to answer for a resource the router already knew nothing about.
   */
  it("404s a provider no descriptor declares", async () => {
    const res = await request(app())
      .post("/api/integrations/not-a-provider/connect")
      .send(BODY);

    expect(res.status).toBe(404);
    expect(connectMock).not.toHaveBeenCalled();
  });

  /**
   * The URL is the only source. A body naming a different provider is refused
   * rather than silently preferred either way — a request that provisioned a
   * provider its own URL does not name is the defect WARP-2500 removed from
   * the lifecycle verbs.
   *
   * Mutation: spread the body AFTER the URL provider (`{ provider, ...body }`)
   * → red, because the body then wins and the service is asked to connect
   * `eaglesoft-api` from Acme's URL.
   */
  it("refuses a body provider that contradicts the URL", async () => {
    const res = await request(app())
      .post("/api/integrations/acme-pms/connect")
      .send({ ...BODY, provider: "eaglesoft-api" });

    expect(res.status).toBe(400);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("accepts a body provider that agrees with the URL", async () => {
    const res = await request(app())
      .post("/api/integrations/acme-pms/connect")
      .send({ ...BODY, provider: "acme-pms" });

    expect(res.status).toBe(200);
    expect(connectMock.mock.calls[0][0]).toMatchObject({ provider: "acme-pms" });
  });

  it("still validates the body", async () => {
    const res = await request(app())
      .post("/api/integrations/acme-pms/connect")
      .send({ port: 2638 });

    expect(res.status).toBe(400);
    expect(connectMock).not.toHaveBeenCalled();
  });

  /**
   * The new routes are admin-gated like the literals they generalise.
   *
   * Mutation: drop `requireRole("owner", "admin")` from the parameterised
   * registration → red, because a `family` session then provisions a LAN
   * database connection.
   */
  it("is admin-gated", async () => {
    const res = await request(app({ id: "u-2", role: "family" }))
      .post("/api/integrations/acme-pms/connect")
      .send(BODY);

    expect(res.status).toBe(403);
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/integrations/:provider/test", () => {
  it("tests the LAN provider the URL names", async () => {
    const res = await request(app()).post("/api/integrations/acme-pms/test").send(BODY);

    expect(res.status).toBe(200);
    expect(testMock.mock.calls[0][0]).toMatchObject({ provider: "acme-pms" });
  });

  it("404s a provider that declares no LAN provisioning", async () => {
    const res = await request(app()).post("/api/integrations/hubspot/test").send(BODY);

    expect(res.status).toBe(404);
    expect(testMock).not.toHaveBeenCalled();
  });
});

/**
 * The Eaglesoft literals stay, and stay DIFFERENT: they take their provider
 * from the body, which is the only way to reach the `eaglesoft-api` REST track
 * today. Removing them on the lifecycle aliases' schedule would drop that.
 *
 * Mutation: register the parameterised routes BEFORE the literals → red on the
 * second case, because `/integrations/eaglesoft/connect` then matches
 * `:provider` and the contradiction check rejects the REST track's body.
 */
describe("the deprecated eaglesoft literal connect/test", () => {
  it("still answers, defaulting the provider in the service", async () => {
    const res = await request(app())
      .post("/api/integrations/eaglesoft/connect")
      .send({ host: "10.0.1.5" });

    expect(res.status).toBe(200);
    expect(connectMock.mock.calls[0][0].provider).toBeUndefined();
  });

  it("is how the REST track is selected, by body", async () => {
    const res = await request(app())
      .post("/api/integrations/eaglesoft/connect")
      .send({ host: "10.0.1.5", provider: "eaglesoft-api" });

    expect(res.status).toBe(200);
    expect(connectMock.mock.calls[0][0]).toMatchObject({ provider: "eaglesoft-api" });
  });
});
