/**
 * WARP-2453 — `disconnect()` flipped a flag and left the credentials in the row.
 *
 * ADR-041 §2: _"Disconnecting must be equally real: it revokes and **purges the
 * stored tokens**, not merely flips a flag."_ Before this file,
 * `integrations.service.ts` `disconnect()` wrote
 * `{ status: "DISABLED", writeEnabled: false }` and nothing else, so an owner
 * who clicked Disconnect got a row that READ as disconnected while
 * `apiCredentialsEnc` and `providerTokensEnc` stayed decryptable in Postgres —
 * for credentials ADR-042 notes mostly never expire, indefinitely.
 *
 * **Every test in this file is red against `origin/stage`.** That is the point;
 * they are the defect, expressed as assertions.
 *
 * Prisma is a `vi.fn()` stub, per the house rule against mock-database
 * integration tests: what is being asserted is the SHAPE OF THE WRITE — which
 * columns the one `update` carries — not what a database does with it.
 *
 * ---
 *
 * ## WARP-2482 — the second half of the same purge
 *
 * This file is EXTENDED rather than joined by a sibling, deliberately. The
 * defect WARP-2482 fixes is that WARP-2453's purge stopped at
 * `IntegrationConnection` and left the connection's `ErpSyncCursor` rows
 * behind, so `foldSyncState` kept folding a dead credential's last words —
 * `needsReconnect: true`, `syncState: "FAILED"` — into a purged connection's
 * hub summary. A NEW file asserting the cursors are reset could pass in full
 * while every assertion here still described a purge that only did half the
 * job; the two facts have to be able to fail each other, so they share a
 * fixture and a stub.
 *
 * The stub grows two capabilities to carry that:
 *
 *  - **The rows are now live objects, not per-call literals.** The old stub
 *    could only answer "what shape was the write". The claim under test now is
 *    what the HUB READS BACK, so `getEaglesoft()` after `disconnect()` has to
 *    see what `disconnect()` wrote. Still a hand-rolled `vi.fn()` stub and
 *    still no database — the house rule bans mock DATABASES, not stubs that
 *    remember what they were told.
 *  - **A real `$transaction`**, the shared WARP-1570 seam rather than
 *    `(fn) => fn(self)`. The purge and the reset must be ONE transaction, and
 *    the hand-rolled shape cannot express that: it discards the isolation
 *    option and never rolls back, so "the reset failed, therefore the purge is
 *    not visible either" would be unprovable and a split into two
 *    transactions would stay green.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("./activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import {
  ConnectorBlockedError,
  XeroConnector,
  pruneExpiredXeroTokens,
  __resetXeroTokenCacheForTest,
} from "@droplet/erp-connector";
import { mcpProviderIds, providerDescriptor } from "@droplet/shared-types";
import { createIntegrationsService } from "./integrations.service.js";
// WARP-2500 — the provider table is DERIVED from the live registry, never
// hand-written here: a provider added to `provider-registry.ts` has to join
// the provider-scoping assertions without anyone remembering to list it.
import { KNOWN_ERP_PROVIDERS, EAGLESOFT_PROVIDER } from "./erp-provider.js";
import { SERIALIZABLE_TX } from "../lib/prisma-tx.js";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
  type TransactionSeam,
} from "../__tests__/helpers/prisma-tx-harness.js";

/**
 * Stand-ins for the two encrypted columns, distinctive enough that a leak into
 * the audit scope is unmistakable. Composed from parts rather than written as
 * one literal so no secret-shaped contiguous string exists in the tree — the
 * lesson from WARP-2379, where a fixture passed local gitleaks and was then
 * refused by GitHub's own push-protection scanner.
 */
const SEEDED_API_CIPHERTEXT = "SEEDED" + "-EAGLESOFT-TRIPLE-CIPHERTEXT";
const SEEDED_TOKEN_CIPHERTEXT = "dcv1:" + "SEEDED-SAAS-CREDENTIAL-CIPHERTEXT";

/**
 * The scalar columns `disconnect()` must clear. Nullable `String`/`DateTime`,
 * so the update carries a literal `null` and the assertion is exact.
 */
const PURGED_SCALAR_COLUMNS = [
  "apiCredentialsEnc",
  "providerTokensEnc",
  "apiCaCert",
  "schemaHash",
  "schemaVersion",
  "lastHealthyAt",
] as const;

/**
 * The nullable `Json` columns it must clear.
 *
 * Split out because Prisma types these as `NullableJsonNullValueInput` — a
 * literal `null` is a COMPILE error and the clear must be written
 * `Prisma.DbNull`. Under test that sentinel reads as `undefined`, because the
 * shared `@prisma/client` mock (`src/__tests__/setup.ts:253-263`) does not
 * export it; `activity.service.test.ts:79-88` documents the same thing for
 * `ActivityRow.refs`. So the assertion here is that the KEY IS PRESENT and no
 * longer carries the seeded value — key absence is what a removed purge looks
 * like, and that is the mutation this catches.
 */
const PURGED_JSON_COLUMNS = ["providerConfig", "apiRouteMap"] as const;

/** Every column `disconnect()` must clear. */
const PURGED_COLUMNS = [...PURGED_SCALAR_COLUMNS, ...PURGED_JSON_COLUMNS] as const;

/**
 * A connected row holding material on every column the purge is responsible
 * for. Seeded, not empty: a purge test against a row with nothing in it passes
 * vacuously.
 */
function connectedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn_1",
    provider: "eaglesoft",
    status: "CONNECTED",
    host: "10.0.0.5",
    port: null,
    databaseName: "PattersonPM",
    secretRef: "eaglesoft:pending",
    writeEnabled: true,
    schemaVersion: "2026.1",
    schemaHash: "sha256:abc",
    lastHealthyAt: new Date("2026-08-20T00:00:00.000Z"),
    apiCredentialsEnc: SEEDED_API_CIPHERTEXT,
    providerTokensEnc: SEEDED_TOKEN_CIPHERTEXT,
    providerConfig: { accountId: "acct-1" },
    apiRouteMap: { appointments: "/api/appt" },
    apiCaCert: "-----BEGIN CERTIFICATE-----seeded-----END CERTIFICATE-----",
    ...overrides,
  };
}

/**
 * A cursor as the poller leaves it when a customer revokes the grant in the
 * vendor's console: parked, latched on `needsReconnect`, still holding the
 * position it reached. This is the row `disconnect()` used to walk past.
 */
function revokedCursor(over: Record<string, unknown> = {}) {
  return {
    id: "cur_1",
    connectionId: "conn_1",
    entity: "invoice",
    watermark: "2026-08-20T00:00:00.000Z",
    state: "FAILED",
    consecutiveFailures: 7,
    nextAttemptAt: new Date("2026-08-21T00:00:00.000Z"),
    lastSyncedAt: new Date("2026-08-20T00:00:00.000Z"),
    lastSweepAt: new Date("2026-08-19T00:00:00.000Z"),
    needsReconnect: true,
    lastError: "vendor rejected the credential",
    ...over,
  };
}

/**
 * Every progress-bearing cursor field, with the value an UNSTARTED cursor
 * carries — written out LITERALLY rather than imported from
 * `UNSTARTED_ERP_CURSOR`.
 *
 * Importing the constant would make this assertion a tautology: a mutation
 * that changed what "unstarted" means (leaving `needsReconnect: true`, say)
 * would change both sides at once and stay green. Spelling the values here is
 * what makes the constant answerable to something.
 */
const UNSTARTED_CURSOR_FIELDS = {
  watermark: null,
  state: "IDLE",
  consecutiveFailures: 0,
  nextAttemptAt: null,
  lastSyncedAt: null,
  lastSweepAt: null,
  needsReconnect: false,
  lastError: null,
} as const;

export interface StubPrisma {
  integrationConnection: Record<string, ReturnType<typeof vi.fn>>;
  erpAuditLog: Record<string, ReturnType<typeof vi.fn>>;
  erpSyncCursor: Record<string, ReturnType<typeof vi.fn>>;
  erpDriftRecord: Record<string, ReturnType<typeof vi.fn>>;
  /** WARP-2549 — the CRM rows this connection landed, purged with it. */
  crmCompany: Record<string, ReturnType<typeof vi.fn>>;
  contact: Record<string, ReturnType<typeof vi.fn>>;
  crmDeal: Record<string, ReturnType<typeof vi.fn>>;
  crmPipeline: Record<string, ReturnType<typeof vi.fn>>;
  crmPipelineStage: Record<string, ReturnType<typeof vi.fn>>;
  crmActivity: Record<string, ReturnType<typeof vi.fn>>;
  $transaction: TransactionSeam["$transaction"];
  /** The live connection rows, so a test can read back what was written. */
  rows: Array<Record<string, unknown>>;
  /** The live cursor rows, same reason. */
  cursors: Array<Record<string, unknown>>;
  /** Landed CRM rows, seeded by a test and MUTATED by the purge. */
  landed: {
    companies: Array<Record<string, unknown>>;
    contacts: Array<Record<string, unknown>>;
    deals: Array<Record<string, unknown>>;
    /** Ids that carry a note a human typed — the archive-not-delete trigger. */
    withLocalActivity: Set<string>;
  };
  seam: TransactionSeam;
}

/**
 * The in-memory stub. `rows` and `cursors` are MUTATED by the write methods so
 * a later read observes the write — see the header note on why that is not a
 * mock database.
 */
function stubPrisma(
  /**
   * WARP-2500 — accepts an ARRAY as well as a single row.
   *
   * A one-row box cannot express the defect this ticket fixes: with only an
   * Eaglesoft row present, "disconnect the Eaglesoft row" and "disconnect the
   * row the caller named" are the same write, so the hardcoded provider and
   * the parameterised one are indistinguishable. The table-driven suite below
   * seeds one row per KNOWN provider precisely so those two come apart.
   */
  row: Record<string, unknown> | Array<Record<string, unknown>> | null,
  cursors: Array<Record<string, unknown>> = [],
): StubPrisma {
  const seeded = row === null ? [] : Array.isArray(row) ? row : [row];
  const rows = seeded.map((r) => ({ ...r }));
  const cursorRows = cursors.map((c) => ({ ...c }));

  // WARP-2549 — landed rows live alongside the connection rows, and the purge
  // mutates them in place, so a later read observes the write.
  const landedCompanies: Array<Record<string, unknown>> = [];
  const landedContacts: Array<Record<string, unknown>> = [];
  const landedDeals: Array<Record<string, unknown>> = [];
  const localActivity = new Set<string>();

  const landedTable = (store: Array<Record<string, unknown>>) => ({
    findMany: vi.fn(async (args?: { where?: { connectionId?: string } }) =>
      store
        .filter((r) => !args?.where?.connectionId || r.connectionId === args.where.connectionId)
        .map((r) => ({ id: r.id as string })),
    ),
    delete: vi.fn(async (args: { where: { id: string } }) => {
      const i = store.findIndex((r) => r.id === args.where.id);
      if (i >= 0) store.splice(i, 1);
      return {};
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = store.find((r) => r.id === args.where.id);
      if (row) Object.assign(row, args.data);
      return row ?? {};
    }),
  });

  const self = {
    integrationConnection: {
      /**
       * WARP-2500 — this HONORS `where.provider`.
       *
       * It used to return `rows[0]` whatever it was asked for. That was
       * harmless while every test seeded one Eaglesoft row, and fatal the
       * moment the suite went table-driven over providers: a stub that hands
       * back the only row regardless of the filter cannot tell a
       * provider-scoped read from the hardcoded `EAGLESOFT_PROVIDER` one this
       * ticket removes, so the mutation "restore the Eaglesoft default" would
       * have stayed GREEN and the table would have proved nothing.
       *
       * Filtering here is not a mock database (§4's rule) — it is one `where`
       * clause the subject actually depends on, made observable. The tests that
       * seed several providers below are the reason it has to be.
       */
      findFirst: vi.fn(async (args?: { where?: { provider?: string } }) => {
        const wanted = args?.where?.provider;
        const hit =
          wanted === undefined ? rows[0] : rows.find((r) => r.provider === wanted);
        return hit ? { ...hit } : null;
      }),
      findMany: vi.fn(async () => rows.map((r) => ({ ...r }))),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = { ...connectedRow(), ...data };
        rows.push(created);
        return { ...created };
      }),
      /**
       * WARP-2500 — this HONORS `where.id`, for the same reason `findFirst`
       * honors `where.provider`.
       *
       * Writing to `rows[0]` unconditionally meant a multi-provider test could
       * assert "the Stripe row was purged" while the service had in fact
       * updated whichever row happened to be seeded first. The `where.id` the
       * service passes comes from the row it read, so honoring it is what makes
       * "purged the RIGHT row" an assertable fact rather than an assumption.
       */
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where?: { id?: string };
          data: Record<string, unknown>;
        }) => {
          const target =
            (where?.id ? rows.find((r) => r.id === where.id) : rows[0]) ?? null;
          if (!target) {
            const created = { ...connectedRow(), ...data };
            rows.push(created);
            return { ...created };
          }
          Object.assign(target, data);
          return { ...target };
        },
      ),
    },
    erpAuditLog: { create: vi.fn(async () => ({})) },
    erpSyncCursor: {
      findMany: vi.fn(
        async (args?: { where?: { connectionId?: string } }) =>
          cursorRows
            .filter(
              (c) =>
                !args?.where?.connectionId ||
                c.connectionId === args.where.connectionId,
            )
            .map((c) => ({ ...c })),
      ),
      updateMany: vi.fn(
        async (args: {
          where: { connectionId: string };
          data: Record<string, unknown>;
        }) => {
          const hit = cursorRows.filter(
            (c) => c.connectionId === args.where.connectionId,
          );
          for (const c of hit) Object.assign(c, args.data);
          return { count: hit.length };
        },
      ),
    },
    /**
     * Present so a test can assert the WARP-2463 drift records are NOT
     * deleted. A stub that lacked the model would make that assertion pass by
     * making the deletion impossible, which proves nothing.
     */
    erpDriftRecord: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    /**
     * WARP-2549 — the landed CRM rows. Present and MUTATED for the same reason
     * `erpDriftRecord` is present: a stub without these models would make
     * "the purge removed the landed rows" pass by making the removal
     * impossible, which proves nothing.
     */
    crmCompany: landedTable(landedCompanies),
    contact: landedTable(landedContacts),
    crmDeal: landedTable(landedDeals),
    crmPipeline: {
      findFirst: vi.fn(async () => null),
      delete: vi.fn(async () => ({})),
    },
    crmPipelineStage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    crmActivity: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const id = (args.where.companyId ??
          args.where.contactId ??
          args.where.dealId) as string;
        return localActivity.has(id) ? { id: "act-1" } : null;
      }),
    },
  } as unknown as StubPrisma;

  const seam = createTransactionSeam({
    client: () => self,
    stores: {
      rows,
      cursors: cursorRows,
      landedCompanies,
      landedContacts,
      landedDeals,
    },
  });
  self.$transaction = seam.$transaction;
  self.rows = rows;
  self.cursors = cursorRows;
  self.landed = {
    companies: landedCompanies,
    contacts: landedContacts,
    deals: landedDeals,
    withLocalActivity: localActivity,
  };
  self.seam = seam;
  return self;
}

/** A connector whose every live method is blocked — the shipped stub shape. */
function blockedConnector() {
  return {
    connect: vi.fn(async () => {
      throw new ConnectorBlockedError("blocked", "install the driver");
    }),
    introspect: vi.fn(async () => ({}) as never),
    health: vi.fn(async () => ({}) as never),
    close: vi.fn(async () => {}),
  } as never;
}

function serviceFor(prisma: ReturnType<typeof stubPrisma>) {
  return createIntegrationsService(prisma as never, {
    connectorFor: () => blockedConnector(),
  });
}

/** The `data` of the Nth `integrationConnection.update` call. */
function updateData(
  prisma: ReturnType<typeof stubPrisma>,
  n = 0,
): Record<string, unknown> {
  const call = prisma.integrationConnection.update.mock.calls[n] as unknown as [
    { data: Record<string, unknown> },
  ];
  return call[0].data;
}

/** The `where` + `data` of the Nth `erpSyncCursor.updateMany` call. */
function cursorResetCall(
  prisma: ReturnType<typeof stubPrisma>,
  n = 0,
): { where: Record<string, unknown>; data: Record<string, unknown> } {
  const call = prisma.erpSyncCursor.updateMany.mock.calls[n] as unknown as [
    { where: Record<string, unknown>; data: Record<string, unknown> },
  ];
  if (!call) throw new Error("erpSyncCursor.updateMany was never called");
  return call[0];
}

beforeEach(() => {
  recordActivityMock.mockClear();
});

describe("disconnect() purges the connection's secrets and identity", () => {
  it("nulls every credential and identity column in the update", async () => {
    // Mutation: revert `data` to `{ status: "DISABLED", writeEnabled: false }`
    // → every one of these assertions goes red. That mutation IS the code on
    // `origin/stage`.
    const prisma = stubPrisma(connectedRow());
    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    const data = updateData(prisma);
    for (const column of PURGED_SCALAR_COLUMNS) {
      expect(data, `${column} must be nulled by disconnect()`).toHaveProperty(column);
      expect(data[column], `${column} must be null, not left as-is`).toBeNull();
    }
    for (const column of PURGED_JSON_COLUMNS) {
      expect(data, `${column} must be cleared by disconnect()`).toHaveProperty(column);
      expect(data[column], `${column} still carries its old value`).not.toEqual(
        connectedRow()[column],
      );
    }
  });

  it("keeps the row, its provider, and the explicit DISABLED state", async () => {
    // The no-guessing rule: "disconnected" is a status we WRITE, never the
    // absence of a row. Deleting the row would make the hub derive the state
    // from absence, which is the thing the enum column exists to prevent.
    const prisma = stubPrisma(connectedRow());
    const detail = await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    const data = updateData(prisma);
    expect(data.status).toBe("DISABLED");
    expect(data.writeEnabled).toBe(false);
    expect(data).not.toHaveProperty("provider");
    expect(detail.provider).toBe("eaglesoft");
    expect(detail.status).toBe("DISABLED");
  });

  it("writes the purge and the status flip as ONE update", async () => {
    // Mutation: split the purge into a second `update` call → red. Two writes
    // means a crash between them leaves a row reading DISABLED while still
    // holding a live credential — the exact lie this fix removes.
    const prisma = stubPrisma(connectedRow());
    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    expect(prisma.integrationConnection.update).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — no row means no write, no cursor reset and no audit", async () => {
    const prisma = stubPrisma(null);
    const detail = await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    expect(prisma.erpSyncCursor.updateMany).not.toHaveBeenCalled();
    expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
    expect(prisma.erpAuditLog.create).not.toHaveBeenCalled();
    expect(detail.status).toBe("NOT_CONFIGURED");
  });
});

/**
 * WARP-2383 — the copy of the credential Postgres cannot reach.
 *
 * Raised on #1946: the Xero track keeps its minted access token in a
 * process-lifetime `Map` keyed by connection id, because `erp.service` builds
 * and closes a connector per read. `forgetXeroToken` existed and was called
 * from the two 401 paths and `decommission()` — but never from
 * `disconnect()`, so the columns were purged while a live bearer token for the
 * organisation stayed usable in memory for up to the 30-minute TTL plus the
 * prune cron's lag.
 *
 * These assert against the REAL module-level cache, through a real
 * `XeroConnector` with an injected fetch — not against a spy on
 * `forgetXeroToken`. A spy would only prove a function was called; the claim
 * is that the token is gone, and a mutation that called it with the wrong key
 * (`row.provider` instead of `row.id`, say) would satisfy the spy and leave
 * the token exactly where it was.
 */
describe("disconnect() also drops the token that never reached Postgres", () => {
  const XERO_CONNECTION_ID = "conn_1";
  const XERO_CLIENT_ID = "FAKE-XERO-CLIENT-ID-0000";
  const XERO_CLIENT_SECRET = "FAKE-XERO-CLIENT-SECRET-do-not-use-0000";

  beforeEach(() => {
    __resetXeroTokenCacheForTest();
  });

  /** A connector on the connection id the fixture row carries, with a token
   *  already minted into the shared cache. */
  async function mintedXeroToken() {
    const connector = new XeroConnector(
      {
        connectionId: XERO_CONNECTION_ID,
        clientId: XERO_CLIENT_ID,
        credentialVariant: "custom-connection",
        credentialsSecretRef: "xero:pending",
      },
      {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              access_token: "FAKE-XERO-ACCESS-TOKEN-0000",
              expires_in: 1800,
              token_type: "Bearer",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )) as never,
        now: () => Date.UTC(2026, 8, 2, 12, 0, 0),
        resolveSecret: async () => XERO_CLIENT_SECRET,
      },
    );
    await connector.connect();
    expect((await connector.status()).hasAccessToken).toBe(true);
    return connector;
  }

  it("leaves no minted Xero token behind after the purge commits", async () => {
    // Mutation: delete the `forgetXeroToken(row.id)` line in
    // `integrations.service.ts` `disconnect()` → red. That mutation IS the
    // code #1946 was reviewed at.
    const connector = await mintedXeroToken();
    const prisma = stubPrisma(connectedRow({ provider: "xero" }));

    await serviceFor(prisma).disconnect({ actor: "romain" }, "xero");

    expect((await connector.status()).hasAccessToken).toBe(false);
  });

  it("keys the forget on the connection id, not on the provider name", async () => {
    // Mutation: `forgetXeroToken(row.provider)` → the cache is keyed by
    // connection id, so "xero" deletes nothing and this stays true. The test
    // above would still pass a spy-based assertion; only reading the cache
    // catches it.
    const connector = await mintedXeroToken();
    const prisma = stubPrisma(
      connectedRow({ id: XERO_CONNECTION_ID, provider: "xero", status: "CONNECTED" }),
    );

    await serviceFor(prisma).disconnect({ actor: "romain" }, "xero");

    // Nothing is left for the prune cron to find — the count it returns is the
    // map's own answer about what it still holds.
    expect(pruneExpiredXeroTokens(Date.UTC(2026, 8, 3, 12, 0, 0))).toBe(0);
    expect((await connector.status()).hasAccessToken).toBe(false);
  });

  it("does not disturb another connection's token", async () => {
    // The delete is scoped, not a `clear()`. Mutation: swap
    // `forgetXeroToken(row.id)` for `__resetXeroTokenCacheForTest()` → red,
    // and every other connected organisation on the box re-mints on its next
    // read, spending a daily allowance the four-hour cadence exists to protect.
    const other = new XeroConnector(
      {
        connectionId: "conn_someone_else",
        clientId: XERO_CLIENT_ID,
        credentialVariant: "custom-connection",
        credentialsSecretRef: "xero:pending",
      },
      {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              access_token: "FAKE-XERO-ACCESS-TOKEN-0001",
              expires_in: 1800,
              token_type: "Bearer",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )) as never,
        now: () => Date.UTC(2026, 8, 2, 12, 0, 0),
        resolveSecret: async () => XERO_CLIENT_SECRET,
      },
    );
    await other.connect();
    const disconnected = await mintedXeroToken();
    const prisma = stubPrisma(connectedRow({ provider: "xero" }));

    await serviceFor(prisma).disconnect({ actor: "romain" }, "xero");

    expect((await disconnected.status()).hasAccessToken).toBe(false);
    expect((await other.status()).hasAccessToken).toBe(true);
  });
});

/**
 * WARP-2482 — the purge above stopped at `IntegrationConnection`.
 *
 * Every test in this describe is red against `feat/warp-2466-wire-cloud-
 * connectors`, which carries WARP-2453's purge and nothing else.
 */
describe("disconnect() also returns the connection's cursors to unstarted", () => {
  it("resets every cursor of THIS connection, by connectionId", async () => {
    // Mutation: delete the `resetCursorsForConnection(tx, row.id)` call from
    // `disconnect()` → red. That deletion IS the code this ticket fixes.
    const prisma = stubPrisma(connectedRow(), [revokedCursor()]);
    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    const { where } = cursorResetCall(prisma);
    // Scoped to the connection. An unscoped `updateMany` would rewind every
    // other provider's cursors on the box because one connection was dropped.
    expect(where).toEqual({ connectionId: "conn_1" });
  });

  it("clears every progress-bearing field, each to an EXPLICIT value", async () => {
    // Mutation: drop any single field from `UNSTARTED_ERP_CURSOR` → red on
    // that field. The values are spelled out here rather than imported, so a
    // change to the constant's meaning cannot move both sides at once.
    const prisma = stubPrisma(connectedRow(), [revokedCursor()]);
    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    const { data } = cursorResetCall(prisma);
    for (const [field, value] of Object.entries(UNSTARTED_CURSOR_FIELDS)) {
      expect(data, `${field} must be written by the reset`).toHaveProperty(field);
      expect(data[field], `${field} must be reset to ${String(value)}`).toEqual(value);
    }
  });

  it("resets rather than deletes, so the registration stays explicit", async () => {
    // The no-guessing rule applied to the cursor table. `deleteMany` would
    // make "this connection is not syncing" an inference from absent rows —
    // and `foldSyncState` would then report `syncState: null` ("no cursor
    // registered"), a different claim from "registered, idle, at zero".
    //
    // Mutation: swap the reset for a `deleteMany` → red.
    const prisma = stubPrisma(connectedRow(), [revokedCursor()]);
    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    expect(prisma.cursors).toHaveLength(1);
    expect(prisma.cursors[0]).toMatchObject(UNSTARTED_CURSOR_FIELDS);
    // The registration itself survives — same row, same entity.
    expect(prisma.cursors[0]).toMatchObject({ id: "cur_1", entity: "invoice" });
  });

  it("RETAINS the WARP-2463 drift records — they are not credential material", async () => {
    // The decision, made explicit and testable rather than left to a comment.
    // Drift rows are counts and timestamps by construction, are read only by
    // their own admin endpoint and the sweep-cadence streak (never folded into
    // a connection summary, so they cannot reproduce this defect), and answer
    // a question about the VENDOR that outlives one credential. Their lifetime
    // already belongs to `trimErpDriftRecords`.
    //
    // Mutation: add an `erpDriftRecord.deleteMany` to
    // `resetCursorsForConnection` → red.
    const prisma = stubPrisma(connectedRow(), [revokedCursor()]);
    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    expect(prisma.erpDriftRecord.deleteMany).not.toHaveBeenCalled();
  });

  it("counts the reset cursors into the audit scope, never their entity names", async () => {
    // An entity name is the closest thing to customer content this row could
    // acquire; the count says how much position was repudiated without it.
    const prisma = stubPrisma(connectedRow(), [
      revokedCursor(),
      revokedCursor({ id: "cur_2", entity: "bill" }),
    ]);
    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    const call = prisma.erpAuditLog.create.mock.calls[0] as unknown as [
      { data: { scope: Record<string, unknown> } },
    ];
    expect(call[0].data.scope.cursorsReset).toBe(2);
    expect(JSON.stringify(call[0].data.scope)).not.toContain("invoice");
    expect(JSON.stringify(call[0].data.scope)).not.toContain("bill");
  });
});

/**
 * The end-to-end statement of the defect: what the HUB READS BACK.
 *
 * Every other assertion in this file is about the shape of a write. These two
 * are about the answer `GET /api/integrations` gives afterwards, which is
 * where a customer actually met the bug — a purged connection asking to be
 * re-authorized, and reporting a sync failure for a sync that is not running.
 */
describe("after a disconnect the hub stops advertising a dead credential", () => {
  it("no longer folds needsReconnect / FAILED into the detail view", async () => {
    // Mutation: delete the reset call → red on BOTH assertions, with the
    // before-block above proving the fixture actually carried the defect (the
    // "make the defect observable" rule: an empty cursor set passes vacuously).
    const prisma = stubPrisma(connectedRow(), [revokedCursor()]);
    const svc = serviceFor(prisma);

    const before = await svc.getEaglesoft();
    expect(before.syncState).toBe("FAILED");
    expect(before.needsReconnect).toBe(true);

    await svc.disconnect({ actor: "romain" }, "eaglesoft");

    const after = await svc.getEaglesoft();
    expect(after.needsReconnect).toBe(false);
    expect(after.syncState).toBe("IDLE");
    // …and the WARP-2453 half is still true at the same moment.
    expect(after.status).toBe("DISABLED");
    expect(after.credentialsPurged).toBe(true);
  });

  it("no longer folds them into the hub LISTING either", async () => {
    // `list()` reads the cursors through a different query than `detailFor()`
    // — one findMany across all connections rather than one scoped read — so
    // it is a genuinely separate path and gets its own assertion.
    const prisma = stubPrisma(connectedRow(), [revokedCursor()]);
    const svc = serviceFor(prisma);

    const before = (await svc.list()).find((s) => s.provider === "eaglesoft");
    expect(before?.needsReconnect).toBe(true);
    expect(before?.syncState).toBe("FAILED");

    await svc.disconnect({ actor: "romain" }, "eaglesoft");

    const after = (await svc.list()).find((s) => s.provider === "eaglesoft");
    expect(after?.needsReconnect).toBe(false);
    expect(after?.syncState).toBe("IDLE");
  });
});

/**
 * WARP-2482 — the purge and the reset are ONE transaction.
 *
 * Not a style point. The two half-commits are independently wrong and the
 * failure modes are not symmetric: purge-without-reset is the defect made
 * permanent (a second `disconnect()` finds a row it considers already purged,
 * so retrying cannot repair it), and reset-without-purge silently rewinds a
 * live connection to position zero and re-enumerates the whole account.
 */
describe("the purge and the cursor reset commit together or not at all", () => {
  it("opens exactly one transaction, at an explicit SERIALIZABLE isolation", async () => {
    // Mutation: drop the `SERIALIZABLE_TX` options argument → red. A
    // transaction with no explicit isolationLevel runs at READ COMMITTED,
    // where the row this decision was taken from can change underneath it.
    // Mutation: split into two `$transaction` calls → red on the count.
    const prisma = stubPrisma(connectedRow(), [revokedCursor()]);
    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    expect(prisma.seam.calls()).toHaveLength(1);
    expectAllTransactionsAt(prisma.seam, SERIALIZABLE_TX);
  });

  it("rolls the purge back when the cursor reset fails — nothing visible", async () => {
    // The atomicity proof, and the reason the shared seam replaced
    // `(fn) => fn(self)`: the hand-rolled shape never rolls back, so this
    // would have passed against two separate transactions.
    //
    // Mutation: move the reset into its own `$transaction` after the purge →
    // red. The purge commits, the credentials are gone, and the cursors keep
    // claiming `needsReconnect` with no way left to repair them.
    const prisma = stubPrisma(connectedRow(), [revokedCursor()]);
    prisma.erpSyncCursor.updateMany.mockRejectedValueOnce(
      new Error("cursor reset failed"),
    );

    await expect(
      serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft"),
    ).rejects.toThrow("cursor reset failed");

    // The row still holds BOTH credentials and its CONNECTED status.
    expect(prisma.rows[0]).toMatchObject({
      status: "CONNECTED",
      apiCredentialsEnc: SEEDED_API_CIPHERTEXT,
      providerTokensEnc: SEEDED_TOKEN_CIPHERTEXT,
    });
    // And the hub says so, rather than reporting a purge that did not happen.
    const detail = await serviceFor(prisma).getEaglesoft();
    expect(detail.credentialsPurged).toBe(false);
  });

  it("still rolls back whole when another transaction commits in between", async () => {
    // The interleaving case. A rollback that merely restored the snapshot it
    // took on entry would also undo whatever a CONCURRENT transaction
    // committed in the meantime; the seam replays those instead, and the claim
    // here is that this disconnect's own half-write is the ONLY thing undone.
    //
    // The concurrent writer touches a DIFFERENT connection's cursors — a model
    // the disconnect writes but never READS — so the two cannot collide under
    // SSI, and the test stays about atomicity rather than about P2034.
    //
    // Mutation: move the reset into its own `$transaction` after the purge →
    // red. The purge is then a committed transaction of its own, and no
    // rollback of the reset can reach it.
    const prisma = stubPrisma(connectedRow(), [
      revokedCursor(),
      revokedCursor({ id: "cur_other", connectionId: "conn_other" }),
    ]);

    // Two explicit rendezvous rather than a race the event loop happens to
    // order: `parked` says the disconnect is mid-transaction (purge written,
    // uncommitted), `release` lets its reset fail once the other transaction
    // has committed.
    let parked!: () => void;
    const parkedAt = new Promise<void>((resolve) => (parked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));

    const applyReset = prisma.erpSyncCursor.updateMany
      .getMockImplementation() as (args: {
      where: { connectionId: string };
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
    prisma.erpSyncCursor.updateMany.mockImplementation(
      async (args: { where: { connectionId: string } }) => {
        // Keyed on the connection, not on call order: a bare `…Once` is
        // consumed by whichever transaction reaches the model first, which is
        // the concurrent writer, not the disconnect.
        if (args.where.connectionId !== "conn_1") return applyReset(args as never);
        parked();
        await released;
        throw new Error("cursor reset failed");
      },
    );

    const disconnecting = serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");
    await parkedAt;

    await prisma.$transaction(
      async (tx: StubPrisma) =>
        tx.erpSyncCursor.updateMany({
          where: { connectionId: "conn_other" },
          data: { lastError: "committed by the concurrent writer" },
        }),
      SERIALIZABLE_TX,
    );

    release();
    await expect(disconnecting).rejects.toThrow("cursor reset failed");

    // Nothing of the disconnect is visible…
    expect(prisma.rows[0]).toMatchObject({
      status: "CONNECTED",
      apiCredentialsEnc: SEEDED_API_CIPHERTEXT,
    });
    expect(prisma.cursors.find((c) => c.id === "cur_1")).toMatchObject({
      state: "FAILED",
      needsReconnect: true,
    });
    // …while the transaction that DID commit survived the rollback.
    expect(prisma.cursors.find((c) => c.id === "cur_other")).toMatchObject({
      lastError: "committed by the concurrent writer",
    });
  });
});

describe("the disconnect audit row records THAT it purged, never WHAT", () => {
  function disconnectAudit(prisma: ReturnType<typeof stubPrisma>) {
    const call = prisma.erpAuditLog.create.mock.calls[0] as unknown as [
      { data: { action: string; scope: Record<string, unknown> } },
    ];
    return call[0].data;
  }

  it("carries a boolean purge marker", async () => {
    // Mutation: drop `purged` from the scope → red. Without it the audit trail
    // cannot distinguish a disconnect that purged from one written by an older
    // build that did not, which is the question an auditor asks about this row.
    const prisma = stubPrisma(connectedRow());
    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    const audit = disconnectAudit(prisma);
    expect(audit.action).toBe("disconnect");
    expect(audit.scope.purged).toBe(true);
  });

  it("contains no credential material", async () => {
    // Mutation: pass the row into the audit scope (`scope: { ...row }`) → red.
    // An append-only, exportable audit row is the worst possible second home
    // for a credential: no rotation can recall it.
    const prisma = stubPrisma(connectedRow());
    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    const serialized = JSON.stringify(disconnectAudit(prisma).scope);
    expect(serialized).not.toContain(SEEDED_API_CIPHERTEXT);
    expect(serialized).not.toContain(SEEDED_TOKEN_CIPHERTEXT);
    expect(serialized).not.toContain("BEGIN CERTIFICATE");
    expect(serialized).not.toContain("acct-1");
  });
});

describe("the read view says whether the credentials are gone", () => {
  it("reports credentialsPurged on a disconnected, emptied row", async () => {
    // Mutation: hardcode `credentialsPurged: false` → red. The hub has to tell
    // "disconnected, credentials removed" from "disabled by policy while still
    // holding a key"; collapsing them is the failure ADR-042 §6 names.
    const prisma = stubPrisma(connectedRow());
    const detail = await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    expect(detail.credentialsPurged).toBe(true);
  });

  it("does NOT claim a purge on a DISABLED row that still holds a credential", async () => {
    // A row disabled by an older build still holds its credential. Saying
    // "purged" there would be the dashboard asserting something false about
    // the box — the one thing this ticket exists to stop.
    const prisma = stubPrisma(connectedRow({ status: "DISABLED" }));
    const detail = await serviceFor(prisma).getEaglesoft();

    expect(detail.status).toBe("DISABLED");
    expect(detail.credentialsPurged).toBe(false);
  });

  it("is false for a connected row — nothing has been purged", async () => {
    const prisma = stubPrisma(connectedRow());
    const detail = await serviceFor(prisma).getEaglesoft();

    expect(detail.credentialsPurged).toBe(false);
  });

  it("carries the flag on the hub summary too, explicitly false when unconfigured", async () => {
    const prisma = stubPrisma(null);
    const [summary] = (await serviceFor(prisma).list()).filter(
      (s) => s.provider === "eaglesoft",
    );

    expect(summary.credentialsPurged).toBe(false);
  });
});

describe("connect() after a disconnect is a full re-provision", () => {
  /**
   * The row a reconnect meets: DISABLED with every purged column already null,
   * plus stale values on the columns `connect()` writes from its INPUT. If
   * `connect()` consulted the row for anything but its id, one of these would
   * surface in the update.
   */
  function purgedRow(overrides: Record<string, unknown> = {}) {
    return connectedRow({
      status: "DISABLED",
      writeEnabled: false,
      host: "STALE-HOST",
      databaseName: "STALE-DB",
      apiCredentialsEnc: null,
      providerTokensEnc: null,
      providerConfig: null,
      apiRouteMap: null,
      apiCaCert: null,
      schemaHash: null,
      schemaVersion: null,
      lastHealthyAt: null,
      ...overrides,
    });
  }

  it("takes every written value from the input, never from the purged row", async () => {
    const prisma = stubPrisma(purgedRow());
    await serviceFor(prisma).connect({ host: "10.0.0.9" }, { actor: undefined });

    const data = updateData(prisma);
    expect(data.host).toBe("10.0.0.9");
    expect(data.databaseName).toBe("PattersonPM"); // the default, not STALE-DB
    // A fresh verdict, not the row's stale DISABLED.
    expect(data.status).toBe("PROVISIONING");
  });

  it("does not resurrect any purged column the input omits", async () => {
    // Mutation: have `connect()` fall back to the existing `providerConfig`
    // (or any other purged column) when the input omits it → red. A reconnect
    // that silently reuses what disconnect deleted un-does the purge.
    const prisma = stubPrisma(purgedRow());
    await serviceFor(prisma).connect({ host: "10.0.0.9" });

    const data = updateData(prisma);
    for (const column of PURGED_COLUMNS) {
      expect(data, `${column} must not be carried over by connect()`).not.toHaveProperty(
        column,
      );
    }
  });

  it("still writes the material the input DOES supply", async () => {
    // The negative above must not be satisfied by connect() simply never
    // writing these columns: with the input carrying them, they are written.
    //
    // WARP-2500 — the seeded row is now `eaglesoft-api`, matching the provider
    // this connect names. It used to be the default `eaglesoft` row and the
    // test still took the UPDATE path, because the stub's `findFirst` ignored
    // `where.provider` and returned whatever row existed. Against real Prisma
    // that call finds nothing and CREATEs, so the assertion below was reading
    // an update the production path would never have performed. Seeding the
    // matching provider keeps the test's actual subject — "the supplied
    // material is written" — while making the path it exercises the real one.
    const prisma = stubPrisma(purgedRow({ provider: "eaglesoft-api" }));
    await serviceFor(prisma).connect({
      host: "10.0.0.9",
      provider: "eaglesoft-api",
      apiCaCert: "-----BEGIN CERTIFICATE-----fresh-----END CERTIFICATE-----",
      apiRouteMap: { appointments: "/api/appt" },
    });

    const data = updateData(prisma);
    expect(data.apiCaCert).toContain("fresh");
    expect(data.apiRouteMap).toEqual({ appointments: "/api/appt" });
  });

  /**
   * WARP-2482 — the reconnect half of the same story.
   *
   * `disconnect()` now resets on the way out, so on a row this build disabled
   * these are belt and braces. They are not redundant: a row disabled by a
   * build that predates this change still carries its stale watermarks and its
   * latched `needsReconnect`, and `connect()` is the only place left that
   * repairs it. The position also simply is not ours to keep — the grant being
   * pasted is a new one, and a watermark earned by the old one is not a claim
   * we can stand behind.
   */
  it("starts a reconnect from reset cursors, in the same transaction as the flip", async () => {
    // Mutation: delete the `resetCursorsForConnection(tx, existing.id)` call
    // from `connect()`'s DISABLED branch → red.
    // Mutation: move it outside the `$transaction` → red on the transaction
    // count, which is what stops a reconnect from rewinding cursors while its
    // own status flip rolls back.
    const prisma = stubPrisma(purgedRow(), [revokedCursor()]);
    await serviceFor(prisma).connect({ host: "10.0.0.9" });

    const { where, data } = cursorResetCall(prisma);
    expect(where).toEqual({ connectionId: "conn_1" });
    expect(data).toMatchObject(UNSTARTED_CURSOR_FIELDS);
    expect(prisma.seam.calls()).toHaveLength(1);
    expectAllTransactionsAt(prisma.seam, SERIALIZABLE_TX);
  });

  it("leaves a LIVE connection's cursors alone — the gate is the DISABLED enum", async () => {
    // The other half of the gate, and the mutation that matters most:
    // dropping the `existing.status !== "DISABLED"` check → red here.
    // Re-running connect() on a CONNECTED row is how an owner changes a host
    // or rotates a key on a live connection; wiping the watermarks there
    // silently re-enumerates the entire account for an edit that changed
    // nothing about the position.
    const prisma = stubPrisma(connectedRow(), [revokedCursor()]);
    await serviceFor(prisma).connect({ host: "10.0.0.9" });

    expect(prisma.erpSyncCursor.updateMany).not.toHaveBeenCalled();
    expect(prisma.cursors[0]).toMatchObject({
      watermark: "2026-08-20T00:00:00.000Z",
    });
    // And no transaction was opened for a path with only one write to make.
    expect(prisma.seam.calls()).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * WARP-2500 — the lifecycle calls are PROVIDER-SCOPED
 *
 * Everything above this line seeds exactly one Eaglesoft row. That is the
 * shape in which this bug is invisible: with one row on the box, "read the
 * Eaglesoft row" and "read the row the caller named" are the same read, so a
 * hardcoded `EAGLESOFT_PROVIDER` and a parameterised `provider` produce
 * identical writes and every assertion above passes either way.
 *
 * The suite below seeds one CONNECTED row for every provider in
 * `KNOWN_ERP_PROVIDERS` — an Eaglesoft row always among them — and then
 * disconnects them one at a time. That is what makes the two come apart, and
 * it is the reason the table is driven off the live registry rather than a
 * hand-written list: a provider added to `provider-registry.ts` joins these
 * assertions without anyone remembering to add it.
 *
 * ## The mutation, and what it must do
 *
 *   In `integrations.service.ts`, restore the Eaglesoft default:
 *     disconnect()      `where: { provider: scoped }` → `provider: EAGLESOFT_PROVIDER`
 *     setWriteEnabled() `findRow(scoped)`             → `findRow(EAGLESOFT_PROVIDER)`
 *
 * Expected: the `eaglesoft` row of the table stays GREEN — it always did —
 * and EVERY OTHER provider goes RED. A mutation that leaves the whole table
 * green means the table is not seeing the provider, and is a finding to chase
 * rather than a result to record.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Stable per-provider ids, so an assertion can name the row it expects. */
const connIdFor = (provider: string) => `conn_${provider}`;
const cursorIdFor = (provider: string) => `cur_${provider}`;

/**
 * A box with every known provider connected at once.
 *
 * Every row carries credential material on every purgeable column, so "this
 * row was purged" and "that row was not" are both observable. A row seeded
 * empty would make the negative assertion pass vacuously.
 */
function everyProviderConnected() {
  return KNOWN_ERP_PROVIDERS.map((provider) =>
    connectedRow({ id: connIdFor(provider), provider }),
  );
}

/** One parked, needs-reconnect cursor per connection. */
function everyProviderCursor() {
  return KNOWN_ERP_PROVIDERS.map((provider) =>
    revokedCursor({ id: cursorIdFor(provider), connectionId: connIdFor(provider) }),
  );
}

/** The live row for a provider, read back out of the stub after the call. */
function rowFor(prisma: StubPrisma, provider: string) {
  const hit = prisma.rows.find((r) => r.provider === provider);
  if (!hit) throw new Error(`no seeded row for provider "${provider}"`);
  return hit;
}

/**
 * Guards the whole table against a vacuous pass. If the registry ever returned
 * one provider — or an empty list — every `describe.each` below would run over
 * a set too small to distinguish a scoped read from a hardcoded one, and would
 * report green while proving nothing.
 */
describe("the provider table this suite is driven from", () => {
  it("contains Eaglesoft AND several others, or the table proves nothing", () => {
    expect(KNOWN_ERP_PROVIDERS).toContain(EAGLESOFT_PROVIDER);
    expect(
      KNOWN_ERP_PROVIDERS.filter((p) => p !== EAGLESOFT_PROVIDER).length,
    ).toBeGreaterThan(1);
  });
});

describe.each(KNOWN_ERP_PROVIDERS)(
  "disconnect(ctx, %s) on a box where every provider is connected",
  (provider) => {
    /** WARP-2453, now per provider. */
    it("purges THIS provider's credential material", async () => {
      const prisma = stubPrisma(everyProviderConnected(), everyProviderCursor());
      await serviceFor(prisma).disconnect({ actor: "romain" }, provider);

      const purged = rowFor(prisma, provider);
      expect(purged.status).toBe("DISABLED");
      expect(purged.writeEnabled).toBe(false);
      for (const column of PURGED_SCALAR_COLUMNS) {
        expect(purged[column], `${provider}.${column} must be purged`).toBeNull();
      }
    });

    it("leaves EVERY OTHER provider's credential material untouched", async () => {
      // This is the assertion the Eaglesoft default kills. With it restored,
      // disconnecting `stripe` purges the `eaglesoft` row instead, so the
      // Stripe row still holds its ciphertext and this goes red — for every
      // provider in the table except `eaglesoft` itself.
      const prisma = stubPrisma(everyProviderConnected(), everyProviderCursor());
      await serviceFor(prisma).disconnect({ actor: "romain" }, provider);

      for (const other of KNOWN_ERP_PROVIDERS.filter((p) => p !== provider)) {
        const row = rowFor(prisma, other);
        expect(row.status, `${other} must still be CONNECTED`).toBe("CONNECTED");
        expect(
          row.providerTokensEnc,
          `disconnecting ${provider} must not purge ${other}`,
        ).toBe(SEEDED_TOKEN_CIPHERTEXT);
        expect(row.apiCredentialsEnc).toBe(SEEDED_API_CIPHERTEXT);
      }
    });

    /** WARP-2482, now per provider. */
    it("resets THIS provider's cursors, by its own connectionId", async () => {
      const prisma = stubPrisma(everyProviderConnected(), everyProviderCursor());
      await serviceFor(prisma).disconnect({ actor: "romain" }, provider);

      const { where, data } = cursorResetCall(prisma);
      expect(where).toEqual({ connectionId: connIdFor(provider) });
      expect(data).toMatchObject(UNSTARTED_CURSOR_FIELDS);
    });

    it("leaves every OTHER provider's cursors at their recorded position", async () => {
      const prisma = stubPrisma(everyProviderConnected(), everyProviderCursor());
      await serviceFor(prisma).disconnect({ actor: "romain" }, provider);

      for (const other of KNOWN_ERP_PROVIDERS.filter((p) => p !== provider)) {
        const cursor = prisma.cursors.find(
          (c) => c.connectionId === connIdFor(other),
        );
        expect(cursor, `${other} must still have a cursor`).toBeDefined();
        // Still parked exactly where the revoked credential left it.
        expect(cursor).toMatchObject({
          watermark: "2026-08-20T00:00:00.000Z",
          state: "FAILED",
          needsReconnect: true,
        });
      }
    });

    it("audits the provider it actually purged", async () => {
      // The audit used to be a hardcoded constant, so on a mis-scoped purge it
      // agreed with the mistake — an audit row that cannot be used to discover
      // the thing it exists to record.
      const prisma = stubPrisma(everyProviderConnected(), everyProviderCursor());
      await serviceFor(prisma).disconnect({ actor: "romain" }, provider);

      const audit = prisma.erpAuditLog.create.mock.calls[0][0] as {
        data: { connectionId: string; scope: Record<string, unknown> };
      };
      expect(audit.data.connectionId).toBe(connIdFor(provider));
      expect(audit.data.scope).toMatchObject({ provider, purged: true });
      // Rule 19 — the scope still carries no credential material.
      expect(JSON.stringify(audit.data.scope)).not.toContain("CIPHERTEXT");
    });

    it("returns a detail naming THIS provider", async () => {
      const prisma = stubPrisma(everyProviderConnected(), everyProviderCursor());
      const detail = await serviceFor(prisma).disconnect(
        { actor: "romain" },
        provider,
      );

      expect(detail.provider).toBe(provider);
      expect(detail.status).toBe("DISABLED");
      expect(detail.credentialsPurged).toBe(true);
    });
  },
);

describe.each(KNOWN_ERP_PROVIDERS)(
  "setWriteEnabled(ctx, %s, …) on a box where every provider is connected",
  (provider) => {
    /**
     * The write flag is one of the two inputs to the WARP-2465 connector-grant
     * axis: `effective-access.service.ts`'s `connectionLevels()` reads
     * `{ provider, writeEnabled }` per row and `min()`s it against the role's
     * `AccessRoleConnectorGrant`. That fold was already provider-keyed; what it
     * never received was a per-provider INPUT, because only the Eaglesoft row's
     * flag could move. These tests are that input.
     */
    it("flips THIS provider's flag and no other's", async () => {
      const prisma = stubPrisma(
        everyProviderConnected().map((r) => ({ ...r, writeEnabled: false })),
      );
      await serviceFor(prisma).setWriteEnabled({ actor: "romain" }, provider, true);

      expect(rowFor(prisma, provider).writeEnabled).toBe(true);
      for (const other of KNOWN_ERP_PROVIDERS.filter((p) => p !== provider)) {
        expect(
          rowFor(prisma, other).writeEnabled,
          `enabling writes for ${provider} must not enable them for ${other}`,
        ).toBe(false);
      }
    });

    it("audits the provider it actually flipped", async () => {
      const prisma = stubPrisma(
        everyProviderConnected().map((r) => ({ ...r, writeEnabled: false })),
      );
      await serviceFor(prisma).setWriteEnabled({ actor: "romain" }, provider, true);

      const audit = prisma.erpAuditLog.create.mock.calls[0][0] as {
        data: {
          connectionId: string;
          action: string;
          scope: Record<string, unknown>;
        };
      };
      expect(audit.data.connectionId).toBe(connIdFor(provider));
      expect(audit.data.action).toBe("write-enable");
      expect(audit.data.scope).toMatchObject({ provider, writeEnabled: true });
    });

    it("disables writes for THIS provider and no other", async () => {
      const prisma = stubPrisma(everyProviderConnected()); // all writeEnabled: true
      await serviceFor(prisma).setWriteEnabled({ actor: "romain" }, provider, false);

      expect(rowFor(prisma, provider).writeEnabled).toBe(false);
      for (const other of KNOWN_ERP_PROVIDERS.filter((p) => p !== provider)) {
        expect(rowFor(prisma, other).writeEnabled).toBe(true);
      }
    });
  },
);

/**
 * The 404 half of the acceptance criteria.
 *
 * The failure being ruled out is not "it throws the wrong error" — it is the
 * SILENT NO-OP the old shape produced: `disconnect(ctx)` on a box with no
 * Eaglesoft row returned `{ provider: "eaglesoft", status: "NOT_CONFIGURED" }`
 * having written nothing, which a caller asking about Stripe could not tell
 * apart from a successful disconnect of Stripe.
 */
describe("an unknown provider is an error, never a silent no-op", () => {
  /** A key no descriptor declares and no export profile can mint. */
  const UNKNOWN = "not-a-real-connector";

  it("is genuinely unknown, or the tests below prove nothing", () => {
    expect(KNOWN_ERP_PROVIDERS).not.toContain(UNKNOWN);
  });

  it("disconnect() rejects it with a 404-class ErpError", async () => {
    const prisma = stubPrisma(everyProviderConnected(), everyProviderCursor());
    await expect(
      serviceFor(prisma).disconnect({ actor: "romain" }, UNKNOWN),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("disconnect() writes NOTHING when it rejects", async () => {
    // The mutation this kills: validating INSIDE the transaction, or after the
    // read, so an unknown provider still opens a SERIALIZABLE transaction and
    // still reaches the `if (!row) return null` branch — which is exactly the
    // silent no-op, re-created one layer down.
    const prisma = stubPrisma(everyProviderConnected(), everyProviderCursor());
    await serviceFor(prisma)
      .disconnect({ actor: "romain" }, UNKNOWN)
      .catch(() => {});

    expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
    expect(prisma.erpSyncCursor.updateMany).not.toHaveBeenCalled();
    expect(prisma.erpAuditLog.create).not.toHaveBeenCalled();
    expect(prisma.seam.calls()).toHaveLength(0);
    // And no provider's credentials moved.
    for (const p of KNOWN_ERP_PROVIDERS) {
      expect(rowFor(prisma, p).providerTokensEnc).toBe(SEEDED_TOKEN_CIPHERTEXT);
    }
  });

  it("setWriteEnabled() rejects it with a 404-class ErpError and writes nothing", async () => {
    const prisma = stubPrisma(everyProviderConnected());
    await expect(
      serviceFor(prisma).setWriteEnabled({ actor: "romain" }, UNKNOWN, true),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
    expect(prisma.erpAuditLog.create).not.toHaveBeenCalled();
  });
});

/**
 * A KNOWN provider with no row is a different fact from an unknown one, and
 * both are different from "some other provider's status".
 */
describe("a known but unconfigured provider answers about ITSELF", () => {
  /** Every provider except the one under test — so a row always exists, and a
   *  mis-scoped read has something wrong to find. */
  const seedAllBut = (provider: string) =>
    KNOWN_ERP_PROVIDERS.filter((p) => p !== provider).map((p) =>
      connectedRow({ id: connIdFor(p), provider: p }),
    );

  it("disconnect() is idempotent and names the provider ASKED about", async () => {
    // With the Eaglesoft default restored this returns `provider: "eaglesoft"`
    // — and worse, on a box that HAS an Eaglesoft row it purges it. Both are
    // wrong answers to a question about Stripe.
    const target = "stripe";
    expect(KNOWN_ERP_PROVIDERS).toContain(target);
    const prisma = stubPrisma(seedAllBut(target));

    const detail = await serviceFor(prisma).disconnect({ actor: "romain" }, target);

    expect(detail.provider).toBe(target);
    expect(detail.status).toBe("NOT_CONFIGURED");
    expect(detail.credentialsPurged).toBe(false);
    expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
    expect(prisma.erpAuditLog.create).not.toHaveBeenCalled();
    // Every other provider is untouched — nothing was purged by proxy.
    for (const other of KNOWN_ERP_PROVIDERS.filter((p) => p !== target)) {
      expect(rowFor(prisma, other).status).toBe("CONNECTED");
    }
  });

  it("setWriteEnabled() reports NOT_CONFIGURED for the provider ASKED about", async () => {
    const target = "hubspot";
    expect(KNOWN_ERP_PROVIDERS).toContain(target);
    const prisma = stubPrisma(seedAllBut(target));

    await expect(
      serviceFor(prisma).setWriteEnabled({ actor: "romain" }, target, true),
    ).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      // The MESSAGE has to name the right provider too: a 409 that says
      // "eaglesoft" to someone asking about HubSpot sends them to fix the
      // wrong connector.
      message: expect.stringContaining(target),
    });
    expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
  });
});

describe("WARP-2549 — disconnecting also removes what the connection landed", () => {
  /** Seed the rows a sync would have landed under this connection. */
  function withLanded(
    prisma: ReturnType<typeof stubPrisma>,
    opts: { companies?: string[]; withNotes?: string[] } = {},
  ) {
    const connectionId = prisma.rows[0].id as string;
    for (const id of opts.companies ?? []) {
      prisma.landed.companies.push({
        id,
        connectionId,
        origin: "EXTERNAL",
        externalSystem: "eaglesoft",
        externalId: `x-${id}`,
        isArchived: false,
      });
    }
    for (const id of opts.withNotes ?? []) prisma.landed.withLocalActivity.add(id);
    return prisma;
  }

  it("deletes a landed record nobody wrote against", async () => {
    const prisma = withLanded(stubPrisma(connectedRow()), { companies: ["co-1"] });

    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    expect(prisma.landed.companies).toHaveLength(0);
  });

  it("🔴 ARCHIVES one that carries a note a human typed", async () => {
    // Every CrmActivity subject relation is `onDelete: Cascade`, so deleting
    // the parent takes the owner's own prose with it — proven against real
    // Postgres in crm-activity-cascade.pg.test.ts.
    const prisma = withLanded(stubPrisma(connectedRow()), {
      companies: ["co-1"],
      withNotes: ["co-1"],
    });

    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    expect(prisma.landed.companies).toHaveLength(1);
    expect(prisma.landed.companies[0]).toMatchObject({ isArchived: true });
  });

  it("purges the records in the SAME transaction as the credentials", async () => {
    // Mutation: move the record purge outside the transaction → the rollback
    // leaves the credentials intact and the customer's records gone.
    const prisma = withLanded(stubPrisma(connectedRow()), { companies: ["co-1"] });
    prisma.erpSyncCursor.updateMany.mockRejectedValueOnce(new Error("reset failed"));

    await expect(
      serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft"),
    ).rejects.toThrow("reset failed");

    expect(prisma.landed.companies).toHaveLength(1);
    expect(prisma.rows[0].apiCredentialsEnc).not.toBeNull();
  });

  it("counts what it removed into the audit scope, never what it was", async () => {
    const prisma = withLanded(stubPrisma(connectedRow()), {
      companies: ["co-1", "co-2"],
      withNotes: ["co-2"],
    });

    await serviceFor(prisma).disconnect({ actor: "romain" }, "eaglesoft");

    const call = prisma.erpAuditLog.create.mock.calls[0] as unknown as [
      { data: { scope: Record<string, unknown> } },
    ];
    expect(call[0].data.scope).toMatchObject({ landedDeleted: 1, landedArchived: 1 });
    expect(JSON.stringify(call[0].data.scope)).not.toContain("co-1");
  });
});

// ===========================================================================
// WARP-2659 — the mcp track
// ===========================================================================

/**
 * `disconnect()` read `requireKnownProvider`, whose predicate has been an
 * explicit `lan | cloud` allow-list since WARP-2650, so an `mcp` provider was
 * refused with a 404 — while stage's `DisconnectControl` rendered on its hub
 * tile and on its credentials form. The purge is track-agnostic; only the
 * gate excluded the track. These pin the admission, the teardown the track
 * needs beyond the purge, and the one gate that must NOT widen with it.
 */
describe("disconnect() admits the mcp track (WARP-2659)", () => {
  const MCP_ID = mcpProviderIds()[0]!;
  const MCP_SERVER_ID = (() => {
    const d = providerDescriptor(MCP_ID);
    if (d?.track !== "mcp") throw new Error("fixture is not an mcp track");
    return d.mcpServerId;
  })();

  /** A connected MCP row as `saas-credential.service.ts` writes it: the secret
   *  sealed in `providerTokensEnc`, the two connection facts in
   *  `providerConfig`, every LAN column empty. */
  function mcpRow() {
    return connectedRow({
      id: "conn_mcp",
      provider: MCP_ID,
      host: null,
      databaseName: null,
      secretRef: `${MCP_ID}:pending`,
      writeEnabled: false,
      apiCredentialsEnc: null,
      apiRouteMap: null,
      apiCaCert: null,
      schemaVersion: null,
      schemaHash: null,
      providerConfig: { email: "ops@vendor.example", cloudId: "cloud-1" },
    });
  }

  function serviceWithDetach(
    prisma: ReturnType<typeof stubPrisma>,
    detach: (id: string) => Promise<void>,
  ) {
    return createIntegrationsService(prisma as never, {
      connectorFor: () => blockedConnector(),
      remoteMcp: { detach },
    });
  }

  it("purges the mcp credential — the sealed token and the config it is used with", async () => {
    // Mutation: revert `disconnect()` to `requireKnownProvider` → 404 → red.
    const prisma = stubPrisma(mcpRow());
    const detail = await serviceFor(prisma).disconnect({ actor: "romain" }, MCP_ID);
    expect(detail.provider).toBe(MCP_ID);
    expect(detail.status).toBe("DISABLED");

    const data = updateData(prisma);
    expect(data.providerTokensEnc).toBeNull();
    expect(data).toHaveProperty("providerConfig");
    expect(data.providerConfig).not.toEqual(mcpRow().providerConfig);

    // And the hub reads the purge back as a fact, exactly as for a cloud row.
    const listed = (await serviceFor(prisma).list()).find((r) => r.provider === MCP_ID);
    expect(listed?.status).toBe("DISABLED");
    expect(listed?.credentialsPurged).toBe(true);
  });

  it("tears down the remote server by the descriptor's server id, once the purge is on the row", async () => {
    // Mutation: drop the detach block → red. Mutation: pass `scoped` instead
    // of `descriptor.mcpServerId` → red the day the two differ, and the
    // assertion is written against the descriptor so it will.
    const prisma = stubPrisma(mcpRow());
    const seen: Array<{ serverId: string; statusAtCall: unknown; tokenAtCall: unknown }> = [];
    const detach = vi.fn(async (serverId: string) => {
      seen.push({
        serverId,
        statusAtCall: prisma.rows[0]!.status,
        tokenAtCall: prisma.rows[0]!.providerTokensEnc,
      });
    });

    await serviceWithDetach(prisma, detach).disconnect({ actor: "romain" }, MCP_ID);

    expect(detach).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      { serverId: MCP_SERVER_ID, statusAtCall: "DISABLED", tokenAtCall: null },
    ]);
  });

  it("tears nothing down when there was nothing to disconnect", async () => {
    const prisma = stubPrisma(null);
    const detach = vi.fn(async () => {});
    const detail = await serviceWithDetach(prisma, detach).disconnect(
      { actor: "romain" },
      MCP_ID,
    );
    expect(detail.status).toBe("NOT_CONFIGURED");
    expect(detach).not.toHaveBeenCalled();
  });

  it("never tears down a remote server for a track that has none", async () => {
    const prisma = stubPrisma(connectedRow());
    const detach = vi.fn(async () => {});
    await serviceWithDetach(prisma, detach).disconnect({ actor: "romain" }, EAGLESOFT_PROVIDER);
    expect(detach).not.toHaveBeenCalled();
  });

  it("reports the purge even when the teardown fails — the row is the durable fact", async () => {
    const prisma = stubPrisma(mcpRow());
    const detach = vi.fn(async () => {
      throw new Error("bridge unreachable");
    });
    const detail = await serviceWithDetach(prisma, detach).disconnect(
      { actor: "romain" },
      MCP_ID,
    );
    expect(detail.status).toBe("DISABLED");
    expect(prisma.rows[0]!.providerTokensEnc).toBeNull();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("still refuses the write toggle for an mcp track (ADR-043 §3)", async () => {
    // Mutation: switch `setWriteEnabled` to `requireConnectionProvider` → red.
    // `writeEnabled: true` on an MCP row would be a flag nothing honours, and
    // the remote write interceptor (WARP-2305) does not exist yet.
    const prisma = stubPrisma(mcpRow());
    await expect(
      serviceFor(prisma).setWriteEnabled({ actor: "romain" }, MCP_ID, true),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
  });
});
