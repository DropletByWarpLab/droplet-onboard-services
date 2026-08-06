/**
 * ERP REST track, end to end through the HTTP API against a live Eaglesoft box.
 *
 * This is the install rehearsal, run as a test. Everything below the HTTP call
 * is production code and production infrastructure:
 *
 *   real HTTP over a loopback socket\n *             → the real Express app (createApp)
 *             → the real integrations/erp routers, zod validation, RBAC gates
 *             → the real services
 *             → a REAL PostgreSQL row (migration applied, credentials
 *               encrypted at rest with the real encryption.service)
 *             → the real EaglesoftApiConnector
 *             → real TLS, verified against a real private CA
 *             → the harness Eaglesoft box
 *
 * `erp-api-live.test.ts` proves the service layer with a Prisma stub; this
 * proves the layers that one cannot: HTTP validation, the router's RBAC gate,
 * and — the reason it needs a real database — that the connection material
 * actually round-trips through Postgres. A stubbed Prisma will happily hand
 * back whatever object it was given; a real one has to survive JSONB
 * marshalling, a nullable integer column, and TEXT ciphertext.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every other `.pg.test.ts`
 * here. Run it with `scripts/test-orchestrator-pg.sh` (which stands up a
 * throwaway cluster via Docker or native initdb, then migrates).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The global unit setup mocks @prisma/client for the DB-less lane. This file
// needs the real client.
vi.unmock("@prisma/client");

// @ts-expect-error -- plain ESM JS harness, outside any tsconfig rootDir.
import { startMockEaglesoftApi } from "../../../../services/erp-connector/harness/eaglesoft-api/mock-server.mjs";
// @ts-expect-error -- see above.
import { opensslAvailable } from "../../../../services/erp-connector/harness/eaglesoft-api/certs.mjs";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0 &&
  opensslAvailable();

/**
 * Boot an Express app on a real loopback port and return a fetch-based client.
 *
 * Deliberately NOT supertest. supertest is fine, but this exercises a real
 * listening socket and a real HTTP client, which is what the claim under test
 * ("the box can reach the practice over HTTP") actually means — and it sidesteps
 * the suite's `::ffff:127.0.0.1` bind, which needs IPv6 that not every runner or
 * container has.
 */
async function serve(app: any) {
  const server = await new Promise<any>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async get(path: string) {
      const r = await fetch(`${base}${path}`);
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async post(path: string, body: unknown) {
      const r = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

describe.skipIf(!RUN)("ERP REST track — HTTP → Postgres → live Eaglesoft box", () => {
  let prisma: any;
  let http: Awaited<ReturnType<typeof serve>>;
  let box: any;

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new (PrismaClient as any)();
    const { createApp } = await import("../app.js");
    http = await serve(createApp(prisma));
    box = await startMockEaglesoftApi();
  }, 60_000);

  afterAll(async () => {
    await http?.close();
    await box?.close();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.erpAuditLog.deleteMany({});
    await prisma.erpWriteRequest.deleteMany({});
    await prisma.integrationConnection.deleteMany({});
  });

  /** The connect payload an installer would POST, pointed at the harness box. */
  function connectBody(overrides: Record<string, unknown> = {}) {
    return {
      provider: "eaglesoft-api",
      host: box.host,
      port: box.port,
      apiCredentials: box.credentials,
      apiRouteMap: box.routeMap,
      apiCaCert: box.ca,
      ...overrides,
    };
  }

  const connect = (body: Record<string, unknown>) =>
    http.post("/api/integrations/eaglesoft/connect", body);

  it("connects: the box answers, and the row lands CONNECTED", async () => {
    const res = await connect(connectBody());
    expect(res.status).toBe(200);

    const row = await prisma.integrationConnection.findFirst({
      where: { provider: "eaglesoft-api" },
    });
    expect(row).toBeTruthy();
    // CONNECTED is only reachable if connect() + introspect() actually
    // succeeded against the box — i.e. the TLS handshake verified, the
    // Authenticate call returned a session token, and the route map parsed.
    expect(row.status).toBe("CONNECTED");
    expect(row.host).toBe(box.host);
    expect(row.port).toBe(box.port);
  });

  it("stores the credentials ENCRYPTED in Postgres — verified by reading the raw column", async () => {
    await connect(connectBody());

    // Read the column as raw SQL, bypassing every application-layer helper, so
    // this cannot be satisfied by a getter that decrypts on the way out.
    const raw: Array<{ apiCredentialsEnc: string | null }> = await prisma.$queryRawUnsafe(
      `SELECT "apiCredentialsEnc" FROM "IntegrationConnection" WHERE provider = 'eaglesoft-api'`,
    );
    const stored = raw[0]?.apiCredentialsEnc ?? "";
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).not.toContain(box.credentials.password);
    expect(stored).not.toContain(box.credentials.integrationKey);
    expect(stored).not.toContain(box.credentials.userId);
  });

  it("never echoes the credentials back over HTTP", async () => {
    const res = await connect(connectBody());
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(box.credentials.password);
    expect(body).not.toContain(box.credentials.integrationKey);

    const detail = await http.get("/api/integrations/eaglesoft");
    expect(JSON.stringify(detail.body)).not.toContain(box.credentials.password);
  });

  it("reads the schedule over HTTP — real patient rows off the live box", async () => {
    await connect(connectBody());

    const res = await http.get(`/api/erp/schedule?date=${box.anchorDate}`);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items.map((i: any) => i.appt_id)).toEqual([5001, 5002, 5003]);
  });

  it("searches patients over HTTP, minimum-necessary only", async () => {
    await connect(connectBody());

    const res = await http.get("/api/erp/patients?query=Lis");
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.items).toEqual([
      { patient_id: 1003, first_name: "Barbara", last_name: "Liskov" },
    ]);
    // Demographics the box returned must not survive the DTO projection.
    expect(JSON.stringify(res.body)).not.toContain("555-01");
    expect(JSON.stringify(res.body)).not.toContain("1985-11-02");
  });

  it("returns the AR summary over HTTP", async () => {
    await connect(connectBody());

    const res = await http.get("/api/erp/ar-summary");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true,
      accountCount: 5,
      totalBalance: 634.5,
    });
  });

  it("writes a PHI-free audit row to Postgres for every read", async () => {
    await connect(connectBody());
    await http.get("/api/erp/patients?query=Knuth");

    const audits = await prisma.erpAuditLog.findMany({});
    expect(audits.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain("Knuth");
    expect(serialized).not.toContain(box.credentials.password);
  });

  // ------------------------------------------------------- honest failure --

  it("a box that is down leaves the row PROVISIONING, never CONNECTED", async () => {
    const res = await connect(connectBody({ port: 1 })); // nothing listening
    expect(res.status).toBe(200);
    const row = await prisma.integrationConnection.findFirst({
      where: { provider: "eaglesoft-api" },
    });
    expect(row.status).toBe("PROVISIONING");
  });

  it("reads degrade honestly when the box starts failing after a good connect", async () => {
    await connect(connectBody());
    box.setFaults({ status: 500 });
    try {
      const res = await http.get("/api/erp/ar-summary");
      expect(res.status).toBe(200); // the API stays up...
      expect(res.body.connected).toBe(false); // ...and tells the truth
      expect(res.body.reason).toBe("ERP_NOT_CONNECTED");
      expect(res.body.totalBalance).toBeNull(); // never a fabricated number
    } finally {
      box.setFaults(null);
    }
  });

  it("rejects an unknown provider rather than routing it somewhere surprising", async () => {
    const res = await connect(connectBody({ provider: "not-a-real-erp" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("survives a restart: the persisted row alone is enough to read again", async () => {
    await connect(connectBody());

    // Throw away every in-memory object and rebuild from Postgres, the way a
    // box does after a reboot. If any part of the connection material only
    // worked because it was still in memory, this is where it breaks.
    const { PrismaClient } = await import("@prisma/client");
    const fresh = new (PrismaClient as any)();
    const { createApp } = await import("../app.js");
    const freshHttp = await serve(createApp(fresh));
    try {
      const res = await freshHttp.get(`/api/erp/schedule?date=${box.anchorDate}`);
      expect(res.body.connected).toBe(true);
      expect(res.body.items).toHaveLength(3);
    } finally {
      await freshHttp.close();
      await fresh.$disconnect();
    }
  });
});
