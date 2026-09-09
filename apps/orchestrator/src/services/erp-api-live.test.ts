/**
 * The orchestrator's ERP service against a LIVE dummy Eaglesoft REST box.
 *
 * Everything else in this repo tests the ERP service with a stubbed connector,
 * which proves the service's own logic but says nothing about whether a
 * deployed box could actually reach a practice. This closes that: it starts the
 * harness box from `@droplet/erp-connector`'s `harness/eaglesoft-api/`, writes a
 * connection row exactly as `connect()` would (encrypted credentials, stored
 * route map, stored CA), and drives `createErpService(...)` — the real service,
 * the real connector, real TLS — until patient data comes back.
 *
 * That is the rehearsal an installer needs before standing in a dental office:
 * proof that config → connect → read works end to end, with only the route map
 * and credentials swapped for the real ones on the day.
 *
 * Runs in-process on an ephemeral port; no Docker, no network, no PHI.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The encryption service reads DEVICE_SECRET_KEY from config at call time, so
// the stored-credential path needs a deterministic key (same fixture value the
// device-clients suite uses).
vi.mock("../config.js", () => ({
  config: {
    DEVICE_SECRET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  },
}));

// @ts-expect-error -- plain ESM JS test harness, outside any tsconfig rootDir.
import { startMockEaglesoftApi } from "../../../../services/erp-connector/harness/eaglesoft-api/mock-server.mjs";
// @ts-expect-error -- see above.
import { ensureCerts } from "../../../../services/erp-connector/harness/eaglesoft-api/certs.mjs";
// @ts-expect-error -- see above.
import { liveBoxSkipReason, announceLiveBoxSkip } from "../../../../services/erp-connector/harness/eaglesoft-api/preflight.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createErpService } from "./erp.service.js";
import { createIntegrationsService } from "./integrations.service.js";
import {
  decodeApiCredentials,
  encodeApiCredentials,
  parseRouteMap,
  EAGLESOFT_API_PROVIDER,
} from "./erp-provider.js";

/** What this machine lacks for the live box — the `openssl` CLI the harness
 *  mints its CA with, or a Node whose built-in fetch takes the CA-trusting
 *  undici dispatcher (WARP-2611) — or `null` when it can run the suite. Skip
 *  explicitly with the reason rather than sit red on every clean checkout, but
 *  fail in CI rather than lose the coverage silently. */
const SKIP_REASON: string | null = liveBoxSkipReason();

it("CI runs this live-box suite rather than skipping it", () => {
  if (!process.env.CI) return;
  expect(SKIP_REASON, "the live ERP suite would skip in CI and prove nothing").toBeNull();
});

const OWNER = { id: "u-owner", role: "owner" };

announceLiveBoxSkip("erp.service — live Eaglesoft REST box", SKIP_REASON);

describe.skipIf(SKIP_REASON !== null)("erp.service — live Eaglesoft REST box", () => {
  let box: any;

  beforeAll(async () => {
    box = await startMockEaglesoftApi();
  }, 30_000);

  afterAll(async () => {
    await box?.close();
  });

  afterEach(() => box.setFaults(null));

  /** A connection row as `connect()` would have persisted it. `overrides` lets a
   *  test knock out one piece and assert the degradation is honest. */
  function connectionRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "conn-api",
      provider: EAGLESOFT_API_PROVIDER,
      status: "CONNECTED",
      host: box.host,
      port: box.port,
      databaseName: "PattersonPM",
      secretRef: "eaglesoft-api:device",
      writeEnabled: false,
      schemaHash: null,
      apiCredentialsEnc: encodeApiCredentials(box.credentials),
      apiRouteMap: box.routeMap,
      apiCaCert: box.ca,
      ...overrides,
    };
  }

  /** Prisma stand-in returning that row, plus a sink for the audit trail. */
  function prismaFor(row: Record<string, unknown> | null) {
    const auditLog: Record<string, unknown>[] = [];
    return {
      auditLog,
      prisma: {
        integrationConnection: {
          findFirst: vi.fn(async ({ where }: any) =>
            row && where.provider === row.provider ? { ...row } : null,
          ),
        },
        erpWriteRequest: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
        erpAuditLog: {
          create: vi.fn(async ({ data }: any) => {
            auditLog.push(data);
            return data;
          }),
        },
      } as any,
    };
  }

  /** The service, wired the production way: no injected connector, so it builds
   *  the real one from the row via `connectorForProvider`. */
  function serviceFor(row: Record<string, unknown> | null) {
    const { prisma, auditLog } = prismaFor(row);
    // `port` is not a column on IntegrationConnection, so the row's host must
    // carry the ephemeral port the harness bound. host:port is how a practice
    // would configure a non-default port anyway.
    return { svc: createErpService(prisma), auditLog };
  }

  it("reads today's schedule off the live box, end to end", async () => {
    const { svc } = serviceFor(connectionRow());
    const result = await svc.getSchedule({ date: box.anchorDate }, OWNER);

    expect(result.connected).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({ appt_id: 5001, status: "confirmed" });
  });

  it("searches patients, returning only minimum-necessary fields", async () => {
    const { svc } = serviceFor(connectionRow());
    const result = await svc.searchPatients({ query: "Lis" }, OWNER);

    expect(result.connected).toBe(true);
    expect(result.items).toEqual([
      { patient_id: 1003, first_name: "Barbara", last_name: "Liskov" },
    ]);
    // The box returns DateOfBirth/Phone; neither may survive the mapping.
    expect(JSON.stringify(result.items)).not.toContain("555-01");
  });

  it("aggregates AR to two numbers", async () => {
    const { svc } = serviceFor(connectionRow());
    await expect(svc.getArSummary(OWNER)).resolves.toMatchObject({
      connected: true,
      accountCount: 5,
      totalBalance: 634.5,
    });
  });

  it("writes a non-PHI audit row for a live read", async () => {
    const { svc, auditLog } = serviceFor(connectionRow());
    await svc.searchPatients({ query: "Kn" }, OWNER);

    expect(auditLog).toHaveLength(1);
    const scope = JSON.stringify(auditLog[0]);
    expect(scope).not.toContain("Knuth"); // no patient name in the audit trail
    expect(scope).not.toContain(box.credentials.password);
  });

  // ------------------------------------------------- honest degradation ----

  it("degrades honestly when the row carries no credentials", async () => {
    const { svc } = serviceFor(connectionRow({ apiCredentialsEnc: null }));
    await expect(svc.getSchedule({ date: box.anchorDate }, OWNER)).resolves.toMatchObject({
      connected: false,
      reason: "ERP_NOT_CONNECTED",
      items: [],
    });
  });

  it("degrades honestly when the stored credentials cannot be decrypted", async () => {
    // e.g. DEVICE_SECRET_KEY was rotated out from under the row.
    const { svc } = serviceFor(connectionRow({ apiCredentialsEnc: "not-a-valid-blob" }));
    await expect(svc.getArSummary(OWNER)).resolves.toMatchObject({
      connected: false,
      reason: "ERP_NOT_CONNECTED",
    });
  });

  it("degrades honestly when no route map has been discovered yet", async () => {
    const { svc } = serviceFor(connectionRow({ apiRouteMap: null }));
    await expect(svc.getSchedule({ date: box.anchorDate }, OWNER)).resolves.toMatchObject({
      connected: false,
      reason: "ERP_NOT_CONNECTED",
    });
  });

  it("degrades honestly when no CA is configured for a privately-signed box", async () => {
    // No CA on the row => fall back to the system trust store, which has never
    // heard of the harness's private CA.
    const { svc } = serviceFor(connectionRow({ apiCaCert: null }));
    await expect(svc.getArSummary(OWNER)).resolves.toMatchObject({
      connected: false,
      reason: "ERP_NOT_CONNECTED",
    });
  });

  it("REFUSES a box whose certificate does not chain to the configured CA", async () => {
    // A well-formed CA that simply did not sign this box's certificate.
    //
    // This is the test that distinguishes "we trust the configured CA" from
    // "we stopped checking": the absent-CA case above still fails if
    // verification is disabled outright, so on its own it proves nothing.
    // Here, a connector that skipped verification (or passed
    // rejectUnauthorized:false) would happily connect and this would go red.
    const unrelated = ensureCerts({
      dir: join(tmpdir(), "droplet-erp-unrelated-ca"),
      hosts: ["somewhere-else.example"],
    });
    const { svc } = serviceFor(connectionRow({ apiCaCert: unrelated.ca }));
    await expect(svc.getArSummary(OWNER)).resolves.toMatchObject({
      connected: false,
      reason: "ERP_NOT_CONNECTED",
    });
  });

  it("degrades honestly when the box returns 5xx", async () => {
    const { svc } = serviceFor(connectionRow());
    box.setFaults({ status: 500 });
    await expect(svc.getArSummary(OWNER)).resolves.toMatchObject({
      connected: false,
      reason: "ERP_NOT_CONNECTED",
    });
  });

  it("reports NOT_CONFIGURED when there is no connection row at all", async () => {
    const { svc } = serviceFor(null);
    await expect(svc.getArSummary(OWNER)).resolves.toMatchObject({
      connected: false,
      reason: "NOT_CONFIGURED",
    });
  });

  // ------------------------------------------------------- row resolution --

  it("finds the API row even though the SQL provider is the historical default", async () => {
    // The pre-existing resolver only ever looked for provider "eaglesoft"; an
    // API-only deployment would have resolved to NOT_CONFIGURED forever.
    const { svc } = serviceFor(connectionRow());
    await expect(svc.getArSummary(OWNER)).resolves.toMatchObject({ connected: true });
  });
});

// ------------------------------------------------- connect() persistence ----

describe("connect() persists REST-track material", () => {
  /** Minimal Prisma stub capturing what connect() writes. */
  function makePrisma(seed?: Record<string, unknown>) {
    const rows: Record<string, unknown>[] = seed ? [{ id: "c1", ...seed }] : [];
    return {
      rows,
      client: {
        integrationConnection: {
          findFirst: vi.fn(async ({ where }: any) =>
            rows.find((r) => r.provider === where.provider) ?? null,
          ),
          create: vi.fn(async ({ data }: any) => {
            const row = { id: "c1", ...data };
            rows.push(row);
            return row;
          }),
          update: vi.fn(async ({ where, data }: any) => {
            const row = rows.find((r) => r.id === where.id)!;
            Object.assign(row, data);
            return row;
          }),
        },
        erpAuditLog: { create: vi.fn(async ({ data }: any) => data) },
      } as any,
    };
  }

  const CREDS = { integrationKey: "vendor-key-xyz", userId: "u1", password: "s3cret-pw" };

  async function connectWith(input: Record<string, unknown>, seed?: Record<string, unknown>) {
    const { rows, client } = makePrisma(seed);
    const svc = createIntegrationsService(client);
    // The connector is unreachable here (nothing is listening), so connect()
    // lands in PROVISIONING — which is fine: what's under test is what got
    // WRITTEN, not whether the box answered.
    await svc.connect({
      provider: EAGLESOFT_API_PROVIDER,
      host: "eaglesoft.example",
      ...input,
    } as any).catch(() => {});
    return rows[0];
  }

  it("stores credentials encrypted — never cleartext on the row", async () => {
    const row = await connectWith({ apiCredentials: CREDS });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("s3cret-pw");
    expect(serialized).not.toContain("vendor-key-xyz");
    expect(decodeApiCredentials(row.apiCredentialsEnc as string)).toEqual(CREDS);
  });

  it("stores the route map, the CA, and the port", async () => {
    const row = await connectWith({
      apiRouteMap: { authenticate: {}, reads: {}, writes: {} },
      apiCaCert: "-----BEGIN CERTIFICATE-----\nxx\n-----END CERTIFICATE-----",
      port: 9999,
    });
    expect(parseRouteMap(row.apiRouteMap)).toBeDefined();
    expect(row.apiCaCert).toContain("BEGIN CERTIFICATE");
    // Regression: `port` was accepted by connect() and silently dropped before
    // it had a column, so any non-default-port practice was unconfigurable.
    expect(row.port).toBe(9999);
  });

  it("a reconnect that changes only the host keeps the existing credentials", async () => {
    // Re-running the wizard to fix a typo'd host must not silently log the
    // practice out of its own integration.
    const row = await connectWith(
      { host: "new-host.example" },
      {
        provider: EAGLESOFT_API_PROVIDER,
        status: "CONNECTED",
        host: "old-host.example",
        databaseName: "PattersonPM",
        secretRef: "eaglesoft-api:device",
        apiCredentialsEnc: encodeApiCredentials(CREDS),
      },
    );
    expect(row.host).toBe("new-host.example");
    expect(decodeApiCredentials(row.apiCredentialsEnc as string)).toEqual(CREDS);
  });
});

// ------------------------------------------------------------ pure units ----

describe("stored REST-track material", () => {
  it("round-trips credentials through encryption", () => {
    const creds = {
      integrationKey: "vendor-key-abcdef",
      userId: "provider-login",
      password: "correct-horse-battery-staple",
    };
    const blob = encodeApiCredentials(creds);
    // Encrypted, not merely encoded — none of the three survives in the blob.
    // (Substrings must be long enough not to collide with base64 by chance.)
    expect(blob).not.toContain("vendor-key-abcdef");
    expect(blob).not.toContain("provider-login");
    expect(blob).not.toContain("correct-horse-battery-staple");
    expect(decodeApiCredentials(blob)).toEqual(creds);
  });

  it("treats an unusable credential blob as absent, never as a partial identity", () => {
    expect(decodeApiCredentials(null)).toBeUndefined();
    expect(decodeApiCredentials("")).toBeUndefined();
    expect(decodeApiCredentials("garbage")).toBeUndefined();
    // Decryptable, but not the expected shape.
    expect(decodeApiCredentials(encodeApiCredentials({ integrationKey: "k" } as never))).toBeUndefined();
  });

  it("rejects a stored route map that isn't one", () => {
    expect(parseRouteMap(null)).toBeUndefined();
    expect(parseRouteMap("a string")).toBeUndefined();
    expect(parseRouteMap([])).toBeUndefined();
    expect(parseRouteMap({ reads: {}, writes: {} })).toBeUndefined(); // no authenticate
    expect(parseRouteMap({ authenticate: {}, reads: {}, writes: {} })).toBeDefined();
  });
});
