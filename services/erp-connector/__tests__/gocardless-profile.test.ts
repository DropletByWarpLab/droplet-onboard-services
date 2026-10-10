/**
 * WARP-3697 / ADR-046 — GoCardless's VENDOR FACTS, pinned against GoCardless's
 * own documentation.
 *
 * ## Why this file is mandatory rather than nice to have
 *
 * ADR-046's Consequences section: *"A declarative profile is easier to get wrong
 * quietly than code is. A wrong watermark parameter is one string. Mitigation:
 * the parameter names are pinned by tests that cite the vendor page, exactly as
 * `graph-resources.test.ts` does for Microsoft Graph."* This is that file for
 * GoCardless. `rest-track.test.ts` proves the connector does what a profile SAYS
 * — which is exactly the question that stays green when the profile says the
 * wrong thing — and `introspect()`'s fingerprint hashes the datasets and their
 * canonical columns, not the paths, headers or parameter spellings. Only this
 * file can catch those.
 *
 * GoCardless's version of the silent failure is the WIRE SPELLING of its filter:
 * `created_at` is a nested filter object (`gt`, `gte`, `lt`, `lte`), and on the
 * wire it is the bracketed key `created_at[gte]`. A profile that wrote
 * `created_at_gte` or `created_after` would not fail loudly — it would read the
 * merchant's whole collection history and report an incremental read.
 *
 * ## The sources every claim below was checked against (2026-10-04)
 *
 *  • [src: https://docs.gocardless.com/docs/api-reference, accessed 2026-10-04]
 *    — the live and sandbox base hosts.
 *  • [src: https://docs.gocardless.com/docs/api-reference/making-requests.md,
 *    accessed 2026-10-04] — `Authorization: Bearer`, `GoCardless-Version:
 *    2015-07-06` ("Current version"), `Accept: application/json`.
 *  • [src: https://docs.gocardless.com/docs/api-reference/data-conventions.md,
 *    accessed 2026-10-04] — `limit` default 50 / max 500 / min 1, the `after` and
 *    `before` cursors, the `meta.cursors` object, "keep passing the `after`
 *    cursor ... until the array is empty or shorter than the requested `limit`",
 *    timestamps `2014-02-27T15:05:06.123Z`, dates `YYYY-MM-DD`, lists
 *    reverse-chronological by default.
 *  • [src: https://docs.gocardless.com/docs/api-reference/limits.md, accessed
 *    2026-10-04] — the rate-limit table (1,600 a minute), the header example
 *    (`ratelimit-limit: 1000`), the "1,000 requests/minute as a performance
 *    target" note, the 429 `rate_limit_exceeded` and the `ratelimit-*` headers.
 *  • [src: https://docs.gocardless.com/docs/api-reference/{payment,refund,payout,
 *    customer,creditor}, rendered, accessed 2026-10-04] — the `created_at` filter
 *    object, `amount` "in lowest denomination", the `currency` enum, the
 *    `links` objects, `arrival_date`.
 *  • [src: https://docs.gocardless.com/docs/api-reference/oauth-reference.md,
 *    accessed 2026-10-04] — the `read_only` / `read_write` scope values.
 *  • [src: https://support.gocardless.com/hc/en-us/articles/17144828748444-How-to-create-an-access-token,
 *    accessed 2026-10-04] — admins only, the Developers -> API settings -> Create
 *    -> Access token click-path, "we will not be able to show this again",
 *    "Disable access token", and that disabling its creator does not revoke it.
 *  • [src: https://gocardless.com/en-us/pricing/, accessed 2026-10-04] — no
 *    recurring subscription fee; the API is not tier-gated.
 *  • [src: github.com/gocardless/gocardless-nodejs, src/api/api.ts and README,
 *    accessed 2026-10-04] — the official Node SDK serialises nested filter
 *    objects with `qs.stringify`, and its README lists `created_at: { gt: ... }`:
 *    the source of the `created_at[gte]` wire form.
 *
 * ## 🔴 What this file does NOT claim — the UNVERIFIED register
 *
 * Nothing was signed up for and no GoCardless endpoint was called. Every item in
 * the "UNVERIFIED" block at the bottom is pinned AS UNVERIFIED: the test records
 * the profile's declared posture and says, in its title, that the vendor has not
 * confirmed it. A test that asserted such an item as a vendor fact would be a
 * guess wearing a pin's clothes.
 *
 * ## 🔴 The fixtures are the DOCUMENTED example objects, assembled — not captured
 *
 * `PM123`, `RF123` and `PO123` are the ids and fields the research spec records
 * from GoCardless's own examples. Where the spec records only some of an
 * object's fields, the others (named at each fixture) are supplied by the test
 * author so the row can be projected at all. The multi-page fixtures are those
 * same objects with `meta.cursors.after` edited by the test author. None of it is
 * a captured response body.
 *
 * Every test drives the REAL `GOCARDLESS_PROFILE` through the REAL
 * `RestProfileConnector` with an injected fetch, and every fact is asserted from
 * the OUTGOING request. Every test names the mutation that must turn it red.
 */
import { describe, expect, it } from "vitest";

import { providerDescriptor } from "@droplet/shared-types";

import {
  formatWatermark,
  RestPaginationContractError,
  RestProfileConnector,
  RestRateLimitedError,
  UnsafeBaseUrlError,
} from "../src/rest/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { authPlaceholders } from "../src/rest/profile.js";
import { restProfileFor } from "../src/rest/profiles.js";
import {
  GOCARDLESS_API_ORIGIN,
  GOCARDLESS_API_VERSION,
  GOCARDLESS_MIN_REQUEST_INTERVAL_MS,
  GOCARDLESS_PAGE_LIMIT,
  GOCARDLESS_PROFILE,
  GOCARDLESS_PROVIDER,
} from "../src/rest/vendors/gocardless.js";
import { CANONICAL_COLUMNS } from "../src/export-drop/profiles.js";
import { readRepoFile } from "./helpers/test-paths.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A recording fetch stub — the same shape `rest-track.test.ts` uses, and
 * duplicated rather than imported ON PURPOSE: importing it from that file would
 * execute that file's whole suite as a side effect of loading this one.
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
 * An access token's stand-in. GoCardless documents no shape for one — the
 * `live_` / `sandbox_` prefixes are community-reported only — so the value is
 * deliberately nothing in particular. It works because nothing validates the
 * shape, which is the property the descriptor test below pins.
 */
const ACCESS_TOKEN = "test-access-token";

/**
 * The REAL profile, through the REAL connector.
 *
 * The clock and `sleep` are injected because this profile paces at 60 ms between
 * requests: with the default `setTimeout` a multi-page read would make the suite
 * pay GoCardless's rate ceiling. The recorded sleeps are asserted in the pacing
 * test rather than discarded.
 */
function connectorWith(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const { impl, calls } = stubFetch(pages);
  const slept: number[] = [];
  let clock = 0;
  const connector = new RestProfileConnector(
    GOCARDLESS_PROFILE,
    { provider: GOCARDLESS_PROVIDER },
    {
      fetchImpl: impl,
      resolveCredentials: async () => ({ accessToken: ACCESS_TOKEN }),
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    },
  );
  return { connector, calls, slept };
}

/** The watermark instant a scheduled tick would pass, and what it must appear as. */
const SINCE = "2026-09-01T00:00:00Z";
const SINCE_ISO = "2026-09-01T00:00:00.000Z";

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;
const rowsOf = (rows: unknown[]) => rows as Record<string, unknown>[];
const queryKeys = (url: string) => [...new URL(url).searchParams.keys()].sort();

/**
 * The documented payment `PM123`. `id`, `amount`, `currency`, `status` and
 * `links` are the spec's recorded example; `created_at` is the instant the
 * expected row carries. `amount_refunded` is in the spec's expected row too.
 * NO customer link — the documented `links` are `mandate` and `creditor` only
 * (UNVERIFIED that none ever appears; see the register below).
 */
const PAYMENT = {
  id: "PM123",
  created_at: "2014-05-08T17:01:06.000Z",
  amount: 100,
  amount_refunded: 0,
  currency: "GBP",
  status: "pending_submission",
  links: { mandate: "MD123", creditor: "CR123" },
};

/**
 * The documented refund `RF123`: `id`, `status` and `links.payment` are the
 * spec's; `amount`, `currency` and `created_at` are supplied by the test author
 * (the spec records them only as REQUIRED columns), and are marked as such.
 */
const REFUND = {
  id: "RF123",
  created_at: "2014-05-09T10:00:00.000Z",
  amount: 100,
  currency: "GBP",
  status: "created",
  links: { payment: "PM123" },
};

/**
 * The documented payout `PO123`: `id`, `amount`, `arrival_date` and `status` are
 * the spec's; `created_at` and `currency` are supplied by the test author.
 */
const PAYOUT = {
  id: "PO123",
  created_at: "2014-06-25T09:30:00.000Z",
  amount: 1000,
  currency: "GBP",
  arrival_date: "2014-06-27",
  status: "pending",
};

/** A list body in GoCardless's envelope: rows under their resource name, then `meta.cursors`. */
const page = (key: string, rows: unknown[], after: string | null) => ({
  body: { [key]: rows, meta: { cursors: { before: null, after } } },
});

// ── identity, custody and the descriptor ────────────────────────────────────

describe("GoCardless — the profile the track actually dispatches", () => {
  it("is the profile restProfileFor('gocardless') returns, not a copy", () => {
    // Mutation: register a second GoCardless profile in `profiles.ts` and this
    // whole file starts testing a file nothing ships.
    expect(restProfileFor(GOCARDLESS_PROVIDER)).toBe(GOCARDLESS_PROFILE);
  });

  it("🔴 dials ONE static LIVE host, and it is the host the descriptor registers for egress", () => {
    // The API reference names two base hosts: live and sandbox. A sandbox token
    // authenticates only against the sandbox host, which this box never dials,
    // so the profile has exactly one origin and no region, no account subdomain.
    // Mutation: point the origin at the sandbox host, or change the descriptor's
    // `egressHosts` -> red.
    expect(GOCARDLESS_PROFILE.baseUrl).toEqual({ kind: "static", origin: GOCARDLESS_API_ORIGIN });
    expect(GOCARDLESS_API_ORIGIN).toBe("https://api.gocardless.com");
    expect(providerDescriptor(GOCARDLESS_PROVIDER)!.egressHosts).toEqual(["api.gocardless.com"]);
  });

  it("🔴 has its OWN egress entry, which registers the live host and NEVER the sandbox one", () => {
    // The static scanner is the first line, and this pins the registration's
    // content: kind, service, data class, ticket, and the code_refs the BACKING
    // pass reads. The sandbox host and the dashboard hosts are never dialled, so
    // they are never registered.
    // Mutation: delete the `gocardless-api` entry from allowed-egress.yaml, or add
    // the sandbox host to its `hosts` -> red.
    const yaml = readRepoFile("docs", "security", "allowed-egress.yaml");
    const start = yaml.indexOf("  - id: gocardless-api\n");
    expect(start, "an entry with id gocardless-api").toBeGreaterThan(-1);
    const entry = yaml.slice(start, yaml.indexOf("\n  - id: ", start + 1));
    expect(entry).toContain("kind: egress");
    expect(entry).toContain("service: erp-connector");
    expect(entry).toContain("hosts: [api.gocardless.com]");
    expect(entry).not.toContain("api-sandbox");
    expect(entry).toContain("data_class: user-content-on-request");
    expect(entry).toContain("ticket: WARP-3697");
    expect(entry).toContain("code_refs: [services/erp-connector/src/rest/vendors/gocardless.ts]");
  });

  it("🔴 serves EXACTLY the datasets the descriptor advertises — `charge`, `refund` and `payout`", () => {
    // The descriptor is what the hub, the scheduler (`entityServedBy`) and the
    // dashboard read; the profile is what the connector reads. A drift between
    // them is a hub tile offering a dataset the connection will refuse the first
    // time it is asked. Compared as SETS: ordering carries no meaning.
    const served = GOCARDLESS_PROFILE.datasets.map((d) => d.dataset);
    expect([...served].sort()).toEqual([...providerDescriptor(GOCARDLESS_PROVIDER)!.datasets].sort());
    expect(served).toEqual(["charge", "refund", "payout"]);
  });

  it("🔴 declares NO credential-field pattern — the token prefix is not on an official page", () => {
    // The `live_` / `sandbox_` prefixes are community-reported only (UNVERIFIED).
    // A regex anchored on an undocumented shape is the Brevo / Square / Cal.com
    // false rejection: it blocks a paying merchant at the paste box for zero
    // security gain. What narrows the token is its SCOPE, chosen at creation, not
    // its shape; and the proof a token is real is GoCardless answering the probe.
    // Mutation: add `pattern: "^live_"` -> red.
    const fields = providerDescriptor(GOCARDLESS_PROVIDER)!.credentialFields;
    expect(fields.map((f) => f.name)).toEqual(["accessToken"]);
    for (const field of fields) expect(field.pattern).toBeUndefined();
    expect(fields[0]!.secret).toBe(true);
    expect(fields[0]!.required).toBe(true);
    expect(fields[0]!.storage).toBe("encrypted");
  });

  it("names its credential placeholder EXACTLY as the descriptor names the field", () => {
    // These two are wired together at runtime by nothing but this string: the
    // orchestrator stores the field under the descriptor's name, the connector
    // looks it up by the template's placeholder. Rename either alone and every
    // GoCardless connection refuses with "the stored credential has no
    // accessToken" — at first read, on a schedule, where nobody is watching.
    expect(authPlaceholders(GOCARDLESS_PROFILE.auth)).toEqual(["accessToken"]);
    expect(providerDescriptor(GOCARDLESS_PROVIDER)!.credentialFields.map((f) => f.name)).toEqual(
      authPlaceholders(GOCARDLESS_PROFILE.auth),
    );
  });

  it("🔴 tells the owner the click-path, asks for the read-only scope, and names NO host", () => {
    // ADR-042 model 3: the owner mints the token in their own dashboard, so the
    // help text IS the click-path. The read-only scope is the one control the
    // owner has (the token is bounded by scope, not by shape), so the help must
    // ask for it; and it must say the live dashboard, not the sandbox. No host
    // literal: the egress scanner reads descriptor strings.
    // Mutation: drop the read-only advice, or paste a dashboard URL into the help
    // -> red.
    const help = providerDescriptor(GOCARDLESS_PROVIDER)!.credentialFields[0]!.help ?? "";
    for (const step of ["Developers", "API settings", "Create", "Access token", "read-only", "admin"]) {
      expect(help, step).toContain(step);
    }
    expect(help).toMatch(/live/i);
    expect(help).not.toMatch(/https?:\/\//i);
    expect(help).not.toMatch(/\.(com|net|org|io)\b/i);
  });

  it("is a Payments card in hub slot 19, on the REST track, with its guide", () => {
    // `catalog.order` is the hub sequence AND the order `cloudRowForDataset`
    // resolves a dataset's provider by (WARP-2833); 19 sits after Loyverse's 17
    // and Keap's 18 and is pinned so a renumbering is a deliberate act.
    // Mutation: change the order or the guide href -> red.
    const d = providerDescriptor(GOCARDLESS_PROVIDER)!;
    expect(d.track).toBe("rest");
    expect(d.category).toBe("Payments");
    expect(d.catalog?.order).toBe(19);
    expect(d.catalog?.availability).toBe("available");
    expect(d.catalog?.setupGuideHref).toBe("/help/connectors/gocardless");
  });

  it("🔴 paces at the LOWER of GoCardless's two published figures, and the descriptor says the same thing twice", async () => {
    // GoCardless's limits page contradicts itself: the table says 1,600 requests
    // a minute, the header example says `ratelimit-limit: 1000`, and a note says
    // to "think of 1,000 requests/minute as a performance target". The profile
    // paces at the LOWER figure — ceil(60,000 / 1,000) = 60 ms — because pacing
    // at the higher one risks a 429 on the figure the docs themselves hedge.
    // Mutation: pace at 1,600 a minute (38 ms) -> red.
    const rateLimit = providerDescriptor(GOCARDLESS_PROVIDER)!.rateLimit!;
    expect(rateLimit).toEqual({ callCeiling: 1_000, periodMs: 60_000 });
    expect(rateLimit.periodMs / rateLimit.callCeiling).toBe(GOCARDLESS_MIN_REQUEST_INTERVAL_MS);
    expect(GOCARDLESS_PROFILE.minRequestIntervalMs).toBe(60);

    // And it is a WAIT between requests, not a refusal.
    const { connector, slept } = connectorWith([page("payments", [PAYMENT], "PM456"), page("payments", [], null)]);
    await connector.runRead("get_recent_charges", { since: SINCE });
    expect(slept).toEqual([GOCARDLESS_MIN_REQUEST_INTERVAL_MS]);
  });
});

// ── the headers that actually leave the box ─────────────────────────────────

describe("GoCardless — auth and the version header, read off the wire", () => {
  it("sends Authorization: Bearer <token> — the literal name and the literal template", async () => {
    // making-requests: `Authorization: Bearer ...`. A genuine RFC-6750 Bearer
    // scheme — pinned because most of the shapes on ADR-046 §2's table are NOT
    // this one.
    // Mutation: spell it `X-Api-Key`, or drop the `Bearer ` prefix -> red.
    const { connector, calls } = connectorWith([page("payments", [], null)]);
    await connector.runRead("get_recent_charges", {});

    expect(GOCARDLESS_PROFILE.auth).toEqual({
      headerName: "Authorization",
      valueTemplate: "Bearer {{accessToken}}",
    });
    expect(headersOf(calls[0]!.init).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("🔴 sends GoCardless-Version: 2015-07-06 on EVERY request, and nothing else beyond accept", async () => {
    // making-requests lists the version header as required, "Current version"
    // 2015-07-06. It is a CONSTANT header: the profile carries it for every
    // request including the probe. The whole header set is asserted, so an
    // invented header (a User-Agent, an API-key spelling) goes red too.
    // Mutation: drop `GoCardless-Version`, or add a second constant header -> red.
    const { connector, calls } = connectorWith([page("payments", [PAYMENT], null)]);
    await connector.connect();
    await connector.runRead("get_recent_charges", {});

    expect(GOCARDLESS_API_VERSION).toBe("2015-07-06");
    expect(GOCARDLESS_PROFILE.constantHeaders).toEqual({ "GoCardless-Version": "2015-07-06" });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(Object.keys(headersOf(call.init)).sort()).toEqual(["Authorization", "GoCardless-Version", "accept"]);
      expect(headersOf(call.init)["GoCardless-Version"]).toBe("2015-07-06");
      expect(headersOf(call.init).accept).toBe("application/json");
    }
  });

  it("probes GET /creditors?limit=1 on BOTH connect() and health()", async () => {
    // 🔴 Resolving the credential locally is not a connection: a token an admin
    // disabled resolves perfectly and fails on the first scheduled read, hours
    // later. GoCardless's creditors list is the cheapest authenticated read —
    // the spec records "your organisation will have a single creditor" — and a
    // 401 on it is about the TOKEN. (Whether a READ-ONLY token may call it is
    // UNVERIFIED; the UNVERIFIED block below pins the fallback.)
    // Mutation: point probePath at `/payments?limit=500` -> the health check
    // pages the merchant's collections every time.
    const { connector, calls } = connectorWith([{ body: { creditors: [{ id: "CR123" }] } }]);
    await connector.connect();
    await connector.health();

    expect(GOCARDLESS_PROFILE.probePath).toBe("/creditors?limit=1");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.gocardless.com/creditors?limit=1",
      "https://api.gocardless.com/creditors?limit=1",
    ]);
  });
});

// ── payments → charge ───────────────────────────────────────────────────────

describe("GoCardless charge — GET /payments", () => {
  it("🔴 sends created_at[gte] as the watermark — the bracketed key, the ISO form, the constant limit", async () => {
    const { connector, calls } = connectorWith([page("payments", [PAYMENT], null)]);
    await connector.runRead("get_recent_charges", { since: SINCE });

    const first = new URL(calls[0]!.url);
    expect(first.host).toBe("api.gocardless.com");
    expect(first.pathname).toBe("/payments");

    // The watermark. The payment reference carries a `created_at` filter object
    // with `gt`, `gte`, `lt` and `lte`; `gte` is "created on or after". On the
    // wire a nested filter object is the BRACKETED key — the official Node SDK
    // serialises it with `qs.stringify`. `formatWatermark("iso")` is the
    // `2026-09-01T00:00:00.000Z` shape the docs' own timestamps use.
    // 🔴 A misspelling does not 4xx; it reads the whole history and reports an
    // incremental read.
    // Mutation: spell it `created_at_gte`, `created_after` or `since` -> red.
    expect(first.searchParams.get("created_at[gte]")).toBe(SINCE_ISO);
    expect(formatWatermark(SINCE, "iso")).toBe(SINCE_ISO);
    expect(queryKeys(calls[0]!.url)).toEqual(["created_at[gte]", "limit"]);

    // The page size: "Default 50, max 500, min 1". The maximum, because an
    // on-demand read has no watermark and is paid in pages. A constant query
    // parameter — the `cursor` arm has no page-size slot.
    // Mutation: set `limit: "1000"` -> red, and GoCardless would reject it.
    expect(first.searchParams.get("limit")).toBe("500");
    expect(GOCARDLESS_PAGE_LIMIT).toBe("500");
  });

  it("🔴 sends NO date parameter on a plain read — the first read is unbounded, and says so", async () => {
    // B10 (h): the first read of a connection has no watermark, so the history
    // pull is unbounded by date. Fine at 500 rows a page; the guide says so. What
    // must NOT happen is a guessed lower bound riding on every read.
    // Mutation: add a constant `created_at[gte]` "to cap the history" -> red.
    const { connector, calls } = connectorWith([page("payments", [PAYMENT], null)]);
    await connector.runRead("get_recent_charges", {});
    expect(queryKeys(calls[0]!.url)).toEqual(["limit"]);
  });

  it("🔴 follows meta.cursors.after on the `after` parameter, keeping limit AND the watermark; null stops", async () => {
    // data-conventions: pass the `after` cursor back until the array is empty or
    // shorter than the limit. The cursor arm echoes every other parameter on the
    // follow-up, so `limit` and the watermark ride on page two — dropping the
    // watermark mid-walk would widen the read to the whole history.
    // Mutation: page on `before`, or drop the cursor echo -> red.
    const { connector, calls } = connectorWith([
      page("payments", [{ ...PAYMENT, id: "PM1" }], "PM456"),
      page("payments", [{ ...PAYMENT, id: "PM2" }], null),
    ]);
    const rows = rowsOf(await connector.runRead("get_recent_charges", { since: SINCE }));

    expect(calls).toHaveLength(2);
    const second = new URL(calls[1]!.url);
    expect(second.searchParams.get("after")).toBe("PM456");
    expect(second.searchParams.get("limit")).toBe("500");
    expect(second.searchParams.get("created_at[gte]")).toBe(SINCE_ISO);
    expect(rows.map((r) => r.charge_id)).toEqual(["PM1", "PM2"]);
  });

  it("declares the cursor path, the rows key and an INCOMPLETE creation-time watermark", () => {
    // `complete: false` is honest: the filter is on CREATION, and a payment moves
    // pending -> confirmed -> paid_out after it is created, so an incremental pass
    // never sees the move. It is permitted only because none of the three is in
    // `ERP_SYNC_ENTITIES` (the descriptor test's `unscheduled` pin) — the day
    // `RestWatermark.complete` has a reader, these are the datasets it is for.
    // Mutation: flip it to `true` "so it can be scheduled" -> red.
    const charge = GOCARDLESS_PROFILE.datasets.find((d) => d.dataset === "charge")!;
    expect(charge.path).toBe("/payments");
    expect(charge.query).toEqual({ limit: "500" });
    expect(charge.watermark).toEqual({ name: "created_at[gte]", location: "query", format: "iso", complete: false });
    expect(charge.pagination).toEqual({ kind: "cursor", nextCursorPath: "meta.cursors.after", cursorParam: "after" });
    expect(charge.rowsPath).toBe("payments");
  });

  it("🔴 converts MINOR UNITS against the row's own currency — 100 pence is 1.00, 1250 yen is 1250", async () => {
    // `amount` and `amount_refunded` are integers "in lowest denomination". The
    // eight currencies GoCardless carries are all exponent 2, but the transform
    // reads the ROW'S currency anyway: a blanket /100 is wrong the day a currency
    // with another exponent appears. JPY is not a GoCardless currency — it is
    // here to prove the exponent comes from the row, not from a constant.
    // Mutation: divide by 100 blindly -> the JPY row goes red.
    const { connector } = connectorWith([
      page(
        "payments",
        [
          { ...PAYMENT, id: "PM_gbp", amount: 100, amount_refunded: 40, currency: "GBP" },
          { ...PAYMENT, id: "PM_jpy", amount: 1250, amount_refunded: 250, currency: "JPY" },
        ],
        null,
      ),
    ]);
    const rows = rowsOf(await connector.runRead("get_recent_charges", {}));
    const gbp = rows.find((r) => r.charge_id === "PM_gbp")!;
    const jpy = rows.find((r) => r.charge_id === "PM_jpy")!;
    expect([gbp.amount, gbp.amount_refunded, gbp.currency]).toEqual([1, 0.4, "GBP"]);
    expect([jpy.amount, jpy.amount_refunded, jpy.currency]).toEqual([1250, 250, "JPY"]);
  });

  it("🔴 projects the documented payment onto the expected row — and leaves customer_id and updated_at UNDEFINED", async () => {
    // The documented payment's `links` are `mandate` and `creditor`; no customer
    // link is shown, and none of the three datasets carries a modification time.
    // `customer_id` is NOT filled from `links.mandate`: a mandate id in a
    // customer column joins to nothing and reads as a customer.
    // Mutation: map `customer_id: "links.mandate"` or `updated_at: "created_at"`
    // -> red.
    const { connector } = connectorWith([page("payments", [PAYMENT], null)]);
    const row = rowsOf(await connector.runRead("get_recent_charges", {}))[0]!;
    expect(row).toEqual({
      charge_id: "PM123",
      created_at: "2014-05-08T17:01:06.000Z",
      customer_id: undefined,
      amount: 1,
      amount_refunded: 0,
      currency: "GBP",
      status: "pending_submission",
      updated_at: undefined,
    });
    expect("customer_id" in row).toBe(true);
    expect("updated_at" in row).toBe(true);
  });

  it("🔴 reads `payments`, not whatever else the body carries — a wrong rowsPath is a loud failure", async () => {
    // Decoy: a `refunds` key beside the real one. A profile reading the wrong key
    // would return the decoy. And `absentRowsMeansEmpty` stays UNSET, so a body
    // with no `payments` array at all is a contract error, never "no payments".
    // Mutation: set `rowsPath: "refunds"` or `absentRowsMeansEmpty: true` -> red.
    const charge = GOCARDLESS_PROFILE.datasets.find((d) => d.dataset === "charge")!;
    expect(charge.absentRowsMeansEmpty).toBeUndefined();

    const { connector } = connectorWith([
      { body: { payments: [PAYMENT], refunds: [{ id: "decoy" }], meta: { cursors: { after: null } } } },
    ]);
    expect(rowsOf(await connector.runRead("get_recent_charges", {})).map((r) => r.charge_id)).toEqual(["PM123"]);

    const missing = connectorWith([{ body: { meta: { cursors: { after: null } } } }]);
    await expect(missing.connector.runRead("get_recent_charges", {})).rejects.toThrow(RestPaginationContractError);
  });
});

// ── refunds → refund ────────────────────────────────────────────────────────

describe("GoCardless refund — GET /refunds", () => {
  it("🔴 reads /refunds with the same watermark spelling, the same limit and the same cursor", async () => {
    const { connector, calls } = connectorWith([
      page("refunds", [{ ...REFUND, id: "RF1" }], "RF456"),
      page("refunds", [{ ...REFUND, id: "RF2" }], null),
    ]);
    const rows = rowsOf(await connector.runRead("get_refunds", { since: SINCE }));

    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/refunds");
    expect(first.searchParams.get("created_at[gte]")).toBe(SINCE_ISO);
    expect(first.searchParams.get("limit")).toBe("500");
    const second = new URL(calls[1]!.url);
    expect(second.searchParams.get("after")).toBe("RF456");
    expect(second.searchParams.get("created_at[gte]")).toBe(SINCE_ISO);
    expect(rows.map((r) => r.refund_id)).toEqual(["RF1", "RF2"]);
  });

  it("🔴 takes charge_id from `links.payment`, and leaves reason and updated_at UNDEFINED", async () => {
    // The refund's `links.payment` is the payment it returns money from, which is
    // exactly what `charge_id` means. `reason` is only free text under
    // `metadata.reason` in GoCardless's example — not a field — so it is not
    // mapped; and there is no modification time.
    // Mutation: map `reason: "metadata.reason"` or `charge_id: "id"` -> red.
    const { connector } = connectorWith([page("refunds", [REFUND], null)]);
    const row = rowsOf(await connector.runRead("get_refunds", {}))[0]!;
    expect(row).toEqual({
      refund_id: "RF123",
      created_at: "2014-05-09T10:00:00.000Z",
      charge_id: "PM123",
      amount: 1,
      currency: "GBP",
      status: "created",
      reason: undefined,
      updated_at: undefined,
    });
  });

  it("declares an INCOMPLETE creation-time watermark and the `refunds` rows key", () => {
    // Mutation: flip `complete` or change the key -> red.
    const refund = GOCARDLESS_PROFILE.datasets.find((d) => d.dataset === "refund")!;
    expect(refund.path).toBe("/refunds");
    expect(refund.watermark).toEqual({ name: "created_at[gte]", location: "query", format: "iso", complete: false });
    expect(refund.rowsPath).toBe("refunds");
  });
});

// ── payouts → payout ────────────────────────────────────────────────────────

describe("GoCardless payout — GET /payouts", () => {
  it("🔴 reads /payouts with the same watermark spelling, limit and cursor", async () => {
    const { connector, calls } = connectorWith([
      page("payouts", [{ ...PAYOUT, id: "PO1" }], "PO456"),
      page("payouts", [{ ...PAYOUT, id: "PO2" }], null),
    ]);
    const rows = rowsOf(await connector.runRead("get_payouts", { since: SINCE }));
    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/payouts");
    expect(first.searchParams.get("created_at[gte]")).toBe(SINCE_ISO);
    expect(first.searchParams.get("limit")).toBe("500");
    expect(new URL(calls[1]!.url).searchParams.get("after")).toBe("PO456");
    expect(rows.map((r) => r.payout_id)).toEqual(["PO1", "PO2"]);
  });

  it("🔴 widens arrival_date (a calendar date) to UTC midnight, and leaves updated_at UNDEFINED", async () => {
    // `arrival_date` is `YYYY-MM-DD`, in a column `COLUMN_KIND` calls a
    // timestamp: widened explicitly rather than passed through for every
    // downstream `Date.parse` to guess a timezone for.
    // Mutation: map `arrival_at: "arrival_date"` with no transform -> the
    // instant is the bare date and this goes red.
    const { connector } = connectorWith([page("payouts", [PAYOUT], null)]);
    const row = rowsOf(await connector.runRead("get_payouts", {}))[0]!;
    expect(row).toEqual({
      payout_id: "PO123",
      created_at: "2014-06-25T09:30:00.000Z",
      arrival_at: "2014-06-27T00:00:00.000Z",
      amount: 10,
      currency: "GBP",
      status: "pending",
      updated_at: undefined,
    });
  });

  it("declares an INCOMPLETE creation-time watermark and the `payouts` rows key", () => {
    const payout = GOCARDLESS_PROFILE.datasets.find((d) => d.dataset === "payout")!;
    expect(payout.path).toBe("/payouts");
    expect(payout.watermark).toEqual({ name: "created_at[gte]", location: "query", format: "iso", complete: false });
    expect(payout.rowsPath).toBe("payouts");
  });
});

// ── the vocabulary join ─────────────────────────────────────────────────────

describe("GoCardless — the profile ↔ vocabulary join", () => {
  it("maps ONLY canonical columns, and every REQUIRED one, for all three datasets", () => {
    // `rest-track.test.ts` runs this over every shipped profile; this pins which
    // columns GoCardless fills and which it honestly leaves out.
    const expected: Record<string, string[]> = {
      charge: ["charge_id", "created_at", "amount", "amount_refunded", "currency", "status"],
      refund: ["refund_id", "created_at", "charge_id", "amount", "currency", "status"],
      payout: ["payout_id", "created_at", "arrival_at", "amount", "currency", "status"],
    };
    for (const spec of GOCARDLESS_PROFILE.datasets) {
      expect(Object.keys(spec.fieldMap).sort(), spec.dataset).toEqual([...expected[spec.dataset]!].sort());
      for (const column of Object.keys(spec.fieldMap)) {
        expect(CANONICAL_COLUMNS[spec.dataset], `${spec.dataset}.${column}`).toContain(column);
      }
    }
  });

  it("orders each dataset the way its read semantics document — oldest first by created_at", async () => {
    // `get_recent_charges` windows and orders on `created_at`; GoCardless's own
    // page order (newest first) is NOT preserved.
    const { connector } = connectorWith([
      page(
        "payments",
        [
          { ...PAYMENT, id: "PM_new", created_at: "2014-06-01T00:00:00.000Z" },
          { ...PAYMENT, id: "PM_old", created_at: "2014-05-01T00:00:00.000Z" },
        ],
        null,
      ),
    ]);
    expect(rowsOf(await connector.runRead("get_recent_charges", {})).map((r) => r.charge_id)).toEqual(["PM_old", "PM_new"]);
  });
});

// ── what is NOT verified, pinned as such ────────────────────────────────────

/**
 * 🔴 The UNVERIFIED register (research spec §7 and §3.2 B10). Nothing here is a
 * vendor fact. Each test records the profile's DECLARED POSTURE and says in its
 * title that GoCardless has not confirmed it, so that the day a live token
 * settles an item, this is the test to change — and so that nobody reads a
 * green test as a verified claim.
 */
describe("GoCardless — UNVERIFIED items, pinned as UNVERIFIED", () => {
  it("UNVERIFIED — whether a READ-ONLY token may call GET /creditors; the fallback probe is /payments?limit=1", () => {
    // The probe is `/creditors?limit=1`. No page read says a read-only token can
    // call it. If a live read-only token is refused there, the one-line change is
    // `probePath: "/payments?limit=1"` — at the cost of a payments page as the
    // health check. Pinned so that change is a deliberate edit to this test.
    expect(GOCARDLESS_PROFILE.probePath).toBe("/creditors?limit=1");
  });

  it("UNVERIFIED — whether GoCardless accepts the PERCENT-ENCODED bracket form the connector emits", async () => {
    // The connector builds the query through `URLSearchParams`, so the key leaves
    // as `created_at%5Bgte%5D=`. The official Node SDK sends the brackets RAW
    // (`encode: false`). A standards-compliant server decodes both; one live call
    // would settle it. Pinned as the wire form the box ACTUALLY sends.
    const { connector, calls } = connectorWith([page("payments", [], null)]);
    await connector.runRead("get_recent_charges", { since: SINCE });
    expect(calls[0]!.url).toContain("created_at%5Bgte%5D=2026-09-01T00%3A00%3A00.000Z");
  });

  it("UNVERIFIED — that the last NON-EMPTY page returns `after: null`; the walk is correct either way", async () => {
    // data-conventions says to keep passing `after` until the array is empty or
    // shorter than the limit. Whether the last non-empty page already carries
    // `after: null` is not shown. Shape A stops on it; shape B costs exactly ONE
    // extra request returning an empty array with `after: null`. Both end, and
    // neither is silent.
    const shapeA = connectorWith([page("payments", [PAYMENT], null)]);
    await shapeA.connector.runRead("get_recent_charges", {});
    expect(shapeA.calls).toHaveLength(1);

    const shapeB = connectorWith([page("payments", [PAYMENT], "PM456"), page("payments", [], null)]);
    const rows = await shapeB.connector.runRead("get_recent_charges", {});
    expect(shapeB.calls).toHaveLength(2);
    expect(rows).toHaveLength(1);
  });

  it("UNVERIFIED — that a payment NEVER carries a customer link; customer_id stays unmapped", () => {
    // The documented `links` are `mandate` and `creditor`. A customer link is
    // not shown, and nobody has seen every payment shape. Until one does,
    // `customer_id` is absent from the map rather than guessed from `mandate`.
    const charge = GOCARDLESS_PROFILE.datasets.find((d) => d.dataset === "charge")!;
    expect("customer_id" in charge.fieldMap).toBe(false);
  });

  it("UNVERIFIED — the empty-list envelope; a body with no rows array is a contract error", async () => {
    // No page read shows what GoCardless sends for a list with nothing in it.
    // `absentRowsMeansEmpty` is therefore left unset, so a wrong rowsPath fails
    // loudly instead of reading as "no collections this month".
    const { connector } = connectorWith([{ body: { meta: { cursors: { after: null } } } }]);
    await expect(connector.runRead("get_payouts", {})).rejects.toThrow(RestPaginationContractError);
  });

  it("UNVERIFIED — a 429 carries `ratelimit-reset` (an HTTP-date) and NO Retry-After, so retryAfter is undefined", async () => {
    // limits.md documents `ratelimit-limit`, `-remaining` and `-reset`, the last
    // an HTTP-date, and no `Retry-After`. `RestRateLimitedError.retryAfter` reads
    // only `Retry-After`, so it is undefined here and the sync's generic backoff
    // applies; the 60 ms pacing is what prevents the 429 in the first place.
    // Not observed live.
    const { connector } = connectorWith([
      {
        body: {},
        status: 429,
        headers: {
          "ratelimit-limit": "1000",
          "ratelimit-remaining": "0",
          "ratelimit-reset": "Sat, 04 Oct 2026 12:00:00 GMT",
        },
      },
    ]);
    const err = (await connector.runRead("get_recent_charges", {}).catch((e: unknown) => e)) as RestRateLimitedError;
    expect(err).toBeInstanceOf(RestRateLimitedError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBeUndefined();
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * 🔴 ADR-046 §3 and `rest-track.test.ts`'s own header state the rule: **a
 * refusal asserts `fetch` was called ZERO times**, never merely that an error
 * was thrown. A test that inspected only the returned error would still pass if
 * the request had already gone out carrying the merchant's token.
 */
describe("GoCardless — the refusals, each costing ZERO fetch calls", () => {
  /** The real profile with a resolver that yields exactly what is passed. */
  function connectorWithCredentials(creds: Record<string, string>) {
    const { impl, calls } = stubFetch([page("payments", [], null)]);
    const connector = new RestProfileConnector(
      GOCARDLESS_PROFILE,
      { provider: GOCARDLESS_PROVIDER },
      { fetchImpl: impl, resolveCredentials: async () => creds },
    );
    return { connector, calls };
  }

  it("🔴 refuses a read when the stored credential has no accessToken — ZERO fetch calls", async () => {
    // Sending the literal `{{accessToken}}` would land in GoCardless's logs as a
    // failed auth nobody can explain.
    // Mutation: fall back to "" instead of refusing an empty placeholder -> the
    // request goes out and the call count goes to 1.
    const { connector, calls } = connectorWithCredentials({});
    await expect(connector.runRead("get_recent_charges", {})).rejects.toThrow(/has no "accessToken"/);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a blank token as firmly as a missing one — ZERO fetch calls", async () => {
    const { connector, calls } = connectorWithCredentials({ accessToken: "\t \n" });
    await expect(connector.connect()).rejects.toThrow(/has no "accessToken"/);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses the datasets GoCardless could serve and this profile does not — ZERO fetch calls", async () => {
    // `subscription` (an interval COUNT plus an interval UNIT cannot be one
    // `interval` column, and a quarterly plan would read as monthly), `customer`
    // (payer PII with no join to payments), `balance_transaction` (no list
    // resource on the pages read). Refused by NAME: `[]` would be a confident
    // false statement about a merchant's money.
    // Mutation: make `runRead` fall through to an empty array -> red.
    for (const name of ["get_subscriptions_by_status", "find_customer", "get_processing_fees", "get_open_invoices"]) {
      const { connector, calls } = connectorWithCredentials({ accessToken: ACCESS_TOKEN });
      await expect(connector.runRead(name, { since: SINCE }), name).rejects.toThrow(DatasetNotServedError);
      expect(calls, name).toHaveLength(0);
    }
  });

  it("🔴 refuses every write, and spends no call finding out — the track is read-only", async () => {
    // GoCardless has a full write API (payments, mandates, subscriptions). The
    // refusal is the track's, not the vendor's, and it costs no request.
    const { connector, calls } = connectorWithCredentials({ accessToken: ACCESS_TOKEN });
    await expect(connector.applyWrite("reschedule_appointment", {})).rejects.toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses to build against a provider id that is not GoCardless's — ZERO fetch calls", async () => {
    const { impl, calls } = stubFetch([page("payments", [], null)]);
    expect(
      () =>
        new RestProfileConnector(
          GOCARDLESS_PROFILE,
          { provider: "gocardless-sandbox" },
          { fetchImpl: impl, resolveCredentials: async () => ({ accessToken: ACCESS_TOKEN }) },
        ),
    ).toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a 302 rather than following it off api.gocardless.com", async () => {
    // `fetch` defaults to following redirects, so without `redirect: "error"` the
    // guard would be checking a URL while the answer chose the destination, with
    // the merchant's token attached. EXACTLY ONE call: the redirect was not
    // followed.
    const { connector, calls } = connectorWith([
      { body: {}, status: 302, headers: { location: "https://evil.example.net/payments" } },
    ]);
    await expect(connector.runRead("get_recent_charges", {})).rejects.toThrow(UnsafeBaseUrlError);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("api.gocardless.com");
  });
});
