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
import { liveBoxSkipReason, announceLiveBoxSkip } from "../../../../services/erp-connector/harness/eaglesoft-api/preflight.mjs";

const PG_LANE =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

/** Same live-box prerequisites as the other two harness suites — the `openssl`
 *  CLI, and a Node whose built-in fetch takes the CA-trusting undici dispatcher
 *  (WARP-2611) — on top of this lane's own database gate. Only probed inside the
 *  pg lane, so the DB-less run neither pays for it nor reports a second reason
 *  for a suite it was already skipping. */
const LIVE_BOX_SKIP_REASON: string | null = PG_LANE ? liveBoxSkipReason() : null;

const RUN = PG_LANE && LIVE_BOX_SKIP_REASON === null;

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

announceLiveBoxSkip("ERP REST track — HTTP → Postgres → live Eaglesoft box", LIVE_BOX_SKIP_REASON);

describe.skipIf(!RUN)("ERP REST track — HTTP → Postgres → live Eaglesoft box", () => {
  let prisma: any;
  let http: Awaited<ReturnType<typeof serve>>;
  let box: any;

  beforeAll(async () => {
    // Fail loudly and specifically on a misconfigured lane. Without these the
    // symptom is nine assertion failures reading `expected 401 to be 200` (auth
    // on) or an opaque throw from the encryption service — neither of which
    // names the actual cause. They are set by the pg-integration job and by
    // scripts/test-orchestrator-pg.sh; keep those two in lockstep.
    //
    // Deliberately a throw, not a skip: silently skipping when the environment
    // is wrong is how coverage disappears without anyone noticing.
    const { config } = await import("../config.js");
    if (config.AUTH_ENABLED) {
      throw new Error(
        "erp-api-e2e.pg.test.ts needs AUTH_ENABLED=false — it exercises the ERP " +
          "routers and their RBAC gates, not the login flow. Run it via " +
          "scripts/test-orchestrator-pg.sh, which sets it.",
      );
    }
    if (!config.DEVICE_SECRET_KEY) {
      throw new Error(
        "erp-api-e2e.pg.test.ts needs DEVICE_SECRET_KEY — connect() encrypts the " +
          "stored ERP credentials. Run it via scripts/test-orchestrator-pg.sh.",
      );
    }

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

  // Namespaced like every sibling pg suite (party-link, crm-activity-cascade,
  // landing-provenance): the pg-gated files share ONE throwaway database and
  // run serially (--no-file-parallelism), so a `deleteMany({})` here is this
  // file claiming rows it never created.
  //
  // `connect()` resolves the provider BEFORE it writes anything, so
  // "eaglesoft-api" is the COMPLETE set of IntegrationConnection rows this
  // suite can land -- including the `port: 1` row that stays PROVISIONING. The
  // "not-a-real-erp" post is rejected 4xx and lands nothing at all.
  const OURS = { provider: "eaglesoft-api" } as const;

  beforeEach(async () => {
    // Ids first: ErpAuditLog.connectionId and ErpWriteRequest.connectionId are
    // plain columns with no relation and no foreign key, so they cannot be
    // scoped by a relation filter -- they have to be scoped by id.
    const ours = await prisma.integrationConnection.findMany({
      where: OURS,
      select: { id: true },
    });
    const connectionIds = ours.map((r: { id: string }) => r.id);
    await prisma.erpAuditLog.deleteMany({
      where: { connectionId: { in: connectionIds } },
    });
    await prisma.erpWriteRequest.deleteMany({
      where: { connectionId: { in: connectionIds } },
    });
    // Last, and scoped. `PartyLink.connectionId` is onDelete: Restrict
    // (WARP-2562) on purpose -- nothing may sweep away a human's confirmed
    // customer match. Unscoped, this line reached the connection that
    // party-link.pg.test.ts deliberately leaves behind (it runs just before
    // this file: vitest orders the serial pg lane largest-file-first) and died
    // on `PartyLink_connectionId_fkey`. That FK was doing its job; deleting
    // another suite's rows was never this file's job.
    await prisma.integrationConnection.deleteMany({ where: OURS });
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
