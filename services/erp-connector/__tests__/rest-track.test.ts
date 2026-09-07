/**
 * WARP-2707 / ADR-046 — the declarative REST track.
 *
 * ## Why this file is bigger than any single connector's suite
 *
 * ADR-046's Consequences section states the trade it makes openly: *"A bug in
 * the shared connector is a bug in every vendor at once. The blast radius
 * inverts: today a Mailchimp defect is a Mailchimp defect. This is the standing
 * argument for the track's own test suite being heavier than any single
 * connector's."* This file is that argument, discharged.
 *
 * ## The rule every guard test obeys
 *
 * 🔴 **Refusals assert `fetch` was called ZERO times.** Never merely that an
 * error was thrown. Ten of the surveyed vendors assemble their host per
 * account; for every one of them `allowed-egress.yaml` carries a `kind: dynamic`
 * entry that contributes ZERO host patterns to
 * `scripts/check-egress-allowlist.py`, so nothing in CI verifies where this
 * connector dials. `assertSafeRestBaseUrl` is the entire control. A test that
 * inspected only the returned error would still pass if the request had already
 * gone out carrying the customer's credential.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, expect, it } from "vitest";

import {
  assertValidRestProfile,
  authPlaceholders,
  InvalidRestProfileError,
  type RestVendorProfile,
} from "../src/rest/profile.js";
import {
  assertHostConfigValue,
  assertSafeFollowUrl,
  assertSafeRestBaseUrl,
  UnsafeBaseUrlError,
} from "../src/rest/host-guard.js";
import {
  applyRestReadFilter,
  applyRestReadOrder,
  REST_READ_SEMANTICS,
  restReadSemantics,
} from "../src/rest/read-semantics.js";
import {
  formatWatermark,
  nextLinkFrom,
  readPath,
  RestPaginationContractError,
  RestProfileConnector,
  RestVendorError,
  REST_MAX_PAGES,
} from "../src/rest/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { UnknownWriteCommandError } from "../src/write-commands.js";
import { CANONICAL_COLUMNS } from "../src/export-drop/profiles.js";
import { getReadQuery } from "../src/read-queries.js";
import { REST_VENDOR_PROFILES } from "../src/rest/profiles.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A recording fetch stub. Every test asserts on `calls`, not only on returns. */
function stubFetch(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const page = pages[Math.min(n, pages.length - 1)];
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

/** A minimal valid static profile serving `company`. */
function staticProfile(over: Partial<RestVendorProfile> = {}): RestVendorProfile {
  return {
    provider: "test-vendor",
    baseUrl: { kind: "static", origin: "https://api.example.com" },
    auth: { headerName: "Authorization", valueTemplate: "Bearer {{token}}" },
    constantHeaders: { "X-Api-Version": "2026-01-01" },
    probePath: "/v1/me",
    datasets: [
      {
        dataset: "company",
        path: "/v1/companies",
        watermark: { name: "updated_since", location: "query", format: "iso", complete: true },
        pagination: { kind: "cursor", nextCursorPath: "meta.next", cursorParam: "cursor" },
        rowsPath: "data",
        fieldMap: { company_id: "id", name: "attributes.name", updated_at: "attributes.updated" },
      },
    ],
    ...over,
  };
}

/** A dynamic-host profile, in the Pipedrive shape. */
function dynamicProfile(over: Partial<RestVendorProfile> = {}): RestVendorProfile {
  return {
    ...staticProfile(),
    provider: "dyn-vendor",
    baseUrl: {
      kind: "dynamic",
      configField: "companyDomain",
      allowedSuffixes: [".example.com"],
      allowedHosts: [],
    },
    ...over,
  };
}

const creds = async () => ({ token: "secret-key" });

// ── profile validation ──────────────────────────────────────────────────────

describe("profile validation — a malformed profile fails to BUILD, not on first read", () => {
  it("accepts the reference static profile", () => {
    expect(() => assertValidRestProfile(staticProfile())).not.toThrow();
  });

  it("reads every {{placeholder}} out of an auth template, in order", () => {
    // Open Dental's shape was the motivating case: two secrets in ONE header.
    // Mutation: return only the first match -> this goes red.
    expect(
      authPlaceholders({ headerName: "Authorization", valueTemplate: "ODFHIR {{developerKey}}/{{customerKey}}" }),
    ).toEqual(["developerKey", "customerKey"]);
  });

  it("refuses an auth template with no placeholder — it would send no credential", () => {
    // Mutation: drop the placeholder check -> a profile that authenticates with
    // a constant string ships, and every request is anonymous.
    expect(() =>
      assertValidRestProfile(staticProfile({ auth: { headerName: "Authorization", valueTemplate: "Bearer" } })),
    ).toThrow(InvalidRestProfileError);
  });

  it("refuses a non-https static origin", () => {
    expect(() =>
      assertValidRestProfile(staticProfile({ baseUrl: { kind: "static", origin: "http://api.example.com" } })),
    ).toThrow(/https/);
  });

  it("refuses a static origin carrying a path — it would silently prefix every dataset", () => {
    expect(() =>
      assertValidRestProfile(staticProfile({ baseUrl: { kind: "static", origin: "https://api.example.com/v2" } })),
    ).toThrow(/bare origin/);
  });

  it("🔴 refuses a dynamic host with an EMPTY allow-set", () => {
    // This is the one that matters most. An empty guard is an unconstrained
    // destination — exactly what `kind: dynamic` exists to prevent. Absence is
    // never a silent allow.
    // Mutation: default the empty case to "allow" -> this goes red.
    expect(() =>
      assertValidRestProfile(
        dynamicProfile({
          baseUrl: { kind: "dynamic", configField: "d", allowedSuffixes: [], allowedHosts: [] },
        }),
      ),
    ).toThrow(/at least one allowed host or suffix/);
  });

  it("refuses a host suffix written as a URL, or without its leading dot", () => {
    for (const bad of ["example.com", "https://.example.com", ".exam/ple.com"]) {
      expect(() =>
        assertValidRestProfile(
          dynamicProfile({
            baseUrl: { kind: "dynamic", configField: "d", allowedSuffixes: [bad], allowedHosts: [] },
          }),
        ),
      ).toThrow(InvalidRestProfileError);
    }
  });

  it("refuses a profile serving no datasets, and one declaring a dataset twice", () => {
    expect(() => assertValidRestProfile(staticProfile({ datasets: [] }))).toThrow(/no datasets/);
    const one = staticProfile().datasets[0]!;
    expect(() => assertValidRestProfile(staticProfile({ datasets: [one, one] }))).toThrow(/twice/);
  });
});

// ── the host guard ──────────────────────────────────────────────────────────

describe("host guard — the ONLY enforcement for a dynamic destination", () => {
  it("returns a normalised origin for a static profile", () => {
    expect(assertSafeRestBaseUrl("v", { kind: "static", origin: "https://api.example.com" })).toBe(
      "https://api.example.com",
    );
  });

  it("completes a bare label with the declared suffix", () => {
    expect(assertSafeRestBaseUrl("v", dynamicProfile().baseUrl, "acme")).toBe("https://acme.example.com");
  });

  it("🔴 refuses a host that merely ENDS WITH the suffix", () => {
    // `endsWith(".example.com")` admits `example.com.evil.example.com` from
    // anyone who controls a subdomain. A suffix test is not a host test.
    // Mutation: swap the anchored pattern for endsWith -> this goes red.
    expect(() =>
      assertSafeRestBaseUrl("v", dynamicProfile().baseUrl, "acme.example.com.evil.com"),
    ).toThrow(UnsafeBaseUrlError);
  });

  it("🔴 refuses a multi-label host under the suffix", () => {
    // `a.b.example.com` is not a customer subdomain; admitting it widens the
    // grant to every nested name the suffix owner ever delegates.
    expect(() => assertSafeRestBaseUrl("v", dynamicProfile().baseUrl, "a.b.example.com")).toThrow(
      UnsafeBaseUrlError,
    );
  });

  it("refuses userinfo, a non-https scheme, and a non-443 port", () => {
    const base = { kind: "static" as const, origin: "https://api.example.com@evil.com" };
    expect(() => assertSafeRestBaseUrl("v", base)).toThrow(UnsafeBaseUrlError);
    expect(() => assertSafeRestBaseUrl("v", { kind: "static", origin: "http://api.example.com" })).toThrow(
      /not https/,
    );
    expect(() => assertSafeRestBaseUrl("v", { kind: "static", origin: "https://api.example.com:8443" })).toThrow(
      /443 only/,
    );
  });

  it("refuses a dynamic profile with no supplied host value, rather than sampling a region", () => {
    expect(() => assertSafeRestBaseUrl("v", dynamicProfile().baseUrl, undefined)).toThrow(
      /supplies no "companyDomain"/,
    );
  });

  it("refuses a config value that is a URL rather than a host", () => {
    for (const bad of ["https://acme.example.com", "acme.example.com/x", "a@b", "acme:443", ""]) {
      expect(() => assertHostConfigValue("v", bad)).toThrow(UnsafeBaseUrlError);
    }
  });

  it("admits an exact host from allowedHosts even when no suffix matches", () => {
    const base = {
      kind: "dynamic" as const,
      configField: "dc",
      allowedSuffixes: [],
      allowedHosts: ["www.zohoapis.eu", "www.zohoapis.com"],
    };
    expect(assertSafeRestBaseUrl("v", base, "www.zohoapis.eu")).toBe("https://www.zohoapis.eu");
    expect(() => assertSafeRestBaseUrl("v", base, "www.zohoapis.cn")).toThrow(UnsafeBaseUrlError);
  });

  it("🔴 refuses a pagination link that points at another host", () => {
    // `Link:` is VENDOR-CONTROLLED input. A cross-host next-page URL is the
    // obvious way to walk a customer's credential off the registered
    // destination, and it would look like normal pagination in every log.
    expect(() => assertSafeFollowUrl("v", "https://api.example.com", "https://evil.com/next")).toThrow(
      /pagination link pointed at/,
    );
    expect(assertSafeFollowUrl("v", "https://api.example.com", "https://api.example.com/v1/x?page=2")).toContain(
      "page=2",
    );
  });
});

// ── read semantics ──────────────────────────────────────────────────────────

describe("read semantics — the named queries as data over canonical rows", () => {
  it("🔴 every declared column exists in CANONICAL_COLUMNS for its dataset", () => {
    // The table LOOKS right next to the column map; this is what makes it right.
    // Mutation: rename any column in the table -> this goes red.
    for (const [name, semantics] of Object.entries(REST_READ_SEMANTICS)) {
      const columns = CANONICAL_COLUMNS[semantics.dataset];
      const referenced: string[] = [...semantics.orderBy];
      const f = semantics.filter;
      if (f.kind === "prefix" || f.kind === "equals" || f.kind === "atMost") referenced.push(f.column);
      if (f.kind === "window") referenced.push(f.column);
      if (f.kind === "equalsBoth") referenced.push(f.first.column, f.second.column);
      for (const column of referenced) {
        expect(columns, `${name} -> ${semantics.dataset}.${column}`).toContain(column);
      }
    }
  });

  it("🔴 every entry's dataset matches that read query's real dependsOnTables", () => {
    // Reads the REAL registry, not a copy of it.
    for (const [name, semantics] of Object.entries(REST_READ_SEMANTICS)) {
      expect(getReadQuery(name).dependsOnTables, name).toEqual([semantics.dataset]);
    }
  });

  it("leaves get_recall_due deliberately unserved", () => {
    // `recall` is not one of the twenty-three canonical datasets. Absent by
    // decision, and a REST connection asked for it raises DatasetNotServedError
    // rather than returning [].
    expect(restReadSemantics("get_recall_due")).toBeUndefined();
  });

  it("prefix-matches case-insensitively, and treats an absent term as 'all'", () => {
    const rows = [{ last_name: "Smith" }, { last_name: "smithers" }, { last_name: "Jones" }];
    const f = { kind: "prefix" as const, column: "last_name", param: "query" };
    expect(applyRestReadFilter(rows, f, { query: "SMI" })).toHaveLength(2);
    // Matches `escapeLike("")` -> `LIKE '%'` on the LAN track.
    expect(applyRestReadFilter(rows, f, {})).toHaveLength(3);
  });

  it("🔴 windows are HALF-OPEN, so adjacent windows never double-count money", () => {
    // Mutation: make the upper bound inclusive -> a charge at exactly the
    // boundary appears in both August and September, and revenue is overstated.
    const rows = [{ created_at: "2026-09-01T00:00:00Z" }];
    const f = { kind: "window" as const, column: "created_at" };
    expect(
      applyRestReadFilter(rows, f, { from: "2026-08-01T00:00:00Z", to: "2026-09-01T00:00:00Z" }),
    ).toHaveLength(0);
    expect(
      applyRestReadFilter(rows, f, { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" }),
    ).toHaveLength(1);
  });

  it("🔴 refuses an unparseable window bound rather than widening to everything", () => {
    // Silently ignoring a bad date turns "August revenue" into "all revenue".
    expect(() =>
      applyRestReadFilter([{ created_at: "2026-09-01T00:00:00Z" }], { kind: "window", column: "created_at" }, {
        from: "last tuesday",
      }),
    ).toThrow(RangeError);
  });

  it("drops rows whose filtered column is undefined, as SQL does with NULL", () => {
    // Keeping them "just in case" would put a row with no created_at into every
    // date window at once.
    const rows = [{ created_at: undefined }, { created_at: "2026-08-15T00:00:00Z" }];
    expect(
      applyRestReadFilter(rows, { kind: "window", column: "created_at" }, { from: "2026-08-01T00:00:00Z" }),
    ).toHaveLength(1);
  });

  it("sorts numerically where both values are numbers, and puts undefined last", () => {
    const rows = [{ inventory_quantity: 10 }, { inventory_quantity: 9 }, { inventory_quantity: undefined }];
    const sorted = applyRestReadOrder(rows, ["inventory_quantity"]);
    // Mutation: compare as text -> "10" sorts before "9" and this goes red.
    expect(sorted.map((r) => r.inventory_quantity)).toEqual([9, 10, undefined]);
  });
});

// ── the connector ───────────────────────────────────────────────────────────

describe("RestProfileConnector", () => {
  it("readPath walks a dotted path, and '' means the body itself", () => {
    expect(readPath({ a: { b: [1] } }, "a.b")).toEqual([1]);
    expect(readPath([1, 2], "")).toEqual([1, 2]);
    expect(readPath({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  it("🔴 indexes arrays with BRACKETS, not a bare numeric segment", () => {
    // Two reasons, and the second is a real CI failure rather than taste:
    // `hosts.0.id` is a HOSTNAME to check-egress-allowlist.py, because `.id`
    // is a real ICANN TLD — the bare-host pass extracts it out of the field
    // map's string literal and fails the egress gate.
    // Mutation: drop the bracket branch -> Cal.com's provider_id goes undefined.
    const body = { hosts: [{ id: 7 }, { id: 9 }], a: { b: [{ c: "x" }] } };
    expect(readPath(body, "hosts[0].id")).toBe(7);
    expect(readPath(body, "hosts[1].id")).toBe(9);
    expect(readPath(body, "a.b[0].c")).toBe("x");
    // Out of range is undefined, never a throw and never element 0.
    expect(readPath(body, "hosts[5].id")).toBeUndefined();
    // A bare numeric segment still works — JS arrays are objects — so existing
    // paths are unaffected; brackets are the spelling profiles must USE.
    expect(readPath(body, "hosts.0.id")).toBe(7);
  });

  it("🔴 no shipped profile writes a path the egress scanner reads as a host", () => {
    // The gate only sees git-TRACKED files, so a green local run on a branch
    // with new untracked files is a false green. This asserts the property
    // directly instead of relying on that run.
    // Mutation: change any fieldMap path back to `a.0.b` -> red here.
    for (const profile of REST_VENDOR_PROFILES) {
      for (const spec of profile.datasets) {
        for (const [column, source] of Object.entries(spec.fieldMap)) {
          const path = typeof source === "string" ? source : source.path;
          expect(
            /\.\d+(\.|$)/.test(path),
            `${profile.provider}.${spec.dataset}.${column} = "${path}" — use brackets: a[0].b`,
          ).toBe(false);
        }
      }
    }
  });

  it("formats a watermark per the endpoint's declared format", () => {
    const iso = "2026-09-07T10:30:00.000Z";
    expect(formatWatermark(iso, "iso")).toBe(iso);
    // Lossy on purpose — GitLab's events `after` takes a date.
    expect(formatWatermark(iso, "date")).toBe("2026-09-07");
    expect(formatWatermark(iso, "epoch-seconds")).toBe(String(Date.parse(iso) / 1000));
    expect(formatWatermark(iso, "http-date")).toContain("GMT");
  });

  it("parses rel=next out of a Link header and ignores rel=prev", () => {
    expect(nextLinkFrom('<https://a/1>; rel="prev", <https://a/2>; rel="next"')).toBe("https://a/2");
    expect(nextLinkFrom('<https://a/1>; rel="prev"')).toBeNull();
    expect(nextLinkFrom(null)).toBeNull();
  });

  it("🔴 refuses to construct against a destination it will not dial — ZERO fetch calls", () => {
    const { impl, calls } = stubFetch([{ body: { data: [] } }]);
    expect(
      () =>
        new RestProfileConnector(dynamicProfile(), { provider: "dyn-vendor", hostConfigValue: "evil.com" }, {
          fetchImpl: impl,
          resolveCredentials: creds,
        }),
    ).toThrow(UnsafeBaseUrlError);
    // THE assertion. Inspecting only the thrown error would still pass if the
    // request had already gone out carrying the customer's key.
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a profile whose id disagrees with the connection's — ZERO fetch calls", () => {
    const { impl, calls } = stubFetch([{ body: { data: [] } }]);
    expect(
      () => new RestProfileConnector(staticProfile(), { provider: "other" }, { fetchImpl: impl }),
    ).toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses when a credential placeholder has no stored value — ZERO fetch calls", () => {
    // Otherwise the literal `{{token}}` goes out on the wire and lands in the
    // vendor's logs as a failed auth nobody can explain.
    const { impl, calls } = stubFetch([{ body: { data: [] } }]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: async () => ({}) },
    );
    return expect(c.connect()).rejects.toThrow(ConnectorBlockedError).then(() => {
      expect(calls).toHaveLength(0);
    });
  });

  it("sends the auth header, the constant headers, and the watermark as declared", async () => {
    const { impl, calls } = stubFetch([{ body: { data: [{ id: "c1", attributes: { name: "Acme" } }] } }]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    await c.runRead("get_company", { since: "2026-09-01T00:00:00Z" });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toContain("https://api.example.com/v1/companies");
    // Mutation: drop the watermark from the query -> full scan reported as
    // an incremental read, exactly the ADR-046 §2 failure.
    expect(url).toContain("updated_since=2026-09-01T00%3A00%3A00.000Z");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
    expect(headers["X-Api-Version"]).toBe("2026-01-01");
  });

  it("puts a header-located watermark in the HEADERS, not the query", async () => {
    // Zoho's is `If-Modified-Since`. A query-only design would full-scan Zoho
    // forever and report it as incremental.
    const profile = staticProfile();
    const withHeaderWatermark: RestVendorProfile = {
      ...profile,
      datasets: [
        {
          ...profile.datasets[0]!,
          watermark: { name: "If-Modified-Since", location: "header", format: "http-date", complete: true },
        },
      ],
    };
    const { impl, calls } = stubFetch([{ body: { data: [] } }]);
    const c = new RestProfileConnector(
      withHeaderWatermark,
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    await c.runRead("get_company", { since: "2026-09-01T00:00:00Z" });
    expect(calls[0]!.url).not.toContain("If-Modified-Since");
    expect((calls[0]!.init.headers as Record<string, string>)["If-Modified-Since"]).toContain("GMT");
  });

  it("projects vendor rows onto exactly CANONICAL_COLUMNS, leaving unmapped columns undefined", async () => {
    const { impl } = stubFetch([
      { body: { data: [{ id: "c1", attributes: { name: "Acme", updated: "2026-09-02T00:00:00Z" } }] } },
    ]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    const rows = (await c.runRead("get_company", {})) as Record<string, unknown>[];
    expect(Object.keys(rows[0]!).sort()).toEqual([...CANONICAL_COLUMNS.company].sort());
    expect(rows[0]!.company_id).toBe("c1");
    expect(rows[0]!.name).toBe("Acme");
    // `domain` is not in the fieldMap. Undefined is the honest representation of
    // "this vendor does not carry that fact" — never a fabricated default.
    expect(rows[0]!.domain).toBeUndefined();
  });

  it("follows a body cursor until it is absent", async () => {
    const { impl, calls } = stubFetch([
      { body: { data: [{ id: "a" }], meta: { next: "tok1" } } },
      { body: { data: [{ id: "b" }], meta: {} } },
    ]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    const rows = await c.runRead("get_company", {});
    expect(rows).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("cursor=tok1");
  });

  it("stops limit-offset paging on a short page, and advances the offset by rows read", async () => {
    const profile = staticProfile();
    const lo: RestVendorProfile = {
      ...profile,
      datasets: [
        {
          ...profile.datasets[0]!,
          pagination: { kind: "limit-offset", limitParam: "Limit", offsetParam: "Offset", pageSize: 2 },
        },
      ],
    };
    const { impl, calls } = stubFetch([
      { body: { data: [{ id: "a" }, { id: "b" }] } },
      { body: { data: [{ id: "c" }] } },
    ]);
    const c = new RestProfileConnector(lo, { provider: "test-vendor" }, { fetchImpl: impl, resolveCredentials: creds });
    expect(await c.runRead("get_company", {})).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("Offset=0");
    expect(calls[1]!.url).toContain("Offset=2");
  });

  it("🔴 reports a non-terminating pagination rather than truncating silently", async () => {
    // A vendor whose cursor never clears would otherwise spin against the
    // customer's rate ceiling forever, or return a partial read that looks
    // complete. ADR-046's "no silent caps" rule.
    const { impl, calls } = stubFetch([{ body: { data: [{ id: "a" }], meta: { next: "same" } } }]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    await expect(c.runRead("get_company", {})).rejects.toThrow(RestPaginationContractError);
    expect(calls).toHaveLength(REST_MAX_PAGES);
  });

  it("reports a body with no array at the declared rowsPath", async () => {
    // Wrong here means zero rows reported as a successful empty read.
    const { impl } = stubFetch([{ body: { data: { not: "an array" } } }]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    await expect(c.runRead("get_company", {})).rejects.toThrow(/no array at "data"/);
  });

  it("distinguishes a rejected credential from an outage", async () => {
    // This is what lets the hub say "paste a new key" instead of "can't connect".
    const { impl } = stubFetch([{ body: {}, status: 401 }]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    await expect(c.runRead("get_company", {})).rejects.toThrow(ConnectorBlockedError);

    const other = stubFetch([{ body: { error: "boom" }, status: 503 }]);
    const c2 = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: other.impl, resolveCredentials: creds },
    );
    await expect(c2.runRead("get_company", {})).rejects.toThrow(RestVendorError);
  });

  it("🔴 refuses a read whose dataset this profile does not serve", async () => {
    // NOT an empty array: `[]` from a money query reads as a confident false
    // statement about money that no caller can tell from a genuinely empty one.
    const { impl, calls } = stubFetch([{ body: { data: [] } }]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    await expect(c.runRead("get_open_invoices", {})).rejects.toThrow(DatasetNotServedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 applyWrite ALWAYS throws for a REAL command — the track is read-only by construction", async () => {
    // ADR-046 §4. There is no profile field that could turn this on; the
    // absence is the enforcement.
    const { impl, calls } = stubFetch([{ body: {} }]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    await expect(c.applyWrite("reschedule_appointment", {})).rejects.toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("validates an unknown write command through the REGISTRY before refusing the track", async () => {
    // Order matters: a caller with a typo must be told their command does not
    // exist, not that this track is read-only. Same order as every other
    // track, so one caller bug produces one typed error everywhere.
    // Mutation: throw ConnectorBlockedError first -> this goes red.
    const { impl } = stubFetch([{ body: {} }]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    await expect(c.applyWrite("no_such_command", {})).rejects.toThrow(UnknownWriteCommandError);
  });

  it("paces against a declared minimum interval, and does not pace without one", async () => {
    const slept: number[] = [];
    let clock = 0;
    const { impl } = stubFetch([{ body: { data: [{ id: "a" }], meta: { next: "t" } } }, { body: { data: [] } }]);
    const c = new RestProfileConnector(
      staticProfile({ minRequestIntervalMs: 5000 }),
      { provider: "test-vendor" },
      {
        fetchImpl: impl,
        resolveCredentials: creds,
        now: () => clock,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
      },
    );
    await c.runRead("get_company", {});
    // Pacing is a WAIT, never a refusal: a refusal would make a slow sync
    // incomplete, which is worse than making it slow.
    expect(slept).toEqual([5000]);
  });

  it("fingerprints the CANONICAL SHAPE served — and is explicit about what it cannot see", async () => {
    const { impl } = stubFetch([{ body: { data: [] } }]);
    const build = (p: RestVendorProfile) =>
      new RestProfileConnector(p, { provider: p.provider }, { fetchImpl: impl, resolveCredentials: creds });
    const base = staticProfile();
    const a = await build(base).introspect();
    expect((await build(staticProfile()).introspect()).fingerprint).toBe(a.fingerprint);
    // No schema owner exists on a REST vendor; the provider id is the truthful
    // namespace. An invented "dba" would read as a database this has no access to.
    expect(a.tables[0]!.owner).toBe("test-vendor");

    // 🔴 A CHANGED PATH DOES NOT MOVE IT, and that is the documented contract
    // rather than a defect. `computeSchemaFingerprint` hashes the datasets and
    // their canonical columns — the same thing it hashes on a LAN track. There
    // is no live catalog to introspect on a REST vendor, so nothing here can
    // observe a vendor moving an endpoint under a stable profile; only the
    // per-vendor tests that cite the vendor's documentation can.
    const movedPath = await build({
      ...base,
      datasets: [{ ...base.datasets[0]!, path: "/v2/companies" }],
    }).introspect();
    expect(movedPath.fingerprint).toBe(a.fingerprint);

    // What it DOES catch: this connection no longer serving the same datasets.
    const movedDataset = await build({
      ...base,
      datasets: [{ ...base.datasets[0]!, dataset: "contact", fieldMap: { contact_id: "id" } }],
    }).introspect();
    expect(movedDataset.fingerprint).not.toBe(a.fingerprint);
  });
});
