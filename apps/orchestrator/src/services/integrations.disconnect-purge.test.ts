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
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("./activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import { ConnectorBlockedError } from "@droplet/erp-connector";
import { createIntegrationsService } from "./integrations.service.js";

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

function stubPrisma(row: Record<string, unknown> | null) {
  return {
    integrationConnection: {
      findFirst: vi.fn(async () => (row ? { ...row } : null)),
      findMany: vi.fn(async () => (row ? [{ ...row }] : [])),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...connectedRow(),
        ...data,
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...(row ?? connectedRow()),
        ...data,
      })),
    },
    erpAuditLog: { create: vi.fn(async () => ({})) },
  };
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

beforeEach(() => {
  recordActivityMock.mockClear();
});

describe("disconnect() purges the connection's secrets and identity", () => {
  it("nulls every credential and identity column in the update", async () => {
    // Mutation: revert `data` to `{ status: "DISABLED", writeEnabled: false }`
    // → every one of these assertions goes red. That mutation IS the code on
    // `origin/stage`.
    const prisma = stubPrisma(connectedRow());
    await serviceFor(prisma).disconnect({ actor: "romain" });

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
    const detail = await serviceFor(prisma).disconnect({ actor: "romain" });

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
    await serviceFor(prisma).disconnect({ actor: "romain" });

    expect(prisma.integrationConnection.update).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — no row means no write and no audit", async () => {
    const prisma = stubPrisma(null);
    const detail = await serviceFor(prisma).disconnect({ actor: "romain" });

    expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
    expect(prisma.erpAuditLog.create).not.toHaveBeenCalled();
    expect(detail.status).toBe("NOT_CONFIGURED");
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
    await serviceFor(prisma).disconnect({ actor: "romain" });

    const audit = disconnectAudit(prisma);
    expect(audit.action).toBe("disconnect");
    expect(audit.scope.purged).toBe(true);
  });

  it("contains no credential material", async () => {
    // Mutation: pass the row into the audit scope (`scope: { ...row }`) → red.
    // An append-only, exportable audit row is the worst possible second home
    // for a credential: no rotation can recall it.
    const prisma = stubPrisma(connectedRow());
    await serviceFor(prisma).disconnect({ actor: "romain" });

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
    const detail = await serviceFor(prisma).disconnect({ actor: "romain" });

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
  function purgedRow() {
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
    const prisma = stubPrisma(purgedRow());
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
});
