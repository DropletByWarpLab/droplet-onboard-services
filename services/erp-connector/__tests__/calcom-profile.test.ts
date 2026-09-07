/**
 * WARP-2707 / ADR-046 — Cal.com's VENDOR FACTS, pinned against Cal.com's own
 * documentation.
 *
 * ## Why this file is mandatory rather than nice to have
 *
 * ADR-046's Consequences section: *"A declarative profile is easier to get wrong
 * quietly than code is. A wrong watermark parameter is one string. Mitigation:
 * the parameter names are pinned by tests that cite the vendor page, exactly as
 * `graph-resources.test.ts` does for Microsoft Graph."* This is that file for
 * Cal.com. `rest-track.test.ts` proves the connector does what a profile SAYS —
 * which is exactly the question that stays green when the profile says the wrong
 * thing — and `introspect()`'s fingerprint hashes the datasets and their
 * canonical columns, not the paths, headers or parameter spellings. Only this
 * file can catch those.
 *
 * Cal.com's version of the silent failure is worse than an ignored parameter.
 * `cal-api-version` is `required: true` on `GET /v2/bookings` in Cal.com's own
 * OpenAPI document, described there as *"Must be set to 2026-05-01"*, and
 * Cal.com's note on omitting it is that the request *"will default to an older
 * version of this endpoint"* — the 2024-08-13 one, with `take`/`skip` paging and
 * a differently shaped pagination object. A profile that dropped the header would
 * read the first page, find no `nextCursor` where it looked, and report a
 * COMPLETE incremental sync over a fraction of the customer's bookings.
 *
 * ## The sources every claim below was checked against (2026-09-07)
 *
 *  • Get all bookings  https://cal.com/docs/api-reference/v2/bookings/get-all-bookings
 *  • Get my profile    https://cal.com/docs/api-reference/v2/me/get-my-profile
 *  • Introduction (auth + rate limits)
 *                      https://cal.com/docs/api-reference/v2/introduction
 *  • the hosted OpenAPI document itself, which is where the parameter list,
 *    `BookingHost`, `BookingAttendee`, `CursorPaginationMeta_2026_05_01` and the
 *    `required: ["status", "data", "pagination"]` line below were read.
 *
 * ## The rule every test here obeys
 *
 * 🔴 **Facts are asserted from the OUTGOING REQUEST, not from the profile
 * object.** These tests run the REAL profile through a REAL
 * `RestProfileConnector` with an injected fetch, so a connector that drops the
 * version header, forgets the watermark or pages on the wrong parameter goes red
 * here even though the profile is untouched.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, expect, it } from "vitest";

import { providerDescriptor } from "@droplet/shared-types";

import {
  RestPaginationContractError,
  RestProfileConnector,
  UnsafeBaseUrlError,
} from "../src/rest/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { authPlaceholders } from "../src/rest/profile.js";
import { restProfileFor } from "../src/rest/profiles.js";
import {
  CALCOM_API_ORIGIN,
  CALCOM_BOOKINGS_API_VERSION,
  CALCOM_MIN_REQUEST_INTERVAL_MS,
  CALCOM_PROFILE,
  CALCOM_PROVIDER,
} from "../src/rest/vendors/calcom.js";
import { CANONICAL_COLUMNS } from "../src/export-drop/profiles.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A recording fetch stub — the same shape `rest-track.test.ts` uses, and
 * duplicated rather than imported ON PURPOSE: importing it from that file would
 * execute that file's whole suite as a side effect of loading this one, and a
 * suite that runs another suite reports failures against the wrong file.
 */
function stubFetch(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const page = pages[Math.min(n, pages.length - 1)]!;
    n += 1;
    const status = page.status ?? 200;
    const headers = page.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } as unknown as Headers,
      json: async () => page.body,
      text: async () => JSON.stringify(page.body),
    } as unknown as Response;
  };
  return { impl: impl as never, calls };
}

/**
 * An API key's stand-in, deliberately in NEITHER documented shape — no
 * `cal_live_` and no `cal_` at all. It works because nothing validates the
 * shape, which is the property the descriptor test below pins.
 */
const API_KEY = "test-api-key";

/**
 * The REAL profile, through the REAL connector.
 *
 * The clock and `sleep` are injected because this profile paces at 500 ms
 * between requests: with the default `setTimeout` a two-page read would make the
 * suite actually pay Cal.com's rate ceiling. The recorded sleeps are asserted in
 * the pacing test rather than discarded.
 */
function connectorWith(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const { impl, calls } = stubFetch(pages);
  const slept: number[] = [];
  let clock = 0;
  const connector = new RestProfileConnector(
    CALCOM_PROFILE,
    { provider: CALCOM_PROVIDER },
    {
      fetchImpl: impl,
      resolveCredentials: async () => ({ apiKey: API_KEY }),
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    },
  );
  return { connector, calls, slept };
}

/** The watermark instant every read below passes, and what it must appear as. */
const SINCE = "2026-09-01T00:00:00Z";
const SINCE_ISO = "2026-09-01T00:00:00.000Z";

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;
const rowsOf = (rows: unknown[]) => rows as Record<string, unknown>[];

/**
 * One Cal.com `Booking`, shaped as the 2026-05-01 bookings response documents
 * it — and carrying exactly the two values a later pass would be tempted to put
 * in `patient_id` and `operatory_id`.
 *
 * TWO hosts, because that is the round-robin / collective shape the `provider_id`
 * projection is knowingly lossy about.
 */
const BOOKING = {
  id: 123,
  uid: "bk_abc",
  start: "2026-09-08T15:30:00Z",
  end: "2026-09-08T16:00:00Z",
  status: "accepted",
  hosts: [
    { id: 42, name: "Alice", email: "alice@example.com", username: "alice" },
    { id: 43, name: "Bob", email: "bob@example.com", username: "bob" },
  ],
  attendees: [
    {
      name: "Casey Jordan",
      email: "casey@example.com",
      timeZone: "Europe/Paris",
      language: "en",
      absent: false,
      phoneNumber: "+33123456789",
    },
  ],
  location: "https://meet.example.com/room-7",
};

// ── identity, custody and the descriptor ────────────────────────────────────

describe("Cal.com — the profile the track actually dispatches", () => {
  it("is the profile restProfileFor('calcom') returns, not a copy", () => {
    // Mutation: register a second Cal.com profile in `profiles.ts` and this whole
    // file starts testing a file nothing ships.
    expect(restProfileFor(CALCOM_PROVIDER)).toBe(CALCOM_PROFILE);
  });

  it("🔴 dials the HOSTED host only, and it is the host the descriptor registers for egress", () => {
    // Cal.com ships two products under one name and they run DIFFERENT API
    // contracts: hosted `api.cal.com` (cursor/limit, cal-api-version 2026-05-01)
    // and self-hosted `cal.diy` (take/skip, 2024-08-13, a feature-reduced build).
    // Self-hosted is a SECOND profile with a customer-supplied origin, a
    // `kind: dynamic` egress entry and its own exact-host guard — not a variable
    // host on this one.
    // Mutation: turn this into a `kind: dynamic` base URL "so self-hosters work"
    // -> the static egress scanner stops seeing any host for this provider, and
    // `assertSafeRestBaseUrl` becomes the only control over a destination nothing
    // in CI checks. That change needs the dynamic entry, not this edit.
    expect(CALCOM_PROFILE.baseUrl).toEqual({ kind: "static", origin: CALCOM_API_ORIGIN });
    expect(CALCOM_API_ORIGIN).toBe("https://api.cal.com");
    expect(providerDescriptor(CALCOM_PROVIDER)!.egressHosts).toEqual(["api.cal.com"]);
  });

  it("🔴 serves EXACTLY the datasets the descriptor advertises", () => {
    // The descriptor is what the hub, the scheduler (`entityServedBy`) and the
    // dashboard read; the profile is what the connector reads. A drift between
    // them is the class of bug the descriptor exists to prevent — a hub tile
    // offering a dataset the connection will refuse the first time it is asked.
    // Compared as SETS: ordering carries no meaning in either place.
    const served = CALCOM_PROFILE.datasets.map((d) => d.dataset);
    expect([...served].sort()).toEqual([...providerDescriptor(CALCOM_PROVIDER)!.datasets].sort());
    expect(served).toEqual(["appointment"]);
  });

  it("🔴 declares NO credential-field pattern, and here the reason is stronger than usual", () => {
    // A hosted LIVE key is `cal_live_…` but a hosted TEST key is `cal_…` with no
    // second segment, so the obvious `^cal_(live|test)_` REJECTS valid keys. And
    // on a self-hosted install the prefix is not a vendor constant at all — it is
    // the operator-set `API_KEY_PREFIX` environment variable (default `cal_`), so
    // it can be anything at all. A rejecting pattern anchored on a configurable
    // prefix is a false rejection that blocks a paying customer at the paste box
    // for zero security gain; the only thing that proves a key is Cal.com
    // answering `GET /v2/me` with it, which `connect()` already does.
    // Mutation: add `pattern: "^cal_"` -> red, and a self-hoster is locked out.
    const fields = providerDescriptor(CALCOM_PROVIDER)!.credentialFields;
    expect(fields.map((f) => f.name)).toEqual(["apiKey"]);
    for (const field of fields) expect(field.pattern).toBeUndefined();
    expect(fields[0]!.secret).toBe(true);
    expect(fields[0]!.required).toBe(true);
  });

  it("names its credential placeholder EXACTLY as the descriptor names the field", () => {
    // These two are wired together at runtime by nothing but this string: the
    // orchestrator stores the field under the descriptor's name, the connector
    // looks it up by the template's placeholder. Rename either alone and every
    // Cal.com connection refuses with "the stored credential has no apiKey" — at
    // first read, on a schedule, where nobody is watching.
    expect(authPlaceholders(CALCOM_PROFILE.auth)).toEqual(["apiKey"]);
    expect(providerDescriptor(CALCOM_PROVIDER)!.credentialFields.map((f) => f.name)).toEqual(
      authPlaceholders(CALCOM_PROFILE.auth),
    );
  });

  it("paces at the DOCUMENTED floor, and the descriptor's ceiling says the same thing twice", async () => {
    // Cal.com documents 120 requests per minute for API-key authentication — one
    // request per 500 ms. Unlike Square (which publishes no ceiling at all) this
    // is a published number, so the profile paces against it. The descriptor
    // states the same fact in `ProviderRateLimit`'s hourly shape, and these are
    // the only two places it is written down.
    // Mutation: raise the profile to 200/min "because support said they'd raise
    // it" -> red. The floor is what a customer gets WITHOUT asking, so the floor
    // is what the box assumes.
    const rateLimit = providerDescriptor(CALCOM_PROVIDER)!.rateLimit!;
    expect(rateLimit).toEqual({ callCeiling: 7_200, periodMs: 3_600_000 });
    expect(rateLimit.periodMs / rateLimit.callCeiling).toBe(CALCOM_MIN_REQUEST_INTERVAL_MS);
    expect(CALCOM_PROFILE.minRequestIntervalMs).toBe(500);

    // And it is a WAIT between requests, not a refusal: a refusal would make a
    // slow sync incomplete, which is worse than making it slow.
    const { connector, slept } = connectorWith([
      { body: { data: [BOOKING], pagination: { nextCursor: "CUR1", hasMore: true } } },
      { body: { data: [], pagination: { nextCursor: null, hasMore: false } } },
    ]);
    await connector.runRead("get_schedule_today", { since: SINCE });
    expect(slept).toEqual([CALCOM_MIN_REQUEST_INTERVAL_MS]);
  });
});

// ── the headers that actually leave the box ─────────────────────────────────

describe("Cal.com — auth and the version header, read off the wire", () => {
  it("sends Authorization: Bearer <key> — the literal name and the literal template", async () => {
    // Cal.com's own parameter description: the value "must be `Bearer <token>`
    // where `<token>` is api key prefixed with cal_, managed user access token, or
    // OAuth access token". A genuine RFC-6750 Bearer scheme — pinned because five
    // of the six shapes on ADR-046 §2's table are NOT this one.
    const { connector, calls } = connectorWith([
      { body: { data: [], pagination: { nextCursor: null, hasMore: false } } },
    ]);
    await connector.runRead("get_schedule_today", { since: SINCE });

    expect(CALCOM_PROFILE.auth).toEqual({
      headerName: "Authorization",
      valueTemplate: "Bearer {{apiKey}}",
    });
    expect(headersOf(calls[0]!.init).Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("🔴 sends cal-api-version: 2026-05-01 on EVERY request", async () => {
    // THE most load-bearing constant in this profile. Cal.com's own OpenAPI marks
    // the header `required: true` on GET /v2/bookings and describes it as "Must be
    // set to 2026-05-01" — and omitting it does not fail loudly: Cal.com's note is
    // that not passing the correct value "will default to an older version of this
    // endpoint". The hosted spec still serves the 2024-08-13 booking output,
    // whose paging is `take`/`skip` and whose pagination object is shaped
    // differently, so an unversioned read walks one page, finds no `nextCursor`
    // where this profile looks, and reports a COMPLETE sync over a fraction of the
    // customer's bookings.
    // Mutation: drop `constantHeaders`, or copy Cal.com's OTHER documented value
    // (`2024-08-13`) across -> red on both calls below.
    const { connector, calls } = connectorWith([
      { body: { data: [], pagination: { nextCursor: null, hasMore: false } } },
    ]);
    await connector.connect();
    await connector.runRead("get_schedule_today", { since: SINCE });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(headersOf(call.init)["cal-api-version"]).toBe(CALCOM_BOOKINGS_API_VERSION);
    }
    expect(CALCOM_BOOKINGS_API_VERSION).toBe("2026-05-01");
    expect(CALCOM_PROFILE.constantHeaders).toEqual({ "cal-api-version": CALCOM_BOOKINGS_API_VERSION });

    // ⚠ The value is PER ENDPOINT, not per vendor — GET /v2/bookings is
    // 2026-05-01 while POST /v2/bookings is 2026-02-25 on the same API. It lives
    // in `constantHeaders` ONLY because this profile serves exactly one endpoint.
    // Mutation: add a second dataset and carry this header across it -> the
    // ADR-046 §2 per-dataset failure, one level up from the watermark. This
    // assertion is the tripwire: a second dataset makes it a lie.
    expect(CALCOM_PROFILE.datasets).toHaveLength(1);
  });

  it("probes GET /v2/me on BOTH connect() and health()", async () => {
    // 🔴 Resolving the credential locally is not a connection: a key the owner
    // expired in their console resolves perfectly and fails on the first
    // scheduled read, hours later. `/v2/me` returns the key's own user and
    // nothing else — no pagination, one row — so a 401 on it is unambiguous
    // evidence about the KEY.
    // Mutation: point probePath at `/v2/bookings` -> the health check pages the
    // customer's calendar every time, and an account with no bookings still
    // "connects" for reasons unrelated to the key.
    const { connector, calls } = connectorWith([{ body: { status: "success", data: { id: 1 } } }]);
    await connector.connect();
    await connector.health();

    expect(CALCOM_PROFILE.probePath).toBe("/v2/me");
    expect(calls.map((c) => c.url)).toEqual(["https://api.cal.com/v2/me", "https://api.cal.com/v2/me"]);
    // The probe carries no watermark and no paging parameter: this endpoint
    // documents none, and sending one would be inventing a contract.
    for (const call of calls) expect(new URL(call.url).search).toBe("");
  });
});

// ── the one dataset, read off the wire ──────────────────────────────────────

describe("Cal.com appointment — GET /v2/bookings", () => {
  it("🔴 filters on afterUpdatedAt and pages on cursor / pagination.nextCursor", async () => {
    const { connector, calls } = connectorWith([
      {
        body: {
          data: [{ ...BOOKING, uid: "bk_1" }],
          pagination: { nextCursor: "CUR1", hasMore: true },
          // Decoy: proves `rowsPath` is read, not guessed. A profile reading the
          // wrong key would return this row rather than none.
          bookings: [{ uid: "decoy" }],
        },
      },
      { body: { data: [{ ...BOOKING, uid: "bk_2" }], pagination: { nextCursor: null, hasMore: false } } },
    ]);
    const rows = rowsOf(await connector.runRead("get_schedule_today", { since: SINCE }));

    const first = new URL(calls[0]!.url);
    expect(first.host).toBe("api.cal.com");
    expect(first.pathname).toBe("/v2/bookings");
    // The watermark. Cal.com: "Filter bookings that have been updated after this
    // date string" — a genuine last-modified filter, which is what makes
    // `complete: true` below honest.
    // Mutation: spell it `afterUpdated`, or reach for the sibling
    // `beforeUpdatedAt` -> the read either full-scans or returns the wrong half
    // of the customer's calendar, and the sync still reports success.
    expect(first.searchParams.get("afterUpdatedAt")).toBe(SINCE_ISO);
    expect(first.searchParams.has("beforeUpdatedAt")).toBe(false);

    // Page two: the cursor Cal.com returned at `pagination.nextCursor`, sent back
    // on the parameter Cal.com names, with the watermark still attached.
    const second = new URL(calls[1]!.url);
    expect(second.searchParams.get("cursor")).toBe("CUR1");
    expect(second.searchParams.get("afterUpdatedAt")).toBe(SINCE_ISO);
    expect(calls).toHaveLength(2);

    // 🔴 `take`/`skip` are the SELF-HOSTED spelling, on the 2024-08-13 contract.
    // Sending them to the hosted API is not an error there — they are simply
    // ignored — so this absence is the only thing that catches the mix-up.
    for (const call of calls) {
      const url = new URL(call.url);
      expect(url.searchParams.has("take")).toBe(false);
      expect(url.searchParams.has("skip")).toBe(false);
    }

    expect(rows.map((r) => r.appt_id)).toEqual(["bk_1", "bk_2"]);
  });

  it("declares the watermark COMPLETE, the cursor paths, and the rows path", () => {
    // `afterUpdatedAt` filters on the booking's own modification time, so a
    // status change (accepted -> cancelled) comes back on the next pass. That
    // is the vendor fact `complete: true` records.
    //
    // ⚠ It is a RECORDED FACT, not a control: nothing reads `complete` today.
    // The reconciliation sweep's cadence is uniform, and `appointment` is not
    // in `ERP_SYNC_ENTITIES`, so a Cal.com connection registers no cursor and
    // is neither ticked nor swept — its rows are reached on demand through
    // `runRead` and nowhere else. See `RestWatermark.complete`, and the
    // orchestrator test that pins the empty intersection.
    // Mutation: flip it to false -> red here, and nowhere else.
    const appointment = CALCOM_PROFILE.datasets.find((d) => d.dataset === "appointment")!;
    expect(appointment.path).toBe("/v2/bookings");
    expect(appointment.watermark).toEqual({
      name: "afterUpdatedAt",
      location: "query",
      format: "iso",
      complete: true,
    });
    expect(appointment.pagination).toEqual({
      kind: "cursor",
      nextCursorPath: "pagination.nextCursor",
      cursorParam: "cursor",
    });
    expect(appointment.rowsPath).toBe("data");
  });

  it("🔴 takes appt_id from `uid`, NOT from `id`", async () => {
    // `uid` is the API's own addressing key — it is the `{bookingUid}` path
    // segment in every other bookings route — while `id` is a numeric per-row key
    // that is not the documented identifier. Both are present on every booking,
    // both are stable, and only one of them can be handed back to Cal.com.
    // Mutation: map `appt_id: "id"` -> nothing fails, rows land, and every
    // identifier the box holds for a booking is one Cal.com's own API will not
    // accept. The fixture's `id` is asserted absent so a "helpful" fallback
    // (`uid ?? id`) cannot pass this either.
    const { connector } = connectorWith([
      { body: { data: [BOOKING], pagination: { nextCursor: null, hasMore: false } } },
    ]);
    const row = rowsOf(await connector.runRead("get_schedule_today", { since: SINCE }))[0]!;
    expect(row.appt_id).toBe("bk_abc");
    expect(row.appt_id).not.toBe("123");
    expect(row.appt_time).toBe("2026-09-08T15:30:00.000Z");
    expect(row.status).toBe("accepted");
  });

  it("🔴 takes provider_id from the FIRST host — knowingly lossy for round-robin", async () => {
    // The canonical column holds ONE provider. Round-robin and collective event
    // types return MULTIPLE hosts, and this fixture has two. The first host is the
    // organiser in Cal.com's own ordering, which is the closest thing to "the
    // provider" the column means — so a two-host booking is reported against
    // host 42 and the fact that 43 was also on it is NOT representable here.
    // That loss is deliberate and is recorded rather than hidden: it is the
    // argument for the scheduling-vocabulary widening ADR-046's follow-ups call
    // for, not something to paper over by joining the names into one string.
    // Mutation: read `hosts.1.id`, or the whole array -> red; a text column
    // holding "42,43" is not an identifier anything can join on.
    const { connector } = connectorWith([
      { body: { data: [BOOKING], pagination: { nextCursor: null, hasMore: false } } },
    ]);
    const row = rowsOf(await connector.runRead("get_schedule_today", { since: SINCE }))[0]!;
    // A numeric vendor id, stringified by the canonical text coercion — ids
    // arrive as JSON numbers and a canonical identifier column is text.
    expect(row.provider_id).toBe("42");
  });

  it("🔴 leaves patient_id and operatory_id UNDEFINED — Cal.com has no honest source for either", async () => {
    // THE pin this file exists for. `CANONICAL_COLUMNS.appointment` is the
    // PRACTICE-MANAGEMENT vocabulary (WARP-1964, dental) and Cal.com is a general
    // booking product:
    //
    //  • `patient_id` — the `BookingAttendee` schema this endpoint returns has NO
    //    `id` field at all (absent, displayEmail, email, language, name,
    //    phoneNumber, timeZone), and Cal.com serves no `patient` dataset, so there
    //    is nothing for a patient id to point AT. Using the attendee's EMAIL would
    //    put a contact detail in an identifier column and silently make a
    //    customer's email address a join key — personal data promoted to an index,
    //    by a one-line mapping. (The older `BookingAttendeeWithId_2024_08_13`
    //    variant does carry an `id`; it is an attendee-row key on a version this
    //    profile does not request, and it still points at no dataset the box
    //    holds, so finding it is not a reason to unpin this.)
    //  • `operatory_id` — Cal.com has no room, chair or operatory concept.
    //    `location` is free text that is variously a meeting URL, a phone number,
    //    a street address, or the literal "Cal Video": four kinds of value for a
    //    column that means one thing.
    //
    // The fixture deliberately carries both temptations — an attendee email and a
    // meeting-URL location — so the assertions below fail for the mapping a later
    // pass would actually write.
    // Mutation: `patient_id: "attendees.0.email"` or
    // `operatory_id: "location"` -> red, twice.
    const { connector } = connectorWith([
      { body: { data: [BOOKING], pagination: { nextCursor: null, hasMore: false } } },
    ]);
    const row = rowsOf(await connector.runRead("get_schedule_today", { since: SINCE }))[0]!;

    // Present-and-undefined, not missing: the projection is driven by the
    // vocabulary, and "the vendor does not carry this fact" is an undefined value
    // on a column that exists — never an absent column and never a fabricated one.
    expect(Object.keys(row).sort()).toEqual([...CANONICAL_COLUMNS.appointment].sort());
    expect("patient_id" in row).toBe(true);
    expect("operatory_id" in row).toBe(true);
    expect(row.patient_id).toBeUndefined();
    expect(row.operatory_id).toBeUndefined();

    // Whole-row sweep: whichever column someone routed them to, the attendee's
    // email and the free-text location must not appear anywhere in a canonical
    // appointment row.
    expect(Object.values(row)).not.toContain("casey@example.com");
    expect(Object.values(row)).not.toContain("https://meet.example.com/room-7");
    expect(Object.values(row)).not.toContain("+33123456789");

    // And the field map does not mention them at all — the absence is in the
    // profile, not merely in the outcome.
    const appointment = CALCOM_PROFILE.datasets.find((d) => d.dataset === "appointment")!;
    expect(Object.keys(appointment.fieldMap).sort()).toEqual([
      "appt_id",
      "appt_time",
      "provider_id",
      "status",
    ]);
  });

  it("🔴 does NOT tolerate an absent `data` array — that is a Square fact, not a Cal.com one", async () => {
    // Square omits the array on an empty result, so its specs declare
    // `absentRowsMeansEmpty`. Cal.com's response schema makes `data` REQUIRED
    // (`GetBookingsOutput_2026_05_01`: required ["status", "data", "pagination"]),
    // so this profile does not — and the difference is load-bearing: with the flag
    // set, a WRONG rowsPath would read as "no bookings this week" on every page of
    // every sync, which is a confident false statement about an owner's calendar.
    // Mutation: copy `absentRowsMeansEmpty: true` across from the Square profile
    // "for symmetry" -> this goes red, and it should.
    const appointment = CALCOM_PROFILE.datasets.find((d) => d.dataset === "appointment")!;
    expect(appointment.absentRowsMeansEmpty).toBeUndefined();

    const { connector } = connectorWith([{ body: { pagination: { nextCursor: null, hasMore: false } } }]);
    await expect(connector.runRead("get_schedule_today", { since: SINCE })).rejects.toThrow(
      RestPaginationContractError,
    );
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * 🔴 The refusal tests this file's header calls non-negotiable, and which it
 * shipped without.
 *
 * ADR-046 §3 and `rest-track.test.ts`'s own header state the rule: **a refusal
 * asserts `fetch` was called ZERO times**, never merely that an error was
 * thrown. A test that inspected only the returned error would still pass if the
 * request had already gone out carrying the owner's API key.
 *
 * Cal.com's hosted profile is STATIC, so its host cannot be steered by a
 * connection row today. The self-hosted product is a SECOND profile with a
 * customer-supplied origin — the shape ten of the surveyed vendors have — and
 * these refusals are what that profile will inherit. Writing them now is what
 * makes adding it a profile change rather than a security review.
 */
describe("Cal.com — the refusals, each costing ZERO fetch calls", () => {
  /** The real profile with a resolver that yields exactly what is passed. */
  function connectorWithCredentials(creds: Record<string, string>) {
    const { impl, calls } = stubFetch([
      { body: { data: [], pagination: { nextCursor: null, hasMore: false } } },
    ]);
    const connector = new RestProfileConnector(
      CALCOM_PROFILE,
      { provider: CALCOM_PROVIDER },
      { fetchImpl: impl, resolveCredentials: async () => creds },
    );
    return { connector, calls };
  }

  it("🔴 refuses a read when the stored credential has no apiKey — ZERO fetch calls", async () => {
    // The shape a real connection reaches this in: the descriptor's field was
    // renamed, or the owner's secret was purged on disconnect and the row
    // survived. Sending the literal `{{apiKey}}` would land in Cal.com's logs
    // as a failed auth nobody can explain.
    // Mutation: fall back to "" instead of refusing an empty placeholder -> the
    // request goes out and the call count goes to 1.
    const { connector, calls } = connectorWithCredentials({});
    await expect(connector.runRead("get_schedule_today", { since: SINCE })).rejects.toThrow(
      /has no "apiKey"/,
    );
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a blank apiKey as firmly as a missing one — ZERO fetch calls", async () => {
    // Whitespace is what a paste box produces. An empty Authorization header is
    // a request that cannot succeed, and Cal.com paces at 500 ms, so spending a
    // call to learn that costs the owner's budget as well as the round trip.
    const { connector, calls } = connectorWithCredentials({ apiKey: "\t \n" });
    await expect(connector.connect()).rejects.toThrow(/has no "apiKey"/);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a dataset Cal.com does not serve — ZERO fetch calls, and NOT an empty array", async () => {
    // This profile serves `appointment` and nothing else. Asked for money or
    // for a patient record, the connection refuses by NAME.
    // `[]` would be a confident false statement no caller can tell from a
    // genuinely empty result — and on `get_ar_summary` that statement is about
    // a practice's money.
    // Mutation: make `runRead` fall through to an empty array -> red.
    for (const name of ["get_ar_summary", "get_open_invoices", "get_recent_charges"]) {
      const { connector, calls } = connectorWithCredentials({ apiKey: API_KEY });
      await expect(connector.runRead(name, { since: SINCE }), name).rejects.toThrow(
        DatasetNotServedError,
      );
      expect(calls, name).toHaveLength(0);
    }
  });

  it("🔴 refuses every write, and spends no call finding out — the track is read-only", async () => {
    // ADR-046 §4. Cal.com HAS a booking-write API and `reschedule_appointment`
    // is a real command in the registry — which is exactly why this matters:
    // the refusal is the track's, not the vendor's, and it costs no request.
    const { connector, calls } = connectorWithCredentials({ apiKey: API_KEY });
    await expect(connector.applyWrite("reschedule_appointment", {})).rejects.toThrow(
      ConnectorBlockedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses to build against a provider id that is not Cal.com's — ZERO fetch calls", async () => {
    // The self-hosted build will be its own provider id with its own profile.
    // A row naming one and dispatched to the other must fail at CONSTRUCTION,
    // before a credential is resolved — not silently read a self-hoster's
    // calendar through the hosted contract.
    const { impl, calls } = stubFetch([{ body: { data: [] } }]);
    expect(
      () =>
        new RestProfileConnector(
          CALCOM_PROFILE,
          { provider: "calcom-selfhosted" },
          { fetchImpl: impl, resolveCredentials: async () => ({ apiKey: API_KEY }) },
        ),
    ).toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a 302 rather than following it off api.cal.com", async () => {
    // `fetch` defaults to following redirects, so without `redirect: "error"`
    // the guard would be checking a URL while the answer chose the destination
    // — with the owner's key attached, and with a booking response body that
    // carries attendee names, emails and phone numbers.
    // EXACTLY ONE call: the redirect was not followed.
    const { connector, calls } = connectorWith([
      { body: {}, status: 302, headers: { location: "https://evil.example.net/v2/bookings" } },
    ]);
    await expect(connector.runRead("get_schedule_today", { since: SINCE })).rejects.toThrow(
      UnsafeBaseUrlError,
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("api.cal.com");
  });
});
