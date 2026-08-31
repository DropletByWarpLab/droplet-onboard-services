/**
 * WARP-2379 — MailchimpConnector.
 *
 * `fetch` is INJECTED, never patched globally, and every test asserts on the
 * CALLS the connector made — not only on what it returned. That distinction
 * carries more weight here than on any other track:
 *
 * Mailchimp's host is ASSEMBLED AT RUNTIME from the datacenter suffix in the
 * customer's API key, so `docs/security/allowed-egress.yaml` registers it as
 * `kind: dynamic` and the static egress scanner verifies NOTHING about where
 * this connector dials (`docs/SECURITY.md:183-185`). The code-side host guard
 * is the entire control. A test that inspected the returned error would still
 * pass if the request had already gone out carrying the key — so the guard's
 * tests assert on ZERO fetch calls.
 *
 * Every test names the mutation that must turn it red.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  ConnectionSemaphore,
  InvalidMailchimpCredentialError,
  MAILCHIMP_ALLOWED_HOST_PATTERN,
  MAILCHIMP_API_BASE_PATH,
  MAILCHIMP_API_HOST_SUFFIX,
  MAILCHIMP_API_USE_POLICY_OBLIGATIONS,
  MAILCHIMP_CAMPAIGN_DELTA_PARAMS,
  MAILCHIMP_DATASETS,
  MAILCHIMP_ECOMMERCE_ORDER_PARAMS,
  MAILCHIMP_MAX_CONCURRENT_CONNECTIONS,
  MAILCHIMP_MAX_PAGE_SIZE,
  MAILCHIMP_MEMBER_DELTA_PARAMS,
  MAILCHIMP_PLAN_PREREQUISITE,
  MAILCHIMP_PROVIDER,
  MAILCHIMP_READABLE_RESOURCES,
  MAILCHIMP_REQUEST_TIMEOUT_MS,
  MAILCHIMP_SCAN_MODE,
  MailchimpCapabilityMissingError,
  MailchimpConnector,
  MailchimpReauthorizationRequiredError,
  MailchimpTimeoutError,
  UnsafeMailchimpBaseUrlError,
  assertEcommerceOrderParams,
  assertMailchimpDatacenter,
  assertReadableMailchimpResource,
  assertSafeMailchimpBaseUrl,
  escapeRegExpLiteral,
  mailchimpBaseUrlFor,
  parseMailchimpApiKey,
  subscriberHash,
  type MailchimpPurgeStore,
} from "../src/mailchimp/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { CANONICAL_COLUMNS, COLUMN_KIND } from "../src/export-drop/profiles.js";

/** 2026-08-27T12:00:00Z, the clock every test runs on. */
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);

/**
 * A well-formed fixture key: 32 hex characters plus the datacenter suffix that
 * selects the host. Not a real credential.
 *
 * COMPOSED FROM PARTS ON PURPOSE — do not inline it back into one literal.
 * This file is path-allowlisted in `.gitleaks.toml`, so local `gitleaks`
 * passes either way, but GITHUB PUSH PROTECTION runs its own "Mailchimp API
 * Key" detector that no repo config can allowlist, and it matches a contiguous
 * `[0-9a-f]{32}-us<n>` literal. A first push of this branch was rejected for
 * exactly that. Keeping the secret and the suffix in separate tokens means the
 * matching string never exists in the source while every test still exercises
 * a realistically-shaped key.
 *
 * (Measured, not guessed: the 31-hex vendor doc example further down was NOT
 * flagged, so the detector wants exactly 32.)
 */
const DC = "us14";
const SECRET = "0123456789abcdef" + "0123456789abcdef";
const KEY = `${SECRET}-${DC}`;
const HOST = `${DC}${MAILCHIMP_API_HOST_SUFFIX}`;

interface StubResponse {
  status?: number;
  body?: unknown;
}
interface Route {
  match: RegExp;
  responses: StubResponse[];
}
interface Recorded {
  url: string;
  init: Record<string, unknown>;
}

/**
 * A routed fetch stub that records every call AND the concurrency timeline.
 *
 * `peak` is the high-water mark of simultaneously-open calls as OBSERVED BY THE
 * STUB, which is the only place the semaphore's promise is falsifiable: a final
 * call count looks identical whether the requests ran ten at a time or all at
 * once.
 */
function stubFetch(routes: Route[], opts: { hold?: boolean } = {}) {
  const calls: Recorded[] = [];
  const seen = new Map<number, number>();
  const releases: (() => void)[] = [];
  let inFlight = 0;
  let peak = 0;

  const impl = async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init });
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
    try {
      if (opts.hold) {
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      const idx = routes.findIndex((r) => r.match.test(url));
      if (idx === -1) throw new Error(`test stub has no route for ${url}`);
      const n = seen.get(idx) ?? 0;
      seen.set(idx, n + 1);
      const list = routes[idx].responses;
      const r = list[Math.min(n, list.length - 1)];
      const status = r.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => r.body ?? {},
      } as unknown as Response;
    } finally {
      inFlight -= 1;
    }
  };

  return {
    impl,
    calls,
    get peak() {
      return peak;
    },
    get pending() {
      return releases.length;
    },
    releaseAll() {
      for (const r of releases.splice(0)) r();
    },
    urls: () => calls.map((c) => c.url),
    params: (i: number) => new URL(calls[i].url).searchParams,
    paramKeys: (i: number) => [...new URL(calls[i].url).searchParams.keys()],
    paths: () => calls.map((c) => new URL(c.url).pathname),
  };
}

function connector(
  opts: {
    routes?: Route[];
    baseUrl?: string;
    datacenter?: string;
    key?: string;
    blocked?: boolean;
    hold?: boolean;
    timeoutMs?: number;
    semaphore?: ConnectionSemaphore;
    purgeStore?: MailchimpPurgeStore;
    audit?: (e: { action: string; scope: Record<string, unknown> }) => void;
    connectionId?: string;
  } = {},
) {
  const f = stubFetch(opts.routes ?? [{ match: /.*/, responses: [{ body: {} }] }], {
    hold: opts.hold,
  });
  const c = new MailchimpConnector(
    {
      credentialsSecretRef: "secret://mailchimp/acct_fixture",
      datacenter: opts.datacenter ?? DC,
      connectionId: opts.connectionId ?? "conn_a",
      baseUrl: opts.baseUrl,
    },
    {
      fetchImpl: f.impl,
      now: () => NOW,
      timeoutMs: opts.timeoutMs,
      semaphore: opts.semaphore,
      purgeStore: opts.purgeStore,
      audit: opts.audit,
      // `blocked` leaves the default resolver in place, which is the
      // shipped-off state: nothing wired, so every I/O path blocks honestly.
      resolveApiKey: opts.blocked ? undefined : async () => opts.key ?? KEY,
    },
  );
  return { c, f };
}

const MAILCHIMP_DIR = join(fileURLToPath(new URL("../src/mailchimp/", import.meta.url)));

function mailchimpSourcePath(f: string): string {
  return join(MAILCHIMP_DIR, f);
}

function mailchimpSources(): string[] {
  return readdirSync(MAILCHIMP_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(mailchimpSourcePath(f), "utf8"));
}

/** `members` page bodies of a given size, for the pagination tests. */
function memberPage(from: number, n: number) {
  return {
    members: Array.from({ length: n }, (_, i) => ({
      id: `m${from + i}`,
      email_address: `person${from + i}@example.test`,
      last_changed: `2026-08-${String((i % 27) + 1).padStart(2, "0")}T00:00:00+00:00`,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The host guard — the ONLY enforcement, because CI cannot see this host
// (WARP-2386)
// ─────────────────────────────────────────────────────────────────────────────

describe("runtime-assembled host guard", () => {
  it("refuses a SUFFIX-ATTACK host on ZERO fetch calls", async () => {
    // The attack the anchoring exists to stop: a host that ends with the real
    // one but is owned by someone else.
    // Mutation: change the guard from anchored equality to
    // `host.endsWith(".api.mailchimp.com")` → red here, AND red on the
    // zero-fetch assertion, which is the half that proves the key never left.
    const f = stubFetch([{ match: /.*/, responses: [{ body: {} }] }]);
    expect(
      () =>
        new MailchimpConnector(
          {
            credentialsSecretRef: "secret://mailchimp/acct_fixture",
            datacenter: DC,
            connectionId: "conn_a",
            baseUrl: `https://${DC}${MAILCHIMP_API_HOST_SUFFIX}.evil.test`,
          },
          { fetchImpl: f.impl, now: () => NOW, resolveApiKey: async () => KEY },
        ),
    ).toThrow(UnsafeMailchimpBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a MISMATCHED datacenter — one customer's key cannot be pointed at another's host", () => {
    // A tampered `providerConfig` must not be able to redirect traffic to a
    // different (real, well-formed) Mailchimp datacenter.
    // Mutation: drop the `host !== expected` check and keep only the shape
    // regex → red (us1… matches the shape but is not this connection's).
    expect(() => assertSafeMailchimpBaseUrl(`https://us1${MAILCHIMP_API_HOST_SUFFIX}`, DC)).toThrow(
      UnsafeMailchimpBaseUrlError,
    );
    expect(() => assertSafeMailchimpBaseUrl(`https://${HOST}`, DC)).not.toThrow();
  });

  it("refuses an ARBITRARY host smuggled in through the datacenter token", () => {
    // The sharp edge of a runtime-assembled host: whatever lands in the
    // datacenter field becomes the leftmost label. A token carrying a dot or a
    // slash would make the "host" someone else's domain entirely.
    // Mutation: relax MAILCHIMP_DATACENTER_PATTERN to /^[a-z0-9.\/-]+$/ → red.
    for (const evil of ["evil.com/", "evil.com", "us14.evil", "../us14", "US14", "u1", "us123"]) {
      expect(() => assertMailchimpDatacenter(evil)).toThrow(UnsafeMailchimpBaseUrlError);
    }
    expect(assertMailchimpDatacenter(DC)).toBe(DC);
    expect(assertMailchimpDatacenter("eu1")).toBe("eu1");
  });

  it("refuses plain http, userinfo and a non-443 port", () => {
    // Mutation: drop any one of the three checks → red. An API key over http
    // is the key given away.
    expect(() => assertSafeMailchimpBaseUrl(`http://${HOST}`, DC)).toThrow(
      UnsafeMailchimpBaseUrlError,
    );
    expect(() => assertSafeMailchimpBaseUrl(`https://evil@${HOST}`, DC)).toThrow(
      UnsafeMailchimpBaseUrlError,
    );
    expect(() => assertSafeMailchimpBaseUrl(`https://${HOST}:8443`, DC)).toThrow(
      UnsafeMailchimpBaseUrlError,
    );
  });

  it("builds the base from the datacenter and re-validates it, ending at /3.0", () => {
    // Mutation: have mailchimpBaseUrlFor return its constructed string without
    // passing it back through the guard → red, because one code path would
    // then be untested.
    expect(mailchimpBaseUrlFor(DC)).toBe(`https://${HOST}${MAILCHIMP_API_BASE_PATH}`);
    expect(() => mailchimpBaseUrlFor("evil.com")).toThrow(UnsafeMailchimpBaseUrlError);
  });

  it("refuses a key whose datacenter disagrees with the stored one — zero fetch calls", async () => {
    // A key swapped out-of-band is a DESTINATION change, not just a credential
    // change, and this is where that is caught.
    // Mutation: build the host from the key's suffix instead of the stored one
    // → red (the connector would happily dial us9).
    const { c, f } = connector({ key: `${SECRET}-us9` });
    await expect(c.probePlanAccess()).rejects.toBeInstanceOf(UnsafeMailchimpBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("re-validates the destination on EVERY request, not once at construction", async () => {
    // A guard that ran only at construction is defeated by anything that
    // changes the connection afterwards — a re-read row, a long-lived instance,
    // a future refactor that assigns the base URL per call. `providerConfig` is
    // free-text JSON, so "it was valid when we built it" is not a property this
    // connector may rely on.
    //
    // Reaching past `private` is deliberate: the invariant under test is
    // "the destination is checked at request time", and the only way to
    // observe it is to make construction-time validation insufficient.
    //
    // Mutation: replace the per-request assertSafeMailchimpBaseUrl(...) in
    // request() with a bare `this.baseUrl` → red, and red on ZERO fetch calls,
    // which is the half proving the key never went out.
    const { c, f } = connector({});
    (c as unknown as { baseUrl: string }).baseUrl =
      `https://${DC}${MAILCHIMP_API_HOST_SUFFIX}.evil.test${MAILCHIMP_API_BASE_PATH}`;
    await expect(c.probePlanAccess()).rejects.toBeInstanceOf(UnsafeMailchimpBaseUrlError);
    expect(f.calls).toHaveLength(0);
  });

  it("keeps the invariant host suffix and the API path as whole-string literals", () => {
    // The scanner is a static text scan and can only extract what it literally
    // sees. The datacenter label is unknowable at build time, so the invariant
    // tail is the most it can ever be given.
    // Mutation: rewrite either as a concatenation ("." + "api.mailchimp" + …)
    // → red.
    const src = readFileSync(mailchimpSourcePath("connector.ts"), "utf8");
    expect(src).toContain('".api.mailchimp.com"');
    expect(src).toContain('"/3.0"');
  });

  it("escapes EVERY regex metacharacter, not only the dot", () => {
    // Stefan's review / CodeQL "Incomplete string escaping or encoding": the
    // previous inline escape handled `.` alone. That was right for today's
    // constant by luck rather than by construction — this makes it right by
    // construction.
    // Mutation: narrow the class back to /\./g -> red for every character
    // below except `.`.
    for (const meta of [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]) {
      const escaped = escapeRegExpLiteral(meta);
      expect(escaped).toBe(`\\${meta}`);
      // The escaped form matches that literal character and nothing else.
      expect(new RegExp(`^${escaped}$`).test(meta)).toBe(true);
    }
    // A dot stays a LITERAL dot, never the any-character wildcard.
    expect(escapeRegExpLiteral("a.b")).toBe("a\\.b");
    expect(new RegExp(`^${escapeRegExpLiteral("a.b")}$`).test("axb")).toBe(false);
    expect(new RegExp(`^${escapeRegExpLiteral("a.b")}$`).test("a.b")).toBe(true);
  });

  it("still refuses the suffix attack now that the escaping is hoisted", () => {
    // Regression guard for the CodeQL fix: hoisting the escape must not have
    // weakened the anchored host check.
    // Mutation: drop the ^ / $ anchors from MAILCHIMP_ALLOWED_HOST_PATTERN
    // -> red.
    expect(MAILCHIMP_ALLOWED_HOST_PATTERN.test(`${DC}${MAILCHIMP_API_HOST_SUFFIX}`)).toBe(true);
    expect(
      MAILCHIMP_ALLOWED_HOST_PATTERN.test(`${DC}${MAILCHIMP_API_HOST_SUFFIX}.evil.test`),
    ).toBe(false);
    // And the dot before "api" is matched literally, not as a wildcard.
    expect(MAILCHIMP_ALLOWED_HOST_PATTERN.test("us14xapi.mailchimp.com")).toBe(false);
    expect(() =>
      assertSafeMailchimpBaseUrl(`https://${DC}${MAILCHIMP_API_HOST_SUFFIX}.evil.test`, DC),
    ).toThrow(UnsafeMailchimpBaseUrlError);
  });

  it("carries NO https:// mailchimp literal, because a dynamic entry registers no hosts", () => {
    // `scripts/check-egress-allowlist.py` collects no host patterns from a
    // `kind: dynamic` entry (it `continue`s past destination.hosts), so a
    // concrete scheme-URL literal in shipping source would be read as an
    // UNREGISTERED destination and fail egress-gate.
    // Mutation: add `const EXAMPLE = "https://us1.api.mailchimp.com/3.0"` to
    // the connector → red here, and red in CI.
    for (const src of mailchimpSources()) {
      expect(src).not.toMatch(/https:\/\/[a-z0-9-]+\.api\.mailchimp\.com/);
    }
  });

  it("registers the host as kind: dynamic with a config_key, never as a static entry", () => {
    // The classification IS the security decision here. A `kind: egress` entry
    // with a wildcard would turn egress-gate green over an unconstrained host.
    // Mutation: change the entry to `kind: egress` with a sampled datacenter
    // → red.
    const yaml = readFileSync(
      join(fileURLToPath(new URL("../../../docs/security/allowed-egress.yaml", import.meta.url))),
      "utf8",
    );
    const entry = yaml.slice(yaml.indexOf("- id: mailchimp-marketing-api"));
    const block = entry.slice(0, entry.indexOf("\n  - id:") + 1 || undefined);
    expect(block).toContain("kind: dynamic");
    expect(block).toContain("config_key:");
    expect(block).toContain("data_class: user-content-on-request");
    // Never the banned fourth value (docs/SECURITY.md:176-178).
    expect(block).not.toContain("ambient-customer-content");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credential intake (WARP-2389)
// ─────────────────────────────────────────────────────────────────────────────

describe("API-key intake", () => {
  it("splits a well-formed key into its secret and its datacenter", () => {
    const { secret, datacenter } = parseMailchimpApiKey(KEY);
    expect(datacenter).toBe(DC);
    expect(secret).toBe("0123456789abcdef0123456789abcdef");
  });

  it("REFUSES a key with no datacenter suffix — it is unroutable, not merely malformed", () => {
    // The mutation the ticket names, and the worst available outcome: default
    // the datacenter to "us1" when absent, and a customer's live credential
    // goes to a host that is not theirs, silently.
    // Mutation: `datacenter ?? "us1"` anywhere on this path → red.
    const err = (() => {
      try {
        parseMailchimpApiKey("0123456789abcdef0123456789abcdef");
        return null;
      } catch (e) {
        return e as InvalidMailchimpCredentialError;
      }
    })();
    expect(err).toBeInstanceOf(InvalidMailchimpCredentialError);
    expect(err?.code).toBe("INVALID_MAILCHIMP_CREDENTIAL");
    expect(err?.reason).toBe("missing_datacenter_suffix");
  });

  it("distinguishes a MALFORMED suffix from a missing one — different paste errors", () => {
    // Mutation: collapse the two reasons into one → red. They want different
    // advice, and an explicit enum is how a caller tells them apart without
    // string-matching a message.
    const reasons = ["-", "abcdef-", "abcdef-usa", "abcdef-us", "abcdef-1234"].map((k) => {
      try {
        parseMailchimpApiKey(`0123456789abcdef0123456789abcdef${k.slice(k.indexOf("-"))}`);
        return "accepted";
      } catch (e) {
        return (e as InvalidMailchimpCredentialError).reason;
      }
    });
    expect(reasons).not.toContain("accepted");
    expect(new Set(reasons).size).toBeGreaterThan(1);
  });

  it("rejects an empty or non-string credential", () => {
    for (const bad of ["", "   ", null, undefined, 42, {}]) {
      expect(() => parseMailchimpApiKey(bad)).toThrow(InvalidMailchimpCredentialError);
    }
  });

  it("NEVER echoes the offered credential back in the error — rule 19", () => {
    // A validation error that quotes the credential writes it into every log
    // line that renders the error.
    // Mutation: interpolate the raw value into the message → red.
    const secret = "deadbeefdeadbeefdeadbeefdeadbeef";
    try {
      parseMailchimpApiKey(secret);
      throw new Error("expected a rejection");
    } catch (e) {
      const rendered = `${(e as Error).message} ${JSON.stringify(e)}`;
      expect(rendered).not.toContain(secret);
    }
  });

  it("accepts the vendor's own documented example, whose prefix is 31 chars not 32", () => {
    // Mailchimp documents "a 32-character string" but its OWN published example
    // (Fundamentals) is `0123456789abcdef0123456789abcde-us6` — 31 characters.
    // Pinning the secret half to exactly {32} would reject the example the
    // vendor publishes, blocking a real customer for no security gain: the
    // secret half never becomes a hostname. The DATACENTER half is what is
    // pinned, because that half IS a hostname label.
    // Mutation: tighten the secret half to {32} → red.
    expect(parseMailchimpApiKey("0123456789abcdef0123456789abcde-us6")).toEqual({
      secret: "0123456789abcdef0123456789abcde",
      datacenter: "us6",
    });
  });

  it("reads the datacenter from providerConfig and refuses a key that disagrees", () => {
    // The AC: the suffix is stored in providerConfig, not re-derived per
    // request. Observable form — the connector's destination comes from the
    // CONFIG, and a stored key whose suffix disagrees is refused rather than
    // silently followed (which is what re-deriving per request would do).
    // Mutation: build the host from the key's suffix instead of the stored one
    // → red, because the connector would happily dial us9.
    const { c } = connector({ datacenter: DC, key: `${SECRET}-us9` });
    return expect(c.probePlanAccess()).rejects.toThrow(/disagrees/);
  });

  it("never renders the key or its base64 Basic-auth encoding in status", async () => {
    // The `hasApiKey` convention: report THAT a credential exists, never its
    // value — and specifically not the base64 shape Basic auth creates, which
    // is the form that actually leaks into logs.
    // Mutation: add `apiKey` (or the Authorization header) to the status object
    // → red.
    const { c } = connector({ routes: [{ match: /ping/, responses: [{ body: { health_status: "Everything's Chimpy!" } }] }] });
    await c.connect();
    const view = JSON.stringify(await c.status());
    const secret = "0123456789abcdef0123456789abcdef";
    expect(view).not.toContain(secret);
    expect(view).not.toContain(Buffer.from(`anystring:${KEY}`).toString("base64"));
    expect(JSON.parse(view).hasApiKey).toBe(true);
    expect(JSON.parse(view).datacenter).toBe(DC);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Subscriber hash (WARP-2396)
// ─────────────────────────────────────────────────────────────────────────────

describe("subscriber hash", () => {
  it("is the MD5 of the LOWERCASED address, not of the address as typed", () => {
    // Hashing the raw address 404s against a subscriber who exists, and
    // presents as MISSING DATA rather than as a lookup error — the worst way
    // for it to show up.
    // Mutation: drop `.toLowerCase()` → red.
    const mixed = "Camille.Moreau@Example.TEST";
    const lowered = mixed.toLowerCase();
    // `subscriberHash` itself no longer uses node:crypto — MD5 is refused by the
    // FIPS provider (WARP-2460). node:crypto MD5 stays HERE on purpose, as the
    // independent oracle the pure implementation is checked against; asserting
    // against our own digest would be vacuous. Test runs are never FIPS.
    // fips:allowed: mailchimp-subscriber-hash
    expect(subscriberHash(mixed)).toBe(createHash("md5").update(lowered).digest("hex"));
    // fips:allowed: mailchimp-subscriber-hash
    expect(subscriberHash(mixed)).not.toBe(createHash("md5").update(mixed).digest("hex"));
    expect(subscriberHash(mixed)).toBe(subscriberHash(lowered));
  });

  it("puts that hash in the member URL, not the address", async () => {
    // Asserted on the REQUEST: a mock returning a member would look identical
    // either way.
    // Mutation: interpolate the email into the path → red.
    const { c, f } = connector({ routes: [{ match: /members/, responses: [{ body: { id: "x" } }] }] });
    await c.getMember("list_1", "Camille.Moreau@Example.TEST");
    const path = f.paths()[0];
    expect(path).toBe(
      `${MAILCHIMP_API_BASE_PATH}/lists/list_1/members/${subscriberHash("camille.moreau@example.test")}`,
    );
    expect(path.toLowerCase()).not.toContain("camille");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency and timeout (WARP-2392)
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrency semaphore and request timeout", () => {
  it("holds at most 10 requests in flight with 25 queued — asserted on the TIMELINE", async () => {
    // Mailchimp documents 10 SIMULTANEOUS CONNECTIONS per key. The "10 req/s"
    // figure that circulates in third-party writeups is an unverified
    // misreading of this cap; a rate limiter here would be cargo cult.
    // Mutation: raise the cap to 11 → red, because the stub observes 11 open
    // calls at once. A final call count would look identical either way, which
    // is why this asserts the high-water mark.
    const { c, f } = connector({
      hold: true,
      routes: [{ match: /members/, responses: [{ body: { id: "x" } }] }],
    });
    const inflight = Array.from({ length: 25 }, (_, i) =>
      c.getMember("list_1", `person${i}@example.test`),
    );
    // Let the semaphore drain its first cohort onto the stub.
    await new Promise((r) => setTimeout(r, 0));
    expect(f.pending).toBe(MAILCHIMP_MAX_CONCURRENT_CONNECTIONS);
    expect(f.peak).toBe(MAILCHIMP_MAX_CONCURRENT_CONNECTIONS);
    expect(f.peak).toBeLessThanOrEqual(MAILCHIMP_MAX_CONCURRENT_CONNECTIONS);

    f.releaseAll();
    // Drain the remainder, releasing each cohort as it arrives.
    for (let i = 0; i < 5 && f.calls.length < 25; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      f.releaseAll();
    }
    await Promise.all(inflight);
    expect(f.calls).toHaveLength(25);
    expect(f.peak).toBeLessThanOrEqual(MAILCHIMP_MAX_CONCURRENT_CONNECTIONS);
  });

  it("releases its slot when a request throws, so a failure cannot deadlock the connector", async () => {
    // Mutation: release the slot on the success path only (drop the `finally`)
    // → red: after ten failures the semaphore would never admit an 11th call
    // and this test would hang rather than fail, which is why the cap is small
    // here.
    const sem = new ConnectionSemaphore(2);
    const boom = async () => {
      throw new Error("nope");
    };
    await expect(sem.run(boom)).rejects.toThrow("nope");
    await expect(sem.run(boom)).rejects.toThrow("nope");
    await expect(sem.run(boom)).rejects.toThrow("nope");
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("renders a stalled request as a NAMED timeout state, never as an empty result", async () => {
    // The ADR-041 never-empty contract. A timeout that returned [] would tell
    // the owner their audience is empty — false, and unfalsifiable from
    // outside.
    // Mutation: `catch { return [] }` on the timeout path → red.
    // Mutation: rely on `AbortSignal.timeout` alone → red, because an injected
    // fetch that ignores the signal never settles and this test would hang.
    const { c } = connector({
      hold: true,
      timeoutMs: 5,
      routes: [{ match: /.*/, responses: [{ body: {} }] }],
    });
    const err = await c.listCampaigns().catch((e) => e);
    expect(err).toBeInstanceOf(MailchimpTimeoutError);
    expect(err.code).toBe("REQUEST_TIMEOUT");
    expect(Array.isArray(err)).toBe(false);
  });

  it("pins the documented 120-second timeout as the default", () => {
    // Mutation: change the default to any other value → red. Ours matches
    // Mailchimp's server-side ceiling exactly, on purpose.
    expect(MAILCHIMP_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(MAILCHIMP_MAX_CONCURRENT_CONNECTIONS).toBe(10);
  });

  it("keeps the failure states distinguishable WITHOUT string-matching a message", async () => {
    // Mutation: collapse any two of these into one class, or drop a `code`
    // field → red.
    const unauthorized = connector({ routes: [{ match: /.*/, responses: [{ status: 401 }] }] });
    await expect(unauthorized.c.probePlanAccess()).rejects.toBeInstanceOf(
      MailchimpReauthorizationRequiredError,
    );
    const forbidden = connector({
      routes: [{ match: /.*/, responses: [{ status: 403, body: { detail: "plan" } }] }],
    });
    await expect(forbidden.c.probePlanAccess()).rejects.toBeInstanceOf(
      MailchimpCapabilityMissingError,
    );
    const codes = new Set([
      new MailchimpTimeoutError("x", 1).code,
      new MailchimpReauthorizationRequiredError("x").code,
      new MailchimpCapabilityMissingError("x", "y").code,
      new UnsafeMailchimpBaseUrlError("x").code,
    ]);
    expect(codes.size).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delta reads (WARP-2396)
// ─────────────────────────────────────────────────────────────────────────────

describe("contact and campaign delta reads", () => {
  it("puts every documented member delta filter on the outgoing REQUEST", async () => {
    // Asserted on the request, NOT on the rows: omitting a filter does not
    // fail — it silently becomes a full scan that still returns
    // correct-looking data.
    // Mutation: drop `since_last_changed` from the query builder → red, even
    // though the stub would still return members.
    const { c, f } = connector({
      routes: [{ match: /members/, responses: [{ body: memberPage(0, 0) }] }],
    });
    await c.listMembers("list_1", {
      sinceLastChanged: "2026-08-01T00:00:00+00:00",
      beforeLastChanged: "2026-08-27T00:00:00+00:00",
      sinceTimestampOpt: "2026-07-01T00:00:00+00:00",
      unsubscribedSince: "2026-06-01T00:00:00+00:00",
    });
    const q = f.params(0);
    for (const p of MAILCHIMP_MEMBER_DELTA_PARAMS) {
      expect(q.get(p)).toBeTruthy();
    }
    expect(q.get("since_last_changed")).toBe("2026-08-01T00:00:00+00:00");
  });

  it("puts both documented campaign delta filters on the outgoing REQUEST", async () => {
    // Mutation: drop `since_send_time` → red.
    const { c, f } = connector({
      routes: [{ match: /campaigns/, responses: [{ body: { campaigns: [] } }] }],
    });
    await c.listCampaigns({
      sinceSendTime: "2026-08-01T00:00:00+00:00",
      sinceCreateTime: "2026-07-01T00:00:00+00:00",
    });
    const q = f.params(0);
    for (const p of MAILCHIMP_CAMPAIGN_DELTA_PARAMS) {
      expect(q.get(p)).toBeTruthy();
    }
  });

  it("omits a filter that was not supplied rather than sending an empty one", async () => {
    // An empty `since_last_changed=` is not the same request as no filter, and
    // a vendor is entitled to treat it differently.
    // Mutation: send every key regardless of value → red.
    const { c, f } = connector({
      routes: [{ match: /members/, responses: [{ body: memberPage(0, 0) }] }],
    });
    await c.listMembers("list_1", { sinceLastChanged: "2026-08-01T00:00:00+00:00" });
    expect(f.paramKeys(0)).not.toContain("unsubscribed_since");
    expect(f.paramKeys(0)).toContain("since_last_changed");
  });

  it("pages 2,500 members offset-only and retrieves every one exactly once", async () => {
    // Pagination is offset-only — there are no cursors anywhere in this API.
    // Mutation: advance the offset by a constant rather than by the page
    // length, or terminate on `length === 0` instead of a SHORT page → red
    // (duplicates, or an extra request).
    const pages = [memberPage(0, 1000), memberPage(1000, 1000), memberPage(2000, 500)];
    const { c, f } = connector({
      routes: [{ match: /members/, responses: pages.map((body) => ({ body })) }],
    });
    const { rows } = await c.listMembers("list_1");
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500);
    expect(f.calls).toHaveLength(3);
    expect(f.params(0).get("offset")).toBe("0");
    expect(f.params(1).get("offset")).toBe("1000");
    expect(f.params(2).get("offset")).toBe("2000");
  });

  it("never asks for more than the documented count ceiling of 1000", async () => {
    // Mutation: raise the clamp above 1000 → red. Mailchimp caps `count` and
    // a larger value is not honoured.
    const { c, f } = connector({
      routes: [{ match: /members/, responses: [{ body: memberPage(0, 0) }] }],
    });
    await c.listMembers("list_1", { pageSize: 5000 });
    expect(Number(f.params(0).get("count"))).toBe(MAILCHIMP_MAX_PAGE_SIZE);
  });

  it("returns the delta watermark instead of persisting one — ADR-041 §4", async () => {
    // WARP-2028 owns ErpSyncCursor and ADR-041 §4 forbids a cloud connector
    // becoming its first writer.
    // Mutation: write the watermark to a store here → red on review, and this
    // test pins that it is RETURNED.
    const { c } = connector({
      routes: [{ match: /members/, responses: [{ body: memberPage(0, 3) }] }],
    });
    const { watermark } = await c.listMembers("list_1");
    expect(watermark).toBe("2026-08-03T00:00:00+00:00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `updated_at` — WARP-2494
// ─────────────────────────────────────────────────────────────────────────────

describe("updated_at on the contact dataset", () => {
  /**
   * One list member, as Mailchimp serves it. `last_changed` and `timestamp_opt`
   * are deliberately DIFFERENT instants: a projection reaching for the opt-in
   * time — this dataset's nearest thing to a creation stamp — must not be able
   * to pass by coincidence.
   */
  function member(over: { id?: string; last_changed?: string | null } = {}) {
    const row: Record<string, unknown> = {
      id: over.id ?? "m1",
      email_address: `${over.id ?? "m1"}@example.test`,
      status: "subscribed",
      timestamp_opt: "2026-01-15T08:00:00+00:00",
    };
    if (over.last_changed !== null) {
      row.last_changed = over.last_changed ?? "2026-08-20T09:30:00+00:00";
    }
    return row;
  }

  function memberRoute(members: Record<string, unknown>[]) {
    return [{ match: /members/, responses: [{ body: { members } }] }];
  }

  it("emits updated_at as a UTC ISO instant from the member's last_changed", async () => {
    // A Mailchimp `contact` IS a list member, and `last_changed` is the field
    // the API's own `since_last_changed` delta filter keys on — so it is the
    // one honest modification time this dataset has.
    // Mutation: drop the `updated_at` projection → red (undefined).
    // Mutation: project `timestamp_opt` instead → red (2026-01-15, not 08-20).
    const { c } = connector({ routes: memberRoute([member()]) });
    const { rows } = await c.listMembers("list_1");
    expect(rows).toHaveLength(1);
    expect(rows[0].updated_at).toBe("2026-08-20T09:30:00.000Z");
    // The opt-in time is still on the row, and is a different instant.
    expect(rows[0].timestamp_opt).toBe("2026-01-15T08:00:00+00:00");
  });

  it("normalises the vendor's +00:00 offset form to a Z instant", async () => {
    // Mailchimp emits `2026-08-20T09:30:00+00:00`; every other track produces a
    // full `…Z` instant, and `COLUMN_KIND.updated_at` is one column across all
    // of them. Passing the vendor string through leaves two spellings of one
    // moment in one column.
    // Mutation: assign `last_changed` verbatim → red.
    const { c } = connector({
      routes: memberRoute([member({ last_changed: "2026-08-20T09:30:00+00:00" })]),
    });
    const { rows } = await c.listMembers("list_1");
    expect(rows[0].updated_at).toBe("2026-08-20T09:30:00.000Z");
    expect(rows[0].updated_at).not.toBe(rows[0].last_changed);
  });

  it("carries a non-UTC offset across to the correct UTC instant", async () => {
    // Mutation: slice the string instead of parsing it → red (it would keep
    // the wall-clock time and silently drop the offset).
    const { c } = connector({
      routes: memberRoute([member({ last_changed: "2026-08-20T09:30:00-07:00" })]),
    });
    const { rows } = await c.listMembers("list_1");
    expect(rows[0].updated_at).toBe("2026-08-20T16:30:00.000Z");
  });

  it("leaves updated_at undefined — never guessed — when last_changed is absent", async () => {
    // Absent source stays absent. Falling back to the opt-in time would put
    // another field's timestamp here under this one's name.
    // Mutation: fall back to `timestamp_opt` → red.
    const { c } = connector({ routes: memberRoute([member({ last_changed: null })]) });
    const { rows } = await c.listMembers("list_1");
    expect(rows[0].updated_at).toBeUndefined();
    // Present-and-undefined, not missing: an unmapped canonical column is still
    // a declared column.
    expect("updated_at" in rows[0]).toBe(true);
  });

  it("leaves updated_at undefined when last_changed does not parse", async () => {
    // Mutation: emit the unparseable string verbatim → red.
    const { c } = connector({
      routes: memberRoute([member({ last_changed: "not-a-date" })]),
    });
    const { rows } = await c.listMembers("list_1");
    expect(rows[0].updated_at).toBeUndefined();
  });

  it("every produced updated_at parses as an ISO instant (COLUMN_KIND.timestamp)", async () => {
    // Mutation: emit the epoch number instead of the ISO string → red.
    const { c } = connector({ routes: memberRoute([memberPage(0, 3).members].flat()) });
    const { rows } = await c.listMembers("list_1");
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(typeof r.updated_at).toBe("string");
      expect(new Date(r.updated_at as string).toISOString()).toBe(r.updated_at);
    }
  });

  it("does not disturb the returned watermark, which stays the vendor's own form", async () => {
    // The watermark is fed straight back as `since_last_changed`, so it must
    // remain the string Mailchimp gave us — normalising it here would change an
    // outgoing filter this ticket has no business touching.
    // Mutation: set the watermark from `updated_at` → red.
    const { c } = connector({ routes: [{ match: /members/, responses: [{ body: memberPage(0, 3) }] }] });
    const { watermark } = await c.listMembers("list_1");
    expect(watermark).toBe("2026-08-03T00:00:00+00:00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E-commerce — a DECLARED full scan (WARP-2400)
// ─────────────────────────────────────────────────────────────────────────────

describe("e-commerce orders: full-scan only", () => {
  it("sends ONLY parameters from the documented set — no date filter exists", async () => {
    // `/ecommerce/stores/{id}/orders` accepts exactly nine parameters and none
    // of them is a date. An invented `since_created_at` would be SILENTLY
    // IGNORED by Mailchimp, producing a full scan reported as a delta.
    // Mutation: add a `since_created_at` parameter to the query builder → red.
    const { c, f } = connector({
      routes: [{ match: /orders/, responses: [{ body: { orders: [] } }] }],
    });
    await c.listEcommerceOrders("store_1", { customerId: "cust_1", campaignId: "camp_1" });
    for (const key of f.paramKeys(0)) {
      expect(MAILCHIMP_ECOMMERCE_ORDER_PARAMS.has(key)).toBe(true);
    }
    expect(f.paramKeys(0).some((k) => k.startsWith("since") || k.startsWith("before"))).toBe(false);
  });

  it("throws on an undocumented order parameter rather than silently full-scanning", () => {
    // The guard, not just the test: the failure mode is silent, so it has to be
    // enforced at runtime.
    // Mutation: turn assertEcommerceOrderParams into a no-op → red.
    expect(() => assertEcommerceOrderParams({ since_created_at: "2026-08-01" })).toThrow(
      ConnectorBlockedError,
    );
    expect(() => assertEcommerceOrderParams({ customer_id: "c1", count: 10 })).not.toThrow();
  });

  it("exposes NO since_* option for orders anywhere in the read surface", () => {
    // The AC: a delta is impossible here, so offering the knob at all is the
    // bug. Pinned against the source so a future signature change is caught.
    // Mutation: add `sinceCreatedAt?: string` to listEcommerceOrders → red.
    const src = readFileSync(mailchimpSourcePath("connector.ts"), "utf8");
    const start = src.indexOf("async listEcommerceOrders(");
    expect(start).toBeGreaterThan(-1);
    const signature = src.slice(start, src.indexOf("): Promise", start));
    expect(signature).not.toMatch(/since/i);
    expect(signature).not.toMatch(/before/i);
  });

  it("declares the dataset full_scan_only so a scheduler can slow it down", () => {
    // Mutation: mark ecommerce_order as "delta" → red. A declared property, not
    // an accident of the code.
    expect(MAILCHIMP_SCAN_MODE.ecommerce_order).toBe("full_scan_only");
    expect(MAILCHIMP_SCAN_MODE.audience_member).toBe("delta");
    expect(MAILCHIMP_SCAN_MODE.campaign).toBe("delta");
    // Every declared dataset has a declared scan mode — no silent omissions.
    for (const d of MAILCHIMP_DATASETS) {
      expect(MAILCHIMP_SCAN_MODE[d]).toBeDefined();
    }
  });

  it("scans every order exactly once across pages, and is idempotent across two runs", async () => {
    // Idempotence is what makes a mandatory full scan tolerable: a re-run costs
    // time, not correctness.
    // Mutation: accumulate into module state rather than a local array → red on
    // the second run.
    const pages = [
      { orders: Array.from({ length: 1000 }, (_, i) => ({ id: `o${i}` })) },
      { orders: Array.from({ length: 200 }, (_, i) => ({ id: `o${1000 + i}` })) },
    ];
    const routes = [{ match: /orders/, responses: pages.map((body) => ({ body })) }];
    const first = connector({ routes });
    const runA = await first.c.listEcommerceOrders("store_1");
    const second = connector({ routes });
    const runB = await second.c.listEcommerceOrders("store_1");
    expect(runA).toHaveLength(1200);
    expect(new Set(runA.map((r) => r.id)).size).toBe(1200);
    expect(runB.map((r) => r.id)).toEqual(runA.map((r) => r.id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-account purge — the API Use Policy obligation, in code (WARP-2404)
// ─────────────────────────────────────────────────────────────────────────────

/** An in-memory stand-in for whatever holds Mailchimp-derived rows. Not a mock
 *  database standing in for Postgres — the team rule forbids that — just a
 *  counter, which is all the scoping property needs. */
function fakeStore(seed: Record<string, Record<string, number>>) {
  const rows = structuredClone(seed);
  const store: MailchimpPurgeStore = {
    async deleteByConnection(connectionId, dataset) {
      const n = rows[connectionId]?.[dataset] ?? 0;
      if (rows[connectionId]) rows[connectionId][dataset] = 0;
      return n;
    },
  };
  return { store, rows };
}

describe("per-account purge", () => {
  it("deletes one connection's records and leaves a SIBLING connection's untouched", async () => {
    // The subtle failure this test exists to catch: scoping the delete by
    // `provider` instead of by connection id destroys a second customer's data
    // on a box with two Mailchimp connections.
    // Mutation: scope deleteByConnection by provider → red.
    const { store, rows } = fakeStore({
      conn_a: { audience_member: 120, campaign: 8, ecommerce_order: 40 },
      conn_b: { audience_member: 77, campaign: 3, ecommerce_order: 12 },
    });
    const { c } = connector({ connectionId: "conn_a", purgeStore: store });
    const result = await c.purgeAccount();

    expect(result.connectionId).toBe("conn_a");
    expect(result.totalDeleted).toBe(168);
    expect(rows.conn_a).toEqual({ audience_member: 0, campaign: 0, ecommerce_order: 0 });
    expect(rows.conn_b).toEqual({ audience_member: 77, campaign: 3, ecommerce_order: 12 });
  });

  it("derives the purged set from servesDatasets rather than a hand-kept list", async () => {
    // A hand-maintained list drifts: a dataset added to the connector would be
    // left behind while the purge still reported success.
    // Mutation: replace the loop with a literal ["contact", "campaign"] → red,
    // because ecommerce_order would survive.
    const asked: string[] = [];
    const store: MailchimpPurgeStore = {
      async deleteByConnection(_id, dataset) {
        asked.push(dataset);
        return 0;
      },
    };
    const { c } = connector({ purgeStore: store });
    const result = await c.purgeAccount();
    expect(asked.sort()).toEqual([...MAILCHIMP_DATASETS].sort());
    expect(result.datasets).toEqual(MAILCHIMP_DATASETS);
  });

  it("writes an audit row of COUNTS ONLY — no subscriber content reaches the trail", async () => {
    // Mutation: drop the record() call → red. Mutation: put a sample row or an
    // address into the scope → red on the content assertion.
    const seen: { action: string; scope: Record<string, unknown> }[] = [];
    const { store } = fakeStore({ conn_a: { audience_member: 2, campaign: 0, ecommerce_order: 0 } });
    const { c } = connector({
      purgeStore: store,
      audit: (e) => {
        seen.push(e);
      },
    });
    await c.purgeAccount();
    expect(seen).toHaveLength(1);
    expect(seen[0].action).toBe("mailchimp.purge_account");
    const scope = JSON.stringify(seen[0].scope);
    expect(scope).not.toContain("smith");
    expect(scope).not.toContain("@");
    expect(seen[0].scope.totalDeleted).toBe(2);
  });

  it("refuses rather than reporting a vacuous success when no store is wired", async () => {
    // A purge that quietly succeeded against nothing would discharge the
    // deletion obligation on paper only.
    // Mutation: return a zeroed result instead of throwing → red.
    const { c } = connector({});
    await expect(c.purgeAccount()).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("records the API Use Policy obligations in-repo, audit rights flagged for Romain", () => {
    // The policy grants Intuit audit rights over our systems and facilities —
    // a contractual exposure for a product whose "systems" are appliances on
    // customers' premises. Recorded so it is decided, not discovered.
    // Mutation: delete the audit-rights line → red.
    const joined = MAILCHIMP_API_USE_POLICY_OBLIGATIONS.join(" | ");
    expect(joined).toMatch(/audit rights/i);
    expect(joined).toMatch(/Romain/);
    expect(joined).toMatch(/privacy policy/i);
    expect(joined).toMatch(/incident/i);
    expect(joined).toMatch(/delete/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Free-plan probe (WARP-2406)
// ─────────────────────────────────────────────────────────────────────────────

describe("plan-access probe", () => {
  it("ships as an explicit `unverified` result, never an optimistic assumption", async () => {
    // The June 2025 free-tier cut is real and the docs do not settle whether a
    // Free account can call the API. `unverified` is a first-class value.
    // Mutation: default the probe to `{ state: "ok" }` → red.
    const { c } = connector({});
    const status = await c.status();
    expect(status.planProbe).toEqual({
      state: "unverified",
      prerequisite: MAILCHIMP_PLAN_PREREQUISITE,
    });
    expect(MAILCHIMP_PLAN_PREREQUISITE).toMatch(/unverified on Free/);
  });

  it("turns a real connect into an EMPIRICAL probe result", async () => {
    // Mutation: skip probePlanAccess() in connect() → red; the probe would stay
    // `unverified` after a successful connection, which is a different (and
    // dishonest) claim.
    const { c, f } = connector({
      routes: [{ match: /ping/, responses: [{ body: { health_status: "Everything's Chimpy!" } }] }],
    });
    await c.connect();
    expect(f.paths()[0]).toBe(`${MAILCHIMP_API_BASE_PATH}/ping`);
    const probe = (await c.status()).planProbe;
    expect(probe.state).toBe("ok");
  });

  it("renders a blocked resource as capability_missing, NEVER as an empty result", async () => {
    // The ADR-041 never-empty contract, and the exact shape a Free-plan block
    // would take.
    // Mutation: `catch { return [] }` on a 403 → red.
    const { c } = connector({
      routes: [{ match: /.*/, responses: [{ status: 403, body: { detail: "upgrade required" } }] }],
    });
    const err = await c.probePlanAccess().catch((e) => e);
    expect(err).toBeInstanceOf(MailchimpCapabilityMissingError);
    expect(Array.isArray(err)).toBe(false);
    expect((await c.status()).state).toBe("capability_missing");
    await expect(c.health()).rejects.toBeInstanceOf(MailchimpCapabilityMissingError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocked boundary — nothing configured (WARP-2392)
// ─────────────────────────────────────────────────────────────────────────────

describe("blocked boundary — nothing configured", () => {
  it("is the mailchimp provider and declares its datasets", () => {
    const { c } = connector({ blocked: true });
    expect(c.provider).toBe(MAILCHIMP_PROVIDER);
    expect(c.servesDatasets).toEqual(MAILCHIMP_DATASETS);
  });

  it("rejects every network-touching method with ConnectorBlockedError", async () => {
    // Nothing mocked — the connector IS the stub in this state.
    // Mutation: let health() return { ok: false } instead of rejecting → red.
    const { c } = connector({ blocked: true });
    await expect(c.connect()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.health()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.listMembers("l1")).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.listCampaigns()).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.listEcommerceOrders("s1")).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.getMember("l1", "a@example.test")).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(c.purgeAccount()).rejects.toBeInstanceOf(ConnectorBlockedError);
  });

  it("reports the disconnected state explicitly rather than inferring it", async () => {
    // Mutation: derive `state` from a null key rather than naming it → red on
    // the ok/state agreement.
    const { c } = connector({ blocked: true });
    const s = await c.status();
    expect(s.state).toBe("disconnected");
    expect(s.ok).toBe(false);
    expect(s.hasApiKey).toBe(false);
  });

  it("holds no key material — the config is a secret-store pointer", async () => {
    // Mutation: store the resolved key on the config → red.
    const { c } = connector({ blocked: true });
    const rendered = JSON.stringify(c);
    expect(rendered).not.toContain("0123456789abcdef");
    expect(rendered).toContain("secret://mailchimp/");
  });

  it("refuses a read whose dataset this track does not serve", async () => {
    // Typed and honest rather than a blocked error: the marketing datasets are
    // not in the closed DatasetName union yet (WARP-2280), so no registered
    // read query maps here.
    // Mutation: return [] for an unserved dataset → red.
    const { c } = connector({});
    await expect(c.runRead("get_open_invoices", {})).rejects.toBeInstanceOf(DatasetNotServedError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Read-only: no send, no mutate, no delete
// ─────────────────────────────────────────────────────────────────────────────

describe("read-only surface", () => {
  it("keeps every dialable resource on an allowlist that admits no send or mutate path", () => {
    // An allowlist checked at the point of use, NEVER a denylist of forbidden
    // words in source: paths here are assembled from ids at runtime, so a
    // denylist only catches the literals someone happened to type.
    // Mutation: add "batches" or an audience-mutation resource to the set →
    // red.
    expect([...MAILCHIMP_READABLE_RESOURCES].sort()).toEqual([
      "campaigns",
      "ecommerce",
      "lists",
      "ping",
      "reports",
    ]);
  });

  it("throws on an off-allowlist resource BEFORE any request is built", () => {
    // Mutation: move the resource check after the URL is assembled → the
    // zero-fetch assertion in the sibling test goes red.
    expect(() => assertReadableMailchimpResource(`${MAILCHIMP_API_BASE_PATH}/batches`)).toThrow(
      ConnectorBlockedError,
    );
    expect(() => assertReadableMailchimpResource(`${MAILCHIMP_API_BASE_PATH}/lists/x/members`)).not.toThrow();
  });

  it("refuses the campaign SEND path, which a resource allowlist alone would admit", () => {
    // Found by this test failing against a first-segment-only guard:
    // `campaigns` is legitimately readable, so `/campaigns/{id}/actions/send`
    // sailed through. Every Mailchimp mutation verb is a POST under
    // `/actions/`, and nothing readable lives there, so the segment is refused
    // by SHAPE — the resource allowlist cannot do this job on its own.
    // Mutation: delete the MAILCHIMP_FORBIDDEN_PATH_SEGMENT check → red.
    for (const verb of ["send", "schedule", "pause", "cancel-send", "replicate", "test"]) {
      expect(() =>
        assertReadableMailchimpResource(`${MAILCHIMP_API_BASE_PATH}/campaigns/c1/actions/${verb}`),
      ).toThrow(ConnectorBlockedError);
    }
    // The readable sibling under the same resource still works, so the guard
    // costs no capability.
    expect(() =>
      assertReadableMailchimpResource(`${MAILCHIMP_API_BASE_PATH}/campaigns/c1`),
    ).not.toThrow();
  });

  it("never dials an off-allowlist resource — zero fetch calls", async () => {
    // The guard runs before the URL is built and before the key is resolved,
    // so a refused path costs no network and never touches the credential.
    // Mutation: drop assertReadableMailchimpResource from request(), or move it
    // below the `await this.key()` line → red.
    const { c, f } = connector({});
    // `batches` is a real Mailchimp resource this connector deliberately does
    // not serve, reached here through the same request path a read uses.
    await expect(
      (c as unknown as {
        request(op: string, path: string): Promise<unknown>;
      }).request("probe", `${MAILCHIMP_API_BASE_PATH}/batches`),
    ).rejects.toBeInstanceOf(ConnectorBlockedError);
    expect(f.calls).toHaveLength(0);
  });

  it("exposes no method whose name implies sending, mutating or deleting an audience", () => {
    // "Destructive is blocked" as a property of the code. Sending a campaign is
    // irreversible and externally visible to thousands of a customer's
    // contacts — the worst candidate in this batch for an agent-initiated
    // action.
    // Mutation: add a `sendCampaign` or `deleteMember` method → red.
    const names = Object.getOwnPropertyNames(MailchimpConnector.prototype);
    for (const n of names) {
      expect(n).not.toMatch(/^(send|delete|remove|unsubscribe|archive|update|create|add)/i);
    }
    // purgeAccount is the ONE deletion path, and it deletes OUR copies, never
    // anything in the customer's Mailchimp account.
    expect(names).toContain("purgeAccount");
  });

  it("refuses applyWrite outright — a customer's audience is not ours to change", async () => {
    // Mutation: let applyWrite fall through to a request → red.
    const { c, f } = connector({});
    await expect(c.applyWrite("reschedule_appointment", {})).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
    expect(f.calls).toHaveLength(0);
  });

  it("uses HTTP Basic with the documented anystring username, and no other auth header", async () => {
    // Mailchimp documents `anystring:apikey` Basic auth (or Bearer). The key is
    // base64'd in exactly one place.
    // Mutation: send the key as a bare header value → red.
    const { c, f } = connector({
      routes: [{ match: /ping/, responses: [{ body: {} }] }],
    });
    await c.probePlanAccess();
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`anystring:${KEY}`).toString("base64")}`,
    );
    expect(f.calls[0].init.redirect).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical row mappers (WARP-2497)
//
// `runRead` threw by design until this story, so all three datasets this track
// declares produced raw vendor JSON and no canonical rows — WARP-2218's
// scheduled sync ran, reported success, and landed nothing.
//
// The leak assertion matters more here than on any other track: a Mailchimp
// member object carries the subscriber's signup and opt-in IP addresses, their
// full merge-field bag and a location guess, none of which this product asked
// for. A mapper written as `{ ...member, ... }` would persist all of it on the
// box, so the fixtures below carry those fields specifically to catch it.
// ─────────────────────────────────────────────────────────────────────────────

/** ISO-8601 as `canonicalInstant` emits it: always UTC, always milliseconds. */
const MC_UTC_INSTANT = /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Mailchimp emits an explicit offset, not a `Z`. Normalising it is the point:
 *  two spellings of one moment in a watermark column is how a sync silently
 *  stops advancing. */
const LAST_CHANGED = "2026-08-20T09:30:00+00:00";
const OPTED_IN = "2026-07-01T08:15:00+00:00";
const SENT_AT = "2026-08-18T14:00:00+00:00";
const PROCESSED_AT = "2026-08-19T11:45:00+00:00";

/** The personal data this product never asked for, present on every member
 *  fixture so a spread-the-record mapper is observable. */
const MEMBER_PII = {
  ip_signup: "203.0.113.7",
  ip_opt: "203.0.113.8",
  merge_fields: { FNAME: "Ada", LNAME: "Lovelace", PHONE: "+15555550123" },
  location: { latitude: 33.64, longitude: -117.92 },
};

function memberPayload(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    email_address: `${id}@example.test`,
    status: "subscribed",
    timestamp_opt: OPTED_IN,
    last_changed: LAST_CHANGED,
    list_id: "aud-1",
    ...MEMBER_PII,
    ...overrides,
  };
}

function campaignPayload(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    send_time: SENT_AT,
    status: "sent",
    emails_sent: 1240,
    recipients: { list_id: "aud-1", recipient_count: 1240 },
    settings: { subject_line: "August product update", title: "Aug blast", from_name: "Ada" },
    report_summary: { unique_opens: 512, subscriber_clicks: 88, opens: 900, clicks: 140 },
    ...overrides,
  };
}

function orderPayload(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    store_id: "store-1",
    customer: { id: "cust-9", email_address: "buyer@example.test", opt_in_status: true },
    order_total: 149.5,
    currency_code: "USD",
    processed_at_foreign: PROCESSED_AT,
    // Mailchimp's own ingest time, deliberately DIFFERENT from the store's, so
    // a mapper reaching for the wrong one cannot pass by coincidence.
    processed_at: "2026-08-21T03:00:00+00:00",
    ...overrides,
  };
}

/** Route set for a full three-dataset enumeration. `lists` and `ecommerce` are
 *  already in MAILCHIMP_READABLE_RESOURCES, so this adds no new resource. */
function mcRoutes(opts: {
  members?: unknown[];
  campaigns?: unknown[];
  orders?: unknown[];
} = {}): Route[] {
  return [
    { match: /\/lists\/[^/]+\/members/, responses: [{ body: { members: opts.members ?? [] } }] },
    { match: /\/lists(\?|$)/, responses: [{ body: { lists: [{ id: "aud-1" }] } }] },
    { match: /\/campaigns/, responses: [{ body: { campaigns: opts.campaigns ?? [] } }] },
    {
      match: /\/ecommerce\/stores\/[^/]+\/orders/,
      responses: [{ body: { orders: opts.orders ?? [] } }],
    },
    { match: /\/ecommerce\/stores/, responses: [{ body: { stores: [{ id: "store-1" }] } }] },
  ];
}

const MAILCHIMP_FIXTURES: ReadonlyArray<{
  dataset: string;
  readQuery: string;
  routes: Route[];
}> = [
  {
    dataset: "audience_member",
    readQuery: "get_audience_members",
    routes: mcRoutes({ members: [memberPayload("m-1")] }),
  },
  {
    dataset: "campaign",
    readQuery: "get_campaign_performance",
    routes: mcRoutes({ campaigns: [campaignPayload("cmp-1")] }),
  },
  {
    dataset: "ecommerce_order",
    readQuery: "get_ecommerce_orders",
    routes: mcRoutes({ orders: [orderPayload("ord-1")] }),
  },
];

describe("canonical row mappers", () => {
  for (const fx of MAILCHIMP_FIXTURES) {
    it(`${fx.dataset}: emits EXACTLY the canonical columns, no more and no fewer`, async () => {
      // Mutation A (drop): make projectCanonicalRow skip a column → the key set
      //   shrinks → red.
      // Mutation B (leak): spread the vendor record into the row → the member's
      //   `ip_signup`, `ip_opt`, `merge_fields` and `location`, or the
      //   campaign's `report_summary`, appear → red. That mutation is the one
      //   that persists a subscriber's IP addresses onto the box.
      const { c } = connector({ routes: fx.routes });
      const rows = (await c.runRead(fx.readQuery, {})) as Record<string, unknown>[];

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(
          [...CANONICAL_COLUMNS[fx.dataset as never]].sort(),
        );
      }
    });

    it(`${fx.dataset}: every value matches its COLUMN_KIND`, async () => {
      // Mutation: drop the `money`/`count` branch from projectCanonicalRow →
      // `total_amount` and the campaign counts come back as strings → red.
      const { c } = connector({ routes: fx.routes });
      const rows = (await c.runRead(fx.readQuery, {})) as Record<string, unknown>[];

      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (value === undefined) continue;
          switch (COLUMN_KIND[column]) {
            case "timestamp":
              expect(String(value), `${fx.dataset}.${column}`).toMatch(MC_UTC_INSTANT);
              break;
            case "money":
            case "count":
              expect(typeof value, `${fx.dataset}.${column}`).toBe("number");
              break;
            default:
              expect(typeof value, `${fx.dataset}.${column}`).toBe("string");
              break;
          }
        }
      }
    });
  }

  it("fills an audience member from the fields Mailchimp actually publishes", async () => {
    // A key-set test passes just as well on a mapper returning every column
    // undefined. `last_changed_at` is the load-bearing one: it is this track's
    // watermark column, and WARP-2466 spelled it `last_changed_at` rather than
    // `updated_at`, so a mapper copied from the HubSpot track fills nothing.
    // Mutation: `case "last_changed_at": return record.updated_at;` → undefined
    //           → red.
    const { c } = connector({ routes: mcRoutes({ members: [memberPayload("m-1")] }) });
    const [row] = (await c.runRead("get_audience_members", {})) as Record<string, unknown>[];

    expect(row).toEqual({
      audience_member_id: "m-1",
      audience_id: "aud-1",
      email: "m-1@example.test",
      subscription_status: "subscribed",
      opted_in_at: new Date(OPTED_IN).toISOString(),
      last_changed_at: new Date(LAST_CHANGED).toISOString(),
    });
  });

  it("reads a campaign's subject from settings and its counts from report_summary", async () => {
    // Three different nesting depths in one row: `id` at the root,
    // `settings.subject_line` one level down, `report_summary.unique_opens`
    // one level down under a different key.
    // Mutation: return `report_summary.opens` for `opens_unique` → 900, not 512
    //           → red. Those count the same subscriber repeatedly and are a
    //           DIFFERENT measurement from the one the column names.
    const { c } = connector({ routes: mcRoutes({ campaigns: [campaignPayload("cmp-1")] }) });
    const [row] = (await c.runRead("get_campaign_performance", {})) as Record<string, unknown>[];

    expect(row).toEqual({
      campaign_id: "cmp-1",
      sent_at: new Date(SENT_AT).toISOString(),
      audience_id: "aud-1",
      subject: "August product update",
      status: "sent",
      emails_sent: 1240,
      opens_unique: 512,
      clicks_unique: 88,
    });
  });

  it("times an order by the STORE's clock, not Mailchimp's ingest time", async () => {
    // `processed_at_foreign` is the storefront's own timestamp. An order
    // imported a day late still happened when the store says it did, and using
    // the ingest time reorders a revenue report.
    // Mutation: `case "processed_at": return record.processed_at;` → red.
    const { c } = connector({ routes: mcRoutes({ orders: [orderPayload("ord-1")] }) });
    const [row] = (await c.runRead("get_ecommerce_orders", {})) as Record<string, unknown>[];

    expect(row).toEqual({
      ecommerce_order_id: "ord-1",
      store_id: "store-1",
      customer_id: "cust-9",
      total_amount: 149.5,
      currency: "USD",
      processed_at: new Date(PROCESSED_AT).toISOString(),
    });
  });

  it("normalises Mailchimp's offset timestamps to a UTC instant", async () => {
    // Mailchimp emits `+00:00`, every other track emits `Z`. `COLUMN_KIND`
    // types these `timestamp` precisely because a watermark COMPARES them, and
    // a string comparison of two spellings of one moment is how an incremental
    // sync silently stops advancing.
    // Mutation: return `record.last_changed` verbatim → red.
    const { c } = connector({ routes: mcRoutes({ members: [memberPayload("m-1")] }) });
    const [row] = (await c.runRead("get_audience_members", {})) as Record<string, unknown>[];

    expect(row.last_changed_at).toBe("2026-08-20T09:30:00.000Z");
    expect(row.last_changed_at).not.toBe(LAST_CHANGED);
  });

  it("passes `since` to Mailchimp as the documented since_last_changed filter", async () => {
    // Omitting the filter does NOT fail — it silently degrades into a full scan
    // returning correct-looking rows, which is why this asserts on the outgoing
    // REQUEST and not on the rows that came back.
    // Mutation: drop `sinceLastChanged: since` from the listMembers call → the
    //           parameter is absent → red.
    const { c, f } = connector({ routes: mcRoutes({ members: [memberPayload("m-1")] }) });

    await c.runRead("get_audience_members", { since: "2026-08-19T00:00:00Z" });

    const memberCall = f.urls().findIndex((u) => u.includes("/members"));
    expect(memberCall).toBeGreaterThanOrEqual(0);
    expect(f.params(memberCall).get("since_last_changed")).toBe("2026-08-19T00:00:00.000Z");
  });

  it("never smuggles a date filter onto the orders endpoint", async () => {
    // `/ecommerce/stores/{id}/orders` documents no `since_*` of any kind, and
    // Mailchimp IGNORES unknown query parameters — so an invented one produces
    // a full scan REPORTED AS a delta. `since` is therefore applied to the
    // mapped rows instead.
    // Mutation: pass `since` into the orders query string → assertEcommerceOrderParams
    //           throws → red.
    const { c, f } = connector({
      routes: mcRoutes({ orders: [orderPayload("ord-1"), orderPayload("ord-2")] }),
    });

    const rows = (await c.runRead("get_ecommerce_orders", {
      since: "2026-08-19T00:00:00Z",
    })) as Record<string, unknown>[];

    const orderCall = f.urls().findIndex((u) => u.includes("/orders"));
    for (const key of f.paramKeys(orderCall)) {
      expect(MAILCHIMP_ECOMMERCE_ORDER_PARAMS.has(key), `${key} is not documented`).toBe(true);
    }
    // The window still applied — to the rows, after mapping.
    expect(rows).toHaveLength(2);
  });

  it("enumerates every audience when the caller names none", async () => {
    // `get_audience_members` is enumerable — the sync runner has no audience id
    // to pass — but `/lists/{id}/members` is not: there is no account-wide
    // member endpoint, so the lists have to be listed first.
    // Mutation: return `[]` from audienceIds → no members at all → red.
    const { c, f } = connector({
      routes: [
        { match: /\/lists\/[^/]+\/members/, responses: [{ body: { members: [memberPayload("m-1")] } }] },
        { match: /\/lists(\?|$)/, responses: [{ body: { lists: [{ id: "aud-1" }, { id: "aud-2" }] } }] },
      ],
    });

    const rows = (await c.runRead("get_audience_members", {})) as Record<string, unknown>[];

    expect(rows).toHaveLength(2);
    expect(f.paths().filter((p) => p.endsWith("/members"))).toHaveLength(2);
  });

  it("filters on a supplied status and enumerates without one", async () => {
    // The registry query makes the status filter MANDATORY, because an
    // unfiltered member list mixes people who unsubscribed in with people who
    // did not. The sync runner still needs the enumeration.
    // Mutation: make the status filter unconditional → the `{}` call returns
    //           nothing → red.
    const routes = mcRoutes({
      members: [
        memberPayload("m-1"),
        memberPayload("m-2", { status: "unsubscribed" }),
      ],
    });

    const all = (await connector({ routes }).c.runRead("get_audience_members", {})) as Record<
      string,
      unknown
    >[];
    expect(all).toHaveLength(2);

    const only = (await connector({ routes }).c.runRead("get_audience_members", {
      status: "subscribed",
    })) as Record<string, unknown>[];
    expect(only.map((r) => r.audience_member_id)).toEqual(["m-1"]);
  });

  it("still refuses a read whose dataset this track does not serve", async () => {
    // `[]` from get_open_invoices reads as "you are owed nothing", which no
    // caller can tell apart from a genuinely empty ledger.
    // Mutation: drop the assertDatasetsServed call → red.
    const { c, f } = connector();
    await expect(c.runRead("get_open_invoices", {})).rejects.toBeInstanceOf(DatasetNotServedError);
    expect(f.calls).toHaveLength(0);
  });

  it("introspects the canonical shape it actually returns", async () => {
    // Before WARP-2466 this track's introspection described Mailchimp PROPERTY
    // spellings (`email_address`, `order_total`) while claiming to be canonical
    // columns, so drift-freeze watched a schema no caller ever saw.
    // Mutation: revert tables() to a local vendor-property table → red.
    const { c } = connector({ blocked: true });
    const out = await c.introspect();
    for (const t of out.tables) {
      expect(t.columns.map((col) => col.name).sort()).toEqual(
        [...CANONICAL_COLUMNS[t.name as never]].sort(),
      );
    }
  });
});
