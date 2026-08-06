/**
 * EaglesoftApiConnector against a LIVE dummy Eaglesoft box.
 *
 * The sibling suite (`api-connector.test.ts`) mocks `fetch` and pins the
 * connector's logic. This one does the thing a mock cannot: it starts the
 * harness box from `harness/eaglesoft-api/`, over real TLS with a real private
 * CA, and drives the REAL connector across a real socket — real handshake, real
 * headers, real status codes, real timeouts.
 *
 * That difference matters because the failures an install actually hits live
 * exactly there: a cert that doesn't verify, a session token the box stopped
 * honouring, a slow response that outlives the timeout, an IIS error page where
 * JSON was promised, a dropped connection. A mocked `fetch` cannot produce any
 * of them; every one is asserted below.
 *
 * The route map driven here is the SAME object the box publishes at `/help`
 * (`harness/eaglesoft-api/fixture.mjs`), so the two cannot drift apart. It is
 * synthetic — a stand-in for Patterson's real contract, which is discovered per
 * box, never guessed. What this proves is that the connector works correctly
 * against whatever contract it is given; swapping in a discovered map is a
 * fixture edit.
 *
 * No Docker required: the box runs in-process on an ephemeral port, so this
 * runs in the normal `npm run -w @droplet/erp-connector test` (and therefore in
 * the existing CI leg, at no extra spend). The Dockerfile next to the fixture
 * wraps this same server for hand-driven install rehearsals.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "undici";
import { API_TRACK_REMEDIATION, EaglesoftApiConnector } from "../src/api-connector.js";
import { ConnectorBlockedError, SQL_TRACK_REMEDIATION } from "../src/connector.js";
import { UnknownReadQueryError } from "../src/read-queries.js";
import { UnknownWriteCommandError } from "../src/write-commands.js";
import { routeMapFingerprint, type EaglesoftApiRouteMap } from "../src/api-route-map.js";
// @ts-expect-error -- the harness is plain ESM JS, deliberately untyped and
// outside `tsconfig`'s `src/` rootDir; it is test-only scaffolding.
import { startMockEaglesoftApi } from "../harness/eaglesoft-api/mock-server.mjs";
// @ts-expect-error -- see above.
import { opensslAvailable } from "../harness/eaglesoft-api/certs.mjs";

/** The harness mints its own CA with the `openssl` CLI (Node has no X.509
 *  signing API). Rather than silently losing this coverage where openssl is
 *  missing, the suite skips locally but FAILS in CI — a green run that proved
 *  nothing is worse than a red one. */
const HAS_OPENSSL = opensslAvailable();

it("CI has the openssl CLI the live-box suite needs", () => {
  if (!process.env.CI) return; // local dev without openssl: the skip below is fine
  expect(HAS_OPENSSL, "openssl is required in CI or the live-box suite skips silently").toBe(true);
});

interface MockBox {
  url: string;
  host: string;
  port: number;
  ca: string;
  anchorDate: string;
  routeMap: EaglesoftApiRouteMap;
  credentials: { integrationKey: string; userId: string; password: string };
  requests(): { method: string; path: string; rawUrl: string; authorization: string | null }[];
  appointments(): Record<string, unknown>[];
  setFaults(f: Record<string, unknown> | null): void;
  expireTokens(): void;
  reset(): void;
  close(): Promise<void>;
}

describe.skipIf(!HAS_OPENSSL)("EaglesoftApiConnector — live dummy box", () => {
  let box: MockBox;
  let agent: Agent;

  beforeAll(async () => {
    box = (await startMockEaglesoftApi()) as MockBox;
    // The production TLS shape: an undici dispatcher carrying the CA to trust,
    // exactly as `EaglesoftApiDeps.dispatcher` is documented to be built from a
    // resolved `caCertRef`. Certificate verification stays ON throughout.
    agent = new Agent({ connect: { ca: box.ca } });
  }, 30_000);

  afterAll(async () => {
    await agent?.close();
    await box?.close();
  });

  afterEach(() => box.setFaults(null));

  /** A connector wired to the live box. `deps`/`config` overrides let a single
   *  test swap one thing (the CA, the timeout, the route map) and leave the
   *  rest production-shaped. */
  function makeConnector(
    config: Partial<{ routeMap: EaglesoftApiRouteMap; credentialsSecretRef: string }> = {},
    deps: Partial<{ dispatcher: unknown; timeoutMs: number; resolveSecret: () => Promise<unknown> }> = {},
  ) {
    return new EaglesoftApiConnector(
      {
        // 127.0.0.1 matches the harness cert's IP SAN.
        host: box.host,
        httpsPort: box.port,
        credentialsSecretRef: "secret://harness/eaglesoft-api/creds",
        routeMap: box.routeMap,
        ...config,
      },
      {
        dispatcher: agent,
        resolveSecret: async () => box.credentials,
        timeoutMs: 5_000,
        ...deps,
      } as ConstructorParameters<typeof EaglesoftApiConnector>[1],
    );
  }

  async function connected() {
    const c = makeConnector();
    await c.connect();
    return c;
  }

  // ---------------------------------------------------------------- connect --

  describe("connect + auth handshake", () => {
    it("authenticates against the live box and reports healthy", async () => {
      const c = await connected();
      await expect(c.health()).resolves.toEqual({ ok: true });
    });

    it("is blocked before connect() — never a read on an unauthenticated box", async () => {
      const c = makeConnector();
      await expect(c.runRead("get_schedule_today", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
      await expect(c.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
    });

    it("degrades honestly when the box rejects the credentials", async () => {
      const c = makeConnector({}, {
        resolveSecret: async () => ({ integrationKey: "wrong", userId: "wrong", password: "wrong" }),
      });
      await expect(c.connect()).rejects.toBeInstanceOf(ConnectorBlockedError);
      // and stays unusable rather than half-connected
      await expect(c.introspect()).rejects.toBeInstanceOf(ConnectorBlockedError);
    });

    it("fingerprints the route map so an API upgrade trips drift-freeze", async () => {
      const c = await connected();
      const { tables, fingerprint } = await c.introspect();
      expect(tables).toEqual([]); // no SQL catalog on the REST track
      expect(fingerprint).toBe(routeMapFingerprint(box.routeMap));

      const moved: EaglesoftApiRouteMap = {
        ...box.routeMap,
        reads: {
          ...box.routeMap.reads,
          get_schedule_today: { ...box.routeMap.reads.get_schedule_today, template: "/api/v2/schedule/range" },
        },
      };
      expect(routeMapFingerprint(moved)).not.toBe(fingerprint);
    });
  });

  // -------------------------------------------------------------------- TLS --

  describe("TLS", () => {
    it("REFUSES a box whose certificate it cannot verify", async () => {
      // No dispatcher => the harness CA is not trusted. This must fail, and the
      // fact that it does is what proves the passing tests above are running
      // against genuine verified TLS rather than disabled verification.
      const c = makeConnector({}, { dispatcher: undefined });
      await expect(c.connect()).rejects.toBeInstanceOf(ConnectorBlockedError);
    });

    it("points a failed connect at REST-track remediation, not the SQL client", async () => {
      // Whoever is triaging a failed install reads this string. On the REST
      // track a SQL Anywhere client has no bearing on the failure, so naming it
      // would send them after the wrong thing.
      const c = makeConnector({}, { dispatcher: undefined });
      const err = await c.connect().catch((e: Error) => e);
      expect(err).toBeInstanceOf(ConnectorBlockedError);
      expect(err.message).toContain(API_TRACK_REMEDIATION);
      expect(err.message).not.toContain("SAP SQL Anywhere client");
      // ...while the SQL track keeps its own, unchanged text.
      expect(new ConnectorBlockedError("connect").message).toContain(SQL_TRACK_REMEDIATION);
    });
  });

  // ------------------------------------------------------------------ reads --

  describe("named reads return the SQL track's canonical row shapes", () => {
    it("get_schedule_today — mapped, and re-sorted into the SQL ORDER BY", async () => {
      const c = await connected();
      const rows = (await c.runRead("get_schedule_today", {
        from: `${box.anchorDate}T00:00:00.000Z`,
        to: `${box.anchorDate}T23:59:59.999Z`,
      })) as Record<string, unknown>[];

      expect(rows).toHaveLength(3); // today's three; yesterday's + tomorrow's excluded
      expect(Object.keys(rows[0]).sort()).toEqual(
        ["appt_id", "appt_time", "operatory_id", "patient_id", "provider_id", "status"],
      );
      // The box answers newest-first on purpose; the connector owes callers the
      // SQL `ORDER BY appt_time` ordering.
      expect(rows.map((r) => r.appt_id)).toEqual([5001, 5002, 5003]);
      expect(rows[0]).toMatchObject({ appt_id: 5001, provider_id: 1, operatory_id: 1, status: "confirmed", patient_id: 1001 });
    });

    it("get_schedule_today — a day with no appointments is empty, not an error", async () => {
      const c = await connected();
      const rows = await c.runRead("get_schedule_today", {
        from: "2000-01-01T00:00:00.000Z",
        to: "2000-01-02T00:00:00.000Z",
      });
      expect(rows).toEqual([]);
    });

    it("find_patient — minimum-necessary: demographics the box returned are dropped", async () => {
      const c = await connected();
      const rows = (await c.runRead("find_patient", { query: "Lis" })) as Record<string, unknown>[];
      expect(rows).toEqual([{ patient_id: 1003, first_name: "Barbara", last_name: "Liskov" }]);
      // The box's payload carries DateOfBirth / Phone / Status; the DTO layer
      // projects to the canonical keys, so they must not survive the mapping.
      expect(rows[0]).not.toHaveProperty("date_of_birth");
      expect(Object.keys(rows[0])).toHaveLength(3);
    });

    it("find_patient — a SQL metacharacter is just a character to this box", async () => {
      // What this asserts, precisely: the harness box matches a LITERAL prefix,
      // so "%" and "_" match nothing rather than everything. It keeps the mock
      // from being MORE permissive than the system it stands in for.
      //
      // What it does NOT assert: that the REST track defends against wildcard
      // over-fetch. It has no such defence. `escapeLike` is used only by the
      // SQL track's statement builder (read-queries.ts); on this track
      // `toApiQuery` renames the param and passes the value through untouched.
      // Whether that matters depends on what Patterson's API does with
      // `lastName` server-side — an UNDISCOVERED behaviour (see the note on
      // find_patient in harness/eaglesoft-api/fixture.mjs). If a real box turns
      // out to do a substring/LIKE match, minimum-necessary needs an answer on
      // this track too, and it will not come from this test.
      const c = await connected();
      await expect(c.runRead("find_patient", { query: "%" })).resolves.toEqual([]);
      await expect(c.runRead("find_patient", { query: "_" })).resolves.toEqual([]);
    });

    it("get_patient — a hit maps one row; a miss is zero rows, not a throw", async () => {
      const c = await connected();
      await expect(c.runRead("get_patient", { patientId: 1003 })).resolves.toEqual([
        { patient_id: 1003, first_name: "Barbara", last_name: "Liskov" },
      ]);
      await expect(c.runRead("get_patient", { patientId: 999999 })).resolves.toEqual([]);
    });

    it("get_ar_summary — aggregated to two numbers, never the raw ledger rows", async () => {
      const c = await connected();
      const rows = (await c.runRead("get_ar_summary", {})) as Record<string, unknown>[];
      expect(rows).toEqual([{ account_count: 5, total_balance: 634.5 }]);
    });

    it("get_recall_due — ordered by last name, then first name", async () => {
      const c = await connected();
      const rows = (await c.runRead("get_recall_due", {})) as Record<string, unknown>[];
      expect(rows.map((r) => r.last_name)).toEqual(["Dijkstra", "Knuth"]);
    });

    it("sends the session token on every read, and the canonical params under the API's names", async () => {
      const c = await connected();
      await c.runRead("find_patient", { query: "Kn" });
      const search = box.requests().filter((r) => r.path === "/api/patients/search").at(-1)!;
      expect(search.authorization).toMatch(/^[0-9a-f]{48}$/); // the issued token, verbatim
      // `query` -> `lastName` came from the discovered route's param map.
      expect(search.rawUrl).toContain("lastName=Kn");
      expect(search.rawUrl).not.toContain("query=");
    });
  });

  // -------------------------------------------------------- registry guards --

  describe("shared-registry validation happens before any transport", () => {
    it("an unregistered read name is a registry error, not a blocked/transport one", async () => {
      const c = await connected();
      const before = box.requests().length;
      await expect(c.runRead("drop_all_patients", {})).rejects.toBeInstanceOf(UnknownReadQueryError);
      expect(box.requests()).toHaveLength(before); // nothing went out the wire
    });

    it("a read whose route is NOT discovered blocks instead of guessing a URL", async () => {
      const undiscovered: EaglesoftApiRouteMap = {
        ...box.routeMap,
        reads: {
          ...box.routeMap.reads,
          // Drop the verb+template: the op is known, its contract is not.
          get_ar_summary: { controller: "Account", method: "GetAgedBalanceByResponsibleParty" },
        },
      };
      const c = makeConnector({ routeMap: undiscovered });
      await c.connect();
      const before = box.requests().length;
      await expect(c.runRead("get_ar_summary", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
      expect(box.requests()).toHaveLength(before);
    });

    it("writes stay honestly blocked, and the forbidden-target guard still bites", async () => {
      const c = await connected();
      // The REST write transport is deferred — it must block, never report a
      // fake APPLIED, even though the box below would happily accept the write.
      await expect(c.applyWrite("reschedule_appointment", { appt_id: 5002 }))
        .rejects.toBeInstanceOf(ConnectorBlockedError);
      await expect(c.applyWrite("delete_ledger", {})).rejects.toBeInstanceOf(UnknownWriteCommandError);
      expect(box.appointments().find((a) => a.AppointmentId === 5002)).toMatchObject({ Status: "scheduled" });
    });
  });

  // ------------------------------------------------------- failure handling --

  describe("survives the failures a real box actually produces", () => {
    it("maps a 5xx to a blocked connector", async () => {
      const c = await connected();
      box.setFaults({ status: 500 });
      await expect(c.runRead("get_ar_summary", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
    });

    it("maps a revoked/expired session token to a blocked connector", async () => {
      const c = await connected();
      box.expireTokens(); // e.g. the box restarted under us
      await expect(c.runRead("get_ar_summary", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
    });

    it("times out rather than hanging when the box stops answering", async () => {
      const c = makeConnector({}, { timeoutMs: 200 });
      await c.connect();
      box.setFaults({ delayMs: 3_000 });
      const started = Date.now();
      await expect(c.runRead("get_ar_summary", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("does not throw on an HTML error page served where JSON was promised", async () => {
      const c = await connected();
      box.setFaults({ malformedJson: true });
      // A 200 whose body is IIS's HTML: unparseable, so zero rows — an honest
      // empty result rather than a crash or invented data.
      await expect(c.runRead("get_schedule_today", { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" }))
        .resolves.toEqual([]);
    });

    it("maps a dropped connection to a blocked connector", async () => {
      const c = await connected();
      box.setFaults({ closeConnection: true });
      await expect(c.runRead("get_ar_summary", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
    });

    it("recovers on the next call once a transient fault clears", async () => {
      const c = await connected();
      box.setFaults({ status: 503, count: 1 }); // fails once, then heals
      await expect(c.runRead("get_ar_summary", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
      await expect(c.runRead("get_ar_summary", {})).resolves.toEqual([
        { account_count: 5, total_balance: 634.5 },
      ]);
    });
  });

  // ------------------------------------------------------------- hygiene ----

  describe("secret hygiene on the wire", () => {
    it("credentials never appear in a URL — only in the auth POST body", async () => {
      box.reset();
      const c = await connected();
      await c.runRead("find_patient", { query: "Kn" });
      await c.runRead("get_ar_summary", {});

      const secrets = [box.credentials.integrationKey, box.credentials.password, box.credentials.userId];
      for (const req of box.requests()) {
        for (const secret of secrets) {
          expect(req.rawUrl, `secret leaked into ${req.method} ${req.rawUrl}`).not.toContain(secret);
        }
      }
      // Exactly one authentication round-trip, and it is a POST (body-carried).
      const auths = box.requests().filter((r) => r.path === "/api/authenticate");
      expect(auths).toHaveLength(1);
      expect(auths[0].method).toBe("POST");
      expect(auths[0].authorization).toBeNull(); // no token yet, and no basic-auth fallback
    });
  });
});
