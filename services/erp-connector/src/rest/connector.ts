/**
 * WARP-2707 / ADR-046 — `RestProfileConnector`: ONE `Connector` serving N
 * vendors, each described by a {@link RestVendorProfile}.
 *
 * ## What this replaces
 *
 * `klaviyo/connector.ts` is 2,927 lines. `brevo/connector.ts` is 2,896.
 * `pipedrive/connector.ts` is 2,458. Read the three side by side and the same
 * program appears three times: resolve a host, guard it, resolve a key, pace
 * against a ceiling, issue a GET, read an array out of a body, follow a cursor,
 * project each row onto canonical columns, filter and sort for the named read
 * query. The differences are VALUES — a header name, a parameter spelling, a
 * dotted path — and values belong in data.
 *
 * ## The inversion this accepts, stated plainly
 *
 * ADR-046's Consequences section is explicit: **a bug here is a bug in every
 * vendor at once.** Today a Mailchimp defect is a Mailchimp defect. That is the
 * standing argument for this module's test suite being heavier than any single
 * connector's, and it is why the guard order below is pinned by tests rather
 * than merely commented.
 *
 * ## Read-only by construction
 *
 * `applyWrite` throws, always. ADR-046 §4 is unambiguous: the write-command
 * registry, the confirm-outbox and the forbidden-table rules exist for the LAN
 * tracks and are not weakened by a track that cannot write at all. A profile
 * cannot opt into writes, because there is no field for it — the absence is the
 * enforcement.
 */
import {
  ConnectorBlockedError,
  DatasetNotServedError,
  assertDatasetsServed,
  type Connector,
  type IntrospectionResult,
} from "../connector.js";
import { projectCanonicalRow } from "../canonical-row.js";
import { CANONICAL_COLUMNS, type DatasetName } from "../export-drop/profiles.js";
import { getReadQuery } from "../read-queries.js";
import { assertTargetAllowed, getWriteCommand } from "../write-commands.js";
import { computeSchemaFingerprint } from "../schema-map.js";
import {
  assertSafeFollowUrl,
  assertSafeRestBaseUrl,
  UnsafeBaseUrlError,
} from "./host-guard.js";
import {
  applyRestReadFilter,
  applyRestReadOrder,
  restReadSemantics,
} from "./read-semantics.js";
import {
  assertValidRestProfile,
  authPlaceholders,
  type FieldSource,
  type RestDatasetSpec,
  type RestVendorProfile,
  type WatermarkFormat,
} from "./profile.js";
import type { IntrospectedTable } from "../schema-map.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Resolves this connection's credential FIELDS — one entry per `{{placeholder}}`
 * in the profile's auth template.
 *
 * A map rather than a single string because Open Dental needs two values in one
 * header (`ODFHIR {{developerKey}}/{{customerKey}}`), and because a
 * single-string resolver would have to be widened the first time a second
 * two-part vendor arrived.
 */
export type RestCredentialResolver = () => Promise<Record<string, string>>;

/** The default resolver: refuses, rather than sending an empty credential. */
export const blockedRestCredentialResolver: RestCredentialResolver = () => {
  throw new ConnectorBlockedError(
    "resolve the vendor credential",
    "no credential resolver was wired for this connection — reconnect the integration from the Integrations page",
  );
};

export interface RestConnectorConfig {
  /** Matches `ProviderDescriptor.id` and the profile's `provider`. */
  readonly provider: string;
  /**
   * The customer's value for a dynamic host — their Pipedrive company domain,
   * their Zoho data-centre host, their self-hosted origin. Unset for a static
   * profile, and REQUIRED for a dynamic one: an absent value is refused at
   * construction rather than defaulted to a sampled region.
   */
  readonly hostConfigValue?: string;
}

export interface RestConnectorDeps {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly resolveCredentials?: RestCredentialResolver;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/** Default per-request timeout. Matches the other cloud tracks. */
export const REST_REQUEST_TIMEOUT_MS = 30_000;

/** Pages walked for one dataset before the connector stops and says so.
 *
 *  A ceiling rather than a `while (true)`: a vendor whose cursor never
 *  terminates (or whose `Link` header points at itself) would otherwise spin
 *  against a customer's rate ceiling forever. Hitting it is reported, never
 *  silently truncated — ADR-046's "no silent caps" rule. */
export const REST_MAX_PAGES = 500;

/** Thrown when a vendor's pagination does not behave as the profile declares. */
export class RestPaginationContractError extends Error {
  readonly code = "PAGINATION_CONTRACT";
  constructor(provider: string, detail: string) {
    super(`"${provider}" pagination: ${detail}`);
    this.name = "RestPaginationContractError";
  }
}

/** Thrown when the vendor answers with a non-2xx this track cannot interpret. */
export class RestVendorError extends Error {
  readonly code = "VENDOR_ERROR";
  constructor(
    readonly provider: string,
    readonly status: number,
    detail: string,
  ) {
    super(`"${provider}" answered ${status}: ${detail}`);
    this.name = "RestVendorError";
  }
}

const REST_TRACK_REMEDIATION =
  "check the key you pasted is still valid in the vendor's console, then reconnect this integration from the Integrations page";

/** Read a dotted path out of a parsed body. `""` means the body itself. */
export function readPath(body: unknown, path: string): unknown {
  if (path === "") return body;
  let cursor: unknown = body;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * ISO-4217 currencies whose minor unit is NOT 1/100 of the major unit.
 *
 * 🔴 A hardcoded `/100` is wrong for every one of these. JPY and KRW have no
 * minor unit at all — ¥1250 in Square's `amount` is ¥1250, not ¥12.50 — and the
 * three-decimal currencies below run the error the other way. Listed rather
 * than looked up: the set is small, stable and standardised, and a runtime
 * table would be a dependency on data this box has no reason to fetch.
 *
 * Anything absent is exponent 2, which is the overwhelming majority.
 */
const CURRENCY_EXPONENT: Readonly<Record<string, number>> = {
  // exponent 0 — the minor unit IS the major unit
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // exponent 3
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

/**
 * Convert an integer minor-unit amount to the major-unit decimal the canonical
 * money columns hold, using the ROW'S OWN currency to pick the exponent.
 *
 * Returns `undefined` — never a guess — when either the amount or the currency
 * is missing. A money value converted under an assumed currency is exactly the
 * confidently-wrong number this whole layer exists to avoid.
 */
export function fromMinorUnits(amount: unknown, currency: unknown): number | undefined {
  const raw = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(raw)) return undefined;
  if (typeof currency !== "string" || currency.trim() === "") return undefined;
  const exponent = CURRENCY_EXPONENT[currency.trim().toUpperCase()] ?? 2;
  if (exponent === 0) return raw;
  // Rounded at the currency's own precision: 1250/100 is exact, but floating
  // division at exponent 3 leaves trailing error that would print as
  // 12.501999999999999 in a money column.
  return Number((raw / 10 ** exponent).toFixed(exponent));
}

/** Read one canonical column out of a vendor row, honouring any transform. */
export function readField(row: unknown, source: FieldSource | undefined): unknown {
  if (source === undefined) return undefined;
  if (typeof source === "string") return readPath(row, source);

  const value = readPath(row, source.path);
  if (value === undefined || value === null) return undefined;

  switch (source.transform) {
    case "minor-units":
      return fromMinorUnits(
        value,
        source.currencyFrom === undefined ? undefined : readPath(row, source.currencyFrom),
      );
    case "date-to-instant": {
      // `YYYY-MM-DD` widened to that day's UTC midnight. Anything else is
      // refused rather than coerced — a half-parsed date in a timestamp column
      // is worse than an absent one.
      const text = String(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
      return `${text}T00:00:00.000Z`;
    }
  }
}

/** Format a watermark instant the way THIS endpoint requires. */
export function formatWatermark(iso: string, format: WatermarkFormat): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) throw new RangeError(`watermark "${iso}" is not an instant`);
  switch (format) {
    case "iso":
      return new Date(at).toISOString();
    case "date":
      // Lossy ON PURPOSE — GitLab's events `after` takes a date, and the caller
      // must re-read the whole day rather than assume the vendor kept a time it
      // was never given.
      return new Date(at).toISOString().slice(0, 10);
    case "epoch-seconds":
      return String(Math.floor(at / 1000));
    case "epoch-millis":
      return String(at);
    case "http-date":
      return new Date(at).toUTCString();
    default:
      throw new RangeError(`unknown watermark format "${format}"`);
  }
}

/** Parse `Link: <url>; rel="next"` and return the next URL, if any. */
export function nextLinkFrom(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (match) return match[1]!;
  }
  return null;
}

export class RestProfileConnector implements Connector {
  readonly provider: string;
  readonly servesDatasets: readonly DatasetName[];

  private readonly profile: RestVendorProfile;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolveCredentials: RestCredentialResolver;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  /** Resolved and guarded ONCE at construction, re-checked per request. */
  private readonly origin: string;
  /** The customer's raw per-account host value, kept so the per-request
   *  re-guard runs over the SAME input the construction-time guard saw —
   *  re-deriving it from the resolved origin would check the guard's own
   *  output, which can only ever agree with itself. */
  private readonly hostConfigValue?: string;

  private credentials: Record<string, string> | null = null;
  /** `null` until the first request. Pacing is the gap BETWEEN requests, so
   *  the first one of a session must not wait — a `0` sentinel would make
   *  every connect pay a full interval before its first byte. */
  private lastRequestAt: number | null = null;
  private lastReadAt: number | null = null;
  /** Set by `connect()`, as on every other track — the value the drift check
   *  compares against on later connects. */
  private fingerprint: string | null = null;

  constructor(
    profile: RestVendorProfile,
    config: RestConnectorConfig,
    deps: RestConnectorDeps = {},
  ) {
    // Structural validation FIRST: a malformed profile must fail to build,
    // loudly, rather than look fine until the first read ships a key.
    assertValidRestProfile(profile);
    if (profile.provider !== config.provider) {
      throw new ConnectorBlockedError(
        `construct the "${config.provider}" connector`,
        `the profile registered for it names "${profile.provider}"`,
      );
    }
    this.profile = profile;
    this.provider = profile.provider;
    this.servesDatasets = profile.datasets.map((d) => d.dataset);
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.resolveCredentials = deps.resolveCredentials ?? blockedRestCredentialResolver;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? REST_REQUEST_TIMEOUT_MS;
    // Validated at CONSTRUCTION, for the same reason Brevo does it: a
    // connection naming a destination we will not dial should fail to build
    // rather than look fine until the first read ships a credential.
    this.hostConfigValue = config.hostConfigValue;
    this.origin = assertSafeRestBaseUrl(this.provider, profile.baseUrl, config.hostConfigValue);
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(detail ? `${op} (${detail})` : op, REST_TRACK_REMEDIATION);
  }

  /**
   * Resolve the credential fields and fill the auth header.
   *
   * NO SHAPE VALIDATION of the values, deliberately, and for the reason Brevo
   * records: a rejecting pattern anchored on an undocumented key prefix is a
   * false rejection that blocks a paying customer for zero security gain.
   * Emptiness is the only thing refused, because an empty header is a request
   * that cannot succeed.
   *
   * A placeholder the connection has no value for is refused too — otherwise
   * the literal `{{token}}` goes out on the wire and lands in the vendor's logs
   * as a failed auth attempt nobody can explain.
   */
  private async authHeaderValue(): Promise<string> {
    if (!this.credentials) {
      const resolved = await this.resolveCredentials();
      this.credentials = resolved ?? {};
    }
    const values = this.credentials;
    let filled = this.profile.auth.valueTemplate;
    for (const name of authPlaceholders(this.profile.auth)) {
      const value = values[name];
      if (typeof value !== "string" || value.trim() === "") {
        throw this.blocked(
          `resolve the "${this.provider}" credential`,
          `the stored credential has no "${name}"`,
        );
      }
      filled = filled.replaceAll(`{{${name}}}`, value.trim());
    }
    return filled;
  }

  /**
   * One request. THE choke point — every call this connector makes goes through
   * here, which is why every guard lives here rather than on the callers.
   *
   * Order is load-bearing and `rest-connector.guards.test.ts` asserts on it:
   *
   *   1. the host guard ({@link assertSafeRestBaseUrl}) — re-run per request,
   *      not only at construction, because a tampered connection row is exactly
   *      what it exists to stop;
   *   2. the URL is built onto the GUARDED origin, never onto the caller's
   *      string, so a query or fragment smuggled into a base URL cannot survive;
   *
   * both BEFORE the credential resolves — so a refused destination costs zero
   * fetch calls and never touches the key. Then the credential, then the pace.
   *
   * 🔴 The tests for every refusal assert `fetch` was called ZERO times, never
   * merely that an error was thrown. A test that inspects the outcome still
   * passes when the request already went out carrying the customer's key.
   */
  private async request(
    op: string,
    url: string,
    /**
     * Per-request headers the DATASET requires — today only a header-located
     * watermark (Zoho's `If-Modified-Since`). Threaded explicitly rather than
     * folded into `constantHeaders`, because these vary per read while those
     * are fixed for the vendor. Dropping this parameter silently full-scans
     * every header-watermarked vendor and reports it as an incremental read.
     */
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<{ body: unknown; headers: Headers }> {
    // (1) and (2): the destination is settled before the credential exists.
    const origin = assertSafeRestBaseUrl(this.provider, this.profile.baseUrl, this.hostConfigValue);
    const target = assertSafeFollowUrl(this.provider, origin, url);

    const authValue = await this.authHeaderValue();

    // Pacing, never refusal — a wait keeps a slow sync correct where a refusal
    // would make it incomplete. Omitted entirely for vendors that publish no
    // ceiling (Square), which react to 429 instead of an invented number.
    const interval = this.profile.minRequestIntervalMs;
    if (interval !== undefined && this.lastRequestAt !== null) {
      const waited = this.now() - this.lastRequestAt;
      if (waited < interval) await this.sleep(interval - waited);
    }
    this.lastRequestAt = this.now();

    const headers: Record<string, string> = {
      ...this.profile.constantHeaders,
      ...extraHeaders,
      [this.profile.auth.headerName]: authValue,
      accept: "application/json",
    };

    const doFetch = this.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!doFetch) throw this.blocked(op, "no fetch implementation is available");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await doFetch(target, { method: "GET", headers, signal: controller.signal });
    } catch (error) {
      throw this.blocked(op, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      // A rejected credential is not an outage. Distinguishing it is what lets
      // the hub say "paste a new key" instead of "can't connect".
      throw this.blocked(op, `the vendor rejected the credential (${response.status})`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new RestVendorError(this.provider, response.status, detail.slice(0, 500));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new RestVendorError(
        this.provider,
        response.status,
        `the response was not JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return { body, headers: response.headers };
  }

  /** The dataset spec for a canonical dataset, or `undefined`. */
  private specFor(dataset: DatasetName): RestDatasetSpec | undefined {
    return this.profile.datasets.find((d) => d.dataset === dataset);
  }

  /** Build the first page's URL for a dataset, applying the watermark. */
  private firstPageUrl(spec: RestDatasetSpec, since: string | undefined): { url: string; headers: Record<string, string> } {
    const url = new URL(this.origin + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, value);

    const extraHeaders: Record<string, string> = {};
    if (spec.watermark && since !== undefined) {
      const formatted = formatWatermark(since, spec.watermark.format);
      if (spec.watermark.location === "query") {
        url.searchParams.set(spec.watermark.name, formatted);
      } else {
        extraHeaders[spec.watermark.name] = formatted;
      }
    }
    if (spec.pagination.kind === "limit-offset") {
      url.searchParams.set(spec.pagination.limitParam, String(spec.pagination.pageSize));
      url.searchParams.set(spec.pagination.offsetParam, "0");
    }
    if (spec.pagination.kind === "page-number") {
      url.searchParams.set(spec.pagination.pageParam, "1");
    }
    return { url: url.toString(), headers: extraHeaders };
  }

  /**
   * Walk every page of one dataset and return the raw vendor rows.
   *
   * The page ceiling ({@link REST_MAX_PAGES}) is REPORTED when hit, never
   * silently applied: a truncated read that looks complete is the failure this
   * codebase refuses everywhere else, and a vendor whose cursor never
   * terminates is a real shape, not a hypothetical.
   */
  private async readPages(spec: RestDatasetSpec, since: string | undefined): Promise<unknown[]> {
    const rows: unknown[] = [];
    const paging = spec.pagination;
    const first = this.firstPageUrl(spec, since);
    // The watermark header rides on EVERY page, not just the first: it is the
    // filter, and dropping it on page two would widen the read mid-walk.
    const datasetHeaders = first.headers;
    let url = first.url;
    let page = 0;

    while (url) {
      if (page >= REST_MAX_PAGES) {
        throw new RestPaginationContractError(
          this.provider,
          `${spec.dataset} did not terminate within ${REST_MAX_PAGES} pages — refusing to report a truncated read as complete`,
        );
      }
      const { body, headers } = await this.request(`read ${spec.dataset}`, url, datasetHeaders);
      page += 1;

      const found = readPath(body, spec.rowsPath);
      // Square omits the rows field entirely on an empty result (`{}`, not
      // `{"customers": []}`), so for a vendor that declares it, ABSENT means
      // no rows. Only absent — a present-but-not-an-array value is still a
      // contract error, because that is a wrong `rowsPath`, not an empty page.
      const chunk =
        found === undefined && spec.absentRowsMeansEmpty ? [] : found;
      if (!Array.isArray(chunk)) {
        throw new RestPaginationContractError(
          this.provider,
          `${spec.dataset}: no array at "${spec.rowsPath || "(root)"}"`,
        );
      }
      rows.push(...chunk);

      url = this.nextPageUrl(spec, paging, body, headers, chunk.length, rows.length, url);
    }
    return rows;
  }

  /** Resolve the next page's URL for the declared pagination shape, or `""`. */
  private nextPageUrl(
    spec: RestDatasetSpec,
    paging: RestDatasetSpec["pagination"],
    body: unknown,
    headers: Headers,
    chunkLength: number,
    total: number,
    currentUrl: string,
  ): string {
    switch (paging.kind) {
      case "cursor": {
        const next = readPath(body, paging.nextCursorPath);
        if (typeof next !== "string" || next === "") return "";
        const url = new URL(currentUrl);
        url.searchParams.set(paging.cursorParam, next);
        return url.toString();
      }
      case "link-header": {
        const next = nextLinkFrom(headers.get("link"));
        // Re-guarded by `request()`; a Link header is vendor-controlled input
        // and a cross-host next-page URL is the obvious credential exfiltration.
        return next ?? "";
      }
      case "limit-offset": {
        if (chunkLength < paging.pageSize) return "";
        const url = new URL(currentUrl);
        url.searchParams.set(paging.offsetParam, String(total));
        return url.toString();
      }
      case "page-number": {
        const switchAt = paging.switchesToCursorAfter;
        if (switchAt && total >= switchAt.rows) {
          const next = readPath(body, switchAt.nextCursorPath);
          if (typeof next !== "string" || next === "") return "";
          const url = new URL(currentUrl);
          url.searchParams.delete(paging.pageParam);
          url.searchParams.set(switchAt.cursorParam, next);
          return url.toString();
        }
        const hasMore = readPath(body, paging.hasMorePath);
        if (hasMore !== true) return "";
        const url = new URL(currentUrl);
        const current = Number(url.searchParams.get(paging.pageParam) ?? "1");
        url.searchParams.set(paging.pageParam, String(current + 1));
        return url.toString();
      }
      case "relay-pageinfo": {
        // Declared for honesty about what was surveyed; GraphQL is OUT of v1
        // per ADR-046 §4, so reaching this arm means a profile shipped that the
        // track cannot serve.
        throw new RestPaginationContractError(
          this.provider,
          `${spec.dataset} declares relay pagination, which this track does not serve (ADR-046 §4)`,
        );
      }
    }
  }

  /**
   * Prove the credential against the VENDOR, not just against our own store.
   *
   * 🔴 Resolving the credential locally is not a connection. A key that is
   * well-formed, present and revoked resolves perfectly and fails on the first
   * read — hours later, on a schedule, where nobody is watching. Every shipped
   * cloud track probes here instead (Brevo `GET /account`, Pipedrive
   * `GET /users/me`), and this track does the same through the profile's
   * declared {@link RestVendorProfile.probePath}.
   */
  async connect(): Promise<void> {
    await this.request("connect", `${this.origin}${this.profile.probePath}`);
    this.fingerprint = (await this.introspect()).fingerprint;
  }

  async close(): Promise<void> {
    this.credentials = null;
  }

  /**
   * 🔴 REJECTS on failure — it does NOT return `{ ok: false }`.
   *
   * This is the connectors' blocked-boundary contract, and
   * `integrations.service.ts` depends on it: it awaits `health()` and treats a
   * successful CALL as the evidence the credential works. A `{ ok: false }`
   * return there is a value nobody reads, so a dead connection would be
   * written CONNECTED with a fresh `lastHealthyAt`.
   */
  async health(): Promise<{ ok: boolean }> {
    await this.request("health", `${this.origin}${this.profile.probePath}`);
    return { ok: true };
  }

  /**
   * "Introspection" for a REST vendor is the PROFILE, not a live schema.
   *
   * There is no catalog to query, so the fingerprint is taken over the shape
   * this connector will read — dataset, path, watermark and pagination. That is
   * the honest analogue: it changes when the contract this box relies on
   * changes, which is exactly what the drift fingerprint is for on the LAN
   * tracks. It does NOT claim to notice a vendor changing their API underneath
   * a stable profile; only the per-vendor tests that cite the vendor's own
   * documentation page can do that.
   */
  async introspect(): Promise<IntrospectionResult> {
    const tables: IntrospectedTable[] = this.profile.datasets.map((spec) => ({
      name: spec.dataset,
      // No schema owner exists on a REST vendor. The provider id is the
      // truthful namespace for these "tables" — an invented "dba" would read
      // as a database this connection does not have.
      owner: this.provider,
      columns: CANONICAL_COLUMNS[spec.dataset].map((column) => ({
        name: column,
        type: "canonical",
      })),
    }));
    // `computeSchemaFingerprint` rather than a local hash, matching Pipedrive
    // and Brevo: one canonicalisation rule under test instead of two, and a
    // drift value comparable with every other track's.
    //
    // 🔴 Be precise about what this DOES catch. It hashes the tables above —
    // the datasets served and their canonical columns — so it moves when this
    // connection stops serving a dataset or the canonical vocabulary changes
    // underneath it. It does NOT move when a vendor changes a path, a
    // watermark parameter or a response shape beneath a stable profile: there
    // is no live catalog to introspect, so nothing here can observe that. Only
    // the per-vendor tests that cite the vendor's own documentation page can,
    // which is why ADR-046 §2's last bullet makes them mandatory rather than
    // optional.
    return { tables, fingerprint: computeSchemaFingerprint(tables) };
  }

  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);

    const semantics = restReadSemantics(name);
    if (!semantics) {
      // A read query the track has no declarative semantics for. Refused by
      // name rather than answered with an empty array — `[]` from a money
      // query reads as a confident false statement, which `DatasetNotServedError`
      // exists to avoid.
      throw new DatasetNotServedError(this.provider, name, query.dependsOnTables);
    }
    const spec = this.specFor(semantics.dataset);
    if (!spec) throw new DatasetNotServedError(this.provider, name, [semantics.dataset]);

    const since = typeof params.since === "string" ? params.since : undefined;
    const raw = await this.readPages(spec, since);
    this.lastReadAt = this.now();

    const projected = raw.map((row) =>
      projectCanonicalRow(spec.dataset, (column) => readField(row, spec.fieldMap[column])),
    );
    return applyRestReadOrder(applyRestReadFilter(projected, semantics.filter, params), semantics.orderBy);
  }

  /**
   * 🔴 Always throws. ADR-046 §4: the track is read-only BY CONSTRUCTION, and
   * there is no profile field that could turn this on. A vendor that needs
   * writes needs a bespoke connector and the outbox→confirm→apply→verify
   * pipeline that goes with it.
   */
  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Same validation ORDER as every other track, so a caller's bug produces
    // the same typed error here as anywhere else: an unknown command name is
    // `UnknownWriteCommandError`, not "this track is read-only". Refusing
    // first would tell a caller with a typo the wrong thing about their bug.
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    throw new ConnectorBlockedError(
      `apply "${name}" through the "${this.provider}" connection`,
      "this integration is read-only — Droplet reads from it and never writes back",
    );
  }

  /** When this connection last returned rows, for the connection card. */
  get lastRead(): number | null {
    return this.lastReadAt;
  }
}

export { UnsafeBaseUrlError };
