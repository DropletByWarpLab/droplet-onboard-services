/**
 * WARP-2918 / ADR-046 — Todoist's VENDOR FACTS, pinned against Todoist's own
 * documentation.
 *
 * ## Why this file is mandatory rather than nice to have
 *
 * ADR-046's Consequences section: *"A declarative profile is easier to get wrong
 * quietly than code is. A wrong watermark parameter is one string. Mitigation:
 * the parameter names are pinned by tests that cite the vendor page, exactly as
 * `graph-resources.test.ts` does for Microsoft Graph."* This is that file for
 * Todoist. `rest-track.test.ts` proves the connector does what a profile SAYS —
 * which is exactly the question that stays green when the profile says the wrong
 * thing — and `introspect()`'s fingerprint hashes the datasets and their
 * canonical columns, not the paths, headers or parameter spellings. Only this
 * file can catch those.
 *
 * Todoist's version of the silent failure is the GitHub one ADR-046 names.
 * `GET /api/v1/tasks` accepts exactly `project_id`, `section_id`, `parent_id`,
 * `label`, `ids`, `cursor` and `limit` — there is NO last-modified filter of any
 * spelling. A profile that guessed `updated_since` or `since` would either 400
 * or be silently ignored, and in the second case the box would report an
 * incremental read over what was in fact a full scan, forever. So the dataset
 * ships `watermark: null`, which is the declared full scan `profile.ts`
 * prescribes, and this file pins it null so a later "improvement" cannot invent
 * a parameter Todoist does not honour.
 *
 * ## The sources every claim below was checked against (2026-09-18)
 *
 *  • API reference root       https://developer.todoist.com/api/v1/
 *  • Authorization            https://developer.todoist.com/api/v1/#tag/Authorization
 *  • Pagination               https://developer.todoist.com/api/v1/#tag/Pagination
 *  • Request limits           https://developer.todoist.com/api/v1/#tag/Request-limits
 *  • Migrating from v9        https://developer.todoist.com/api/v1/#tag/Migrating-from-v9
 *  • Get tasks                https://developer.todoist.com/api/v1/#tag/Tasks/operation/get_tasks_api_v1_tasks_get
 *  • Completed tasks (NOT served)
 *      https://developer.todoist.com/api/v1/#tag/Tasks/operation/tasks_completed_by_completion_date_api_v1_tasks_completed_by_completion_date_get
 *  • User info (the probe)    https://developer.todoist.com/api/v1/#tag/User/operation/user_info_api_v1_user_get
 *  • Find your API token      https://www.todoist.com/help/articles/find-your-api-token-Jpzx9IIlB
 *  • the OpenAPI document embedded in the reference page, which is where the
 *    parameter list for `GET /api/v1/tasks`, the `PaginatedList_ItemSyncView_`
 *    response (`required: ["results", "next_cursor"]`, `next_cursor` string|null)
 *    and the `ItemSyncView` property types below were read.
 *
 * ## 🔴 The fixture is SCHEMA-DERIVED, not a documented response
 *
 * The embedded OpenAPI document carries NO response example on
 * `GET /api/v1/tasks` — `responses.200` is only a `$ref` to
 * `PaginatedList_ItemSyncView_`. The values in `TASK` below are the
 * per-property `examples` on the `ItemSyncView` schema, assembled into one
 * object. Every field this profile reads (`id`, `project_id`, `added_at`,
 * `completed_at`, `content`, `checked`, `priority`, `responsible_uid`,
 * `updated_at`) is a verified `ItemSyncView` property with the type the schema
 * states; the fixture is accurate to the schema, and it is not a captured wire
 * body.
 *
 * ## The rule every test here obeys
 *
 * 🔴 **Facts are asserted from the OUTGOING REQUEST, not from the profile
 * object.** These tests run the REAL profile through a REAL
 * `RestProfileConnector` with an injected fetch, so a connector that adds a
 * guessed watermark, drops the page size or pages on the wrong parameter goes
 * red here even though the profile is untouched.
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
  TODOIST_API_ORIGIN,
  TODOIST_PAGE_SIZE,
  TODOIST_PROFILE,
  TODOIST_PROVIDER,
} from "../src/rest/vendors/todoist.js";
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
 * A token's stand-in, deliberately NOT forty hex characters. Todoist's only
 * example token is forty hex characters, but Todoist documents no token
 * format, so nothing validates the shape — which is the property the
 * descriptor test below pins.
 */
const TOKEN = "test-api-token";

/** The REAL profile, through the REAL connector. */
function connectorWith(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const { impl, calls } = stubFetch(pages);
  const slept: number[] = [];
  const connector = new RestProfileConnector(
    TODOIST_PROFILE,
    { provider: TODOIST_PROVIDER },
    {
      fetchImpl: impl,
      resolveCredentials: async () => ({ token: TOKEN }),
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
  );
  return { connector, calls, slept };
}

/**
 * The watermark instant a scheduled tick passes. Todoist has NO parameter to
 * put it on, so the assertions below check it is NOT on the wire — a `since`
 * that reaches the URL under any spelling is a guessed contract.
 */
const SINCE = "2026-09-01T00:00:00Z";

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;
const rowsOf = (rows: unknown[]) => rows as Record<string, unknown>[];

/**
 * One Todoist task, as the `ItemSyncView` schema's per-property examples
 * describe it (see the file header: schema-derived, not a captured body).
 *
 * `checked: false` and `completed_at: null` are not fixture choices — they are
 * what `GET /api/v1/tasks` ALWAYS returns, because it serves active tasks only.
 */
const TASK = {
  user_id: "1234567",
  id: "6XGgmFVcrG5RRjVr",
  project_id: "6XGgm6PHrGgMpCFX",
  section_id: "6fFPHV272WWh3gpW",
  parent_id: null,
  added_by_uid: "1234567",
  assigned_by_uid: null,
  responsible_uid: "1234567",
  labels: ["priority"],
  deadline: { date: "2025-02-12", lang: "en" },
  duration: { amount: 30, unit: "minute" },
  is_collapsed: false,
  checked: false,
  is_deleted: false,
  added_at: "2025-01-15T10:30:00Z",
  completed_at: null,
  completed_by_uid: null,
  updated_at: "2025-01-17T10:30:00Z",
  due: { date: "2025-02-12", is_recurring: false, lang: "en", string: "tomorrow" },
  priority: 1,
  child_order: 1,
  order_key: "a0",
  content: "Buy milk",
  description: "Pick up organic milk",
  note_count: 0,
  day_order: 1,
  completed_count: 0,
  postponed_count: 0,
};

/** A page with no more results: `next_cursor` is `null`, never absent. */
const LAST_PAGE = (results: unknown[]) => ({ body: { results, next_cursor: null } });

// ── identity, custody and the descriptor ────────────────────────────────────

describe("Todoist — the profile the track actually dispatches", () => {
  it("is the profile restProfileFor('todoist') returns, not a copy", () => {
    // Mutation: register a second Todoist profile in `profiles.ts` and this whole
    // file starts testing a file nothing ships.
    expect(restProfileFor(TODOIST_PROVIDER)).toBe(TODOIST_PROFILE);
  });

  it("🔴 dials ONE static host, and it is the host the descriptor registers for egress", () => {
    // Todoist's unified API has one origin, `https://api.todoist.com/`
    // (`servers[0].url` in the embedded OpenAPI document). No region, no
    // per-account subdomain, no self-hosted edition. So this is a plain
    // `kind: egress` entry whose origin is a whole-string literal the static
    // scanner reads directly from `todoist.ts`.
    // Mutation: change the origin, or the descriptor's `egressHosts` -> red.
    expect(TODOIST_PROFILE.baseUrl).toEqual({ kind: "static", origin: TODOIST_API_ORIGIN });
    expect(TODOIST_API_ORIGIN).toBe("https://api.todoist.com");
    expect(providerDescriptor(TODOIST_PROVIDER)!.egressHosts).toEqual(["api.todoist.com"]);
  });

  it("🔴 serves EXACTLY the datasets the descriptor advertises — `task`, alone", () => {
    // The descriptor is what the hub, the scheduler (`entityServedBy`) and the
    // dashboard read; the profile is what the connector reads. A drift between
    // them is a hub tile offering a dataset the connection will refuse the
    // first time it is asked. Compared as SETS: ordering carries no meaning.
    const served = TODOIST_PROFILE.datasets.map((d) => d.dataset);
    expect([...served].sort()).toEqual([...providerDescriptor(TODOIST_PROVIDER)!.datasets].sort());
    expect(served).toEqual(["task"]);
  });

  it("🔴 declares NO credential-field pattern — Todoist documents no token format", () => {
    // The only token Todoist shows is the forty-hex-character EXAMPLE in the
    // Authorization section. An example is not a contract: the help article
    // and the reference say nothing about the token's length or alphabet, so
    // `^[0-9a-f]{40}$` would be a regex anchored on one sample — the Brevo /
    // Square / Cal.com reasoning exactly. A false rejection at the paste box
    // blocks an owner for zero security gain; the only thing that proves a
    // token is Todoist answering `GET /api/v1/user` with it, which `connect()`
    // already does.
    // Mutation: add `pattern: "^[0-9a-f]{40}$"` -> red.
    const fields = providerDescriptor(TODOIST_PROVIDER)!.credentialFields;
    expect(fields.map((f) => f.name)).toEqual(["token"]);
    for (const field of fields) expect(field.pattern).toBeUndefined();
    expect(fields[0]!.secret).toBe(true);
    expect(fields[0]!.required).toBe(true);
    expect(fields[0]!.storage).toBe("encrypted");
  });

  it("names its credential placeholder EXACTLY as the descriptor names the field", () => {
    // These two are wired together at runtime by nothing but this string: the
    // orchestrator stores the field under the descriptor's name, the connector
    // looks it up by the template's placeholder. Rename either alone and every
    // Todoist connection refuses with "the stored credential has no token" —
    // at first read, on a schedule, where nobody is watching.
    expect(authPlaceholders(TODOIST_PROFILE.auth)).toEqual(["token"]);
    expect(providerDescriptor(TODOIST_PROVIDER)!.credentialFields.map((f) => f.name)).toEqual(
      authPlaceholders(TODOIST_PROFILE.auth),
    );
  });

  it("tells the owner the exact console path to the token, in the field's help text", () => {
    // ADR-042 model 3: the owner mints the token in their own console, so the
    // help text IS the click-path. Todoist's help article: Settings ->
    // Integrations -> Developer -> "Copy API token".
    // Mutation: reword the help to name a screen that does not exist -> red.
    const help = providerDescriptor(TODOIST_PROVIDER)!.credentialFields[0]!.help ?? "";
    for (const step of ["Settings", "Integrations", "Developer", "Copy API token"]) {
      expect(help, step).toContain(step);
    }
  });

  it("🔴 paces against NO invented ceiling, and the descriptor declares none either", async () => {
    // Todoist's Request-limits section publishes ceilings ONLY for the Sync
    // endpoint (1000 partial / 100 full sync requests per user per 15 minutes)
    // and nothing for `GET /api/v1/tasks`; the old REST v2 figure (450 per 15
    // minutes) is unreachable — that page now redirects to v1. Like Square,
    // the profile therefore omits `minRequestIntervalMs` and reacts to a 429
    // (and the body's `retry_after`, which Todoist says may arrive on other
    // errors too) rather than pacing against a guess. The descriptor states
    // the same absence: no `rateLimit`.
    // Mutation: add `minRequestIntervalMs: 2000` "from the v2 figure" -> red.
    expect(TODOIST_PROFILE.minRequestIntervalMs).toBeUndefined();
    expect(providerDescriptor(TODOIST_PROVIDER)!.rateLimit).toBeUndefined();

    const { connector, slept } = connectorWith([
      { body: { results: [TASK], next_cursor: "CUR1" } },
      LAST_PAGE([]),
    ]);
    await connector.runRead("get_tasks_by_status", {});
    expect(slept).toEqual([]);
  });
});

// ── the headers that actually leave the box ─────────────────────────────────

describe("Todoist — auth, read off the wire", () => {
  it("sends Authorization: Bearer <token> — the literal name and the literal template", async () => {
    // Todoist's Authorization section: `Authorization: Bearer $token`, with
    // the personal token from Settings -> Integrations -> Developer. A genuine
    // RFC-6750 Bearer scheme — pinned because most of the shapes on ADR-046
    // §2's table are NOT this one.
    // Mutation: spell it `X-Api-Token`, or drop the `Bearer ` prefix -> red.
    const { connector, calls } = connectorWith([LAST_PAGE([])]);
    await connector.runRead("get_tasks_by_status", {});

    expect(TODOIST_PROFILE.auth).toEqual({
      headerName: "Authorization",
      valueTemplate: "Bearer {{token}}",
    });
    expect(headersOf(calls[0]!.init).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends NO constant header — Todoist has no version or revision header to pin", async () => {
    // Unlike Square (`Square-Version`) and Cal.com (`cal-api-version`), the
    // unified v1 API is versioned in the PATH (`/api/v1/`) and documents no
    // mandatory header beyond `Authorization`. An invented one would be a
    // contract Todoist never stated.
    // Mutation: copy Cal.com's `cal-api-version` across "for symmetry" -> red.
    const { connector, calls } = connectorWith([LAST_PAGE([])]);
    await connector.connect();
    await connector.runRead("get_tasks_by_status", {});

    expect(TODOIST_PROFILE.constantHeaders).toEqual({});
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const names = Object.keys(headersOf(call.init)).filter((h) => h.toLowerCase() !== "authorization");
      expect(names.map((h) => h.toLowerCase())).not.toContain("cal-api-version");
      expect(names.map((h) => h.toLowerCase())).not.toContain("square-version");
    }
  });

  it("probes GET /api/v1/user on BOTH connect() and health()", async () => {
    // 🔴 Resolving the credential locally is not a connection: a token the
    // owner re-issued (which invalidates the previous one) resolves perfectly
    // and fails on the first scheduled read, hours later. `/api/v1/user`
    // returns the token's own user and nothing else — no pagination, one row
    // — so a 401 on it is unambiguous evidence about the TOKEN. Todoist's own
    // guidance on a 401: "do not wait and retry the same invalid or expired
    // token" — it is a revoked credential, not a rate limit.
    // Mutation: point probePath at `/api/v1/tasks` -> the health check pages
    // the owner's whole task list every time, and an account with no tasks
    // still "connects" for reasons unrelated to the token.
    const { connector, calls } = connectorWith([{ body: { id: "1234567", email: "owner@example.test" } }]);
    await connector.connect();
    await connector.health();

    expect(TODOIST_PROFILE.probePath).toBe("/api/v1/user");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.todoist.com/api/v1/user",
      "https://api.todoist.com/api/v1/user",
    ]);
    // The probe carries no paging parameter and no `limit`: this endpoint
    // documents none, and sending one would be inventing a contract.
    for (const call of calls) expect(new URL(call.url).search).toBe("");
  });

  it("🔴 uses the LOWERCASE v1 path on every request — mixed case is a 404 since v1", async () => {
    // Todoist's Migrating-from-v9 section: endpoints are case-sensitive and
    // lowercase in v1. And the paths must be `/api/v1/...`, never the retired
    // `/rest/v2/...` — that prefix now redirects (and `/rest/v2/tasks` is a
    // 404), which the connector would refuse as a cross-path redirect rather
    // than follow.
    // Mutation: use `/rest/v2/tasks` from an older note -> red.
    const { connector, calls } = connectorWith([LAST_PAGE([])]);
    await connector.connect();
    await connector.runRead("get_tasks_by_status", {});
    for (const call of calls) {
      const { pathname } = new URL(call.url);
      expect(pathname).toBe(pathname.toLowerCase());
      expect(pathname.startsWith("/api/v1/")).toBe(true);
      expect(pathname.startsWith("/rest/")).toBe(false);
    }
  });
});

// ── the one dataset, read off the wire ──────────────────────────────────────

describe("Todoist task — GET /api/v1/tasks", () => {
  it("🔴 sends NO watermark under ANY spelling, asks for 200 rows, and pages on cursor / next_cursor", async () => {
    const { connector, calls } = connectorWith([
      {
        body: {
          results: [{ ...TASK, id: "t_1" }],
          next_cursor: "14540000435w8hj8pXXwPQJJch.X9DBH8ya2Xenok55",
          // Decoy: proves `rowsPath` is read, not guessed. A profile reading the
          // wrong key would return this row rather than none.
          items: [{ id: "decoy" }],
        },
      },
      LAST_PAGE([{ ...TASK, id: "t_2" }]),
    ]);
    // A scheduled tick passes `since`; Todoist has nowhere to put it.
    const rows = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE }));

    const first = new URL(calls[0]!.url);
    expect(first.host).toBe("api.todoist.com");
    expect(first.pathname).toBe("/api/v1/tasks");

    // 🔴 The verified parameter list for GET /api/v1/tasks is project_id,
    // section_id, parent_id, label, ids, cursor, limit. There is NO
    // last-modified filter. Every plausible spelling is asserted ABSENT,
    // because Todoist would either 400 or silently ignore it — and in the
    // second case the box would report an incremental read over a full scan.
    // Mutation: declare `watermark: { name: "updated_since", ... }` -> red.
    for (const guess of ["since", "updated_since", "modified_after", "updated_after", "after", "from"]) {
      expect(first.searchParams.has(guess), guess).toBe(false);
    }
    // The page size is a CONSTANT query parameter, not a pagination field: the
    // `cursor` arm of `RestPagination` carries exactly `nextCursorPath` and
    // `cursorParam`. Todoist: "Default: 50, Maximum: 200. If you specify a
    // limit greater than 200, the API will return a validation error."
    // Mutation: set `limit: "500"` -> red, and Todoist would 400 anyway.
    expect(first.searchParams.get("limit")).toBe("200");
    expect(TODOIST_PAGE_SIZE).toBe("200");
    expect(first.searchParams.has("cursor")).toBe(false);

    // Page two: the cursor Todoist returned at `next_cursor`, sent back on the
    // `cursor` parameter, with `limit` still attached — the Pagination guide's
    // "Must be used with the same parameters from the previous request".
    const second = new URL(calls[1]!.url);
    expect(second.searchParams.get("cursor")).toBe("14540000435w8hj8pXXwPQJJch.X9DBH8ya2Xenok55");
    expect(second.searchParams.get("limit")).toBe("200");
    expect(calls).toHaveLength(2);

    expect(rows.map((r) => r.task_id)).toEqual(["t_1", "t_2"]);
  });

  it("🔴 declares the watermark NULL, the cursor paths, and the rows path", () => {
    // `null` is a DECLARED full scan (`profile.ts`: "A dataset with no
    // watermark carries `watermark: null` and is swept as a full scan,
    // honestly"). The incremental read Todoist does offer lives on the Sync
    // API (`POST /api/v1/sync` with a `sync_token` form body), which the
    // GET-only track cannot express; that is a future widening, not a reason
    // to guess a query parameter here.
    // Mutation: any non-null watermark -> red here, and the read above goes
    // red on the wire.
    const task = TODOIST_PROFILE.datasets.find((d) => d.dataset === "task")!;
    expect(task.path).toBe("/api/v1/tasks");
    expect(task.watermark).toBeNull();
    expect(task.query).toEqual({ limit: TODOIST_PAGE_SIZE });
    expect(task.pagination).toEqual({
      kind: "cursor",
      nextCursorPath: "next_cursor",
      cursorParam: "cursor",
    });
    expect(task.rowsPath).toBe("results");
  });

  it("🔴 stops on a NULL next_cursor — the documented end-of-results shape", async () => {
    // Pagination guide: `next_cursor` is "a string token for fetching the next
    // page, or null if there are no more results", and the 200 schema makes it
    // REQUIRED (string | null). So `null` is the terminator, and a connector
    // that treated it as "cursor missing, contract broken" would fail every
    // account on its last page.
    const { connector, calls } = connectorWith([LAST_PAGE([TASK])]);
    const rows = await connector.runRead("get_tasks_by_status", {});
    expect(calls).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it("🔴 maps every canonical `task` column, and to the ItemSyncView property the schema names", () => {
    // Nine of nine. This is the profile↔vocabulary join: the keys are pinned
    // by `rest-track.test.ts` to be canonical, and THIS pins which vendor
    // property each one reads.
    const task = TODOIST_PROFILE.datasets.find((d) => d.dataset === "task")!;
    expect(Object.keys(task.fieldMap).sort()).toEqual([...CANONICAL_COLUMNS.task].sort());
    expect(task.fieldMap).toEqual({
      task_id: "id",
      project_id: "project_id",
      created_at: "added_at",
      closed_at: "completed_at",
      title: "content",
      status: "checked",
      priority: "priority",
      assignee_id: "responsible_uid",
      updated_at: "updated_at",
    });
  });

  it("🔴 keeps ids as the opaque strings Todoist issues — never coerced to numbers", async () => {
    // Todoist's Migrating-from-v9 section: ids are "non-number opaque
    // strings" since v1 (`6XGgmFVcrG5RRjVr`), and the old numeric ids are
    // reachable only through an id-mapping endpoint. A `Number()` anywhere in
    // the projection would turn every id into NaN.
    // Mutation: map `task_id` through a numeric coercion -> red.
    const { connector } = connectorWith([LAST_PAGE([TASK])]);
    const row = rowsOf(await connector.runRead("get_tasks_by_status", {}))[0]!;
    expect(row.task_id).toBe("6XGgmFVcrG5RRjVr");
    expect(row.project_id).toBe("6XGgm6PHrGgMpCFX");
    expect(row.assignee_id).toBe("1234567");
    expect(row.title).toBe("Buy milk");
    expect(row.created_at).toBe("2025-01-15T10:30:00.000Z");
    expect(row.updated_at).toBe("2025-01-17T10:30:00.000Z");
  });

  it("🔴 takes assignee_id from `responsible_uid`, NOT from `added_by_uid` or `assigned_by_uid`", async () => {
    // Three user-id fields sit on a task and only one of them is "who this is
    // assigned to". `added_by_uid` is the creator, `assigned_by_uid` is who
    // did the assigning; `responsible_uid` is the assignee, and it is null on
    // a task nobody is responsible for.
    // Mutation: map `assignee_id: "added_by_uid"` -> red on the second row.
    const { connector } = connectorWith([
      LAST_PAGE([
        { ...TASK, id: "t_1", added_by_uid: "creator", assigned_by_uid: "assigner", responsible_uid: "assignee" },
        { ...TASK, id: "t_2", added_by_uid: "creator", assigned_by_uid: null, responsible_uid: null },
      ]),
    ]);
    const rows = rowsOf(await connector.runRead("get_tasks_by_status", {}));
    expect(rows[0]!.assignee_id).toBe("assignee");
    expect("assignee_id" in rows[1]!).toBe(true);
    expect(rows[1]!.assignee_id).toBeUndefined();
  });

  it("🔴 status is the text \"false\" on EVERY row, and get_tasks_by_status {status:\"open\"} finds NOTHING", async () => {
    // THE declared limitation of this profile, pinned so nobody is surprised
    // by it in production.
    //
    // Todoist has no status STRING; its vendor-supplied state is the boolean
    // `checked`. `GET /api/v1/tasks` serves ACTIVE tasks only ("Get all active
    // tasks for the user"), so `checked` is `false` on every row it can ever
    // return, and the canonical text coercion writes that as the string
    // "false". `read-semantics.ts` compares `status` as text, so the
    // documented example `{ status: "open" }` matches ZERO Todoist rows —
    // and `{ status: "false" }` matches all of them.
    //
    // A value mapping (`checked=false` -> "open") would be a profile widening
    // ADR-046 §2 admits only against a verified failure; it is flagged for
    // review, not smuggled in here. Until then this is the honest shape: the
    // vendor's own value, verbatim.
    // Mutation: hardcode `status: "open"` in the projection -> red.
    const { connector } = connectorWith([LAST_PAGE([TASK, { ...TASK, id: "t_2" }])]);
    const all = rowsOf(await connector.runRead("get_tasks_by_status", {}));
    expect(all).toHaveLength(2);
    for (const row of all) expect(row.status).toBe("false");

    const { connector: byOpen } = connectorWith([LAST_PAGE([TASK, { ...TASK, id: "t_2" }])]);
    expect(await byOpen.runRead("get_tasks_by_status", { status: "open" })).toEqual([]);

    const { connector: byFalse } = connectorWith([LAST_PAGE([TASK, { ...TASK, id: "t_2" }])]);
    expect(rowsOf(await byFalse.runRead("get_tasks_by_status", { status: "false" })).map((r) => r.task_id)).toEqual([
      "6XGgmFVcrG5RRjVr",
      "t_2",
    ]);
  });

  it("🔴 closed_at is UNDEFINED on every row — completed tasks never arrive on this feed", async () => {
    // The consequence of "active tasks only": `completed_at` is `null` on
    // every row, and `canonicalInstant(null)` is `undefined`. A task the owner
    // completes between two scans does not arrive with `closed_at` set — it
    // VANISHES from the feed. Completed tasks live on
    // `/api/v1/tasks/completed/by_completion_date`, whose `since` AND `until`
    // are both required and whose `until` must be a moving "now" — a query the
    // constant-only track cannot express, and the profile cannot declare
    // `task` twice. So completed tasks are OUT of this profile, and the
    // connection card says so.
    // Mutation: map `closed_at` to `updated_at` "so the column is filled" ->
    // red; that would date every open task as closed.
    const { connector } = connectorWith([LAST_PAGE([TASK])]);
    const row = rowsOf(await connector.runRead("get_tasks_by_status", {}))[0]!;
    expect("closed_at" in row).toBe(true);
    expect(row.closed_at).toBeUndefined();
  });

  it("🔴 passes priority through VERBATIM — 1 is normal and 4 is urgent, inverted from most trackers", async () => {
    // Todoist's `priority` is an integer 1 (normal) to 4 (urgent) — the
    // REVERSE of the usual "1 = highest". The canonical column is text and
    // this profile does not remap: a "helpful" inversion would silently make
    // every urgent task read as the least important one.
    // Mutation: any remap -> red.
    const { connector } = connectorWith([
      LAST_PAGE([
        { ...TASK, id: "t_normal", priority: 1 },
        { ...TASK, id: "t_urgent", priority: 4 },
      ]),
    ]);
    const rows = rowsOf(await connector.runRead("get_tasks_by_status", {}));
    expect(rows.map((r) => [r.task_id, r.priority])).toEqual([
      ["t_normal", "1"],
      ["t_urgent", "4"],
    ]);
  });

  it("tolerates NULL timestamps — `added_at` and `updated_at` are nullable in the schema", async () => {
    // Both are documented "or null if unknown". A null must land as undefined
    // (the vendor has no value), never as the epoch or as `now` — both of
    // which would put a fabricated instant into a column a sync position
    // trusts.
    const { connector } = connectorWith([LAST_PAGE([{ ...TASK, added_at: null, updated_at: null }])]);
    const row = rowsOf(await connector.runRead("get_tasks_by_status", {}))[0]!;
    expect(row.created_at).toBeUndefined();
    expect(row.updated_at).toBeUndefined();
    expect(row.task_id).toBe("6XGgmFVcrG5RRjVr");
  });

  it("🔴 does NOT tolerate an absent `results` array — that is a Square fact, not a Todoist one", async () => {
    // Square omits the array on an empty result, so its specs declare
    // `absentRowsMeansEmpty`. Todoist's `PaginatedList_ItemSyncView_` makes
    // `results` REQUIRED, so this profile does not — and the difference is
    // load-bearing: with the flag set, a WRONG rowsPath would read as "no
    // tasks" on every page of every sync, which is a confident false statement
    // about an owner's to-do list.
    // Mutation: copy `absentRowsMeansEmpty: true` across "for symmetry" -> red.
    const task = TODOIST_PROFILE.datasets.find((d) => d.dataset === "task")!;
    expect(task.absentRowsMeansEmpty).toBeUndefined();

    const { connector } = connectorWith([{ body: { next_cursor: null } }]);
    await expect(connector.runRead("get_tasks_by_status", {})).rejects.toThrow(RestPaginationContractError);
  });

  it("orders oldest-first by created_at, as get_tasks_by_status documents", async () => {
    // `REST_READ_SEMANTICS.get_tasks_by_status` orders by `created_at` then
    // `task_id` — the item waiting longest is the one worth surfacing. The
    // vendor's own page order (`child_order`) is NOT preserved.
    const { connector } = connectorWith([
      LAST_PAGE([
        { ...TASK, id: "t_newer", added_at: "2025-03-01T00:00:00Z" },
        { ...TASK, id: "t_older", added_at: "2025-01-01T00:00:00Z" },
      ]),
    ]);
    const rows = rowsOf(await connector.runRead("get_tasks_by_status", {}));
    expect(rows.map((r) => r.task_id)).toEqual(["t_older", "t_newer"]);
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * 🔴 ADR-046 §3 and `rest-track.test.ts`'s own header state the rule: **a
 * refusal asserts `fetch` was called ZERO times**, never merely that an error
 * was thrown. A test that inspected only the returned error would still pass
 * if the request had already gone out carrying the owner's token — which for
 * Todoist is a credential that grants access to the WHOLE account.
 */
describe("Todoist — the refusals, each costing ZERO fetch calls", () => {
  /** The real profile with a resolver that yields exactly what is passed. */
  function connectorWithCredentials(creds: Record<string, string>) {
    const { impl, calls } = stubFetch([LAST_PAGE([])]);
    const connector = new RestProfileConnector(
      TODOIST_PROFILE,
      { provider: TODOIST_PROVIDER },
      { fetchImpl: impl, resolveCredentials: async () => creds },
    );
    return { connector, calls };
  }

  it("🔴 refuses a read when the stored credential has no token — ZERO fetch calls", async () => {
    // The shape a real connection reaches this in: the descriptor's field was
    // renamed, or the owner's secret was purged on disconnect and the row
    // survived. Sending the literal `{{token}}` would land in Todoist's logs
    // as a failed auth nobody can explain.
    // Mutation: fall back to "" instead of refusing an empty placeholder ->
    // the request goes out and the call count goes to 1.
    const { connector, calls } = connectorWithCredentials({});
    await expect(connector.runRead("get_tasks_by_status", {})).rejects.toThrow(/has no "token"/);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a blank token as firmly as a missing one — ZERO fetch calls", async () => {
    // Whitespace is what a paste box produces. An empty Authorization header
    // is a request that cannot succeed, and Todoist's 401 comes with
    // `Retry-After` backoff metadata — so spending a call to learn that costs
    // a wait as well as the round trip.
    const { connector, calls } = connectorWithCredentials({ token: "\t \n" });
    await expect(connector.connect()).rejects.toThrow(/has no "token"/);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a dataset Todoist does not serve — ZERO fetch calls, and NOT an empty array", async () => {
    // This profile serves `task` and nothing else. Asked for money, a
    // customer or a booking, the connection refuses by NAME. `[]` would be a
    // confident false statement no caller can tell from a genuinely empty
    // result — and on `get_ar_summary` that statement is about a practice's
    // money.
    // Mutation: make `runRead` fall through to an empty array -> red.
    for (const name of ["get_ar_summary", "get_open_invoices", "get_recent_charges", "get_bookings"]) {
      const { connector, calls } = connectorWithCredentials({ token: TOKEN });
      await expect(connector.runRead(name, { since: SINCE }), name).rejects.toThrow(DatasetNotServedError);
      expect(calls, name).toHaveLength(0);
    }
  });

  it("🔴 refuses every write, and spends no call finding out — the track is read-only", async () => {
    // ADR-046 §4. Todoist HAS a full write API (`POST /api/v1/tasks`,
    // `/close`, `/reopen`) — which is exactly why this matters: the refusal
    // is the track's, not the vendor's, and it costs no request.
    const { connector, calls } = connectorWithCredentials({ token: TOKEN });
    await expect(connector.applyWrite("reschedule_appointment", {})).rejects.toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses to build against a provider id that is not Todoist's — ZERO fetch calls", async () => {
    // A row naming another provider and dispatched to this profile must fail
    // at CONSTRUCTION, before a credential is resolved.
    const { impl, calls } = stubFetch([LAST_PAGE([])]);
    expect(
      () =>
        new RestProfileConnector(
          TODOIST_PROFILE,
          { provider: "todoist-sync" },
          { fetchImpl: impl, resolveCredentials: async () => ({ token: TOKEN }) },
        ),
    ).toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a 302 rather than following it off api.todoist.com", async () => {
    // `fetch` defaults to following redirects, so without `redirect: "error"`
    // the guard would be checking a URL while the answer chose the
    // destination — with the owner's whole-account token attached. And this
    // is not hypothetical for Todoist: the retired `/rest/v2/` and `/sync/v9/`
    // prefixes now answer with a 301 to `/api/v1/`, so a stale path would be
    // followed silently by a connector that did not refuse redirects.
    // EXACTLY ONE call: the redirect was not followed.
    const { connector, calls } = connectorWith([
      { body: {}, status: 302, headers: { location: "https://evil.example.net/api/v1/tasks" } },
    ]);
    await expect(connector.runRead("get_tasks_by_status", {})).rejects.toThrow(UnsafeBaseUrlError);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("api.todoist.com");
  });
});
