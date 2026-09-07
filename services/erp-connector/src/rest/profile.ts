/**
 * WARP-2707 / ADR-046 — `RestVendorProfile`: a REST vendor expressed as DATA.
 *
 * ## Why this type exists
 *
 * The shipped cloud connectors are 1,740–2,927 lines each (`klaviyo` is 2,927,
 * `brevo` 2,896, `pipedrive` 2,458). Very little of that is vendor-specific:
 * it is the same paging loop, the same exact-host guard, the same metered-call
 * accounting and the same canonical projection, re-expressed once per vendor.
 * A survey of 341 business-tool APIs (2026-09-02) found 130 vendors the
 * account owner can mint a credential for in their own console — the ADR-042
 * model-3 shape — and a follow-up pass took 34 of them to buildable depth.
 * **Twenty-eight of the thirty-four are the same program:** authenticate a GET,
 * pass a watermark, walk pages, project rows onto canonical columns. The
 * differences between them are VALUES, not control flow.
 *
 * So they become values. One `RestProfileConnector` serves N vendors, each
 * described by one of these objects — the same move `export-drop` already made
 * for products that write files to a folder (`vendorFromExportProvider` → one
 * `exportDropFactory`, driven by declarative profiles), and the move
 * `ADD-A-PROVIDER.md` §0 tells you to look for before writing a connector at
 * all.
 *
 * ## The admission criterion for a field here
 *
 * **A field earns its place by naming a real, verified failure — not by
 * seeming general.** ADR-046 §2 is explicit that this is the only thing
 * holding the type's shape, and that it is a review rule rather than a
 * compile-time one. Every field below therefore carries the vendor that would
 * be silently wrong without it. A field that cannot name one does not belong,
 * and "some future vendor might want it" is exactly the argument the ADR
 * forbids.
 *
 * ## What this module is NOT
 *
 * Pure data and pure functions, in the same sense `ProviderDescriptor` is: no
 * I/O, no `fetch`, no vendor-specific control flow, and **no `if (provider ===
 * …)` anywhere downstream of it.** The moment a profile needs a branch the
 * connector has to special-case, that vendor has outgrown the track and gets a
 * bespoke connector — as Mailchimp and Stripe have. The track is the common
 * case, not a mandate.
 *
 * 🔴 **A profile is not the egress control.** For a vendor whose host is
 * assembled per account, `docs/security/allowed-egress.yaml` carries a
 * `kind: dynamic` entry that registers ZERO host patterns — `SECURITY.md` says
 * plainly that the static scanner "cannot see hostnames assembled at runtime".
 * The enforcement is `assertSafeRestBaseUrl()` in `./host-guard.js`, anchored
 * exact-host equality, in the shape of `QBO_ALLOWED_API_HOSTS` /
 * `UnsafeBaseUrlError`. Ten of the thirty-four vendors need it, which is why it
 * is a shared guard here rather than a per-connector one.
 */
import type { DatasetName } from "../export-drop/profiles.js";

/**
 * How the credential is presented on every request.
 *
 * 🔴 **Not a boolean, and not a scheme name.** Six distinct shapes turned up in
 * the eight vendors examined closely, and a `useBearer: boolean` would have
 * been wrong five times out of six:
 *
 * | Vendor    | Header          | Value                          |
 * |-----------|-----------------|--------------------------------|
 * | Square    | `Authorization` | `Bearer <token>`               |
 * | Linear    | `Authorization` | `<token>` — **no scheme**      |
 * | Zoho      | `Authorization` | `Zoho-oauthtoken <token>`      |
 * | Pipedrive | `x-api-token`   | `<token>`                      |
 * | GitLab    | `PRIVATE-TOKEN` | `<token>`                      |
 * | Brevo     | `api-key`       | `<token>`                      |
 *
 * Zoho is the trap that makes this a template rather than an enum: its token
 * response says `token_type: "Bearer"` and sending `Bearer` returns 401. The
 * only safe representation is the literal string the vendor documents.
 *
 * `valueTemplate` carries one or more `{{name}}` placeholders filled from the
 * connection's resolved credential fields. Most vendors use `{{token}}`;
 * Open Dental needs two in one header
 * (`ODFHIR {{developerKey}}/{{customerKey}}`), which is precisely why this is
 * a template and not a prefix string.
 */
export interface RestAuthHeader {
  /** The literal header name, e.g. `Authorization`, `x-api-token`, `api-key`. */
  readonly headerName: string;
  /**
   * The literal value, with `{{fieldName}}` placeholders resolved from the
   * connection's credential fields. A placeholder naming a field the
   * descriptor does not declare is a construction-time throw, never a request
   * that goes out with the literal `{{token}}` in it.
   */
  readonly valueTemplate: string;
}

/** Where a watermark value is carried on the wire. */
export type WatermarkLocation =
  /** A query-string parameter — the common case. */
  | "query"
  /**
   * A REQUEST HEADER. Zoho's watermark is `If-Modified-Since` and returns 304;
   * there is no query parameter for it. A query-only design would have to
   * full-scan Zoho forever and would report it as an incremental read.
   */
  | "header";

/** How a watermark value must be formatted for THIS vendor and endpoint. */
export type WatermarkFormat =
  /** Full ISO-8601 instant, e.g. `2026-09-07T10:00:00Z`. */
  | "iso"
  /**
   * DATE ONLY, no time component. GitLab's `after` on the events endpoint
   * takes a date; sending an instant is rejected. Truncation is lossy on
   * purpose and the connector must re-read the whole day rather than assume
   * the vendor kept the time it was never given.
   */
  | "date"
  /** Seconds since the Unix epoch, as a bare integer. */
  | "epoch-seconds"
  /** Milliseconds since the Unix epoch, as a bare integer. */
  | "epoch-millis"
  /** RFC-1123 / HTTP-date, which is what `If-Modified-Since` requires. */
  | "http-date";

/**
 * The incremental-read watermark for ONE dataset.
 *
 * 🔴 **Per dataset, never per vendor.** GitLab uses `updated_after` for issues,
 * `last_activity_after` for projects and `after` for events — three parameters,
 * one vendor, and the third takes a date rather than an instant. A
 * vendor-level watermark field would have been a lie on four of the eight
 * vendors examined.
 *
 * 🔴 **Absence is declared, never inferred.** GitHub's `since` is verified
 * present on `/issues` and verified ABSENT on `/pulls` and
 * `/orgs/{org}/repos`, and GitHub SILENTLY IGNORES unknown query parameters.
 * So a plausible guess there does not fail — it produces a full scan that the
 * box reports as an incremental read, forever. A dataset with no watermark
 * carries `watermark: null` and is swept as a full scan, honestly.
 */
export interface RestWatermark {
  /** The literal parameter or header name, exactly as the vendor spells it. */
  readonly name: string;
  readonly location: WatermarkLocation;
  readonly format: WatermarkFormat;
  /**
   * `true` when this is a genuine last-modified filter that moves on any edit.
   *
   * `false` when it is documented to miss edits — Postmark's `fromdate` is a
   * SEND-time filter, not a last-modified one, so an incremental pass keyed on
   * it never sees a later change. This mirrors the `complete` reasoning
   * `CANONICAL_COLUMNS` already carries for Xero's `UpdatedDateUTC` and is
   * load-bearing in exactly the same way: an incomplete watermark makes the
   * periodic full sweep MANDATORY rather than a safety net.
   */
  readonly complete: boolean;
}

/**
 * How to walk past the first page.
 *
 * A CLOSED union of five. Every arm below exists because a verified vendor
 * uses it; an arm cannot be added without a vendor that needs it.
 */
export type RestPagination =
  /**
   * An opaque forward-only token in the response body. Square
   * (`cursor`), Zoho past 2,000 rows (`page_token`).
   */
  | {
      readonly kind: "cursor";
      /** Dotted path to the next-cursor value, e.g. `additional_data.next_cursor`. */
      readonly nextCursorPath: string;
      /** The request parameter the cursor is echoed back in. */
      readonly cursorParam: string;
    }
  /**
   * RFC-5988 `Link` header with `rel="next"`. GitHub, and GitLab's keyset
   * pagination. The URL is taken from the header VERBATIM and must still pass
   * the exact-host guard — a `Link` header is vendor-controlled input, and a
   * redirect to another host through it is the obvious attack.
   */
  | { readonly kind: "link-header" }
  /** Classic `limit`/`offset`. Brevo. */
  | {
      readonly kind: "limit-offset";
      readonly limitParam: string;
      readonly offsetParam: string;
      readonly pageSize: number;
    }
  /**
   * Page number, with a boolean in the body saying whether more remain. Zoho
   * below 2,000 rows — note Zoho then SWITCHES to `cursor` past that ceiling,
   * which is why a vendor may need both and the connector must be able to
   * follow the switch rather than assume one mode per endpoint.
   */
  | {
      readonly kind: "page-number";
      readonly pageParam: string;
      /** Dotted path to the has-more boolean, e.g. `info.more_records`. */
      readonly hasMorePath: string;
      readonly pageSize: number;
      /**
       * Set when the vendor switches to a cursor past a row ceiling (Zoho at
       * 2,000). Absent for vendors with one mode.
       */
      readonly switchesToCursorAfter?: {
        readonly rows: number;
        readonly nextCursorPath: string;
        readonly cursorParam: string;
      };
    }
  /** Relay-style `pageInfo { hasNextPage, endCursor }`. Linear — GraphQL, and
   *  therefore OUT of v1 per ADR-046 §4; the arm is declared so the union is
   *  honest about what was surveyed, not because a v1 profile may use it. */
  | {
      readonly kind: "relay-pageinfo";
      readonly pageInfoPath: string;
    };

/**
 * Where this vendor is dialled.
 *
 * 🔴 The `dynamic` arm carries NO scheme-URL literal for the per-account host,
 * and that is a hard rule rather than a style preference: a `kind: dynamic`
 * allowlist entry registers zero hosts, so any `https://…` literal for it in
 * tracked source is extracted by `scripts/check-egress-allowlist.py` and fails
 * the gate as an unregistered destination. The anchor constant is a bare
 * suffix (`.pipedrive.com`), registered as `kind: reference` — see the
 * `ref-pipedrive-host-suffix` entry, which exists for exactly this reason.
 */
export type RestBaseUrl =
  /** One fixed host for every customer. Twenty-four of the thirty-four. */
  | { readonly kind: "static"; readonly origin: string }
  /**
   * Assembled per account — a region, a subdomain, a self-hosted install, or a
   * host handed back in a token response. Ten of the thirty-four.
   */
  | {
      readonly kind: "dynamic";
      /**
       * The `providerConfig` field holding the customer's value. Named rather
       * than assumed so it cannot drift from the `CredentialFieldDef` that
       * validates it.
       */
      readonly configField: string;
      /**
       * The anchored suffix the exact-host guard matches on, e.g.
       * `.pipedrive.com`. Bare host, never a URL. A profile whose customer
       * value is a WHOLE host (a self-hosted GitLab, a self-hosted Cal.com)
       * carries `allowedSuffixes: []` and relies on `allowedHosts` instead;
       * one of the two must be non-empty, checked at registration.
       */
      readonly allowedSuffixes: readonly string[];
      /** Exact hosts permitted in addition to the suffixes, e.g. a closed set
       *  of regional data-centre names (Zoho's `.com`/`.eu`/`.in`/`.au`). */
      readonly allowedHosts: readonly string[];
    };

/**
 * A conversion applied to a vendor value on its way to a canonical column.
 *
 * The admission criterion applies here as hard as anywhere: each arm names a
 * verified vendor failure, not a convenience.
 */
export type FieldTransform =
  /**
   * 🔴 Integer MINOR UNITS → the major-unit decimal `CANONICAL_COLUMNS` money
   * columns hold. Square documents `amount_money.amount` as *"the amount of
   * money, in the smallest denomination of the currency indicated by
   * `currency`. For example, when `currency` is USD, `amount` is in cents"* —
   * and Stripe, Brevo and most payment APIs do the same.
   *
   * A dotted path cannot divide, so without this arm every Square amount lands
   * a hundred times too large: a $12.50 charge reports as 1250. That is a
   * silent, confident, wrong statement about money, which is the failure class
   * `CANONICAL_COLUMNS`'s own comments are most careful about.
   *
   * 🔴 The divisor is NOT always 100. ISO-4217 exponents differ — JPY and KRW
   * are exponent 0 (the minor unit IS the major unit), and BHD, JOD, KWD, OMR
   * and TND are exponent 3. So the conversion needs the row's CURRENCY, which
   * is why {@link RestDatasetSpec.fieldMap} carries `currencyFrom` alongside
   * it rather than hardcoding a divisor.
   */
  | "minor-units"
  /**
   * A calendar DATE (`YYYY-MM-DD`) widened to an instant at UTC midnight.
   *
   * Square's payout `arrival_date` is *"the calendar date, in ISO 8601 format
   * (YYYY-MM-DD)"* while `COLUMN_KIND` says `arrival_at` is a timestamp.
   * Passing the date through lexically would put a non-instant in a timestamp
   * column, where every downstream `Date.parse` guesses a timezone for it. The
   * widening is lossy and DECLARED, rather than lossy and accidental.
   */
  | "date-to-instant";

/** How one canonical column is read out of a vendor row. */
export type FieldSource =
  /** A dotted path, taken verbatim. The common case. */
  | string
  /** A dotted path plus a declared conversion. */
  | {
      readonly path: string;
      readonly transform: FieldTransform;
      /**
       * For `minor-units`: the dotted path to this row's ISO-4217 currency
       * code, which decides the exponent. REQUIRED for that transform — a
       * money conversion with no currency is a hardcoded /100 wearing a
       * policy's clothes, and it is wrong for every JPY seller.
       */
      readonly currencyFrom?: string;
    };

/** One dataset this vendor serves, and exactly how to read it. */
export interface RestDatasetSpec {
  /**
   * MUST be one of the closed twenty-three `DATASET_NAMES`. Typed with
   * `DatasetName` rather than `string` on purpose: the exhaustive `Record`s
   * keyed by it (`CANONICAL_COLUMNS`, `DATASET_CATEGORY`) only buy
   * exhaustiveness while the union stays closed, and a vendor dataset with no
   * canonical home is a vocabulary decision — made deliberately, in the
   * dataset vocabulary, under its drift gate — never a `string` widening here.
   */
  readonly dataset: DatasetName;
  /** Path appended to the origin, e.g. `/v2/customers`. Leading slash. */
  readonly path: string;
  /** Constant query parameters this endpoint always needs. */
  readonly query?: Readonly<Record<string, string>>;
  /** `null` when this endpoint has NO watermark — declared, never inferred. */
  readonly watermark: RestWatermark | null;
  readonly pagination: RestPagination;
  /**
   * Dotted path to the array of rows in the response body; the empty string
   * means the body IS the array. Wrong here means zero rows reported as a
   * successful empty read, so it is pinned by a fixture test per vendor.
   */
  readonly rowsPath: string;
  /**
   * 🔴 `true` when this vendor OMITS the rows field entirely on an empty
   * result rather than sending an empty array.
   *
   * Square's ListCustomers returns the literal `{}` — the field is documented
   * as present only when there is something in it. Without this flag the
   * shared paging loop finds no array at `rowsPath` and raises a pagination
   * contract error, so a healthy account with no rows yet reads as a broken
   * connection.
   *
   * DECLARED per dataset rather than inferred globally, and defaulting to
   * `false`, because the alternative — treating every missing array as "no
   * rows" — would turn a genuinely wrong `rowsPath` into a permanent silent
   * empty read, which is the worse of the two failures.
   */
  readonly absentRowsMeansEmpty?: boolean;
  /**
   * Vendor field → canonical column. Keys are exactly the columns in
   * `CANONICAL_COLUMNS[dataset]`; values are dotted paths into a vendor row,
   * or a path plus a declared {@link FieldTransform}.
   *
   * A column absent from this map is written `undefined` by
   * `projectCanonicalRow`, which is the honest representation of "this vendor
   * does not carry that fact" — never a fabricated default. Square's Customer
   * carries no `total_spent_amount`, and a `0` there would read as "this
   * customer has never bought anything".
   */
  readonly fieldMap: Readonly<Record<string, FieldSource>>;
}

/** A whole vendor, as data. */
export interface RestVendorProfile {
  /** Matches `ProviderDescriptor.id` exactly — the join between the two. */
  readonly provider: string;
  readonly baseUrl: RestBaseUrl;
  readonly auth: RestAuthHeader;
  /**
   * Mandatory constant headers. Klaviyo requires a dated `revision`, Square a
   * `Square-Version`, GitHub an `X-GitHub-Api-Version`. Omitting one is a 400,
   * not a default — so these are part of the profile, not a nicety.
   */
  readonly constantHeaders: Readonly<Record<string, string>>;
  /**
   * The cheapest authenticated read that proves the credential works.
   *
   * 🔴 Not optional, and not a dataset endpoint. `connect()` and `health()`
   * both call it, and `integrations.service.ts` treats a successful `health()`
   * as THE evidence a pasted key is good — so without a real round trip a
   * revoked key would be written CONNECTED and fail hours later on a schedule,
   * unattended. Every shipped cloud track has one (Brevo `GET /account`,
   * Pipedrive `GET /api/v1/users/me`); making it a profile field is how the
   * declarative track keeps that property instead of quietly dropping it.
   *
   * Pick the endpoint that returns the FEWEST rows: a health probe runs on
   * every connect and every status poll, and pointing it at a paginated
   * collection spends the customer's rate budget to learn one bit.
   */
  readonly probePath: string;
  readonly datasets: readonly RestDatasetSpec[];
  /**
   * Minimum milliseconds between requests, derived from the vendor's published
   * ceiling (Pipedrive 20 per 2 s → 100 ms; Klaviyo 150/min → 400 ms).
   *
   * Omit it where the vendor publishes NO ceiling. Square is the case in
   * point: it documents none, so the connector reacts to `429` and the
   * `Retry-After`/`X-RateLimit-*` headers where they arrive rather than
   * pacing against an invented number. A guessed ceiling is a policy wearing a
   * fact's clothes — the same reasoning that leaves Dentrix Ascend with no
   * `ProviderRateLimit` on its descriptor.
   */
  readonly minRequestIntervalMs?: number;
}

/** Thrown when a profile is structurally impossible — at registration, not on
 *  the first request, so a malformed profile cannot reach a customer's key. */
export class InvalidRestProfileError extends Error {
  readonly provider: string;
  constructor(provider: string, reason: string) {
    super(`REST profile "${provider}" is invalid: ${reason}`);
    this.name = "InvalidRestProfileError";
    this.provider = provider;
  }
}

/** Every `{{placeholder}}` in an auth value template, in order of appearance. */
export function authPlaceholders(auth: RestAuthHeader): string[] {
  return [...auth.valueTemplate.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
}

/**
 * Structural validation, run at registration for every built-in profile.
 *
 * Deliberately checks only what is decidable from the profile alone. Whether a
 * watermark parameter is the one the vendor honours is NOT decidable here —
 * that is pinned per vendor by a test citing the vendor's documentation page,
 * exactly as `graph-resources.test.ts` does for Microsoft Graph.
 */
export function assertValidRestProfile(profile: RestVendorProfile): void {
  const fail = (reason: string): never => {
    throw new InvalidRestProfileError(profile.provider, reason);
  };

  if (!profile.provider) fail("provider id is empty");

  if (authPlaceholders(profile.auth).length === 0) {
    fail("auth valueTemplate carries no {{placeholder}}, so no credential would be sent");
  }
  if (!profile.auth.headerName) fail("auth headerName is empty");

  if (profile.baseUrl.kind === "static") {
    // A static origin must be an https origin and nothing more — no path, no
    // query. A path here would silently prefix every dataset path.
    let parsed: URL;
    try {
      parsed = new URL(profile.baseUrl.origin);
    } catch {
      return fail(`static origin "${profile.baseUrl.origin}" is not a URL`);
    }
    if (parsed.protocol !== "https:") fail("static origin must be https");
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      fail("static origin must be a bare origin, with no path, query or fragment");
    }
  } else {
    const { allowedHosts, allowedSuffixes, configField } = profile.baseUrl;
    if (!configField) fail("dynamic baseUrl names no configField");
    if (allowedHosts.length === 0 && allowedSuffixes.length === 0) {
      // Refused rather than defaulted: an empty guard is an unconstrained
      // destination, which is the exact failure `kind: dynamic` exists to
      // prevent. Absence is never a silent allow.
      fail("dynamic baseUrl must carry at least one allowed host or suffix");
    }
    for (const suffix of allowedSuffixes) {
      if (!suffix.startsWith(".")) fail(`host suffix "${suffix}" must start with a dot`);
      if (suffix.includes("/")) fail(`host suffix "${suffix}" must be a bare host suffix, not a URL`);
    }
    for (const host of allowedHosts) {
      if (host.includes("/")) fail(`allowed host "${host}" must be a bare host, not a URL`);
    }
  }

  if (!profile.probePath.startsWith("/")) fail('probePath must start with "/"');
  if (profile.datasets.length === 0) fail("profile serves no datasets");

  const seen = new Set<string>();
  for (const spec of profile.datasets) {
    if (seen.has(spec.dataset)) fail(`dataset "${spec.dataset}" is declared twice`);
    seen.add(spec.dataset);
    if (!spec.path.startsWith("/")) fail(`dataset "${spec.dataset}" path must start with "/"`);
  }
}
