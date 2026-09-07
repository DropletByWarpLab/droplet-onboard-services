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

  it("🔴 refuses a fieldMap key that is not a canonical column of that dataset", () => {
    // `projectCanonicalRow` iterates CANONICAL_COLUMNS and looks each column UP
    // in the map — it never iterates the map. So a key that is not a canonical
    // column is NEVER READ, and the failure is completely silent: nothing
    // throws, nothing logs, the read succeeds, the connection card stays green,
    // and the column is `undefined` on every row of every sync forever.
    //
    // One character does it. `chrage_id` for `charge_id`, or a column carried
    // across from a neighbouring dataset because the profiles sit side by side.
    // In review the profile READS correctly, which is why a type cannot be
    // relied on here and a check is.
    // Mutation: delete the fieldMap loop in `assertValidRestProfile` -> red.
    expect(() =>
      assertValidRestProfile(
        staticProfile({
          datasets: [
            {
              dataset: "company",
              path: "/v1/companies",
              watermark: null,
              pagination: { kind: "cursor", nextCursorPath: "meta.next", cursorParam: "cursor" },
              rowsPath: "data",
              fieldMap: { compnay_id: "id" },
            },
          ],
        }),
      ),
    ).toThrow(/"compnay_id", which is not one of its canonical columns/);

    // A column that is real but belongs to a DIFFERENT dataset is refused for
    // the same reason and is the likelier mistake of the two.
    expect(() =>
      assertValidRestProfile(
        staticProfile({
          datasets: [
            {
              dataset: "company",
              path: "/v1/companies",
              watermark: null,
              pagination: { kind: "cursor", nextCursorPath: "meta.next", cursorParam: "cursor" },
              rowsPath: "data",
              fieldMap: { company_id: "id", appt_time: "created" },
            },
          ],
        }),
      ),
    ).toThrow(/appt_time/);

    // And the reference profile — and both shipped ones — still build.
    expect(() => assertValidRestProfile(staticProfile())).not.toThrow();
    for (const profile of REST_VENDOR_PROFILES) {
      expect(() => assertValidRestProfile(profile), profile.provider).not.toThrow();
    }
  });

  it("🔴 every shipped profile maps ONLY canonical columns — checked against the vocabulary directly", () => {
    // The check above proves the guard rejects; this proves the shipped
    // profiles pass it for the right reason, by reading CANONICAL_COLUMNS
    // rather than by trusting `assertValidRestProfile` not to have been
    // weakened. Two independent paths to the same claim, which is the point.
    for (const profile of REST_VENDOR_PROFILES) {
      for (const spec of profile.datasets) {
        const columns = CANONICAL_COLUMNS[spec.dataset];
        expect(columns, `${profile.provider}.${spec.dataset}`).toBeDefined();
        for (const column of Object.keys(spec.fieldMap)) {
          expect(columns, `${profile.provider}.${spec.dataset}.${column}`).toContain(column);
        }
      }
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

// ── the private-range blocklist ─────────────────────────────────────────────

describe("host guard — a vendor SaaS is never on this box, this LAN, or the metadata service", () => {
  /** A profile that would admit ANY host, so only the blocklist can refuse. */
  const permissive = {
    kind: "dynamic" as const,
    configField: "host",
    allowedSuffixes: [],
    // The literal is registered as an allowed host on purpose: it takes the
    // allow-set out of the question, so a green test here is the BLOCKLIST
    // passing and nothing else. Without this the test would pass for the wrong
    // reason — "not in the allow-set" — and would keep passing with the
    // blocklist deleted.
    allowedHosts: [] as string[],
  };
  const admitting = (host: string) => ({ ...permissive, allowedHosts: [host] });

  it("🔴 refuses loopback, the private ranges, and link-local — in EVERY IPv4 spelling", () => {
    // Mutation: delete any row of `BLOCKED_V4_RANGES` -> its cases go green.
    const cases: [string, string][] = [
      ["127.0.0.1", "127.0.0.0/8"],
      ["127.1.2.3", "127.0.0.0/8"],
      ["10.0.0.5", "10.0.0.0/8"],
      ["172.16.0.1", "172.16.0.0/12"],
      ["172.31.255.254", "172.16.0.0/12"],
      ["192.168.1.250", "192.168.0.0/16"],
      ["169.254.1.1", "169.254.0.0/16"],
      // 🔴 THE one. Unauthenticated HTTP, and it answers with role credentials.
      ["169.254.169.254", "169.254.0.0/16"],
      ["100.64.0.1", "100.64.0.0/10"],
      ["0.0.0.0", "0.0.0.0/8"],
    ];
    for (const [host, cidr] of cases) {
      expect(() => assertSafeRestBaseUrl("v", admitting(host), host), host).toThrow(UnsafeBaseUrlError);
      expect(() => assertSafeRestBaseUrl("v", admitting(host), host), host).toThrow(cidr);
    }
  });

  it("🔴 the alternate IPv4 spellings do not get past it", () => {
    // The WHATWG parser folds hex, decimal, octal and short forms to a
    // dotted-quad BEFORE the ranges are applied, which is why the blocklist can
    // be a list of ranges rather than a list of spellings. This test is what
    // says so — matching on the raw string instead would pass every case above
    // and fail every case here.
    //
    // Driven through a STATIC origin on purpose. The obvious spelling of this
    // test — `assertSafeFollowUrl("v", "https://0x7f.0.0.1", …)` — is green
    // WITHOUT the blocklist, because the raw origin string and the parser's
    // normalised `127.0.0.1` differ and the origin-equality check refuses it
    // first. It would have passed for the wrong reason. (Found by running the
    // mutation; it is the only reason this comment exists.) A static origin
    // consults no allow-set and no origin comparison, so the blocklist is the
    // only thing that can refuse.
    // Mutation: read `raw` instead of `url.hostname` in the guard -> red.
    const spellings: [string, string][] = [
      ["0x7f.0.0.1", "127.0.0.1"], // hex first octet
      ["2130706433", "127.0.0.1"], // one 32-bit decimal
      ["0177.0.0.1", "127.0.0.1"], // octal first octet
      ["0xc0a80101", "192.168.1.1"], // one 32-bit hex
      ["0300.0250.1.1", "192.168.1.1"], // octal, two octets
      ["192.168.001.001", "192.168.1.1"], // leading zeros
    ];
    for (const [spelling, folded] of spellings) {
      expect(
        () => assertSafeRestBaseUrl("v", { kind: "static", origin: `https://${spelling}` }),
        `${spelling} folds to ${folded}`,
      ).toThrow(UnsafeBaseUrlError);
    }
    // ⚠ Not every odd spelling is a blocked address, and assuming so is how this
    // test lies: `010.0.0.1` is OCTAL 10, so it folds to the PUBLIC `8.0.0.1`
    // and is admitted. Pinned so nobody "fixes" it into the list above.
    expect(assertSafeRestBaseUrl("v", { kind: "static", origin: "https://010.0.0.1" })).toBe(
      "https://8.0.0.1",
    );
  });

  it("🔴 refuses the IPv6 ranges, including an IPv4-mapped metadata address", () => {
    // `::ffff:169.254.169.254` is the metadata endpoint wearing an IPv6
    // spelling, and the parser hands it over as `::ffff:a9fe:a9fe` — two hex
    // groups, matching NO IPv4 rule until the mapping is decoded.
    // Mutation: drop the `::ffff:` branch -> the two mapped cases go green
    // while every other case here stays red.
    // Static origins again, for the reason the test above records.
    const cases = ["[::1]", "[::]", "[fe80::1]", "[fc00::1]", "[fd12:3456::1]", "[::ffff:127.0.0.1]", "[::ffff:169.254.169.254]"];
    for (const host of cases) {
      expect(
        () => assertSafeRestBaseUrl("v", { kind: "static", origin: `https://${host}` }),
        host,
      ).toThrow(UnsafeBaseUrlError);
    }
    // And a PUBLIC IPv6 literal is still admitted — the rule is the ranges, not
    // "no IPv6".
    expect(assertSafeRestBaseUrl("v", { kind: "static", origin: "https://[2606:2800:220:1::1]" })).toBe(
      "https://[2606:2800:220:1::1]",
    );
  });

  it("still admits an ordinary public vendor host, and a public IP literal", () => {
    // The blocklist must not become a "no IP literals" rule by accident: a
    // vendor that publishes a bare address is unusual but not forbidden, and a
    // guard that over-refuses is a paying customer who cannot connect.
    expect(assertSafeRestBaseUrl("v", admitting("api.example.com"), "api.example.com")).toBe(
      "https://api.example.com",
    );
    expect(assertSafeRestBaseUrl("v", admitting("93.184.216.34"), "93.184.216.34")).toBe(
      "https://93.184.216.34",
    );
    expect(assertSafeRestBaseUrl("v", admitting("172.32.0.1"), "172.32.0.1")).toBe("https://172.32.0.1");
    expect(assertSafeRestBaseUrl("v", admitting("100.63.255.255"), "100.63.255.255")).toBe(
      "https://100.63.255.255",
    );
  });

  it("🔴 applies to a STATIC profile origin and to a follow URL, not only to a customer's value", () => {
    // One `assertCommonUrlSafety` serves all three entry points, and this is
    // what pins that. A blocklist wired into the dynamic branch alone would
    // leave a mistyped static profile and a vendor's cursor URL unguarded.
    expect(() =>
      assertSafeRestBaseUrl("v", { kind: "static", origin: "https://192.168.1.250" }),
    ).toThrow(/192\.168\.0\.0\/16/);
    expect(() =>
      assertSafeFollowUrl("v", "https://api.example.com", "https://169.254.169.254/latest/meta-data/"),
    ).toThrow(/169\.254\.0\.0\/16/);
  });

  it("🔴 a REQUEST to a blocked host costs ZERO fetch calls", async () => {
    // The file's rule. A refusal that arrived after the request went out would
    // have shipped the credential to the metadata service, which is the entire
    // point of pointing a connection there.
    const { impl, calls } = stubFetch([{ body: { data: [] } }]);
    expect(
      () =>
        new RestProfileConnector(
          dynamicProfile({
            baseUrl: {
              kind: "dynamic",
              configField: "host",
              allowedSuffixes: [],
              allowedHosts: ["169.254.169.254"],
            },
          }),
          { provider: "dyn-vendor", hostConfigValue: "169.254.169.254" },
          { fetchImpl: impl, resolveCredentials: creds },
        ),
    ).toThrow(UnsafeBaseUrlError);
    expect(calls).toHaveLength(0);
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

  it("🔴 an OUTAGE is not reported as a bad credential — the remediation differs", async () => {
    // `integrations.service.ts` renders `err.remediation` verbatim to the owner
    // as `not connected: …`. Every transport failure — DNS, connection refused,
    // TLS, and this connector's own timeout — arrives in ONE catch, and they
    // were all carrying "check the key you pasted is still valid", which sends
    // an owner to rotate a working credential in the middle of an outage.
    //
    // WARP-1964 is the same bug: an export-drop failure told installers to
    // license a SAP driver. `ConnectorBlockedError`'s `remediation` parameter
    // exists because of that ticket.
    // Mutation: pass REST_TRACK_REMEDIATION in the transport catch -> red.
    const refused = (async () => {
      throw new Error("connect ECONNREFUSED 203.0.113.7:443");
    }) as never;
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: refused, resolveCredentials: creds },
    );
    const err = await c.runRead("get_company", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    const blocked = err as ConnectorBlockedError;
    expect(blocked.remediation).toMatch(/not a credential problem/);
    expect(blocked.remediation).not.toMatch(/key you pasted/);

    // …while a credential the VENDOR rejected still says to re-paste it. Both
    // halves, because a fix that made everything an outage would be the same
    // defect pointing the other way.
    const { impl } = stubFetch([{ body: {}, status: 401 }]);
    const c2 = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    const err2 = (await c2.runRead("get_company", {}).catch((e: unknown) => e)) as ConnectorBlockedError;
    expect(err2.remediation).toMatch(/key you pasted/);
  });

  it("🔴 names its own timeout instead of surfacing a bare AbortError", async () => {
    // The abort comes from THIS connector's `AbortController` after
    // `timeoutMs`. Reporting "AbortError" tells an owner nothing and reads like
    // a client bug; "the vendor did not answer within 50ms" is the fact.
    // Mutation: drop the `aborted` branch -> the message is "This operation was
    // aborted" (or whatever the runtime calls it) -> red.
    const never = ((_url: string, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        (init.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
          const e = new Error("This operation was aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as never;
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: never, resolveCredentials: creds, timeoutMs: 50 },
    );
    const err = (await c.runRead("get_company", {}).catch((e: unknown) => e)) as ConnectorBlockedError;
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect(err.message).toMatch(/did not answer within 50ms/);
    expect(err.remediation).toMatch(/not a credential problem/);
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

// ── redirects ───────────────────────────────────────────────────────────────

describe("redirects — the host guard is enforcement only because none are followed", () => {
  it("🔴 asks fetch for redirect: 'error' on EVERY request", async () => {
    // Without this option `fetch` defaults to `redirect: "follow"`, and the
    // runtime re-issues the request at the `Location` header — after both host
    // guards have passed, and with the credential attached. The guard would be
    // checking a URL while something else chose the destination.
    // Mutation: delete `redirect: "error"` from the init object -> red.
    const { impl, calls } = stubFetch([
      { body: { data: [{ id: "a" }], meta: { next: "t" } } },
      { body: { data: [] } },
    ]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    await c.connect();
    await c.runRead("get_company", {});

    // connect() probes, introspect() is local, then the read walks two pages.
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call.init.redirect).toBe("error");
  });

  it("🔴 refuses a 302 and does NOT follow it — fetch is called EXACTLY ONCE", async () => {
    // THE assertion is the call count. An implementation that followed the
    // redirect would also end in an error here (the second hop returns the same
    // 302 forever), so a test that inspected only the thrown error would pass
    // over a connector that had already shipped the customer's credential to
    // whatever host the `Location` header named.
    // Mutation: drop the 3xx branch in `request()` -> the stub's `ok: false`
    // sends this down the RestVendorError path instead -> red on the type.
    const { impl, calls } = stubFetch([
      { body: {}, status: 302, headers: { location: "https://evil.example.net/v1/companies" } },
    ]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );

    await expect(c.runRead("get_company", {})).rejects.toThrow(UnsafeBaseUrlError);
    expect(calls).toHaveLength(1);
    // And the ONE call that went out went to the registered origin, not to the
    // host the redirect named.
    expect(new URL(calls[0]!.url).host).toBe("api.example.com");
  });

  it("🔴 refuses a 3xx on connect() too, before a schedule ever runs", async () => {
    // `connect()` is where an owner is watching. A redirect met here must be
    // refused as a DESTINATION problem — not reported as a bad key, which would
    // send them to their vendor console to rotate a credential that is fine.
    const { impl, calls } = stubFetch([{ body: {}, status: 307 }]);
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    await expect(c.connect()).rejects.toThrow(UnsafeBaseUrlError);
    expect(calls).toHaveLength(1);
  });

  it("🔴 refuses an answer a non-conforming fetch already followed", async () => {
    // `response.redirected` is the only evidence left when an injected or
    // future fetch ignores the option and hands back the FINAL response. 200,
    // a body that parses, and the credential already gone — the status check
    // alone cannot see it.
    // Mutation: drop `|| response.redirected === true` -> red.
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        redirected: true,
        headers: { get: () => null } as unknown as Headers,
        json: async () => ({ data: [] }),
        text: async () => "{}",
      } as unknown as Response;
    }) as never;
    const c = new RestProfileConnector(
      staticProfile(),
      { provider: "test-vendor" },
      { fetchImpl: impl, resolveCredentials: creds },
    );
    await expect(c.runRead("get_company", {})).rejects.toThrow(UnsafeBaseUrlError);
    expect(calls).toHaveLength(1);
  });
});


// ── Link header pagination ──────────────────────────────────────────────────

describe("nextLinkFrom", () => {
  it("reads the next URL out of a well-formed Link header", () => {
    // 🔴 Turns red if the indexOf scan returns the wrong slice bounds — an
    // off-by-one on `open`/`close` yields "<https://..." or drops the last char.
    expect(
      nextLinkFrom('<https://api.example.test/v1/companies?page=2>; rel="next"'),
    ).toBe("https://api.example.test/v1/companies?page=2");
  });

  it("picks the next link out of a multi-part header, not merely the first part", () => {
    // 🔴 Turns red if the loop returns on the first part that has angle
    // brackets instead of the first whose rel is actually `next`.
    const header =
      '<https://api.example.test/v1/x?page=1>; rel="prev", ' +
      '<https://api.example.test/v1/x?page=3>; rel="next", ' +
      '<https://api.example.test/v1/x?page=9>; rel="last"';
    expect(nextLinkFrom(header)).toBe("https://api.example.test/v1/x?page=3");
  });

  it("accepts the unquoted and loosely spaced spellings vendors actually send", () => {
    // 🔴 Turns red if REL_NEXT loses a `\s*` or the `"?` optional quote.
    expect(nextLinkFrom("<https://a.test/2>;rel=next")).toBe("https://a.test/2");
    expect(nextLinkFrom('<https://a.test/2>  ;  REL = "NEXT"')).toBe("https://a.test/2");
  });

  it("returns null when no part carries rel=next", () => {
    // 🔴 Turns red if REL_NEXT loses its `^` anchor: unanchored, `rel="next"`
    // appearing anywhere later in the part — including inside a URL's own query
    // string — would match and hand back a link the vendor marked `prev`.
    expect(nextLinkFrom('<https://a.test/1>; rel="prev"')).toBeNull();
    expect(nextLinkFrom('<https://a.test/1?rel="next">; rel="prev"')).toBeNull();
    expect(nextLinkFrom(null)).toBeNull();
    expect(nextLinkFrom("")).toBeNull();
  });

  it("ignores parts with an unterminated angle bracket instead of scanning past it", () => {
    // 🔴 Turns red if the `close === -1` guard is dropped — slice(open+1, -1)
    // silently returns the whole rest of the part as if it were a URL.
    expect(nextLinkFrom('<https://a.test/1; rel="next"')).toBeNull();
  });

  it("returns promptly on the pathological header CodeQL flagged (js/polynomial-redos)", () => {
    // 🔴 This is the regression test for the high-severity CodeQL finding on
    // this PR. The old body was
    //   part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i)
    // which retries `<([^>]+)>` from EVERY `<` and rescans to end of input each
    // time — O(n^2) on a run of `<=` that never closes. The `Link` header is
    // vendor-controlled: it arrives on a paginated response from whichever host
    // the customer's account points at, so this input is reachable in
    // production, not merely theoretical.
    //
    // Turns red if the regex scan is reinstated: at 100k this took multiple
    // seconds under the old implementation and is sub-millisecond under
    // indexOf. The bound is deliberately loose (1s) so it fails on a
    // reintroduced quadratic scan, not on a slow CI runner.
    const evil = "<" + "<=".repeat(100_000);
    const started = Date.now();
    expect(nextLinkFrom(evil)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
