/**
 * WARP-2127 — `DentrixAscendConnector`: Henry Schein One's cloud dental
 * practice-management system, read over its Public API.
 *
 * ## Why this one exists when the on-premise Dentrix connector does not
 *
 * Both are Dentrix. Only one can be written honestly today, and the difference
 * is not effort — it is whether a contract exists to write against.
 *
 * On-premise Dentrix (the Developer Program) publishes 172 object NAMES and
 * refuses the schema as policy: *"Henry Schein ONE does not share or divulge
 * the data dictionary or schema."* Not one column name is public. A connector
 * for it would invent every field reference, pass its own tests, and fail at
 * the first real site (WARP-2126 removed a much smaller guess for exactly that
 * reason).
 *
 * Dentrix Ascend publishes a complete OpenAPI 3.0.0 specification, anonymously,
 * with no login. Every endpoint, parameter, filter operator and response field
 * below is read from it. Nothing here is guessed.
 *
 * ## Spec provenance — record it, because a tolerant-reader contract moves
 *
 *   openapi 3.0.0 · info.version 186.0.9 · 300 paths / 449 operations / 436 schemas
 *   https://papidocs.hs1api.com/publicapi/apispec  (2,421,594 bytes, sha256 d3a0f06d1889c685…)
 *   fetched 2026-08-20
 *
 * The vendor's own guidance is tolerant-reader: fields may be ADDED without a
 * version bump. So this connector reads only the fields it maps and ignores the
 * rest, and pins the spec version it was written against in the drift
 * fingerprint — a schema change that matters shows up as drift rather than as
 * quietly different numbers.
 *
 * ## ⚠ This is a CLOUD CONNECTOR under ADR-041, with one unresolved question
 *
 * It meets the five conditions: outbound-only, ships off, destinations
 * registered in `allowed-egress.yaml`, read-through rather than persisted (same
 * reasoning as QuickBooks Online — a ledger's freshest copy is the vendor's,
 * and this avoids becoming the first writer of the unencrypted `ErpEntityCache`
 * that WARP-2028 has not fixed), and tokens treated as account-level
 * credentials.
 *
 * **What is NOT resolved, and is legal rather than technical:** Henry Schein
 * One's Developer Agreement is not published. The FAQ summarises a clause
 * prohibiting *"transferring, selling, distributing, disclosing, leasing,
 * syndicating, sub-syndicating, lending, or sublicensing the API (including the
 * API key) or redistributing data retrieved through the API to unauthorized
 * parties."* Whether a **shipped on-premise appliance that holds the API key on
 * customer hardware** is compatible with that cannot be determined from public
 * text. That question belongs to the enrolment meeting, and this connector must
 * not be enabled for a customer until it has an answer. The code is written so
 * that answer can be "no" at no further cost.
 *
 * Enrolment is also gated: application → use-case review → signed agreement,
 * with no self-serve sandbox. A live probe confirms the hosts and paths are
 * real and only the credential is missing — `GET /v1/patients` against both
 * documented servers returns Apigee's `oauth.v2.InvalidAccessToken`.
 */
import {
  ConnectorBlockedError,
  assertDatasetsServed,
  PRACTICE_DATASETS,
  type Connector,
  type IntrospectionResult,
} from "../connector.js";
import { getReadQuery } from "../read-queries.js";
import { assertTargetAllowed, getWriteCommand } from "../write-commands.js";
import { computeSchemaFingerprint, type IntrospectedTable } from "../schema-map.js";
import { sortByKey, sumMoney } from "../api-dto.js";
import { CANONICAL_COLUMNS, type DatasetName } from "../export-drop/profiles.js";

/** Provider key for this track. */
export const DENTRIX_ASCEND_PROVIDER = "dentrix-ascend";

/** The OpenAPI version this connector was written against. Pinned into the
 *  drift fingerprint; see the module docstring on tolerant-reader. */
export const ASCEND_SPEC_VERSION = "186.0.9";

/** Documented servers. Sandbox and production differ only by host. */
export const ASCEND_SANDBOX_BASE_URL = "https://test.hs1api.com/ascend-gateway/api";
export const ASCEND_PRODUCTION_BASE_URL = "https://prod.hs1api.com/ascend-gateway/api";

/** The only hosts this connector will send a bearer token to. Same posture as
 *  the QuickBooks Online track: the egress registry says which destinations are
 *  permitted, and the connector refuses anything else even if a connection row
 *  says otherwise. */
export const ASCEND_ALLOWED_HOST_SUFFIX = ".hs1api.com";

export const ASCEND_TRACK_REMEDIATION =
  "needs a Dentrix Ascend organization connected: an Organization-ID, a location id, " +
  "and OAuth client-credentials issued by Henry Schein One after vendor enrolment — " +
  "this track leaves the practice LAN (ADR-041)";

/** Thrown when a connection names a destination this track will not dial. */
export class UnsafeAscendBaseUrlError extends Error {
  readonly code = "UNSAFE_BASE_URL";
  constructor(reason: string) {
    super(`refusing to send a Dentrix Ascend token there: ${reason}`);
    this.name = "UnsafeAscendBaseUrlError";
  }
}

/**
 * Validate an operator-supplied API base, or throw.
 *
 * HTTPS only — a bearer token over http is the token given away — and an
 * hs1api.com host only. Userinfo is rejected because some clients resolve
 * `https://evil@real-host` to a different authority than a reader expects.
 */
export function assertSafeAscendBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeAscendBaseUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") throw new UnsafeAscendBaseUrlError(`"${url.protocol}//" is not https`);
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeAscendBaseUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(ASCEND_ALLOWED_HOST_SUFFIX)) {
    throw new UnsafeAscendBaseUrlError(`"${host}" is not a Dentrix Ascend host`);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** A bearer token and when it stops working. Client-credentials tokens are
 *  short-lived (the vendor documents one hour), so this is refreshed often. */
export interface AscendToken {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * Resolve a bearer token.
 *
 * The OAuth **client secret deliberately does not live in this connector**. It
 * belongs to the orchestrator, which owns the secret store; a per-connection
 * object that is built and thrown away per read has no business holding one.
 * A deployment with no resolver blocks honestly rather than half-authenticating.
 */
export type AscendTokenResolver = () => Promise<AscendToken>;

export const blockedAscendTokenResolver: AscendTokenResolver = async () => {
  throw new ConnectorBlockedError("resolve token", ASCEND_TRACK_REMEDIATION);
};

/** Thrown when only a human re-consent or a vendor action can restore the
 *  connection. Distinct from "unreachable", because retrying cannot help. */
export class AscendAuthorizationError extends Error {
  readonly code = "REAUTHORIZE_REQUIRED";
  constructor(readonly reason: string) {
    super(
      `Dentrix Ascend authorization must be renewed (${reason}). Retrying cannot fix ` +
        `this — the organization must reconnect, or the vendor enablement was withdrawn.`,
    );
    this.name = "AscendAuthorizationError";
  }
}

/** ADR-041 §5 connection-state vocabulary, shared with the QuickBooks Online
 *  track. Explicit, never inferred from a missing token. */
export type AscendConnectionState =
  | "disconnected"
  | "pending_consent"
  | "connected"
  | "needs_reconnect"
  | "error";

export interface DentrixAscendConfig {
  /**
   * The `Organization-ID` header value. REQUIRED on every documented operation
   * (438 of them), so a connection without it cannot make a single call — and
   * says so at construction rather than failing per read.
   */
  organizationId: string;
  /**
   * Location id. Required by the aging-balance report's filter grammar
   * (`location.id==N`), which is the only bulk receivables endpoint. A
   * connection without one can still serve the schedule and patients; it
   * refuses the AR read specifically, which is more useful than refusing the
   * whole connection.
   */
  locationId?: string;
  /** Sandbox or production. Defaults to production; host-guarded either way. */
  baseUrl?: string;
  /** Pointer into the encrypted secret store — never a token. */
  credentialsSecretRef: string;
  /** Page size for list reads. The API paginates by page/pageSize. Must be an
   *  integer >= 1 — validated at construction, because a smaller value makes
   *  the pagination loop's short-page exit unreachable. */
  pageSize?: number;
}

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

export interface DentrixAscendDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  resolveToken?: AscendTokenResolver;
  timeoutMs?: number;
}

/** What a Dentrix Ascend organization carries. Practice management, not
 *  accounting: there are no vendor bills in a dental PMS. */
export const ASCEND_DATASETS: readonly string[] = PRACTICE_DATASETS;

export interface AscendStatus {
  state: AscendConnectionState;
  ok: boolean;
  organizationId: string;
  locationId: string | null;
  /** False when no location is configured, so the AR read is unavailable. */
  receivablesAvailable: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 200;
/**
 * Hard ceiling on pages fetched by one list read. The loop's NORMAL exit is a
 * short page; this bounds what happens when that exit never comes — a server
 * that keeps returning full pages, whether misbehaving or malicious, must not
 * turn a single `runRead` into unbounded outbound calls (the per-request
 * timeout bounds one call, not how many are made).
 *
 * Sized from the largest honest result these reads can produce: a full day's
 * schedule across a very large multi-location organization is a few thousand
 * appointments, and a surname search is far smaller. 100 pages × the default
 * 200-row page = 20,000 rows — several times that ceiling — so hitting the cap
 * means the server is not converging, and the read THROWS rather than
 * returning rows silently truncated at an arbitrary point.
 *
 * Deliberately NOT the QuickBooks track's CallBudget: Ascend's rate limits
 * are per-endpoint and dynamic (429 is handled where it arrives), and there
 * is no shared metered pool for a runaway read to exhaust — so a per-read
 * page ceiling is the right shape here, not a cross-read budget.
 */
export const ASCEND_MAX_LIST_PAGES = 100;
/** Refresh a minute early: a token expiring mid-flight surfaces as a 401 that
 *  looks like a revocation. */
const TOKEN_SKEW_MS = 60_000;

export class DentrixAscendConnector implements Connector {
  readonly provider = DENTRIX_ASCEND_PROVIDER;
  readonly servesDatasets = ASCEND_DATASETS;

  private readonly now: () => number;
  private readonly resolveToken: AscendTokenResolver;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private token: AscendToken | null = null;

  constructor(
    private readonly config: DentrixAscendConfig,
    deps: DentrixAscendDeps = {},
  ) {
    if (!config.organizationId || config.organizationId.trim() === "") {
      throw new ConnectorBlockedError(
        "construct (no Organization-ID configured)",
        ASCEND_TRACK_REMEDIATION,
      );
    }
    this.now = deps.now ?? (() => Date.now());
    this.resolveToken = deps.resolveToken ?? blockedAscendTokenResolver;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Validated at CONSTRUCTION: a connection naming a destination we will not
    // dial should fail to build, loudly, rather than look fine until the first
    // read ships a token.
    this.baseUrl = assertSafeAscendBaseUrl(config.baseUrl ?? ASCEND_PRODUCTION_BASE_URL);
    const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    // Also at construction: the pagination loop's normal exit is
    // `data.length < pageSize`, and with pageSize 0 that is `0 < 0` — false
    // even for an EMPTY page, so the loop could never exit on its own and
    // every list read would burn to the page cap. Refuse the config typo
    // where it was made.
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new ConnectorBlockedError(
        `construct (pageSize ${String(pageSize)} cannot terminate pagination)`,
        "set pageSize to an integer >= 1, or omit it for the default of " +
          `${DEFAULT_PAGE_SIZE} — a page size below 1 makes the short-page exit unreachable`,
      );
    }
    this.pageSize = pageSize;
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(detail ? `${op} (${detail})` : op, ASCEND_TRACK_REMEDIATION);
  }

  private async ensureToken(op: string): Promise<AscendToken> {
    const held = this.token;
    if (held && held.expiresAt - this.now() > TOKEN_SKEW_MS) return held;
    try {
      const fresh = await this.resolveToken();
      this.token = fresh;
      return fresh;
    } catch (err) {
      if (err instanceof ConnectorBlockedError) throw err;
      throw this.blocked(op, `token could not be resolved: ${(err as Error).message}`);
    }
  }

  /**
   * One documented GET.
   *
   * `Organization-ID` is a required header on every operation, so it is set
   * here rather than per call site — a read that forgot it would 4xx in a way
   * that looks like an auth problem.
   */
  private async get(op: string, path: string, query: Record<string, string>): Promise<unknown> {
    const token = await this.ensureToken(op);
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "Organization-ID": this.config.organizationId,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw this.blocked(op, `Dentrix Ascend unreachable: ${(err as Error).message}`);
    }

    if (res.status === 401 || res.status === 403) {
      // A withdrawn grant or a disabled vendor enablement is cleared only by a
      // person. Reporting it as a transport fault sends someone hunting a bug
      // that does not exist. Note vendors default to OFF per organization, so
      // 403 is a routine first-connect state, not an exotic one.
      this.token = null;
      throw new AscendAuthorizationError(`Dentrix Ascend returned ${res.status}`);
    }
    if (res.status === 429) {
      // The vendor's own throttle. Limits are documented as dynamic and
      // per-endpoint, so no number is asserted here.
      throw this.blocked(op, "Dentrix Ascend rate limit reached (429) — back off and retry");
    }
    if (!res.ok) throw this.blocked(op, `Dentrix Ascend returned ${res.status}`);

    try {
      return await res.json();
    } catch (err) {
      throw this.blocked(op, `unparseable response: ${(err as Error).message}`);
    }
  }

  /**
   * Page through a list endpoint.
   *
   * The documented envelope is `{ data, warnings, errors, meta.pagination }`
   * with `page`/`pageSize` query parameters. Stops on a short page — the vendor
   * documents `meta.pagination.total`, but trusting a count we did not compute
   * over a page we did receive is the wrong way round.
   *
   * The short page is the only exit the SERVER controls, so two bounds of our
   * own apply on top of it: a full page opening with the exact row the
   * previous page opened with means the `page` parameter is not being
   * honoured and further requests would fetch the same rows forever; and
   * `ASCEND_MAX_LIST_PAGES` (reasoning on the constant) stops a server that
   * keeps producing novel full pages. Both throw — rows silently truncated at
   * an arbitrary point would be worse than no rows at all.
   */
  private async list(op: string, path: string, filter: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let priorFirstRow: string | null = null;
    for (let page = 1; page <= ASCEND_MAX_LIST_PAGES; page += 1) {
      const body = (await this.get(op, path, {
        filter,
        page: String(page),
        pageSize: String(this.pageSize),
      })) as Record<string, unknown>;
      const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
      // Cheap no-progress fingerprint: a page's first row. An empty page never
      // reaches the comparison — it returns as a short page below.
      const firstRow = data.length > 0 ? JSON.stringify(data[0]) : null;
      if (firstRow !== null && firstRow === priorFirstRow) {
        throw this.blocked(
          op,
          "Dentrix Ascend returned the same page twice in a row — the server ignored the " +
            "page parameter, so paging further would refetch identical rows without end",
        );
      }
      priorFirstRow = firstRow;
      rows.push(...data);
      if (data.length < this.pageSize) return rows;
    }
    throw this.blocked(
      op,
      `Dentrix Ascend was still returning full pages after ${ASCEND_MAX_LIST_PAGES} pages — ` +
        "refusing to page further; this result is larger than any honest answer to this read",
    );
  }

  async connect(): Promise<void> {
    // One real, cheap call proves three things at once: the credentials work,
    // the Organization-ID is accepted, and egress to Ascend is permitted. A
    // single-row page is the smallest honest probe.
    await this.get("connect", "/v1/patients", { page: "1", pageSize: "1" });
  }

  async close(): Promise<void> {
    this.token = null;
  }

  /** Resolve, never infer — the same rule (and the same past bug) as the
   *  QuickBooks Online track's state. */
  private async state(): Promise<AscendConnectionState> {
    try {
      await this.ensureToken("state");
    } catch (err) {
      if (err instanceof AscendAuthorizationError) return "needs_reconnect";
      return "disconnected";
    }
    return "connected";
  }

  async health(): Promise<{ ok: boolean }> {
    const state = await this.state();
    if (state === "needs_reconnect") throw new AscendAuthorizationError("token rejected");
    if (state !== "connected") throw this.blocked("health", "no Dentrix Ascend organization is connected");
    return { ok: true };
  }

  async status(): Promise<AscendStatus> {
    const state = await this.state();
    return {
      state,
      ok: state === "connected",
      organizationId: this.config.organizationId,
      locationId: this.config.locationId ?? null,
      receivablesAvailable: Boolean(this.config.locationId),
    };
  }

  private tables(): IntrospectedTable[] {
    return ASCEND_DATASETS.map((dataset) => ({
      name: dataset,
      owner: "ascend",
      columns: CANONICAL_COLUMNS[dataset as DatasetName].map((name) => ({ name, type: "text" })),
    }));
  }

  async introspect(): Promise<IntrospectionResult> {
    const tables = this.tables();
    // The spec version is pinned INTO the fingerprint. Ascend's documented
    // policy is tolerant-reader — fields may be added without a version bump —
    // so our canonical column list can stay identical across a real upstream
    // change. A fingerprint blind to the spec version would report "no drift"
    // across one.
    return {
      tables,
      fingerprint: `${computeSchemaFingerprint(tables)}:ascend${ASCEND_SPEC_VERSION}`,
    };
  }

  /** A `*Ref` on an appointment is `{ id, type, url }`; the id is what a
   *  canonical row carries. */
  private static refId(v: unknown): string | undefined {
    if (!v || typeof v !== "object") return undefined;
    const id = (v as Record<string, unknown>).id;
    return id === undefined || id === null ? undefined : String(id);
  }

  private static text(v: unknown): string | undefined {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s === "" ? undefined : s;
  }

  /** Ascend emits ISO-8601 date-times. Normalised so a row is byte-identical
   *  to the other tracks, which all produce a full instant. */
  private static instant(v: unknown): string | undefined {
    if (typeof v !== "string" || v.trim() === "") return undefined;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }

  async runRead(name: string, params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    const op = `runRead:${name}`;

    switch (name) {
      case "get_schedule_today": {
        // `start` supports >, <, >=, <= per the spec's filter table, so the
        // half-open [from, to) window the read registry defines maps directly
        // onto the API rather than being applied after the fact.
        const from = String(params.from ?? "");
        const to = String(params.to ?? "");
        const raw = await this.list(op, "/v1/appointments", `start>=${from},start<${to}`);
        const rows = raw.map((a) => ({
          appt_id: DentrixAscendConnector.text(a.id),
          appt_time: DentrixAscendConnector.instant(a.start),
          provider_id: DentrixAscendConnector.refId(a.provider),
          operatory_id: DentrixAscendConnector.refId(a.operatory),
          status: DentrixAscendConnector.text(a.status),
          patient_id: DentrixAscendConnector.refId(a.patient),
        }));
        return sortByKey(rows, "appt_time");
      }

      case "find_patient": {
        // `lastName` supports `~=`. The server-side clause narrows the result;
        // the LITERAL prefix match is then applied here, because `~=` semantics
        // (contains vs starts-with) are not stated in the spec and this read's
        // contract on every other track is a literal prefix. Guessing the
        // operator would change which patients a search returns — a PHI
        // over-fetch in the wrong direction.
        const term = String(params.query ?? "").trim();
        const raw = await this.list(op, "/v1/patients", `lastName~=${term}`);
        const lower = term.toLowerCase();
        const rows = raw
          .map((p) => ({
            patient_id: DentrixAscendConnector.text(p.id),
            first_name: DentrixAscendConnector.text(p.firstName),
            last_name: DentrixAscendConnector.text(p.lastName),
          }))
          .filter((r) => typeof r.last_name === "string" && r.last_name.toLowerCase().startsWith(lower));
        return sortByKey(sortByKey(rows, "first_name"), "last_name");
      }

      case "get_patient": {
        // `id` takes the `->` list operator.
        const id = String(params.patientId ?? "");
        const raw = await this.list(op, "/v1/patients", `id->[${id}]`);
        return raw.map((p) => ({
          patient_id: DentrixAscendConnector.text(p.id),
          first_name: DentrixAscendConnector.text(p.firstName),
          last_name: DentrixAscendConnector.text(p.lastName),
        }));
      }

      case "get_ar_summary": {
        // `/v1/agingbalances` is PER PATIENT (patientId is a required query
        // parameter), so it cannot answer a practice-wide total without one
        // call per patient. `/v1/agingbalances/report` is the bulk form: it
        // returns rolled-up bucket totals for a location plus one
        // `AgingReceivableV1` per guarantor. That is the read this maps to, and
        // it is why `location.id` is configuration rather than a parameter.
        const locationId = this.config.locationId;
        if (!locationId) {
          throw this.blocked(
            op,
            "no location id is configured — the aging-balance report requires filter=location.id==N",
          );
        }
        // `page==1` is deliberately pinned — this read is SINGLE-SHOT. The
        // report does not paginate like the list endpoints: its envelope is
        // one rolled-up AgingBalanceReportV1 object, not the `data[]` +
        // `meta.pagination` contract `list()` pages through, and its `page`
        // term rides the filter grammar with no page size and no end-of-pages
        // signal documented. A loop here would be a guessed termination
        // contract, which this connector refuses everywhere else.
        const body = (await this.get(op, "/v1/agingbalances/report", {
          filter: `location.id==${locationId},page==1`,
        })) as Record<string, unknown>;
        const data = (body.data ?? {}) as Record<string, unknown>;
        const reports = Array.isArray(data.patientReports)
          ? (data.patientReports as Record<string, unknown>[])
          : [];
        // Counted and summed over the per-guarantor rows rather than reading
        // the envelope's own `balance`, so the count and the total come from
        // one source and cannot disagree. Matches how every other track
        // computes this read.
        return [
          {
            account_count: reports.length,
            total_balance: sumMoney(reports),
          },
        ];
      }

      case "get_recall_due":
        // Deliberately not mapped. Ascend has recall/hygiene concepts, but this
        // read's contract on the other tracks is "patients overdue for recare"
        // and the equivalent filter is not something the spec states plainly
        // enough to map without guessing. Refusing is honest; a wrong recall
        // list would have a practice chasing the wrong people.
        throw this.blocked(op, "the recall read is not mapped for Dentrix Ascend yet");

      default:
        throw this.blocked(op, "read is not served by the Dentrix Ascend track");
    }
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // The API does support writes (POST /v1/appointments among others). This
    // track does not, and not only for the usual read-only-by-default reason:
    // the Developer Agreement's redistribution and sublicensing terms are not
    // public, and writing into a customer's clinical record under an agreement
    // nobody has read is not a risk to take on their behalf.
    throw this.blocked(
      `applyWrite:${name}`,
      "the Dentrix Ascend track is read-only — writes need the Developer Agreement " +
        "reviewed and their own ticket",
    );
  }
}
