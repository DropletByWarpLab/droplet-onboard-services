/**
 * WARP-2127 — DentrixAscendConnector.
 *
 * Fixtures are shaped from the published OpenAPI spec (3.0.0, info.version
 * 186.0.9) — the envelope `{ data, warnings, errors, meta.pagination }`, the
 * `PatientV1` / `AppointmentV1` / `AgingBalanceReportV1` field names, and the
 * documented filter operators. That is the whole reason this connector exists
 * and the on-premise one does not: there is a contract to test against.
 *
 * `fetch` is injected and every test asserts on the REQUESTS made, not only on
 * what came back. Several of the guarantees here are about calls that must not
 * happen, or headers that must always be present, and a return-value assertion
 * cannot see either.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, it, expect } from "vitest";

import {
  ASCEND_DATASETS,
  ASCEND_PRODUCTION_BASE_URL,
  ASCEND_SANDBOX_BASE_URL,
  ASCEND_SPEC_VERSION,
  AscendAuthorizationError,
  DentrixAscendConnector,
  UnsafeAscendBaseUrlError,
  assertSafeAscendBaseUrl,
  type AscendToken,
} from "../src/dentrix/ascend-connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { CANONICAL_COLUMNS } from "../src/export-drop/profiles.js";

const NOW = Date.UTC(2026, 7, 21, 9, 0, 0);
const ORG = "9130350";

function token(over: Partial<AscendToken> = {}): AscendToken {
  return { accessToken: "ascend-tok-SECRET", expiresAt: NOW + 3_600_000, ...over };
}

/** Records every request and replays queued responses. */
function stubFetch(pages: unknown[], status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const impl = async (url: string, init?: Record<string, unknown>) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const body = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  };
  return { impl, calls };
}

function ascend(
  opts: {
    pages?: unknown[];
    status?: number;
    tok?: AscendToken;
    locationId?: string | undefined;
    pageSize?: number;
    resolveToken?: () => Promise<AscendToken>;
  } = {},
) {
  const { impl, calls } = stubFetch(opts.pages ?? [{ data: [] }], opts.status);
  const c = new DentrixAscendConnector(
    {
      organizationId: ORG,
      locationId: "locationId" in opts ? opts.locationId : "42",
      credentialsSecretRef: "secret://ascend/9130350",
      pageSize: opts.pageSize,
    },
    {
      fetchImpl: impl,
      now: () => NOW,
      resolveToken: opts.resolveToken ?? (async () => opts.tok ?? token()),
    },
  );
  return { c, calls };
}

/** Shaped from the spec's own PatientV1 example. */
const PATIENTS = {
  data: [
    { id: 1000000020701, type: "PatientV1", firstName: "Ada", lastName: "Lovelace", patientStatus: "ACTIVE" },
    { id: 1000000020702, type: "PatientV1", firstName: "Grace", lastName: "Hopper", patientStatus: "ACTIVE" },
    { id: 1000000020703, type: "PatientV1", firstName: "Alan", lastName: "Turing", patientStatus: "ACTIVE" },
  ],
  warnings: [],
  errors: [],
  meta: { pagination: { limit: 200, offset: 0, total: 3 } },
};

/** AppointmentV1: `start` is a real date-time, `status` is the APPOINTMENT's
 *  status, and provider/operatory/patient are `{id,type,url}` refs. */
const APPOINTMENTS = {
  data: [
    {
      id: 555002,
      start: "2026-08-21T14:05:00.000Z",
      status: "CONFIRMED",
      provider: { id: 7, type: "ProviderV1", url: "…" },
      operatory: { id: 12, type: "OperatoryV1", url: "…" },
      patient: { id: 1000000020702, type: "PatientV1", url: "…" },
    },
    {
      id: 555001,
      start: "2026-08-21T09:30:00.000Z",
      status: "UNCONFIRMED",
      provider: { id: 7, type: "ProviderV1", url: "…" },
      operatory: { id: 11, type: "OperatoryV1", url: "…" },
      patient: { id: 1000000020701, type: "PatientV1", url: "…" },
    },
  ],
  warnings: [],
  errors: [],
  meta: { pagination: { limit: 200, offset: 0, total: 2 } },
};

/** AgingBalanceReportV1 with per-guarantor AgingReceivableV1 rows. */
const AGING = {
  data: {
    currentAmount: 1240.5,
    thirtyDaysAmount: 0,
    sixtyDaysAmount: 0,
    ninetyDaysAmount: 0,
    total: 940.5,
    balance: 940.5,
    patientReports: [
      { id: 1000000020701, firstName: "Ada", lastName: "Lovelace", balance: 1240.5 },
      { id: 1000000020702, firstName: "Grace", lastName: "Hopper", balance: -300 },
    ],
  },
  warnings: [],
  errors: [],
};

// ── construction refuses what it cannot safely do ───────────────────────────

describe("construction", () => {
  it("refuses a connection with no Organization-ID", () => {
    // The header is REQUIRED on every documented operation, so a connection
    // without one cannot make a single call. Failing at construction beats
    // failing per read with something that looks like an auth problem.
    // Mutation: drop the check -> constructing succeeds -> red.
    expect(
      () => new DentrixAscendConnector({ organizationId: "", credentialsSecretRef: "r" }),
    ).toThrow(ConnectorBlockedError);
  });

  it("refuses a non-Ascend host, cleartext http, and userinfo", () => {
    // The bearer token is a credential to a practice's clinical record.
    // Mutation: drop any one clause -> the matching case stops throwing -> red.
    expect(() => assertSafeAscendBaseUrl("https://attacker.example/api")).toThrow(
      UnsafeAscendBaseUrlError,
    );
    expect(() => assertSafeAscendBaseUrl("http://prod.hs1api.com/ascend-gateway/api")).toThrow(
      /not https/,
    );
    expect(() => assertSafeAscendBaseUrl("https://evil@prod.hs1api.com/x")).toThrow(/userinfo/);
  });

  it("is not fooled by a lookalike host", () => {
    // Mutation: use includes(".hs1api.com") instead of a suffix test -> red.
    expect(() => assertSafeAscendBaseUrl("https://prod.hs1api.com.evil.test/api")).toThrow(
      UnsafeAscendBaseUrlError,
    );
  });

  it("accepts both documented servers", () => {
    // The reason baseUrl is configurable: sandbox is where enrolment starts.
    // Mutation: hardcode production -> the sandbox case throws -> red.
    expect(assertSafeAscendBaseUrl(ASCEND_SANDBOX_BASE_URL)).toBe(ASCEND_SANDBOX_BASE_URL);
    expect(assertSafeAscendBaseUrl(ASCEND_PRODUCTION_BASE_URL)).toBe(ASCEND_PRODUCTION_BASE_URL);
  });
});

// ── the contract: real endpoints, real filters, real headers ────────────────

describe("requests match the published spec", () => {
  it("sends Organization-ID on every request", async () => {
    // Required on all 438 documented operations. Mutation: drop the header ->
    // red. Asserted on the RECORDED request, because a response fixture cannot
    // tell you what was sent.
    const { c, calls } = ascend({ pages: [PATIENTS] });
    await c.runRead("find_patient", { query: "lov" });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.headers["Organization-ID"]).toBe(ORG);
  });

  it("builds the appointment window from the documented start operators", async () => {
    // The spec's filter table gives `start` the >, <, >=, <= operators, so the
    // read registry's half-open [from, to) window maps directly onto the API.
    // Mutation: filter client-side instead -> the filter param loses the
    // window -> red.
    const { c, calls } = ascend({ pages: [APPOINTMENTS] });
    await c.runRead("get_schedule_today", {
      from: "2026-08-21T00:00:00.000Z",
      to: "2026-08-22T00:00:00.000Z",
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toContain("/v1/appointments");
    expect(url.searchParams.get("filter")).toBe(
      "start>=2026-08-21T00:00:00.000Z,start<2026-08-22T00:00:00.000Z",
    );
  });

  it("uses the BULK aging report, with the location filter it requires", async () => {
    // /v1/agingbalances takes a REQUIRED patientId, so it cannot answer a
    // practice-wide total without one call per patient. /v1/agingbalances/report
    // is the bulk form and its filter grammar requires location.id.
    // Mutation: point at /v1/agingbalances -> red.
    const { c, calls } = ascend({ pages: [AGING] });
    await c.runRead("get_ar_summary", {});
    const url = new URL(calls[0].url);
    expect(url.pathname).toContain("/v1/agingbalances/report");
    expect(url.searchParams.get("filter")).toContain("location.id==42");
  });

  it("refuses the AR read when no location is configured, and only that read", async () => {
    // Better than refusing the whole connection: the schedule and patients are
    // still perfectly answerable. Mutation: throw at construction instead ->
    // the schedule call below fails -> red.
    const { c } = ascend({ pages: [PATIENTS], locationId: undefined });
    await expect(c.runRead("get_ar_summary", {})).rejects.toThrow(/location id/);
    await expect(c.runRead("find_patient", { query: "lov" })).resolves.toBeInstanceOf(Array);
    expect((await c.status()).receivablesAvailable).toBe(false);
  });

  it("pages until a short page", async () => {
    // Mutation: return after the first page -> the second page's rows vanish.
    const full = { data: Array.from({ length: 2 }, (_, i) => ({ id: i, firstName: "A", lastName: "Zed" })) };
    const short = { data: [{ id: 99, firstName: "B", lastName: "Zed" }] };
    const { c, calls } = ascend({ pages: [full, short], pageSize: 2 });
    const rows = (await c.runRead("find_patient", { query: "zed" })) as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1].url).searchParams.get("page")).toBe("2");
  });
});

// ── rows are indistinguishable from every other track ──────────────────────

describe("reads", () => {
  it("returns appointment rows with the canonical shape", async () => {
    // Mutation: drop any canonical key -> red. A consumer must not be able to
    // tell which track answered by probing for a key.
    const { c } = ascend({ pages: [APPOINTMENTS] });
    const rows = (await c.runRead("get_schedule_today", {
      from: "2026-08-21T00:00:00.000Z",
      to: "2026-08-22T00:00:00.000Z",
    })) as Record<string, unknown>[];
    expect(Object.keys(rows[0]).sort()).toEqual([...CANONICAL_COLUMNS.appointment].sort());
    // Ordered by time even though the fixture is not.
    // Mutation: drop the sort -> red.
    expect(rows.map((r) => r.appt_id)).toEqual(["555001", "555002"]);
    expect(rows[0].appt_time).toBe("2026-08-21T09:30:00.000Z");
    // `status` here is genuinely the APPOINTMENT's status — one of the things
    // the on-premise guess got wrong, where `Status` meant the patient's.
    expect(rows[0].status).toBe("UNCONFIRMED");
    // Refs are {id,type,url}; the row carries the id.
    // Mutation: pass the ref object through -> red.
    expect(rows[0].provider_id).toBe("7");
    expect(rows[0].operatory_id).toBe("11");
    expect(rows[0].patient_id).toBe("1000000020701");
  });

  it("applies a LITERAL prefix match rather than trusting the ~= operator", async () => {
    // The spec gives lastName a `~=` operator but does not state whether it
    // means contains or starts-with. Every other track's contract for this read
    // is a literal prefix, so the server clause narrows and the prefix is
    // enforced here. Guessing the operator would change which patients a search
    // returns — a PHI over-fetch in the wrong direction.
    //
    // Mutation: drop the client-side filter -> "Turing" and "Hopper" come back
    // for a "lov" search -> red.
    const { c, calls } = ascend({ pages: [PATIENTS] });
    const rows = (await c.runRead("find_patient", { query: "lov" })) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      patient_id: "1000000020701",
      first_name: "Ada",
      last_name: "Lovelace",
    });
    // The server-side clause is still sent — it narrows the page.
    expect(new URL(calls[0].url).searchParams.get("filter")).toBe("lastName~=lov");
  });

  it("aggregates receivables from the per-guarantor rows", async () => {
    // Counted and summed over the SAME rows, so the count and the total cannot
    // disagree — and a credit balance stays negative.
    // Mutation: read the envelope's own `balance` and count rows separately ->
    // the two can drift -> red.
    const { c } = ascend({ pages: [AGING] });
    expect(await c.runRead("get_ar_summary", {})).toEqual([
      { account_count: 2, total_balance: 940.5 },
    ]);
  });

  it("refuses the recall read instead of guessing at it", async () => {
    // Ascend has recall concepts; the spec does not state the equivalent filter
    // plainly enough to map without inventing one. A wrong recall list has a
    // practice chasing the wrong people.
    // Mutation: map it to some plausible filter -> this stops throwing -> red.
    const { c } = ascend({ pages: [PATIENTS] });
    await expect(c.runRead("get_recall_due", {})).rejects.toBeInstanceOf(ConnectorBlockedError);
  });
});

// ── failure states stay distinguishable ────────────────────────────────────

describe("failure states", () => {
  it("401/403 is a re-authorization, not a transport fault", async () => {
    // Vendor enablement defaults to OFF per organization, so 403 is a routine
    // first-connect state. Mutation: fold these into the generic !ok branch ->
    // ConnectorBlockedError -> red.
    for (const status of [401, 403]) {
      const { c } = ascend({ status, pages: [{}] });
      await expect(c.runRead("find_patient", { query: "x" })).rejects.toBeInstanceOf(
        AscendAuthorizationError,
      );
    }
  });

  it("429 is a throttle, not an authorization problem", async () => {
    // Different remedy: back off, versus a human reconnecting.
    // Mutation: map 429 to AscendAuthorizationError -> red.
    const { c } = ascend({ status: 429, pages: [{}] });
    const err = await c.runRead("find_patient", { query: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect(err).not.toBeInstanceOf(AscendAuthorizationError);
  });

  it("blocks honestly when no token resolver is wired", async () => {
    // The OAuth client secret belongs to the orchestrator, not to a
    // per-connection object built and discarded per read.
    // Mutation: authenticate with an empty token -> a request goes out -> red.
    const { impl, calls } = stubFetch([PATIENTS]);
    const c = new DentrixAscendConnector(
      { organizationId: ORG, credentialsSecretRef: "r" },
      { fetchImpl: impl, now: () => NOW },
    );
    await expect(c.runRead("find_patient", { query: "x" })).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("reports disconnected rather than inferring health from a held token", async () => {
    // The same inferred-from-absence bug the QuickBooks Online track had twice.
    // Mutation: derive state from `this.token` -> an unconfigured connection
    // reports connected -> red.
    const c = new DentrixAscendConnector(
      { organizationId: ORG, credentialsSecretRef: "r" },
      { now: () => NOW },
    );
    expect((await c.status()).state).toBe("disconnected");
    expect((await c.status()).ok).toBe(false);
    await expect(c.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("never renders a failure as an empty result", async () => {
    // Mutation: catch and return [] anywhere -> red.
    for (const status of [401, 429, 500]) {
      const { c } = ascend({ status, pages: [{}] });
      const out = await c.runRead("find_patient", { query: "x" }).catch((e: unknown) => e);
      expect(Array.isArray(out), `status ${status} returned rows`).toBe(false);
      expect(out).toBeInstanceOf(Error);
    }
  });

  it("leaks no token material into an error", async () => {
    // Errors travel into the chat transcript. Mutation: interpolate the token
    // or the request URL into a message -> red.
    const { c } = ascend({ status: 500, pages: [{}] });
    const err = (await c.runRead("find_patient", { query: "x" }).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("SECRET");
    expect(err.message).not.toContain("Bearer");
    expect(err.message).not.toContain(ORG);
  });
});

// ── capability and posture ─────────────────────────────────────────────────

describe("capability and posture", () => {
  it("serves practice datasets and refuses accounting ones without a call", async () => {
    // A dental PMS has no vendor bills. Not a fault, not fixable.
    // Mutation: remove assertDatasetsServed -> a request goes out -> red.
    const { c, calls } = ascend();
    await expect(c.runRead("get_open_bills", {})).rejects.toBeInstanceOf(DatasetNotServedError);
    expect(calls).toHaveLength(0);
    expect([...ASCEND_DATASETS].sort()).toEqual(["account", "appointment", "patient"]);
  });

  it("refuses every write", async () => {
    // The API supports writes; this track does not — and not only for the usual
    // reason. The Developer Agreement's redistribution terms are unpublished,
    // and writing into a clinical record under an agreement nobody has read is
    // not a risk to take on a customer's behalf.
    // Mutation: allow any write path -> red.
    const { c, calls } = ascend();
    await expect(c.applyWrite("reschedule_appointment", {})).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("pins the spec version into the drift fingerprint", async () => {
    // Ascend's documented policy is tolerant-reader: fields may be ADDED
    // without a version bump, so our canonical column list can stay identical
    // across a real upstream change. A fingerprint blind to the spec version
    // would report "no drift" across one.
    // Mutation: drop the suffix -> red.
    const { c } = ascend();
    expect((await c.introspect()).fingerprint).toContain(`:ascend${ASCEND_SPEC_VERSION}`);
  });
});
