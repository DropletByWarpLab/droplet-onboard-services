/**
 * WARP-2283 — audit gap 1: `IntegrationConnection.connect()` wrote no activity
 * row at all.
 *
 * The gap in one sentence: `connect()` persists a customer's encrypted
 * credentials to the row and, before this story, nothing observed it. Under
 * ADR-041 §2 connecting IS the consent record — the moment a credential enters
 * the box is precisely the moment that must be auditable — so this was a
 * compliance gap, not a missing nicety.
 *
 * **Every test in this file is red against `origin/stage`.** That is the point;
 * they are the gap, expressed as assertions.
 *
 * Prisma is a `vi.fn()` stub, per the house rule against mock-database
 * integration tests: this file is about which calls are made, not about what a
 * database does with them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("./activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import { ConnectorBlockedError } from "@droplet/erp-connector";
import { createIntegrationsService } from "./integrations.service.js";
import { __setEncryptionKeyForTest } from "./encryption.service.js";

const SEEDED_PASSWORD = "SEEDED-CREDENTIAL-VALUE";
/** The REST track seals its credential triple through `encryption.service`
 *  before `connect()` ever writes the row, so the key seam has to be installed
 *  even though nothing here asserts on the ciphertext. */
const TEST_KEY = Buffer.alloc(32, 6).toString("base64");

/** A connector stub. `mode` picks which of `connect()`'s three outcomes runs. */
function stubConnector(mode: "ok" | "blocked" | "error") {
  return {
    connect: vi.fn(async () => {
      if (mode === "blocked") {
        throw new ConnectorBlockedError("blocked", "install the driver");
      }
      if (mode === "error") throw new Error("boom");
    }),
    introspect: vi.fn(async () => ({}) as never),
    health: vi.fn(async () => ({}) as never),
    close: vi.fn(async () => {}),
  } as never;
}

function stubPrisma(overrides: Record<string, unknown> = {}) {
  const row = {
    id: "conn_1",
    provider: "eaglesoft",
    status: "PROVISIONING",
    host: "10.0.0.5",
    port: null,
    databaseName: "PattersonPM",
    secretRef: "eaglesoft:pending",
    writeEnabled: false,
    schemaVersion: null,
    schemaHash: null,
    lastHealthyAt: null,
  };
  return {
    integrationConnection: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...data,
      })),
      ...overrides,
    },
    erpAuditLog: { create: vi.fn(async () => ({})) },
  };
}

function connectRows() {
  return recordActivityMock.mock.calls
    .map((c) => c[0] as { what: string; refs: Record<string, unknown>; actor: unknown })
    .filter((p) => p.what === "Integration connected");
}

beforeEach(() => {
  recordActivityMock.mockClear();
  __setEncryptionKeyForTest(TEST_KEY);
});

describe("connect() writes the consent record", () => {
  it("records exactly one row when the connector reports blocked", async () => {
    const prisma = stubPrisma();
    const svc = createIntegrationsService(prisma as never, {
      connectorFor: () => stubConnector("blocked"),
    });

    await svc.connect({ host: "10.0.0.5" });

    // Mutation: delete the `recordActivity` call from `connect()` → red.
    expect(connectRows()).toHaveLength(1);
  });

  it("records exactly one row on the CONNECTED path", async () => {
    const prisma = stubPrisma();
    const svc = createIntegrationsService(prisma as never, {
      connectorFor: () => stubConnector("ok"),
    });

    const detail = await svc.connect({ host: "10.0.0.5" });

    expect(detail.status).toBe("CONNECTED");
    expect(connectRows()).toHaveLength(1);
    expect(connectRows()[0].refs.status).toBe("CONNECTED");
  });

  it("records exactly one row on the ERROR path — the credential still landed", async () => {
    const prisma = stubPrisma();
    const svc = createIntegrationsService(prisma as never, {
      connectorFor: () => stubConnector("error"),
    });

    await svc.connect({ host: "10.0.0.5" });

    // An unreachable vendor does not un-persist the credential, so it does not
    // un-happen for audit purposes either.
    const rows = connectRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].refs.status).toBe("ERROR");
  });

  it("writes NO row when the persist itself throws", async () => {
    const prisma = stubPrisma({
      create: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const svc = createIntegrationsService(prisma as never, {
      connectorFor: () => stubConnector("ok"),
    });

    await expect(svc.connect({ host: "10.0.0.5" })).rejects.toThrow("db down");
    // Nothing was stored, so there is nothing to attest to.
    expect(connectRows()).toHaveLength(0);
  });

  it("carries hasSecret as a boolean and never the credential", async () => {
    const prisma = stubPrisma();
    const svc = createIntegrationsService(prisma as never, {
      connectorFor: () => stubConnector("blocked"),
    });

    await svc.connect({
      host: "10.0.0.5",
      apiCredentials: {
        integrationKey: "SEEDED-INTEGRATION-KEY",
        userId: "seeded-user",
        password: SEEDED_PASSWORD,
      },
    });

    const row = connectRows()[0];
    expect(row.refs.hasSecret).toBe(true);
    // Mutation: put the credentials into `refs` and this goes red.
    const scope = JSON.stringify(row.refs);
    expect(scope).not.toContain(SEEDED_PASSWORD);
    expect(scope).not.toContain("SEEDED-INTEGRATION-KEY");
  });

  it("reports hasSecret false when no credential was supplied", async () => {
    const prisma = stubPrisma();
    const svc = createIntegrationsService(prisma as never, {
      connectorFor: () => stubConnector("blocked"),
    });

    await svc.connect({ host: "10.0.0.5" });
    expect(connectRows()[0].refs.hasSecret).toBe(false);
  });

  it("attributes the row to the caller when the route supplies one", async () => {
    const prisma = stubPrisma();
    const svc = createIntegrationsService(prisma as never, {
      connectorFor: () => stubConnector("blocked"),
    });

    const actor = { type: "user" as const, id: "11111111-1111-4111-8111-111111111111" };
    await svc.connect({ host: "10.0.0.5" }, { actor });

    // "Was this allowed?" and "by whom?" are different questions; a consent
    // record that cannot answer the second is only half an answer.
    expect(connectRows()[0].actor).toEqual(actor);
  });

  it("falls back to a system actor rather than dropping the row", async () => {
    const prisma = stubPrisma();
    const svc = createIntegrationsService(prisma as never, {
      connectorFor: () => stubConnector("blocked"),
    });

    await svc.connect({ host: "10.0.0.5" });
    expect(connectRows()[0].actor).toEqual({ type: "system", id: null });
  });
});
