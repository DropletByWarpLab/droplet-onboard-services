/**
 * WARP-3698 / ADR-046 — Capsule CRM's VENDOR FACTS, pinned against Capsule's own
 * documentation.
 *
 * ## Why this file is mandatory rather than nice to have
 *
 * ADR-046's Consequences section: *"A declarative profile is easier to get wrong
 * quietly than code is. A wrong watermark parameter is one string. Mitigation:
 * the parameter names are pinned by tests that cite the vendor page, exactly as
 * `graph-resources.test.ts` does for Microsoft Graph."* This is that file for
 * Capsule. `rest-track.test.ts` proves the connector does what a profile SAYS —
 * which is exactly the question that stays green when the profile says the wrong
 * thing — and `introspect()`'s fingerprint hashes the datasets and their
 * canonical columns, not the paths, headers or parameter spellings. Only this
 * file can catch those.
 *
 * Capsule's version of the silent failure is the TASK default. `GET /tasks`
 * returns ONLY OPEN TASKS unless asked otherwise ("By default the body will
 * contain only the open tasks"), so a profile that simply listed `/tasks` would
 * read a feed with no completed work in it, on every tick, and look healthy. The
 * constant `status=open,completed,pending` is what makes `closed_at` and the
 * COMPLETED rows exist at all, and this file pins it.
 *
 * ## The sources every claim below was checked against (2026-10-04)
 *
 *  • [src: https://developer.capsulecrm.com/v2/overview/reading-from-the-api,
 *    accessed 2026-10-04] — the base `https://api.capsulecrm.com/api/v2`, page
 *    numbering 1-based, `perPage` 1-100, "pagination info is included in the
 *    Link header. It is recommended to follow these Link header values instead of
 *    constructing your own URLs", ISO 8601 UTC `2015-09-15T10:43:23Z`.
 *  • [src: https://developer.capsulecrm.com/v2/operations/Opportunity, accessed
 *    2026-10-04] — `GET /opportunities`, the `since` parameter ("includes only
 *    entities that have been changed after this date", ISO 8601), the documented
 *    example row.
 *  • [src: https://developer.capsulecrm.com/v2/operations/Task and
 *    /v2/models/task, accessed 2026-10-04] — `GET /tasks`, the `status` parameter
 *    ("comma separated list ... `open`, `completed` and `pending`"), the status
 *    enum `OPEN | COMPLETED | PENDING`, the field list, the documented example.
 *  • [src: https://developer.capsulecrm.com/v2/models/opportunity, accessed
 *    2026-10-04] — `milestone`, `value`, `closedOn`, `party`.
 *  • [src: https://developer.capsulecrm.com/v2/operations/User, accessed
 *    2026-10-04] — `GET /users/current`, "the user who approved your
 *    application", the probe.
 *  • [src: https://developer.capsulecrm.com/v2/overview/authentication, accessed
 *    2026-10-04] — `Authorization: Bearer {token}`; the scopes `read`, `read
 *    write`, `read write user_preference`.
 *  • [src: https://developer.capsulecrm.com/v2/overview/handling-api-responses,
 *    accessed 2026-10-04] — 401 invalid token; 403 "read-only token or non-admin
 *    user"; "4,000 requests per hour when using Bearer Token Authentication";
 *    `X-RateLimit-Limit/-Remaining/-Reset`; 429 `{"error":"rate limit
 *    reached"}`; the suggested "one-second delay".
 *  • [src: https://capsulecrm.com/support/integrations/how-to-integrate-with-capsule/,
 *    accessed 2026-10-04] — My Preferences -> API Authentication -> Generate new
 *    API token, and revoking from the same page.
 *  • [src: https://capsulecrm.com/blog/HighLevel-CRM-pricing/, accessed
 *    2026-10-04] — "API access included in every tier".
 *
 * ## 🔴 What this file does NOT claim — the UNVERIFIED register
 *
 * Nothing was signed up for and no Capsule endpoint was called. Every item in the
 * "UNVERIFIED" block at the bottom is pinned AS UNVERIFIED: the test records the
 * profile's declared posture and says, in its title, that the vendor has not
 * confirmed it.
 *
 * ## 🔴 The fixtures are the DOCUMENTED example rows
 *
 * `OPPORTUNITY` and `TASK` are the research spec's transcriptions of Capsule's
 * own examples, with the elided fields (`...`) left out. `kase` on the project
 * task, `completedAt` and the COMPLETED / PENDING rows are supplied by the test
 * author from the model page's field list, and each says so. The multi-page
 * fixtures are those rows with a `Link` header written by the test author. None
 * of it is a captured response body.
 *
 * Every test drives the REAL `CAPSULE_PROFILE` through the REAL
 * `RestProfileConnector` with an injected fetch, and every fact is asserted from
 * the OUTGOING request. Every test names the mutation that must turn it red.
 */
import { describe, expect, it } from "vitest";

import { providerDescriptor } from "@droplet/shared-types";

import {
  RestPaginationContractError,
  RestProfileConnector,
  RestRateLimitedError,
  UnsafeBaseUrlError,
} from "../src/rest/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { authPlaceholders } from "../src/rest/profile.js";
import { restProfileFor } from "../src/rest/profiles.js";
import {
  CAPSULE_API_ORIGIN,
  CAPSULE_MIN_REQUEST_INTERVAL_MS,
  CAPSULE_PAGE_SIZE,
  CAPSULE_PROFILE,
  CAPSULE_PROVIDER,
} from "../src/rest/vendors/capsule.js";
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
 * A personal access token's stand-in. Capsule documents NO format for one, so the
 * value is deliberately nothing in particular. It works because nothing validates
 * the shape, which is the property the descriptor test below pins.
 */
const TOKEN = "test-capsule-token";

/**
 * The REAL profile, through the REAL connector.
 *
 * The clock and `sleep` are injected because this profile paces at 900 ms
 * between requests: with the default `setTimeout` a multi-page read would make
 * the suite pay Capsule's rate ceiling.
 */
function connectorWith(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const { impl, calls } = stubFetch(pages);
  const slept: number[] = [];
  let clock = 0;
  const connector = new RestProfileConnector(
    CAPSULE_PROFILE,
    { provider: CAPSULE_PROVIDER },
    {
      fetchImpl: impl,
      resolveCredentials: async () => ({ token: TOKEN }),
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    },
  );
  return { connector, calls, slept };
}

/** The watermark instant a scheduled tick passes, and what it must appear as. */
const SINCE = "2026-09-01T00:00:00Z";
const SINCE_ISO = "2026-09-01T00:00:00.000Z";

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;
const rowsOf = (rows: unknown[]) => rows as Record<string, unknown>[];
const queryKeys = (url: string) => [...new URL(url).searchParams.keys()].sort();

/**
 * The documented opportunity, as the research spec transcribes it from the
 * `GET /opportunities` example (the `owner` object's other fields are elided
 * there and omitted here). Two facts are load-bearing: `party` is an
 * ORGANISATION here but may be a PERSON on another row — which is why
 * `company_id` is NOT mapped from `party.id` — and `milestone` carries the
 * pipeline stage.
 */
const OPPORTUNITY = {
  id: 12,
  updatedAt: "2015-10-29T12:55:12Z",
  owner: { id: 6 },
  party: { id: 581, type: "organisation", name: "Capsule" },
  lostReason: null,
  milestone: { id: 14, name: "Bid" },
  value: { amount: 500, currency: "GBP" },
  expectedCloseOn: "2015-10-31",
  probability: 50,
  closedOn: null,
  createdAt: "2015-10-29T12:55:12Z",
  name: "Consulting",
};

/** The documented task, from the `GET /tasks` example (other fields elided there). */
const TASK = {
  id: 493,
  description: "Send quarterly invoice",
  status: "OPEN",
  owner: { id: 1 },
  createdAt: "2015-10-26T14:37:52Z",
  updatedAt: "2015-10-26T14:37:52Z",
  dueOn: "2015-10-01",
};

/** Capsule's pagination header, in the documented shape, for page 2 of a path. */
const nextLink = (path: string) => ({
  link: `<https://api.capsulecrm.com/api/v2/${path}?page=2&perPage=100>; rel="next"`,
});

// ── identity, custody and the descriptor ────────────────────────────────────

describe("Capsule — the profile the track actually dispatches", () => {
  it("is the profile restProfileFor('capsule') returns, not a copy", () => {
    // Mutation: register a second Capsule profile in `profiles.ts` and this whole
    // file starts testing a file nothing ships.
    expect(restProfileFor(CAPSULE_PROVIDER)).toBe(CAPSULE_PROFILE);
  });

  it("🔴 dials ONE static host, and it is the host the descriptor registers for egress", () => {
    // Capsule's REST base is `https://api.capsulecrm.com/api/v2`: one host, no
    // region, no account subdomain. The `/api/v2` is a PATH, and
    // `assertValidRestProfile` refuses a path on a static origin, so the version
    // prefix rides on `probePath` and on every dataset `path`.
    // Mutation: put `/api/v2` on the origin -> module load throws; change the
    // descriptor's `egressHosts` -> red.
    expect(CAPSULE_PROFILE.baseUrl).toEqual({ kind: "static", origin: CAPSULE_API_ORIGIN });
    expect(CAPSULE_API_ORIGIN).toBe("https://api.capsulecrm.com");
    expect(providerDescriptor(CAPSULE_PROVIDER)!.egressHosts).toEqual(["api.capsulecrm.com"]);
    for (const spec of CAPSULE_PROFILE.datasets) {
      expect(spec.path, spec.dataset).toMatch(/^\/api\/v2\//);
    }
    expect(CAPSULE_PROFILE.probePath).toMatch(/^\/api\/v2\//);
  });

  it("🔴 has its OWN egress entry, plus a reference entry for each JSON path the scanner reads as a host", () => {
    // `milestone.name`, `owner.id` and `kase.id` each END in a real ICANN TLD
    // (`.name`, `.id`), so the WARP-2467 bare-host pass reads the whole string
    // literal in the field map as a destination. Each is registered as `kind:
    // reference`, which states the true fact: a path into a response body, never
    // a connection the box makes. The api host itself is a plain `kind: egress`.
    // Mutation: delete any of the four entries from allowed-egress.yaml -> red.
    const yaml = readRepoFile("docs", "security", "allowed-egress.yaml");
    const block = (id: string) => {
      const start = yaml.indexOf(`  - id: ${id}\n`);
      expect(start, `an entry with id ${id}`).toBeGreaterThan(-1);
      return yaml.slice(start, yaml.indexOf("\n  - id: ", start + 1));
    };

    const api = block("capsule-api");
    expect(api).toContain("kind: egress");
    expect(api).toContain("service: erp-connector");
    expect(api).toContain("hosts: [api.capsulecrm.com]");
    expect(api).toContain("data_class: user-content-on-request");
    expect(api).toContain("ticket: WARP-3698");
    expect(api).toContain("code_refs: [services/erp-connector/src/rest/vendors/capsule.ts]");

    for (const [id, host] of [
      ["ref-capsule-milestone-name-path", "milestone.name"],
      ["ref-capsule-owner-id-path", "owner.id"],
      ["ref-capsule-kase-id-path", "kase.id"],
    ] as const) {
      const ref = block(id);
      expect(ref, id).toContain("kind: reference");
      expect(ref, id).toContain(`hosts: [${host}]`);
      expect(ref, id).toContain("ticket: WARP-3698");
      expect(ref, id).toContain("code_refs: [services/erp-connector/src/rest/vendors/capsule.ts]");
    }
  });

  it("🔴 serves EXACTLY the datasets the descriptor advertises — `deal` and `task`", () => {
    // Compared as SETS: ordering carries no meaning. `contact` and `company` are
    // deliberately NOT served — see the block below.
    const served = CAPSULE_PROFILE.datasets.map((d) => d.dataset);
    expect([...served].sort()).toEqual([...providerDescriptor(CAPSULE_PROVIDER)!.datasets].sort());
    expect(served).toEqual(["deal", "task"]);
  });

  it("🔴 declares NO credential-field pattern — Capsule documents no token format", () => {
    // The authentication page shows how a personal token is generated and sent;
    // it states nothing about the token's length or alphabet. A regex anchored on
    // an undocumented shape is the Brevo / Square / Cal.com false rejection.
    // Mutation: add any `pattern` -> red.
    const fields = providerDescriptor(CAPSULE_PROVIDER)!.credentialFields;
    expect(fields.map((f) => f.name)).toEqual(["token"]);
    for (const field of fields) expect(field.pattern).toBeUndefined();
    expect(fields[0]!.secret).toBe(true);
    expect(fields[0]!.required).toBe(true);
    expect(fields[0]!.storage).toBe("encrypted");
  });

  it("names its credential placeholder EXACTLY as the descriptor names the field", () => {
    // Rename either alone and every Capsule connection refuses with "the stored
    // credential has no token" — at first read, on a schedule, where nobody is
    // watching.
    expect(authPlaceholders(CAPSULE_PROFILE.auth)).toEqual(["token"]);
    expect(providerDescriptor(CAPSULE_PROVIDER)!.credentialFields.map((f) => f.name)).toEqual(
      authPlaceholders(CAPSULE_PROFILE.auth),
    );
  });

  it("🔴 tells the owner the click-path, asks for read access, and names NO host", () => {
    // ADR-042 model 3: the owner mints the token in their own Capsule, so the help
    // text IS the click-path: your name (top menu bar) -> My Preferences -> API
    // Authentication -> Generate new API token. The scope picker is UNVERIFIED, so
    // the help says "if Capsule offers the choice". No host literal: the egress
    // scanner reads descriptor strings.
    // Mutation: reword the click-path, or paste an address into the help -> red.
    const help = providerDescriptor(CAPSULE_PROVIDER)!.credentialFields[0]!.help ?? "";
    for (const step of ["My Preferences", "API Authentication", "Generate new API token", "read access"]) {
      expect(help, step).toContain(step);
    }
    expect(help).not.toMatch(/https?:\/\//i);
    expect(help).not.toMatch(/\.(com|net|org|io)\b/i);
  });

  it("is a CRM card in hub slot 20, on the REST track, with its guide", () => {
    // Mutation: change the order, the category or the guide href -> red.
    const d = providerDescriptor(CAPSULE_PROVIDER)!;
    expect(d.track).toBe("rest");
    expect(d.displayName).toBe("Capsule CRM");
    expect(d.category).toBe("CRM");
    expect(d.catalog?.order).toBe(20);
    expect(d.catalog?.availability).toBe("available");
    expect(d.catalog?.setupGuideHref).toBe("/help/connectors/capsule");
  });

  it("🔴 paces at the DOCUMENTED floor — 4,000 an hour — and the descriptor's ceiling says the same thing twice", async () => {
    // "Each Capsule user is allowed 4,000 requests per hour when using Bearer
    // Token Authentication" -> 3,600,000 / 4,000 = 900 ms. The budget belongs to
    // the USER, shared with every other tool using that user's tokens.
    // Mutation: pace at 1,000 ms "from the one-second delay advice" -> still
    // green, because that is slower; pace at 500 ms -> red.
    const rateLimit = providerDescriptor(CAPSULE_PROVIDER)!.rateLimit!;
    expect(rateLimit).toEqual({ callCeiling: 4_000, periodMs: 3_600_000 });
    expect(rateLimit.periodMs / rateLimit.callCeiling).toBe(CAPSULE_MIN_REQUEST_INTERVAL_MS);
    expect(CAPSULE_PROFILE.minRequestIntervalMs).toBe(900);

    const { connector, slept } = connectorWith([
      { body: { opportunities: [OPPORTUNITY] }, headers: nextLink("opportunities") },
      { body: { opportunities: [] } },
    ]);
    await connector.runRead("get_deals_by_stage", { since: SINCE });
    expect(slept).toEqual([CAPSULE_MIN_REQUEST_INTERVAL_MS]);
  });
});

// ── the headers that actually leave the box ─────────────────────────────────

describe("Capsule — auth, read off the wire", () => {
  it("sends Authorization: Bearer <token> — and NO other header beyond accept", async () => {
    // authentication: `Authorization: Bearer {token}`. No version header is
    // documented, so `constantHeaders` is empty; an invented one is a contract
    // Capsule never stated. The whole header set is asserted.
    // Mutation: spell it `X-Capsule-Token`, drop `Bearer `, or add a version
    // header -> red.
    const { connector, calls } = connectorWith([{ body: { opportunities: [] } }]);
    await connector.connect();
    await connector.runRead("get_deals_by_stage", {});

    expect(CAPSULE_PROFILE.auth).toEqual({ headerName: "Authorization", valueTemplate: "Bearer {{token}}" });
    expect(CAPSULE_PROFILE.constantHeaders).toEqual({});
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(Object.keys(headersOf(call.init)).sort()).toEqual(["Authorization", "accept"]);
      expect(headersOf(call.init).Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("probes GET /api/v2/users/current on BOTH connect() and health(), with no query", async () => {
    // 🔴 Resolving the credential locally is not a connection: a token the owner
    // revoked resolves perfectly and fails on the first scheduled read, hours
    // later. `/users/current` returns "the user who approved your application" —
    // one object, no paging — so a 401 on it is unambiguous evidence about the
    // TOKEN.
    // Mutation: point probePath at `/api/v2/opportunities` -> the health check
    // pages the owner's pipeline every time.
    const { connector, calls } = connectorWith([{ body: { user: { id: 1 } } }]);
    await connector.connect();
    await connector.health();

    expect(CAPSULE_PROFILE.probePath).toBe("/api/v2/users/current");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.capsulecrm.com/api/v2/users/current",
      "https://api.capsulecrm.com/api/v2/users/current",
    ]);
  });
});

// ── opportunities → deal ────────────────────────────────────────────────────

describe("Capsule deal — GET /opportunities", () => {
  it("🔴 sends `since` when a tick passes one, perPage=100 always, and NO guessed spelling of the filter", async () => {
    const { connector, calls } = connectorWith([{ body: { opportunities: [OPPORTUNITY] } }]);
    await connector.runRead("get_deals_by_stage", { since: SINCE });

    const first = new URL(calls[0]!.url);
    expect(first.host).toBe("api.capsulecrm.com");
    expect(first.pathname).toBe("/api/v2/opportunities");

    // The watermark. `since` "includes only entities that have been changed after
    // this date", ISO 8601. 🔴 An unknown parameter is not a 4xx on every vendor:
    // a guessed spelling could be silently ignored, and the box would report an
    // incremental read over a full scan. Every plausible alternative is asserted
    // ABSENT.
    // Mutation: spell it `updated_after`, `modifiedSince` or `updatedSince` -> red.
    expect(first.searchParams.get("since")).toBe(SINCE_ISO);
    for (const guess of ["updated_after", "modifiedSince", "updatedSince", "modified_since", "after"]) {
      expect(first.searchParams.has(guess), guess).toBe(false);
    }
    // `perPage` "range 1-100. Default: 50": the maximum, as a CONSTANT query
    // parameter — the `link-header` arm has no page-size slot.
    // Mutation: `perPage: "250"` -> red, and Capsule would reject it.
    expect(first.searchParams.get("perPage")).toBe("100");
    expect(CAPSULE_PAGE_SIZE).toBe("100");
    expect(first.searchParams.get("embed")).toBe("milestone");
    expect(queryKeys(calls[0]!.url)).toEqual(["embed", "perPage", "since"]);

    // And with NO watermark (the first read of a connection) there is no `since`.
    const plain = connectorWith([{ body: { opportunities: [OPPORTUNITY] } }]);
    await plain.connector.runRead("get_deals_by_stage", {});
    expect(queryKeys(plain.calls[0]!.url)).toEqual(["embed", "perPage"]);
  });

  it("🔴 follows the Link header's rel=\"next\" VERBATIM, and the last page (no rel=\"next\") stops the walk", async () => {
    // reading-from-the-api: "pagination info is included in the Link header. It is
    // recommended to follow these Link header values instead of constructing your
    // own URLs". The URL is taken verbatim and re-guarded against this host.
    // Mutation: build page two from `page=` instead of the header -> red.
    const { connector, calls } = connectorWith([
      { body: { opportunities: [{ ...OPPORTUNITY, id: 1 }] }, headers: nextLink("opportunities") },
      { body: { opportunities: [{ ...OPPORTUNITY, id: 2 }] } },
    ]);
    const rows = rowsOf(await connector.runRead("get_deals_by_stage", { since: SINCE }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://api.capsulecrm.com/api/v2/opportunities?page=2&perPage=100");
    expect(rows.map((r) => r.deal_id)).toEqual(["1", "2"]);
  });

  it("🔴 refuses a Link rel=\"next\" that points off api.capsulecrm.com — the token is never sent there", async () => {
    // A `Link` header is VENDOR-controlled input, and the connector takes the URL
    // verbatim. Without the per-request exact-host re-guard, a next-page URL on
    // another host would be fetched WITH the Authorization header. EXACTLY ONE
    // call: the second was refused before it left.
    const { connector, calls } = connectorWith([
      {
        body: { opportunities: [OPPORTUNITY] },
        headers: { link: '<https://evil.example.net/api/v2/opportunities?page=2>; rel="next"' },
      },
    ]);
    await expect(connector.runRead("get_deals_by_stage", {})).rejects.toThrow(UnsafeBaseUrlError);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("api.capsulecrm.com");
  });

  it("declares the `since` watermark COMPLETE, link-header pagination and the `opportunities` rows key", () => {
    // `complete: true` is declared on the strength of "changed after this date"
    // (UNVERIFIED which field it filters — see the register below); it is what
    // lets `deal` be scheduled without tripping the descriptor test's "no
    // scheduled dataset with an incomplete watermark" pin.
    // Mutation: flip `complete` or rename the key -> red.
    const deal = CAPSULE_PROFILE.datasets.find((d) => d.dataset === "deal")!;
    expect(deal.path).toBe("/api/v2/opportunities");
    expect(deal.query).toEqual({ perPage: "100", embed: "milestone" });
    expect(deal.watermark).toEqual({ name: "since", location: "query", format: "iso", complete: true });
    expect(deal.pagination).toEqual({ kind: "link-header" });
    expect(deal.rowsPath).toBe("opportunities");
  });

  it("🔴 projects the documented opportunity onto the expected row — company_id UNDEFINED even though party.id is present", async () => {
    // `party` may be a PERSON or an ORGANISATION, so `party.id` would put a
    // person's id in a company column — and no `company` dataset is served for it
    // to join to. Left undefined rather than guessed.
    // Mutation: map `company_id: "party.id"` -> red.
    const { connector } = connectorWith([{ body: { opportunities: [OPPORTUNITY] } }]);
    const row = rowsOf(await connector.runRead("get_deals_by_stage", {}))[0]!;
    expect(row).toEqual({
      deal_id: "12",
      created_at: "2015-10-29T12:55:12.000Z",
      closed_at: undefined,
      company_id: undefined,
      name: "Consulting",
      stage: "Bid",
      amount: 500,
      currency: "GBP",
      updated_at: "2015-10-29T12:55:12.000Z",
    });
    expect("company_id" in row).toBe(true);
  });

  it("🔴 reads the pipeline stage from `milestone.name` — Won and Lost are milestones, closedOn only marks the date", async () => {
    // The spec's reading of the model page: won/lost is carried by the MILESTONE,
    // and `closedOn` marks conclusion. So `stage` is the milestone's name, and a
    // concluded deal keeps its closing DATE (`2015-11-30` is widened to UTC
    // midnight by the canonical projection).
    // Mutation: map `stage: "milestone.id"` or `closed_at: "expectedCloseOn"` -> red.
    const { connector } = connectorWith([
      {
        body: {
          opportunities: [{ ...OPPORTUNITY, id: 13, milestone: { id: 15, name: "Won" }, closedOn: "2015-11-30" }],
        },
      },
    ]);
    const row = rowsOf(await connector.runRead("get_deals_by_stage", {}))[0]!;
    expect(row.stage).toBe("Won");
    expect(row.closed_at).toBe("2015-11-30T00:00:00.000Z");
  });

  it("🔴 leaves amount AND currency undefined together when the opportunity has no value", async () => {
    // `value` is null on an unpriced opportunity. The two columns come from the
    // same object, so they are absent together — never a 0, which would read as
    // "worth nothing".
    // Mutation: default `amount` to 0 -> red.
    const { connector } = connectorWith([{ body: { opportunities: [{ ...OPPORTUNITY, value: null }] } }]);
    const row = rowsOf(await connector.runRead("get_deals_by_stage", {}))[0]!;
    expect(row.amount).toBeUndefined();
    expect(row.currency).toBeUndefined();
    expect(row.deal_id).toBe("12");
  });

  it("🔴 reads `opportunities`, not whatever else the body carries — a wrong rowsPath is a loud failure", async () => {
    // Decoy: a `tasks` key beside the real one. And `absentRowsMeansEmpty` stays
    // UNSET, so a body with no `opportunities` array is a contract error, never
    // "no deals".
    // Mutation: set `rowsPath: "tasks"` or `absentRowsMeansEmpty: true` -> red.
    const deal = CAPSULE_PROFILE.datasets.find((d) => d.dataset === "deal")!;
    expect(deal.absentRowsMeansEmpty).toBeUndefined();

    const { connector } = connectorWith([{ body: { opportunities: [OPPORTUNITY], tasks: [{ id: "decoy" }] } }]);
    expect(rowsOf(await connector.runRead("get_deals_by_stage", {})).map((r) => r.deal_id)).toEqual(["12"]);

    const missing = connectorWith([{ body: {} }]);
    await expect(missing.connector.runRead("get_deals_by_stage", {})).rejects.toThrow(RestPaginationContractError);
  });

  it("narrows by `stage` the way get_deals_by_stage documents — on the milestone's own name", async () => {
    const { connector } = connectorWith([
      {
        body: {
          opportunities: [
            { ...OPPORTUNITY, id: 1, milestone: { id: 1, name: "Bid" } },
            { ...OPPORTUNITY, id: 2, milestone: { id: 2, name: "Negotiation" } },
          ],
        },
      },
    ]);
    const rows = rowsOf(await connector.runRead("get_deals_by_stage", { stage: "Negotiation" }));
    expect(rows.map((r) => r.deal_id)).toEqual(["2"]);
  });
});

// ── tasks → task ────────────────────────────────────────────────────────────

describe("Capsule task — GET /tasks", () => {
  it("🔴 asks for status=open,completed,pending — the DEFAULT is open tasks only — and sends NO watermark under any spelling", async () => {
    const { connector, calls } = connectorWith([{ body: { tasks: [TASK] } }]);
    // A scheduled tick passes `since`; `GET /tasks` has nowhere to put it.
    await connector.runRead("get_tasks_by_status", { since: SINCE });

    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe("/api/v2/tasks");

    // 🔴 Capsule's task model page: "By default the body will contain only the
    // open tasks". The `status` parameter takes a "comma separated list ... `open`,
    // `completed` and `pending`", and THIS constant is what makes completed work
    // (and `closed_at`) exist on the box at all. `URLSearchParams` writes the
    // commas as `%2C`, which a standard server decodes; not observed live.
    // Mutation: drop `status` -> only OPEN tasks arrive and nothing goes red
    // anywhere else.
    expect(first.searchParams.get("status")).toBe("open,completed,pending");
    expect(first.searchParams.get("perPage")).toBe("100");
    expect(first.searchParams.get("embed")).toBe("kase,owner");

    // `GET /tasks` documents NO modification filter: parameters are `page`,
    // `perPage`, `embed` and `status`. Every plausible spelling is asserted ABSENT.
    // Mutation: declare `watermark: { name: "since", ... }` on `task` -> red.
    for (const guess of ["since", "updated_after", "modifiedSince", "updatedSince", "modified_since", "after"]) {
      expect(first.searchParams.has(guess), guess).toBe(false);
    }
    expect(queryKeys(calls[0]!.url)).toEqual(["embed", "perPage", "status"]);
  });

  it("declares the watermark NULL, link-header pagination and the `tasks` rows key", () => {
    // `null` is a DECLARED full scan (`profile.ts`: "A dataset with no watermark
    // carries `watermark: null` and is swept as a full scan, honestly").
    // Mutation: any non-null watermark -> red here, and the read above goes red on
    // the wire.
    const task = CAPSULE_PROFILE.datasets.find((d) => d.dataset === "task")!;
    expect(task.path).toBe("/api/v2/tasks");
    expect(task.query).toEqual({ perPage: "100", status: "open,completed,pending", embed: "kase,owner" });
    expect(task.watermark).toBeNull();
    expect(task.pagination).toEqual({ kind: "link-header" });
    expect(task.rowsPath).toBe("tasks");
  });

  it("🔴 projects the documented task onto the expected row — priority UNDEFINED, project_id UNDEFINED without a kase", async () => {
    // Capsule's task has no priority field. `project_id` reads `kase.id` ONLY: a
    // task attaches to exactly one of party / opportunity / kase, so the column is
    // lossy by construction and undefined on most rows.
    // Mutation: map `priority: "status"` or `project_id: "opportunity.id"` -> red.
    const { connector } = connectorWith([{ body: { tasks: [TASK] } }]);
    const row = rowsOf(await connector.runRead("get_tasks_by_status", {}))[0]!;
    expect(row).toEqual({
      task_id: "493",
      project_id: undefined,
      created_at: "2015-10-26T14:37:52.000Z",
      closed_at: undefined,
      title: "Send quarterly invoice",
      status: "OPEN",
      priority: undefined,
      assignee_id: "1",
      updated_at: "2015-10-26T14:37:52.000Z",
    });
  });

  it("🔴 takes project_id from `kase.id`, closed_at from `completedAt`, and keeps the COMPLETED status", async () => {
    // `kase` (a Capsule project) and `completedAt` are supplied by the test
    // author from the model page's field list — the documented example elides
    // them. A COMPLETED task is exactly what the constant `status` parameter
    // exists to bring in.
    // Mutation: map `closed_at: "updatedAt"` -> a completed task's closing time
    // becomes its last edit.
    const { connector } = connectorWith([
      {
        body: {
          tasks: [
            { ...TASK, id: 494, status: "COMPLETED", kase: { id: 77 }, completedAt: "2015-11-02T09:00:00Z" },
            { ...TASK, id: 495, status: "PENDING", opportunity: { id: 12 } },
          ],
        },
      },
    ]);
    const rows = rowsOf(await connector.runRead("get_tasks_by_status", {}));
    const done = rows.find((r) => r.task_id === "494")!;
    expect(done.status).toBe("COMPLETED");
    expect(done.project_id).toBe("77");
    expect(done.closed_at).toBe("2015-11-02T09:00:00.000Z");
    const pending = rows.find((r) => r.task_id === "495")!;
    expect(pending.status).toBe("PENDING");
    expect(pending.project_id).toBeUndefined();
    expect(pending.closed_at).toBeUndefined();
  });

  it("🔴 status is the vendor's UPPER-CASE word — get_tasks_by_status {status:\"open\"} matches NOTHING, {status:\"OPEN\"} matches", async () => {
    // THE declared limitation of this profile, pinned so nobody is surprised by it
    // in production. `read-semantics.ts` compares `status` as CASE-SENSITIVE text
    // and Capsule's enum is `OPEN | COMPLETED | PENDING`, so the documented
    // example `{ status: "open" }` answers with ZERO rows — a confident empty
    // answer. A value mapping or a case-insensitive `equals` is a track widening
    // (research spec §6.3), not something to smuggle in behind one vendor.
    // Mutation: lowercase the status in the projection -> the second assertion
    // goes red.
    const rows = [TASK, { ...TASK, id: 494, status: "COMPLETED" }];
    const lower = connectorWith([{ body: { tasks: rows } }]);
    expect(await lower.connector.runRead("get_tasks_by_status", { status: "open" })).toEqual([]);

    const upper = connectorWith([{ body: { tasks: rows } }]);
    expect(rowsOf(await upper.connector.runRead("get_tasks_by_status", { status: "OPEN" })).map((r) => r.task_id)).toEqual(["493"]);
  });

  it("🔴 reads `tasks`, not whatever else the body carries — a wrong rowsPath is a loud failure", async () => {
    // Mutation: set `rowsPath: "opportunities"` or `absentRowsMeansEmpty: true` ->
    // red.
    const task = CAPSULE_PROFILE.datasets.find((d) => d.dataset === "task")!;
    expect(task.absentRowsMeansEmpty).toBeUndefined();

    const { connector } = connectorWith([{ body: { tasks: [TASK], opportunities: [{ id: "decoy" }] } }]);
    expect(rowsOf(await connector.runRead("get_tasks_by_status", {})).map((r) => r.task_id)).toEqual(["493"]);

    const missing = connectorWith([{ body: {} }]);
    await expect(missing.connector.runRead("get_tasks_by_status", {})).rejects.toThrow(RestPaginationContractError);
  });
});

// ── the vocabulary join ─────────────────────────────────────────────────────

describe("Capsule — the profile ↔ vocabulary join", () => {
  it("maps ONLY canonical columns, and pins which ones Capsule honestly leaves out", () => {
    const expected: Record<string, string[]> = {
      deal: ["deal_id", "created_at", "closed_at", "name", "stage", "amount", "currency", "updated_at"],
      task: ["task_id", "project_id", "created_at", "closed_at", "title", "status", "assignee_id", "updated_at"],
    };
    for (const spec of CAPSULE_PROFILE.datasets) {
      expect(Object.keys(spec.fieldMap).sort(), spec.dataset).toEqual([...expected[spec.dataset]!].sort());
      for (const column of Object.keys(spec.fieldMap)) {
        expect(CANONICAL_COLUMNS[spec.dataset], `${spec.dataset}.${column}`).toContain(column);
      }
    }
    // The two columns left out, by name, and why:
    //  • deal.company_id — `party` may be a person.
    //  • task.priority   — Capsule's task has no such field.
    expect("company_id" in CAPSULE_PROFILE.datasets[0]!.fieldMap).toBe(false);
    expect("priority" in CAPSULE_PROFILE.datasets[1]!.fieldMap).toBe(false);
  });
});

// ── what is NOT verified, pinned as such ────────────────────────────────────

/**
 * 🔴 The UNVERIFIED register (research spec §7 and §3.3 B10). Nothing here is a
 * vendor fact. Each test records the profile's DECLARED POSTURE and says in its
 * title that Capsule has not confirmed it, so that the day a live token settles
 * an item, this is the test to change.
 *
 * Not testable here, and recorded in the guide and the ADR instead: whether a
 * Free-plan account can mint a token (inferred from "API access included in every
 * tier"), the token-scope picker in the UI, and Capsule's API terms.
 */
describe("Capsule — UNVERIFIED items, pinned as UNVERIFIED", () => {
  it("UNVERIFIED — which field `since` filters and whether it is inclusive; `complete: true` is declared on the text alone", () => {
    // The text says "changed after this date". Whether that is `updatedAt` and
    // whether the bound is inclusive are not stated. `complete: true` is therefore
    // DECLARED, not verified: if the bound is exclusive and Capsule's timestamps
    // are second-precision, an edit inside the watermark's own second is skipped
    // until the reconciliation sweep finds it.
    const deal = CAPSULE_PROFILE.datasets.find((d) => d.dataset === "deal")!;
    expect(deal.watermark?.complete).toBe(true);
    expect(deal.watermark?.name).toBe("since");
  });

  it("UNVERIFIED — that Capsule accepts the `.000Z` millisecond form the watermark is written in", async () => {
    // The documented timestamps are second-precision (`2015-09-15T10:43:23Z`).
    // `formatWatermark("iso")` emits `toISOString()`, i.e. WITH milliseconds. Most
    // ISO parsers take both; Capsule's is not shown. Pinned as the form the box
    // ACTUALLY sends. (Added by the implementer; not in the research spec.)
    const { connector, calls } = connectorWith([{ body: { opportunities: [] } }]);
    await connector.runRead("get_deals_by_stage", { since: SINCE });
    expect(calls[0]!.url).toContain("since=2026-09-01T00%3A00%3A00.000Z");
  });

  it("UNVERIFIED — whether rel=\"next\" carries `status`; the connector follows the Link VERBATIM and re-adds nothing", async () => {
    // The documented Link example shows only `page` and `perPage`. If Capsule's
    // rel="next" for `/tasks` drops `status`, page two silently becomes OPEN-ONLY.
    // The connector takes the Link URL verbatim by design, so this pins what the
    // box does today: page two is EXACTLY the URL in the header.
    const { connector, calls } = connectorWith([
      { body: { tasks: [TASK] }, headers: nextLink("tasks") },
      { body: { tasks: [{ ...TASK, id: 494 }] } },
    ]);
    await connector.runRead("get_tasks_by_status", {});
    expect(calls[1]!.url).toBe("https://api.capsulecrm.com/api/v2/tasks?page=2&perPage=100");
    expect(new URL(calls[1]!.url).searchParams.has("status")).toBe(false);
  });

  it("UNVERIFIED — the empty-list envelope `{\"tasks\":[]}`; a body with no rows array is a contract error", async () => {
    // `absentRowsMeansEmpty` is left unset so a wrong rowsPath fails loudly. If
    // Capsule answers an empty list with `{}`, the first read of an account with
    // no tasks reports a contract error instead of zero rows — loud, not silent.
    const empty = connectorWith([{ body: { tasks: [] } }]);
    expect(await empty.connector.runRead("get_tasks_by_status", {})).toEqual([]);

    const bare = connectorWith([{ body: {} }]);
    await expect(bare.connector.runRead("get_tasks_by_status", {})).rejects.toThrow(RestPaginationContractError);
  });

  it("UNVERIFIED — a 429 carries `X-RateLimit-Reset` (UTC epoch seconds) and NO Retry-After, so retryAfter is undefined", async () => {
    // `RestRateLimitedError.retryAfter` reads only `Retry-After`, so the sync's
    // generic backoff applies; the 900 ms pacing is what prevents the 429. Not
    // observed live.
    const { connector } = connectorWith([
      {
        body: { error: "rate limit reached" },
        status: 429,
        headers: { "x-ratelimit-limit": "4000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1758200000" },
      },
    ]);
    const err = (await connector.runRead("get_deals_by_stage", {}).catch((e: unknown) => e)) as RestRateLimitedError;
    expect(err).toBeInstanceOf(RestRateLimitedError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBeUndefined();
  });

  it("UNVERIFIED — the full-scan cost of `task`; the profile declares watermark null and pages at 100", () => {
    // `GET /tasks` has no modification filter, so every tick re-reads every task:
    // 200 pages is about three minutes at 900 ms, and ticks are fifteen minutes
    // apart by default — roughly 800 requests an hour, ~20% of the 4,000 an hour
    // per-user quota, for an account with 20,000 tasks. Shipping
    // `status=open,pending` (active only) would cut it, at the cost of
    // `closed_at`; that is a product decision, recorded and not taken here.
    const task = CAPSULE_PROFILE.datasets.find((d) => d.dataset === "task")!;
    expect(task.watermark).toBeNull();
    expect(task.query?.perPage).toBe("100");
  });
});

// ── what Capsule could serve and this profile does not ──────────────────────

describe("Capsule — datasets refused by NAME, each costing ZERO fetch calls", () => {
  /** The real profile with a resolver that yields exactly what is passed. */
  function connectorWithCredentials(creds: Record<string, string>) {
    const { impl, calls } = stubFetch([{ body: { opportunities: [] } }]);
    const connector = new RestProfileConnector(
      CAPSULE_PROFILE,
      { provider: CAPSULE_PROVIDER },
      { fetchImpl: impl, resolveCredentials: async () => creds },
    );
    return { connector, calls };
  }

  it("🔴 refuses `contact` and `company` — one /parties list returns persons AND organisations with no type filter", async () => {
    // The track cannot route one endpoint to two datasets by row value, and
    // landing would write organisations into the owner's address book and persons
    // into Companies. Also not served: `engagement` (/entries has no `since` and
    // is an unbounded full scan) and projects (no canonical name). Refused by
    // NAME: `[]` would be a confident false statement about an owner's contacts.
    // Mutation: add a `contact` dataset on /parties -> red.
    for (const name of ["find_contact", "get_company", "get_engagements", "get_open_invoices"]) {
      const { connector, calls } = connectorWithCredentials({ token: TOKEN });
      await expect(connector.runRead(name, { since: SINCE }), name).rejects.toThrow(DatasetNotServedError);
      expect(calls, name).toHaveLength(0);
    }
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * 🔴 ADR-046 §3 and `rest-track.test.ts`'s own header state the rule: **a
 * refusal asserts `fetch` was called ZERO times**, never merely that an error
 * was thrown. A test that inspected only the returned error would still pass if
 * the request had already gone out carrying the owner's token.
 */
describe("Capsule — the refusals, each costing ZERO fetch calls", () => {
  function connectorWithCredentials(creds: Record<string, string>) {
    const { impl, calls } = stubFetch([{ body: { opportunities: [] } }]);
    const connector = new RestProfileConnector(
      CAPSULE_PROFILE,
      { provider: CAPSULE_PROVIDER },
      { fetchImpl: impl, resolveCredentials: async () => creds },
    );
    return { connector, calls };
  }

  it("🔴 refuses a read when the stored credential has no token — ZERO fetch calls", async () => {
    // Mutation: fall back to "" instead of refusing an empty placeholder -> the
    // request goes out and the call count goes to 1.
    const { connector, calls } = connectorWithCredentials({});
    await expect(connector.runRead("get_deals_by_stage", {})).rejects.toThrow(/has no "token"/);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a blank token as firmly as a missing one — ZERO fetch calls", async () => {
    const { connector, calls } = connectorWithCredentials({ token: "\t \n" });
    await expect(connector.connect()).rejects.toThrow(/has no "token"/);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses every write, and spends no call finding out — the track is read-only", async () => {
    // Capsule has a full write API, and a default `read write` token scope. The
    // refusal is the track's, not the vendor's, and it costs no request.
    const { connector, calls } = connectorWithCredentials({ token: TOKEN });
    await expect(connector.applyWrite("reschedule_appointment", {})).rejects.toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses to build against a provider id that is not Capsule's — ZERO fetch calls", async () => {
    const { impl, calls } = stubFetch([{ body: { opportunities: [] } }]);
    expect(
      () =>
        new RestProfileConnector(
          CAPSULE_PROFILE,
          { provider: "capsule-mcp" },
          { fetchImpl: impl, resolveCredentials: async () => ({ token: TOKEN }) },
        ),
    ).toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 reads a 401 as a rejected credential and a 403 (read-only token on a write) as the same refusal", async () => {
    // handling-api-responses: 401 is an invalid token; 403 is "read-only token or
    // non-admin user". Neither carries a rate-limit header, so both are about the
    // CREDENTIAL and take the "paste a new key" path — and the 403 is what a
    // read-only token answers to anything that writes, which is what the box wants.
    for (const status of [401, 403]) {
      const { connector } = connectorWith([{ body: {}, status }]);
      await expect(connector.connect(), String(status)).rejects.toThrow(ConnectorBlockedError);
    }
  });

  it("🔴 refuses a 302 rather than following it off api.capsulecrm.com", async () => {
    // `fetch` defaults to following redirects, so without `redirect: "error"` the
    // guard would be checking a URL while the answer chose the destination, with
    // the owner's token attached. EXACTLY ONE call: the redirect was not followed.
    const { connector, calls } = connectorWith([
      { body: {}, status: 302, headers: { location: "https://evil.example.net/api/v2/opportunities" } },
    ]);
    await expect(connector.runRead("get_deals_by_stage", {})).rejects.toThrow(UnsafeBaseUrlError);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("api.capsulecrm.com");
  });
});
