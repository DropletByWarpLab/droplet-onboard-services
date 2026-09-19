/**
 * WARP-2842 — `connect()` builds a cloud / REST connector FROM THE ROW.
 *
 * The sibling suite (`integrations.connect-probe.test.ts`) injects
 * `deps.connectorFor` with a mocked healthy connector, so it proves the probe
 * branch and nothing about how a connector is built. This suite runs the REAL
 * `defaultConnectorFor` against a row whose `providerTokensEnc` is sealed for
 * that row's id, with only the vendor's HTTP stubbed at `globalThis.fetch`.
 *
 * The defect it pins: `defaultConnectorFor` built the selector from the
 * `ConnectInput` alone (host / port / secretRef / apiCredentials), so a cloud
 * track's `connectionId` / `providerConfig` / `cloudTokens` were never on it.
 * Every cloud factory then kept its blocked resolver, the probe rejected with
 * `ConnectorBlockedError`, and the row went PROVISIONING → NOT_CONFIGURED with
 * a perfectly good credential sitting in it.
 *
 * Nothing here reaches a vendor: `fetch` is a `vi.fn()` and every assertion
 * is about what was stored and what was (not) dialed.
 */
import { MAILCHIMP_PROVIDER, STRIPE_PROVIDER } from "@droplet/erp-connector";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { matchesWhere } from "../__tests__/helpers/integration-connection-where.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

import { __resetCallBudgetsForTest } from "./erp-provider.js";
import { createIntegrationsService } from "./integrations.service.js";
import { sealSaasCredentials } from "./saas-credential.service.js";

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("./activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));
// The repo's logger-mock idiom (see inference-runtime.test.ts): the service
// logs through pino, so a `console.warn` spy sees nothing. Only `warn` is
// captured — it is the level the dropped-verdict line is written at.
const warned = vi.hoisted(() => [] as string[]);
vi.mock("../lib/logger.js", () => {
  const push = (...args: unknown[]) => {
    warned.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  const stub = {
    warn: push,
    debug: () => {},
    info: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    child: () => stub,
  };
  return { createLogger: () => stub };
});

/** Composed from parts, never one literal (WARP-2379 — push protection). */
const FAKE_STRIPE_KEY = "rk_test_" + "EXAMPLE" + "FIXTURE" + "NOTAREALKEY";
const ROW_ID = "conn_stripe_2842";

type Row = Record<string, unknown> & { id: string; provider: string; status: string };

function makePrismaMock(seed: Row[]) {
  const rows = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  let seq = 0;
  const integrationConnection = {
    findFirst: vi.fn(async ({ where }: any) => {
      for (const r of rows.values()) if (r.provider === where.provider) return { ...r };
      return null;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const r = rows.get(where.id);
      return r ? { ...r } : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      seq += 1;
      // `providerTokensEnc: null` as Prisma returns it on a row created
      // without one — the verdict guard keys on that column.
      const row: Row = { id: `conn_${seq}`, lastHealthyAt: null, providerTokensEnc: null, ...data };
      rows.set(row.id, row);
      return { ...row };
    }),
    // Prisma semantics: only the keys PRESENT in `data` are applied. A stub
    // that replaced the row would hide an over-wide write.
    update: vi.fn(async ({ where, data }: any) => {
      const row = { ...rows.get(where.id)!, ...data };
      rows.set(where.id, row);
      return { ...row };
    }),
    // Prisma semantics again, and load-bearing for the race cases below:
    // EVERY key in `where` must match — a stub that matched on `id` alone
    // would make the optimistic guard's condition invisible. `matchesWhere`
    // is the shared matcher: a Json `{ equals }` filter (the guard's
    // `providerConfig` key) is matched BY VALUE, as jsonb does it.
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = rows.get(where.id);
      if (!row || !matchesWhere(row, where)) return { count: 0 };
      rows.set(where.id, { ...row, ...data });
      return { count: 1 };
    }),
  };
  const prisma: any = {
    integrationConnection,
    erpAuditLog: { create: vi.fn(async () => ({})) },
    erpSyncCursor: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  // The shared transaction seam (WARP-1570), not a hand-rolled
  // `$transaction: (fn) => fn(self)`: the seam records the options argument,
  // rolls a throwing callback back, and the repo's adoption gate
  // (`prisma-tx-seam-adoption.test.ts`) refuses any suite covering an
  // isolation-declaring module that stubs it by hand.
  prisma.$transaction = createTransactionSeam({ client: () => prisma, stores: { rows } }).$transaction;
  return { rows, prisma };
}

/** A Stripe row exactly as `PATCH /credentials` leaves it: the key sealed for
 *  THIS row's id, config parsed, status PROVISIONING, LAN columns untouched. */
function stripeRow(over: Partial<Row> = {}): Row {
  return {
    id: ROW_ID,
    provider: STRIPE_PROVIDER,
    status: "PROVISIONING",
    host: "",
    port: null,
    databaseName: "",
    secretRef: "stripe:saas",
    writeEnabled: false,
    apiCredentialsEnc: null,
    apiRouteMap: null,
    apiCaCert: null,
    providerConfig: { provider: STRIPE_PROVIDER },
    providerTokensEnc: sealSaasCredentials(ROW_ID, { apiKey: FAKE_STRIPE_KEY }),
    lastHealthyAt: null,
    ...over,
  };
}

/** A Mailchimp row as `PATCH /credentials` leaves it: the key sealed for THIS
 *  row's id, and the NON-SECRET datacenter in `providerConfig` — the field the
 *  factory reads to pick the host. The one cloud track in this suite whose
 *  config carries a real connection fact, which is what the config-only race
 *  below needs. Key composed from parts (WARP-2379). */
const MAILCHIMP_ROW_ID = "conn_mailchimp_2842";
const FAKE_MAILCHIMP_KEY = "0123456789abcdef0123" + "-us14";
function mailchimpRow(over: Partial<Row> = {}): Row {
  return {
    ...stripeRow(),
    id: MAILCHIMP_ROW_ID,
    provider: MAILCHIMP_PROVIDER,
    secretRef: "mailchimp:saas",
    providerConfig: { datacenter: "us14" },
    providerTokensEnc: sealSaasCredentials(MAILCHIMP_ROW_ID, { apiKey: FAKE_MAILCHIMP_KEY }),
    ...over,
  };
}

function okResponse(body: unknown = { object: "list", data: [], has_more: false }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  recordActivityMock.mockClear();
  warned.length = 0;
  fetchMock.mockReset().mockImplementation(async () => okResponse());
  vi.stubGlobal("fetch", fetchMock);
});

/** The activity rows `connect()` wrote, in order. */
function activityRows() {
  return recordActivityMock.mock.calls.map(
    (c) => c[0] as { what: string; severity: string; refs: Record<string, unknown> },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetCallBudgetsForTest();
});

describe("connect() on a cloud row, with NO injected connectorFor", () => {
  it("reaches CONNECTED with lastHealthyAt set, having dialed the vendor with the sealed key", async () => {
    // Mutation: drop the `cloudMaterialFromRow(row)` merge in
    // `defaultConnectorFor` → the Stripe factory keeps its blocked resolver,
    // `connect()` rejects CONNECTOR_BLOCKED, the row lands NOT_CONFIGURED and
    // `fetch` is never called → red on all three.
    const { prisma, rows } = makePrismaMock([stripeRow()]);
    const svc = createIntegrationsService(prisma);

    const detail = await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    expect(detail.status).toBe("CONNECTED");
    const stored = rows.get(ROW_ID)!;
    expect(stored.status).toBe("CONNECTED");
    expect(stored.lastHealthyAt).toBeInstanceOf(Date);
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.stripe\.com\//);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${FAKE_STRIPE_KEY}`,
    );
  });

  it("classifies a vendor 401 as NEEDS_RECONNECT, never CONNECTED", async () => {
    fetchMock.mockImplementation(
      async () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } }),
    );
    const { prisma, rows } = makePrismaMock([stripeRow()]);
    const svc = createIntegrationsService(prisma);

    const detail = await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    expect(detail.status).toBe("NEEDS_RECONNECT");
    expect(rows.get(ROW_ID)!.status).toBe("NEEDS_RECONNECT");
    expect(rows.get(ROW_ID)!.lastHealthyAt).toBeNull();
  });

  it("leaves providerTokensEnc / providerConfig byte-identical and writes no LAN placeholder", async () => {
    // The row-level half of the fix. `persistBase()` used to write
    // `host: input.host`, `databaseName: "PattersonPM"` and
    // `secretRef: "<provider>:pending"` on EVERY track, which is how a cloud
    // row could carry LAN placeholders — and a `baseData` that ever grew a
    // credential column would overwrite the blob the probe is about to read.
    //
    // Mutation: reinstate the LAN `baseData` for cloud tracks → `databaseName`
    // becomes "PattersonPM" and `secretRef` becomes "stripe:pending" → red.
    const seed = stripeRow();
    const { prisma, rows } = makePrismaMock([seed]);
    const svc = createIntegrationsService(prisma);

    await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    const stored = rows.get(ROW_ID)!;
    expect(stored.providerTokensEnc).toBe(seed.providerTokensEnc);
    expect(stored.providerConfig).toEqual(seed.providerConfig);
    expect(stored.host).toBe(seed.host);
    expect(stored.databaseName).toBe(seed.databaseName);
    expect(stored.secretRef).toBe(seed.secretRef);
    // And every `update` that touched the row named only the columns the
    // probe owns.
    for (const call of prisma.integrationConnection.update.mock.calls as Array<[{ data: Record<string, unknown> }]>) {
      const keys = Object.keys(call[0].data);
      expect(keys).not.toContain("providerTokensEnc");
      expect(keys).not.toContain("providerConfig");
      expect(keys).not.toContain("host");
      expect(keys).not.toContain("databaseName");
      expect(keys).not.toContain("secretRef");
    }
  });

  it("is idempotent — a second connect re-probes and leaves writeEnabled alone", async () => {
    // A re-probe is the dashboard's "check again". Under the LAN `baseData`
    // it also wrote `writeEnabled: false` on every call, which would have
    // silently cleared a write opt-in the owner set through the toggle.
    const { prisma, rows } = makePrismaMock([stripeRow({ status: "CONNECTED", writeEnabled: true })]);
    const svc = createIntegrationsService(prisma);

    await svc.connect({ provider: STRIPE_PROVIDER, host: "" });
    await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    expect(rows.get(ROW_ID)!.status).toBe("CONNECTED");
    expect(rows.get(ROW_ID)!.writeEnabled).toBe(true);
    expect(prisma.integrationConnection.create).not.toHaveBeenCalled();
  });

  it("lands NOT_CONFIGURED (via CONNECTOR_BLOCKED) when the row holds no credential — and dials nothing", async () => {
    // The honest answer for a connect called before any paste: nothing is
    // sealed, so the factory keeps its blocked resolver and no request is
    // made with an empty Authorization header.
    const { prisma, rows } = makePrismaMock([stripeRow({ providerTokensEnc: null })]);
    const svc = createIntegrationsService(prisma);

    const detail = await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    expect(detail.status).toBe("NOT_CONFIGURED");
    expect(rows.get(ROW_ID)!.status).toBe("NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does NOT write a verdict when a PATCH-clear lands between probe start and verdict — the row stays cleared", async () => {
    // The lost-update race. The probe was built from key A; while the vendor
    // round-trip is in flight the owner clears the credential (PATCH writes
    // NOT_CONFIGURED + providerTokensEnc null). An unconditional
    // `update({ where: { id } })` would then land CONNECTED + lastHealthyAt on
    // a row with NO credential — which IS pollable, so the scheduler would
    // pick it up, the resolver would throw CONNECTOR_BLOCKED and the cursors
    // would park. The verdict must land only on the credential it was
    // computed for.
    //
    // The vendor call is where the race is staged: `fetch` is the one point
    // strictly between "connector built from the row" and "verdict written".
    //
    // Mutation: drop `providerTokensEnc` from the guard's `where` → the stub
    // matches on `id` alone, CONNECTED + lastHealthyAt land on the cleared
    // row → red on three assertions.
    const { prisma, rows } = makePrismaMock([stripeRow()]);
    const svc = createIntegrationsService(prisma);
    fetchMock.mockImplementation(async () => {
      // What routes/saas-credentials.ts writes for an emptied field.
      const row = rows.get(ROW_ID)!;
      rows.set(ROW_ID, { ...row, status: "NOT_CONFIGURED", providerTokensEnc: null });
      return okResponse();
    });

    const detail = await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = rows.get(ROW_ID)!;
    expect(stored.status).toBe("NOT_CONFIGURED");
    expect(stored.providerTokensEnc).toBeNull();
    expect(stored.lastHealthyAt).toBeNull();
    // The caller is told what the row IS now, not what the probe found.
    expect(detail.status).toBe("NOT_CONFIGURED");
    // And the audit names the dropped verdict rather than claiming a connect.
    const dropped = activityRows().filter((r) => r.what === "Integration probe: superseded");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].severity).toBe("warn");
    expect(dropped[0].refs).toMatchObject({
      provider: STRIPE_PROVIDER,
      status: "NOT_CONFIGURED",
      verdict: "CONNECTED",
      hasSecret: false,
    });
  });

  it("does NOT land key A's verdict on key B — a replaced credential keeps its own PROVISIONING", async () => {
    // The other half of the same race: a new key pasted mid-probe. The PATCH
    // wrote PROVISIONING + a new blob; the dashboard's post-save connect owes
    // key B its own verdict, and key A's must not pre-empt it.
    const seed = stripeRow();
    const keyB = sealSaasCredentials(ROW_ID, { apiKey: FAKE_STRIPE_KEY + "B" });
    const { prisma, rows } = makePrismaMock([seed]);
    const svc = createIntegrationsService(prisma);
    fetchMock.mockImplementation(async () => {
      const row = rows.get(ROW_ID)!;
      rows.set(ROW_ID, { ...row, status: "PROVISIONING", providerTokensEnc: keyB });
      return okResponse();
    });

    const detail = await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    expect(rows.get(ROW_ID)!.status).toBe("PROVISIONING");
    expect(rows.get(ROW_ID)!.providerTokensEnc).toBe(keyB);
    expect(rows.get(ROW_ID)!.lastHealthyAt).toBeNull();
    expect(detail.status).toBe("PROVISIONING");
  });

  it("drops a FAILED verdict the same way — a 401 for key A is not evidence about key B", async () => {
    // Symmetry: the guard covers the classified-failure write too. Without it
    // a slow rejection of the OLD key would stamp NEEDS_RECONNECT onto a key
    // the owner just replaced.
    const keyB = sealSaasCredentials(ROW_ID, { apiKey: FAKE_STRIPE_KEY + "B" });
    const { prisma, rows } = makePrismaMock([stripeRow()]);
    const svc = createIntegrationsService(prisma);
    fetchMock.mockImplementation(async () => {
      const row = rows.get(ROW_ID)!;
      rows.set(ROW_ID, { ...row, status: "PROVISIONING", providerTokensEnc: keyB });
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    });

    const detail = await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    expect(rows.get(ROW_ID)!.status).toBe("PROVISIONING");
    expect(detail.status).toBe("PROVISIONING");
    expect(activityRows().map((r) => r.what)).toEqual(["Integration probe: superseded"]);
    expect(activityRows()[0].refs.verdict).toBe("NEEDS_RECONNECT");
  });

  it("does NOT land a verdict when a CONFIG-ONLY PATCH lands mid-probe — same key, different providerConfig", async () => {
    // The third face of the race, and the one a credential-only guard misses:
    // the owner corrects a NON-secret connection fact — here the Mailchimp
    // datacenter, but Shopify's shopDomain, HubSpot's portalId, Square's
    // locationId and a REST baseUrl are the same shape — while the probe built
    // from the OLD config is in flight. `providerTokensEnc` is byte-identical
    // before and after, so a guard keyed on the credential alone lands
    // CONNECTED + lastHealthyAt on a row whose config now names a host nobody
    // has dialed. The verdict must land only on the (credential, config) pair
    // the connector was built from.
    //
    // `fetch` is the one point strictly between "connector built from the
    // row" and "verdict written", so the PATCH is staged there.
    //
    // Mutation: drop `providerConfig` from the guard's `where` → the stub
    // matches on id + credential, CONNECTED + lastHealthyAt land on the
    // re-configured row, no warn is logged → red.
    const seed = mailchimpRow();
    const { prisma, rows } = makePrismaMock([seed]);
    const svc = createIntegrationsService(prisma);
    fetchMock.mockImplementation(async () => {
      // What routes/saas-credentials.ts writes for a datacenter correction:
      // the merged config and PROVISIONING; the credential column is NOT in
      // the update.
      const row = rows.get(MAILCHIMP_ROW_ID)!;
      rows.set(MAILCHIMP_ROW_ID, {
        ...row,
        status: "PROVISIONING",
        providerConfig: { datacenter: "us21" },
      });
      return okResponse({ health_status: "Everything's Chimpy!" });
    });

    const detail = await svc.connect({ provider: MAILCHIMP_PROVIDER, host: "" });

    // The probe DID run, against the old datacenter.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toMatch(
      /^https:\/\/us14\.api\.mailchimp\.com\//,
    );
    // …and its verdict was dropped: no status, no lastHealthyAt, the new
    // config and the unchanged key both still on the row.
    const stored = rows.get(MAILCHIMP_ROW_ID)!;
    expect(stored.status).toBe("PROVISIONING");
    expect(stored.lastHealthyAt).toBeNull();
    expect(stored.providerConfig).toEqual({ datacenter: "us21" });
    expect(stored.providerTokensEnc).toBe(seed.providerTokensEnc);
    // The caller gets the row as it is now.
    expect(detail.status).toBe("PROVISIONING");
    // The drop is logged at warn…
    expect(warned.some((l) => /verdict dropped/.test(l))).toBe(true);
    // …and the audit names the dropped verdict rather than claiming a connect.
    expect(activityRows().map((r) => r.what)).toEqual(["Integration probe: superseded"]);
    expect(activityRows()[0].severity).toBe("warn");
    expect(activityRows()[0].refs).toMatchObject({
      provider: MAILCHIMP_PROVIDER,
      status: "PROVISIONING",
      verdict: "CONNECTED",
      hasSecret: true,
    });
  });

  it("creates the row in the saas-credentials shape when connect runs before any paste — and lands NOT_CONFIGURED", async () => {
    // The `create` branch of `persistBase` on a cloud track. It has to satisfy
    // the schema's non-null LAN columns, and the shape it writes is the one
    // `routes/saas-credentials.ts` writes on a first paste — NOT the LAN
    // wizard's defaults. Mutation: route the cloud create through the LAN
    // object → `databaseName` becomes "PattersonPM" → red.
    const { prisma, rows } = makePrismaMock([]);
    const svc = createIntegrationsService(prisma);

    const detail = await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    expect(prisma.integrationConnection.create).toHaveBeenCalledTimes(1);
    const [{ data }] = prisma.integrationConnection.create.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).toEqual({
      provider: STRIPE_PROVIDER,
      status: "PROVISIONING",
      host: "",
      databaseName: "",
      secretRef: "stripe:pending",
      writeEnabled: false,
    });
    expect(JSON.stringify(data)).not.toContain("PattersonPM");
    // No credential was ever on the row, so the probe was refused before any
    // dial and the row settles NOT_CONFIGURED — exactly what the PATCH route
    // would have created.
    expect(detail.status).toBe("NOT_CONFIGURED");
    expect([...rows.values()][0].status).toBe("NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("audits a healthy probe as 'Integration connected' with hasSecret TRUE — the credential is on the row, not in the body", async () => {
    // `hasSecret` used to be `input.apiCredentials !== undefined`, which is
    // always false on this path: no body credential is sent because the
    // credential is the row's. The audit's job is to say whether a credential
    // was in play; on the cloud path that is the sealed column.
    const { prisma } = makePrismaMock([stripeRow()]);
    const svc = createIntegrationsService(prisma);

    await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    expect(activityRows()).toHaveLength(1);
    expect(activityRows()[0]).toMatchObject({
      what: "Integration connected",
      severity: "info",
      refs: { provider: STRIPE_PROVIDER, status: "CONNECTED", hasSecret: true },
    });
    expect(JSON.stringify(activityRows()[0])).not.toContain(FAKE_STRIPE_KEY);
  });

  it("audits a rejected key as 'Integration probe: NEEDS_RECONNECT' at warn — never as a connect", async () => {
    // This route is the dashboard's "check again". Under the old shape every
    // rejected re-check wrote an INFO row titled "Integration connected".
    fetchMock.mockImplementation(
      async () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } }),
    );
    const { prisma } = makePrismaMock([stripeRow()]);
    const svc = createIntegrationsService(prisma);

    await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    expect(activityRows()).toHaveLength(1);
    expect(activityRows()[0]).toMatchObject({
      what: "Integration probe: NEEDS_RECONNECT",
      severity: "warn",
      refs: { status: "NEEDS_RECONNECT", hasSecret: true },
    });
  });

  it("audits a credential-less probe as 'Integration probe: NOT_CONFIGURED' with hasSecret FALSE", async () => {
    const { prisma } = makePrismaMock([stripeRow({ providerTokensEnc: null })]);
    const svc = createIntegrationsService(prisma);

    await svc.connect({ provider: STRIPE_PROVIDER, host: "" });

    expect(activityRows()[0]).toMatchObject({
      what: "Integration probe: NOT_CONFIGURED",
      severity: "warn",
      refs: { status: "NOT_CONFIGURED", hasSecret: false },
    });
  });
});
