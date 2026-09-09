/**
 * WARP-2277 / WARP-2281 — route tests for the SaaS credential configurator.
 *
 *   GET   /api/integrations/credentials
 *   GET   /api/integrations/:provider/credentials
 *   PATCH /api/integrations/:provider/credentials
 *
 * Harness mirrors `settings-email.route.test.ts`: a minimal Express app +
 * supertest, a synthetic auth middleware that stuffs `req.user`, and an
 * in-memory Prisma stub. `recordActivity` is mocked at the singleton, which is
 * also how `recordAccessDenied` reaches the audit log — so the SAME mock proves
 * both the credential rows and the policy-violation row.
 *
 * That shared mock is the point of the RBAC test below. `requireRole` and an
 * inline role compare are indistinguishable by status code; they differ only in
 * whether a denied attempt is recorded at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    ROUTING_MODE: "disabled",
    corsAllowedOrigins: ["https://droplet-ai.local"],
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  registerProviderDescriptor,
  __resetRegisteredProvidersForTest,
  type ProviderDescriptor,
} from "@droplet/shared-types";
// WARP-2383 — the PATCH must also drop what a connector minted from the
// previous credential; asserted against the REAL cache, see the last describe.
import { XeroConnector, __resetXeroTokenCacheForTest } from "@droplet/erp-connector";

import { createSaasCredentialsRouter } from "./saas-credentials.js";
import { __setColumnCryptoKeyForTest } from "../services/column-crypto.service.js";
import {
  openSaasCredentials,
  sealSaasCredentials,
  type SaasConnectionRow,
} from "../services/saas-credential.service.js";
import { readPackageFile } from "../__tests__/helpers/test-paths.js";

const TEST_KEY = Buffer.alloc(32, 3).toString("base64");
const ROW_ID = "conn_route_fixture_1";
const SEEDED_SECRET = "SEEDED-CREDENTIAL-VALUE";

/** Registered at runtime, so the route is exercised against a provider it has
 *  no built-in knowledge of — which is the generic claim under test. */
const FIXTURE: ProviderDescriptor = {
  id: "fixture-billing",
  displayName: "Fixture Billing",
  category: "Accounting",
  track: "cloud",
  credentialFields: [
    {
      name: "accountId",
      label: "Account id",
      type: "string",
      required: true,
      secret: false,
      storage: "providerConfig",
    },
    {
      name: "apiKey",
      label: "Restricted API key",
      type: "string",
      required: true,
      secret: true,
      storage: "encrypted",
      pattern: "^rk_(live|test)_",
    },
  ],
  egressHosts: ["api.fixture-billing.invalid"],
  datasets: ["invoice"],
};

interface StubRow {
  id: string;
  provider: string;
  status: string;
  providerTokensEnc: string | null;
  providerConfig: unknown;
  updatedAt: Date;
}

/**
 * The narrowed cast is what makes a dropped credential column a compile error.
 *
 * WARP-2489 made BOTH credential columns REQUIRED on `SaasConnectionRow`,
 * because "was this connection's credential removed" is a question about the
 * ROW and the row has two of them — answering it from `providerTokensEnc`
 * alone lets the credentials page report a purge the hub denies. Its docstring
 * says so outright: "a caller that narrows its `select` and drops the column
 * must fail to compile rather than silently claim a purge."
 *
 * `saas-credentials.ts` was erasing exactly that check at two of its three
 * Prisma reads. `as unknown as SaasConnectionRow` is a DOUBLE cast, and a
 * double cast asserts through any shape at all — so a `select` narrowed to the
 * columns a handler happens to read would have compiled, and
 * `credentialsPurgedFor` would then have judged a purge from a column that was
 * never fetched. `findRow` had it right with a plain `as`; the create and
 * update paths now match it.
 *
 * `StubRow` above IS a narrowed select — it declares five columns and not
 * `apiCredentialsEnc`. That makes it the honest fixture: the assignment below
 * is the error the plain cast reinstates and the double cast swallowed.
 *
 * Restore either double cast and this directive goes UNUSED, failing tsc with
 * "Unused '@ts-expect-error' directive" — which is what makes this a gate and
 * not a comment. `vitest` cannot see any of it: esbuild strips types, so
 * `npx tsc --noEmit` in `apps/orchestrator` is what enforces it.
 */
// @ts-expect-error — a select without `apiCredentialsEnc` is not a SaasConnectionRow.
const NARROWED_SELECT_IS_NOT_A_ROW: SaasConnectionRow = {} as StubRow;
void NARROWED_SELECT_IS_NOT_A_ROW;

function createPrismaStub(initial: StubRow | null) {
  let row = initial;
  return {
    _row: () => row,
    integrationConnection: {
      findFirst: vi.fn(async ({ where }: { where: { provider: string } }) =>
        row && row.provider === where.provider ? row : null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = {
          id: ROW_ID,
          provider: String(data.provider),
          status: String(data.status),
          providerTokensEnc: null,
          providerConfig: null,
          updatedAt: new Date(),
        };
        return row;
      }),
      update: vi.fn(
        async ({ data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (!row) throw new Error("no row");
          // Only keys PRESENT in `data` are applied — the stub must reproduce
          // Prisma's own semantics, or the "omit = keep" case would pass here
          // for the wrong reason.
          row = { ...row, ...data, updatedAt: new Date() } as StubRow;
          return row;
        },
      ),
    },
  };
}

function buildApp(
  prisma: ReturnType<typeof createPrismaStub>,
  user: { id: string; username: string; role: string } = {
    id: "11111111-1111-4111-8111-111111111111",
    username: "romain",
    role: "owner",
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...user };
    next();
  });
  app.use("/api", createSaasCredentialsRouter(prisma as never));
  return app;
}

function seededRow(): StubRow {
  return {
    id: ROW_ID,
    provider: FIXTURE.id,
    status: "CONNECTED",
    providerTokensEnc: sealSaasCredentials(ROW_ID, { apiKey: SEEDED_SECRET }),
    providerConfig: { provider: FIXTURE.id, accountId: "acct-1" },
    updatedAt: new Date("2026-08-27T00:00:00.000Z"),
  };
}

beforeEach(() => {
  recordActivityMock.mockClear();
  __setColumnCryptoKeyForTest(TEST_KEY);
  __resetRegisteredProvidersForTest();
  registerProviderDescriptor(FIXTURE);
});

afterEach(() => {
  __resetRegisteredProvidersForTest();
});

describe("RBAC — the guard is at registration, not inline", () => {
  it("403s a family caller AND records a policy-violation row", async () => {
    const prisma = createPrismaStub(seededRow());
    const app = buildApp(prisma, {
      id: "22222222-2222-4222-8222-222222222222",
      username: "sam",
      role: "family",
    });

    const res = await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { apiKey: "rk_live_x" } });

    expect(res.status).toBe(403);

    // THE assertion that separates `requireRole` from an inline compare. Both
    // return 403; only the middleware writes this row. Mutation: replace the
    // registration guard with `if (req.user.role !== "admin") return 403` and
    // the status assertion above still passes while this one goes red.
    const denied = recordActivityMock.mock.calls
      .map((c) => c[0] as { kind: string; what: string })
      .filter((p) => p.kind === "auth" && p.what === "Access denied");
    expect(denied).toHaveLength(1);
  });

  it("403s a guest on the read routes too", async () => {
    const prisma = createPrismaStub(seededRow());
    const app = buildApp(prisma, {
      id: "33333333-3333-4333-8333-333333333333",
      username: "visitor",
      role: "guest",
    });
    expect((await request(app).get("/api/integrations/credentials")).status).toBe(403);
    expect(
      (await request(app).get(`/api/integrations/${FIXTURE.id}/credentials`)).status,
    ).toBe(403);
  });

  it("does not persist anything when the caller is denied", async () => {
    const prisma = createPrismaStub(seededRow());
    const before = prisma._row()?.providerTokensEnc;
    const app = buildApp(prisma, {
      id: "44444444-4444-4444-8444-444444444444",
      username: "sam",
      role: "family",
    });
    await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { apiKey: "rk_live_x" } });
    expect(prisma.integrationConnection.update).not.toHaveBeenCalled();
    expect(prisma._row()?.providerTokensEnc).toBe(before);
  });
});

describe("validation — zod safeParse, never parse", () => {
  it("returns exactly 400 {error, details} for a malformed body", async () => {
    const app = buildApp(createPrismaStub(seededRow()));
    const res = await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: "not-an-object" });

    // Mutation: swap `safeParse` for `parse` and this becomes an unhandled
    // throw — a 500 — so the status assertion goes red rather than the body one.
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
    expect(res.body).toHaveProperty("details");
    expect(res.body.details).toHaveProperty("fieldErrors");
    // No stack, and no submitted value echoed back.
    expect(JSON.stringify(res.body)).not.toContain("at Object");
    expect(JSON.stringify(res.body)).not.toContain("not-an-object");
  });

  it("rejects an unknown top-level key rather than silently ignoring it", async () => {
    const app = buildApp(createPrismaStub(seededRow()));
    const res = await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { accountId: "a" }, secretz: "oops" });
    expect(res.status).toBe(400);
  });

  it("returns the SAME 400 envelope for a descriptor-pattern refusal", async () => {
    const app = buildApp(createPrismaStub(seededRow()));
    const res = await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { apiKey: "sk_live_wrong" } });

    expect(res.status).toBe(400);
    expect(res.body.details.fieldErrors).toHaveProperty("apiKey");
    // The rejected value must not come back out.
    expect(JSON.stringify(res.body)).not.toContain("sk_live_wrong");
  });

  it("404s an unknown provider instead of rendering an empty form", async () => {
    const app = buildApp(createPrismaStub(null));
    const res = await request(app).get("/api/integrations/no-such-vendor/credentials");
    expect(res.status).toBe(404);
  });
});

describe("GET — the redacted view", () => {
  it("returns hasValue true and no key material", async () => {
    const app = buildApp(createPrismaStub(seededRow()));
    const res = await request(app).get(`/api/integrations/${FIXTURE.id}/credentials`);

    expect(res.status).toBe(200);
    expect(res.body.fields.find((f: { name: string }) => f.name === "apiKey").hasValue).toBe(
      true,
    );
    expect(JSON.stringify(res.body)).not.toContain(SEEDED_SECRET);
    expect(JSON.stringify(res.body)).not.toContain("providerTokensEnc");
  });

  it("lists every cloud provider with an explicit state, configured or not", async () => {
    const app = buildApp(createPrismaStub(null));
    const res = await request(app).get("/api/integrations/credentials");
    expect(res.status).toBe(200);
    const fixture = res.body.providers.find(
      (p: { provider: string }) => p.provider === FIXTURE.id,
    );
    // Explicit constant, never a null or an omitted key.
    expect(fixture.state).toBe("NOT_CONFIGURED");
    expect(fixture.hasCredentials).toBe(false);
  });
});

describe("PATCH — three-way resolution against the persisted column", () => {
  it("OMIT leaves providerTokensEnc byte-identical", async () => {
    const prisma = createPrismaStub(seededRow());
    const before = prisma._row()?.providerTokensEnc;
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { accountId: "acct-2" } });

    expect(res.status).toBe(200);
    expect(prisma._row()?.providerTokensEnc).toBe(before);
    // And the update call itself never carried the key.
    const data = prisma.integrationConnection.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("providerTokensEnc");
  });

  it('EMPTY STRING clears the column and moves status to NOT_CONFIGURED', async () => {
    const prisma = createPrismaStub(seededRow());
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { apiKey: "" } });

    expect(res.status).toBe(200);
    expect(prisma._row()?.providerTokensEnc).toBeNull();
    expect(prisma._row()?.status).toBe("NOT_CONFIGURED");
    expect(res.body.state).toBe("NOT_CONFIGURED");
  });

  it("A VALUE re-encrypts under the row's AAD", async () => {
    const prisma = createPrismaStub(seededRow());
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { apiKey: "rk_live_new" } });

    expect(res.status).toBe(200);
    const blob = prisma._row()?.providerTokensEnc as string;
    expect(blob.startsWith("dcv1:")).toBe(true);
    expect(openSaasCredentials(ROW_ID, blob)).toEqual({ apiKey: "rk_live_new" });
  });

  it("writes ADR-042's column and never the Eaglesoft REST one", async () => {
    // ADR-042 §5: a customer-supplied credential lives in `providerTokensEnc`,
    // AAD-bound to the row id. `apiCredentialsEnc` is the Eaglesoft REST
    // track's static triple under the older `encryptSecret` and belongs to a
    // LAN transport this configurator never touches — writing there would put
    // the credential where no cloud connector's TokenResolver looks for it.
    //
    // Mutation: point the route back at `data.apiCredentialsEnc` → both
    // assertions go red.
    const prisma = createPrismaStub(seededRow());
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { apiKey: "rk_live_adr042" } });

    expect(res.status).toBe(200);
    const data = prisma.integrationConnection.update.mock.calls[0][0].data;
    expect(data).toHaveProperty("providerTokensEnc");
    expect(data).not.toHaveProperty("apiCredentialsEnc");
  });

  it("creates the row before sealing, so the AAD names a real connection", async () => {
    const prisma = createPrismaStub(null);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { accountId: "acct-1", apiKey: "rk_test_ok" } });

    expect(res.status).toBe(200);
    expect(prisma.integrationConnection.create).toHaveBeenCalled();
    expect(openSaasCredentials(ROW_ID, prisma._row()?.providerTokensEnc as string)).toEqual({
      apiKey: "rk_test_ok",
    });
  });
});

describe("audit — one row per mutation, carrying hasSecret and never the value", () => {
  function credentialRows() {
    return recordActivityMock.mock.calls
      .map((c) => c[0] as { what: string; refs: Record<string, unknown> })
      .filter((p) => p.what.startsWith("Integration credential"));
  }

  it("records exactly one row on an update, with hasSecret true", async () => {
    const app = buildApp(createPrismaStub(seededRow()));
    await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { apiKey: "rk_live_new" } });

    const rows = credentialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].refs.hasSecret).toBe(true);
    expect(rows[0].refs.provider).toBe(FIXTURE.id);
  });

  it("never puts the credential in the audit scope", async () => {
    const app = buildApp(createPrismaStub(seededRow()));
    await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { apiKey: "rk_live_new" } });

    // Mutation: add the raw value to `refs` and this goes red. An ActivityRow
    // is append-only, signed and exportable — a secret written here cannot be
    // recalled by rotating anything.
    const scope = JSON.stringify(credentialRows()[0].refs);
    expect(scope).not.toContain("rk_live_new");
    expect(scope).not.toContain(SEEDED_SECRET);
    expect(typeof credentialRows()[0].refs.hasSecret).toBe("boolean");
  });

  it("distinguishes a clear from an update, with hasSecret false", async () => {
    const app = buildApp(createPrismaStub(seededRow()));
    await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { apiKey: "" } });

    const rows = credentialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].what).toBe("Integration credential cleared");
    expect(rows[0].refs.hasSecret).toBe(false);
  });

  it("writes NO row when the persist throws", async () => {
    const prisma = createPrismaStub(seededRow());
    prisma.integrationConnection.update.mockRejectedValueOnce(new Error("db down"));
    const app = buildApp(prisma);

    await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { apiKey: "rk_live_new" } });

    // Mutation: move `recordActivity` above the update and this goes red — the
    // audit log would describe a change the database never made.
    expect(credentialRows()).toHaveLength(0);
  });

  it("writes no row when validation refuses the body", async () => {
    const app = buildApp(createPrismaStub(seededRow()));
    await request(app)
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields: { apiKey: "sk_live_wrong" } });
    expect(credentialRows()).toHaveLength(0);
  });
});

describe("the row casts stay narrow enough to keep the structural check", () => {
  /**
   * The companion to the `@ts-expect-error` fixture above, and the half that
   * actually gates the ROUTE.
   *
   * `tsc` alone cannot catch this. `as unknown as SaasConnectionRow` asserts
   * through any shape whatsoever, so restoring the double cast leaves the
   * typecheck perfectly green — verified, not assumed. That is exactly what
   * makes the double cast dangerous and why it needs a different kind of gate:
   * the type fixture proves a narrowed select is rejected, and this proves the
   * route never opts out of that rejection.
   *
   * Mutation: put either `as unknown as SaasConnectionRow` back in
   * `saas-credentials.ts` → red here, green under `tsc`.
   */
  it("never launders a Prisma result through `unknown` on the way to a row", () => {
    // Anchored to this test file, not the runner's cwd (WARP-2654).
    const source = readPackageFile("src/routes/saas-credentials.ts");

    expect(source).toContain("as SaasConnectionRow");
    // The whole point: a double cast would let a `select` that drops
    // `apiCredentialsEnc` compile, and `credentialsPurgedFor` would then judge
    // a purge from a column that was never fetched.
    expect(source).not.toContain("as unknown as SaasConnectionRow");
  });
});

/**
 * WARP-2383 — the rotation half of the token-cache finding on #1946.
 *
 * The Xero track keeps the access token it minted from the client secret in a
 * process-lifetime map keyed by connection id, for up to 30 minutes. #1946's
 * first fix dropped it on `disconnect()`; this is the other path that replaces
 * the credential — the owner re-pasting a rotated secret through this PATCH.
 * Without the drop, the next `connect()` served the token minted under the OLD
 * secret, the probe passed, and the row went CONNECTED without the new secret
 * ever having been exercised.
 *
 * Asserted against the real module-level cache through a real `XeroConnector`
 * with an injected fetch that records every URL it dials, so "mints fresh" is
 * a count of calls to the identity host — not a spy on `forgetXeroToken`,
 * which `forgetXeroToken(descriptor.id)` would satisfy while deleting nothing.
 */
describe("PATCH also drops the Xero token minted under the PREVIOUS credential", () => {
  const XERO_CLIENT_ID = "FAKE-XERO-CLIENT-ID-0000";
  const XERO_CLIENT_SECRET = "FAKE-XERO-CLIENT-SECRET-do-not-use-0000";
  const XERO_ACCESS_TOKEN = "FAKE-XERO-ACCESS-TOKEN-0000";

  beforeEach(() => {
    __resetXeroTokenCacheForTest();
  });

  /**
   * A connector on `connectionId` whose fetch records every URL and answers
   * each with a token body — the identity call mints from it, and the
   * `Organisation` probe `connect()` follows with happens to parse the same
   * JSON. `mints()` is the number of identity-host calls so far.
   */
  function xeroConnector(connectionId: string) {
    const urls: string[] = [];
    const connector = new XeroConnector(
      {
        connectionId,
        clientId: XERO_CLIENT_ID,
        credentialVariant: "custom-connection",
        credentialsSecretRef: "xero:pending",
      },
      {
        fetchImpl: (async (url: string) => {
          urls.push(url);
          return new Response(
            JSON.stringify({
              access_token: XERO_ACCESS_TOKEN,
              expires_in: 1800,
              token_type: "Bearer",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as never,
        now: () => Date.UTC(2026, 8, 4, 12, 0, 0),
        resolveSecret: async () => XERO_CLIENT_SECRET,
      },
    );
    const mints = () => urls.filter((u) => u.includes("/connect/token")).length;
    return { connector, mints };
  }

  async function patchCredential(fields: Record<string, string>) {
    const prisma = createPrismaStub(seededRow());
    const res = await request(buildApp(prisma))
      .patch(`/api/integrations/${FIXTURE.id}/credentials`)
      .send({ fields });
    return { res, prisma };
  }

  it("a re-pasted secret drops the cached token, and the next connect() mints fresh", async () => {
    // Mutation: delete the `forgetXeroToken(row.id)` line in the PATCH handler
    // → the second connector is served the cached token: zero identity calls
    // and `hasAccessToken` still true. That mutation IS the code this was
    // reviewed at.
    const minted = xeroConnector(ROW_ID);
    await minted.connector.connect();
    expect(minted.mints()).toBe(1);
    expect((await minted.connector.status()).hasAccessToken).toBe(true);

    const { res } = await patchCredential({ apiKey: "rk_live_rotated" });
    expect(res.status).toBe(200);

    expect((await minted.connector.status()).hasAccessToken).toBe(false);
    const next = xeroConnector(ROW_ID);
    await next.connector.connect();
    expect(next.mints()).toBe(1);
  });

  it("keys the forget on the ROW id — the provider name would delete nothing", async () => {
    // Mutation: `forgetXeroToken(descriptor.id)` → the cache is keyed by
    // connection id, "fixture-billing" is not one, and the token survives.
    // The fixture row's id and provider differ, or this proves nothing.
    expect(ROW_ID).not.toBe(FIXTURE.id);
    const minted = xeroConnector(ROW_ID);
    await minted.connector.connect();

    const { res } = await patchCredential({ apiKey: "rk_live_rotated" });
    expect(res.status).toBe(200);

    expect((await minted.connector.status()).hasAccessToken).toBe(false);
  });

  it("a clear drops it too — an emptied column and a live token cannot coexist", async () => {
    const minted = xeroConnector(ROW_ID);
    await minted.connector.connect();

    const { res, prisma } = await patchCredential({ apiKey: "" });
    expect(res.status).toBe(200);
    expect(prisma._row()?.status).toBe("NOT_CONFIGURED");

    expect((await minted.connector.status()).hasAccessToken).toBe(false);
  });

  it("does not disturb another connection's token", async () => {
    // Mutation: `__resetXeroTokenCacheForTest()` in place of the scoped delete
    // → every other organisation on the box re-mints on its next read.
    const other = xeroConnector("conn_someone_else");
    await other.connector.connect();
    const minted = xeroConnector(ROW_ID);
    await minted.connector.connect();

    const { res } = await patchCredential({ apiKey: "rk_live_rotated" });
    expect(res.status).toBe(200);

    expect((await minted.connector.status()).hasAccessToken).toBe(false);
    expect((await other.connector.status()).hasAccessToken).toBe(true);
  });

  it("leaves the token alone when the write is refused", async () => {
    // The column did not change, so the token still agrees with it. Mutation:
    // move the forget ahead of the update → a 400 that changed nothing costs a
    // re-mint, and a validation failure becomes a way to make the box dial the
    // identity host.
    const minted = xeroConnector(ROW_ID);
    await minted.connector.connect();

    const { res, prisma } = await patchCredential({ apiKey: "not-a-restricted-key" });
    expect(res.status).toBe(400);
    expect(openSaasCredentials(ROW_ID, prisma._row()?.providerTokensEnc as string)).toEqual({
      apiKey: SEEDED_SECRET,
    });

    expect((await minted.connector.status()).hasAccessToken).toBe(true);
  });
});
