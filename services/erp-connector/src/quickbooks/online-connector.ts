/**
 * WARP-2109 — `QuickBooksOnlineConnector`: the accounting REST track.
 *
 * Reads a customer's QuickBooks Online company over Intuit's v3 REST API,
 * OAuth 2.0, and serves the same named accounting reads as the export-drop
 * track. Same `Connector` interface, same read registry, same blocked-error
 * contract, so nothing upstream of it changes.
 *
 * ## Two things make this track different from every other one we ship
 *
 * **It is a CLOUD CONNECTOR under ADR-041**, and the first one in this package.
 * Export-drop reads a local share; the SQL track reaches a server on the
 * practice's own network; the QuickBooks Desktop track is inbound from a
 * machine down the hall. This one talks to Intuit over the public internet.
 *
 * ADR-041 permits that on five conditions, and this connector is built to them:
 *
 *   1. **Only ever dials out.** No port, no webhook, no inbound path.
 *   2. **Ships off; owner consent is the enabling event.** With no tokens
 *      resolved the connector blocks honestly rather than half-authenticating.
 *   3. **Every destination registered.** `quickbooks.api.intuit.com` and
 *      `oauth.platform.intuit.com` are in `docs/security/allowed-egress.yaml`
 *      as `user-content-on-request` and `none` respectively.
 *   4. **Persistence.** ADR-041 §4 says cloud connectors persist and that
 *      synced content must be encrypted at rest — and warns that the encryption
 *      `ErpEntityCache` promises is NOT implemented (WARP-2028). This track
 *      therefore does not persist at all: an accounting ledger is answered
 *      read-through, where the freshest copy is the vendor's and a stale local
 *      one would be worse than none. That keeps it clear of the unkept promise
 *      rather than becoming that model's first writer. A future "own a copy of
 *      your books" feature is a different ticket and needs WARP-2028 first.
 *   5. **Tokens are account-level credentials.** Never logged, never in a
 *      tracked file, and the connector deliberately does not hold the OAuth
 *      client secret — see {@link QuickBooksOnlineConnector.refresh}.
 *
 * ADR-041 §"Where the code lives" puts cloud connectors in-process in the
 * orchestrator rather than the sidecar, which is where this one runs: the
 * sidecar exists only to isolate a native driver, and HTTPS needs none.
 *
 * **It is the first connector with a meter, and the meter is on reads.** Under
 * Intuit's App Partner Program (live 2025-07-28, full fees 2025-11-01), *Core*
 * calls — data IN, creating and updating records — are unmetered and free,
 * while *CorePlus* calls — data OUT, querying and reporting — are the charged
 * ones. Droplet is read-only by default and write-averse by design, so we pay
 * for exactly what we do and get free exactly what we refuse to do.
 *
 * Worse, the free Builder tier's 500,000 CorePlus calls/month is a FLEET-WIDE
 * pool that **blocks** rather than bills. One chatty appliance does not run up
 * a bill; it stops every other customer's QuickBooks integration working. That
 * is why {@link CallBudget} is a v1 requirement in this file rather than an
 * optimisation in a later one, and why exhausting it is a distinct typed state.
 *
 * ## Three failure states that must never be confused
 *
 * A caller has to be able to tell these apart, because the remedy differs and
 * two of them are not faults at all:
 *
 *   QUOTA_EXHAUSTED     we are out of CorePlus calls this period. Nothing is
 *                       broken. Data will return on its own next period, or
 *                       sooner on a higher tier.
 *   REAUTHORIZE         the refresh token lapsed or was revoked. A human must
 *                       re-consent in the dashboard; no amount of retrying
 *                       helps, and a bare 401 would send someone hunting a bug.
 *   ConnectorBlocked    not configured, or Intuit is unreachable.
 *
 * None of the three may ever render as an empty result. `[]` from
 * `get_open_bills` reads as "you owe nobody anything".
 */
import {
  ConnectorBlockedError,
  assertDatasetsServed,
  type Connector,
  type IntrospectionResult,
} from "../connector.js";
import { getReadQuery } from "../read-queries.js";
import { assertTargetAllowed, getWriteCommand } from "../write-commands.js";
import { computeSchemaFingerprint, type IntrospectedTable } from "../schema-map.js";
import { sortByKey, sumMoneyWithGaps } from "../api-dto.js";
import { CANONICAL_COLUMNS, type DatasetName } from "../export-drop/profiles.js";

/** Provider key for this track. */
export const QUICKBOOKS_ONLINE_PROVIDER = "quickbooks-online";

/**
 * What this track is waiting on. Deliberately unlike the other three
 * remediation strings: an installer triaging this must not be sent looking for
 * a SAP client, a Patterson enrolment, or a folder full of CSVs.
 */
export const QBO_TRACK_REMEDIATION =
  "needs a QuickBooks Online company connected via OAuth (realm id + tokens on the " +
  "integration row), and Intuit's API host allowed in allowed-egress.yaml — this is " +
  "the only integration track that leaves the practice LAN";

/** Intuit's production API base. Sandbox differs and is operator-configured. */
export const QBO_PRODUCTION_BASE_URL = "https://quickbooks.api.intuit.com";

/**
 * Minor version pin for the v3 API.
 *
 * Pinned rather than omitted on purpose: without it Intuit serves "the current
 * minor version", which means a field can change shape under a box that has not
 * been touched in months. A pinned version is a version we can test against.
 */
export const QBO_MINOR_VERSION = "75";

/**
 * The only hosts this connector will send a bearer token to.
 *
 * The access token is a credential to the customer's whole company file, and it
 * travels in an `Authorization: Bearer` header on every request. `baseUrl` is
 * operator configuration — it exists so a sandbox company can be pointed at
 * Intuit's sandbox host without a code change — and before this it was accepted
 * with no scheme and no host check at all. A misconfigured (or malicious)
 * connection row could therefore ship the token in cleartext to any host on the
 * internet.
 *
 * ADR-041 §3 requires every destination be registered and screened. This is the
 * code-side half of that: the registry says which hosts are allowed, and this
 * refuses to talk to anything else even if a row says otherwise. Belt and
 * braces, because the failure mode is handing away a customer's books.
 */
export const QBO_ALLOWED_HOST_SUFFIX = ".intuit.com";

/** Thrown when a connection names a destination this track will not dial. */
export class UnsafeBaseUrlError extends Error {
  readonly code = "UNSAFE_BASE_URL";
  constructor(reason: string) {
    super(`refusing to send a QuickBooks token there: ${reason}`);
    this.name = "UnsafeBaseUrlError";
  }
}

/**
 * Validate an operator-supplied API base, or throw.
 *
 * HTTPS only — a bearer token over http is the token given away — and an Intuit
 * host only. Rejects userinfo (`https://evil@quickbooks.api.intuit.com`), which
 * some HTTP clients resolve to a different authority than a reader expects.
 */
export function assertSafeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeBaseUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new UnsafeBaseUrlError(`"${url.protocol}//" is not https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeBaseUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "intuit.com" && !host.endsWith(QBO_ALLOWED_HOST_SUFFIX)) {
    throw new UnsafeBaseUrlError(`"${host}" is not an Intuit host`);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** The OAuth material for one company. Cleartext for the life of a call only —
 *  the caller resolves it from the encrypted store and never persists it here. */
export interface QboTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token stops working. */
  accessExpiresAt: number;
  /**
   * Epoch ms when the REFRESH token stops working.
   *
   * The operationally dangerous one. Intuit's refresh token has a long but
   * finite life (order of ~100 days) and rotates on use, so a box powered off
   * or offline past that window loses the connection permanently and needs a
   * human to re-consent. Surfaced ahead of expiry by {@link reauthorizeAfter}
   * rather than discovered as a 401 one morning.
   */
  refreshExpiresAt: number;
}

/** Resolve the current tokens (from the orchestrator's encrypted store). */
export type TokenResolver = () => Promise<QboTokens>;

/** Persist rotated tokens. Intuit rotates the refresh token on every use, so a
 *  connector that does not write the new one back strands the connection at the
 *  next refresh — this is not optional bookkeeping. */
export type TokenPersister = (tokens: QboTokens) => Promise<void>;

/** The default resolver: nothing wired, so the track blocks honestly. */
export const blockedTokenResolver: TokenResolver = async () => {
  throw new ConnectorBlockedError("resolve tokens", QBO_TRACK_REMEDIATION);
};

/** Thrown when this period's metered call allowance is gone. NOT a fault. */
export class QuotaExhaustedError extends Error {
  readonly code = "QUOTA_EXHAUSTED";
  constructor(readonly spent: number, readonly ceiling: number) {
    super(
      `QuickBooks Online read budget exhausted: ${spent}/${ceiling} metered calls used ` +
        `this period. Reads resume next period; nothing is broken and no data is lost.`,
    );
    this.name = "QuotaExhaustedError";
  }
}

/** Thrown when only a human re-consent can restore the connection. */
export class ReauthorizationRequiredError extends Error {
  readonly code = "REAUTHORIZE_REQUIRED";
  constructor(readonly reason: string) {
    super(
      `QuickBooks Online authorization must be renewed by a person (${reason}). ` +
        `Retrying cannot fix this — reconnect the company from the dashboard.`,
    );
    this.name = "ReauthorizationRequiredError";
  }
}

/**
 * The CorePlus meter.
 *
 * Counts only calls that Intuit itself meters: successful (2xx) data-out
 * requests. A 401, a 429 or a network failure costs nothing on their bill and
 * must not cost anything here either — a counter that charged us for failures
 * would exhaust a budget fastest exactly when the integration is already
 * struggling.
 *
 * The ceiling is per connection, not per fleet, and that is a deliberate
 * simplification with a stated limit: the real Builder allowance is a shared
 * pool, so a fleet-wide accounting has to sit above this (the orchestrator
 * knows how many boxes there are; a connector does not). This ceiling stops one
 * box being the one that eats the pool; it cannot by itself stop fifty boxes
 * doing it between them.
 */
export class CallBudget {
  private spent = 0;
  private periodStart: number;

  constructor(
    readonly ceiling: number,
    private readonly now: () => number,
    /** Length of a budget period. Defaults to 30 days, matching Intuit's
     *  monthly allowance rather than a calendar month, which would need a
     *  timezone this connector has no business having an opinion about. */
    private readonly periodMs = 30 * 24 * 60 * 60 * 1000,
  ) {
    this.periodStart = now();
  }

  /** Roll the period over if it has elapsed. */
  private roll(): void {
    const t = this.now();
    if (t - this.periodStart >= this.periodMs) {
      this.periodStart = t;
      this.spent = 0;
    }
  }

  /** Throw if the next metered call would exceed the ceiling. Call BEFORE the
   *  request, so an exhausted budget costs no network at all. */
  assertHeadroom(): void {
    this.roll();
    if (this.spent >= this.ceiling) throw new QuotaExhaustedError(this.spent, this.ceiling);
  }

  /** Record one metered call. Only ever called for a 2xx data-out response. */
  record(): void {
    this.roll();
    this.spent += 1;
  }

  snapshot(): { spent: number; ceiling: number; remaining: number; periodStart: number } {
    this.roll();
    return {
      spent: this.spent,
      ceiling: this.ceiling,
      remaining: Math.max(0, this.ceiling - this.spent),
      periodStart: this.periodStart,
    };
  }
}

/**
 * Default per-connection ceiling.
 *
 * 5,000 metered reads per 30 days ≈ 166/day, which comfortably covers a daily
 * sync plus an assistant answering questions all day, and puts roughly 100
 * boxes inside the free Builder pool. It is a floor for safety, not a
 * prediction: the number that matters is measured per install, and the
 * orchestrator can override it per connection.
 */
export const DEFAULT_CALL_CEILING = 5_000;

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

export interface QuickBooksOnlineConfig {
  /** The QuickBooks company id (Intuit calls it the realm id). */
  realmId: string;
  /** API base. Operator-configured so a sandbox company can be pointed at the
   *  sandbox host without a code change. Defaults to production. */
  baseUrl?: string;
  /** Pointer into the encrypted secret store — never a token. */
  credentialsSecretRef: string;
  /** Per-connection metered-read ceiling per period. */
  callCeiling?: number;
  /**
   * How long before the refresh token expires to start reporting that a
   * re-consent is needed. Defaults to 14 days, which is long enough that a
   * practice closed for a fortnight still gets warned while somebody is there.
   */
  reauthorizeWarningDays?: number;
}

export interface QuickBooksOnlineDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  resolveTokens?: TokenResolver;
  persistTokens?: TokenPersister;
  timeoutMs?: number;
  budget?: CallBudget;
}

/** The accounting datasets a QuickBooks company carries. Note what is absent:
 *  a dental practice's schedule. A QBO connection has no appointments and
 *  saying so is a capability, not a failure. */
export const QBO_DATASETS: readonly string[] = ["invoice", "bill", "ap_summary"];

/**
 * The connection-state vocabulary ADR-041 §5 fixes for every cloud connector.
 *
 * Explicit, never inferred from a missing token. The failure this exists to
 * prevent is a connector that LOOKS connected and quietly syncs nothing — which
 * is exactly what happens when a grant is revoked or a password reset kills the
 * refresh token, and the only signal is an absent value somebody defaulted.
 *
 * `needs_reconnect` is deliberately a routine state, not an error: ADR-041 says
 * to expect it and design the UI for it.
 */
export type CloudConnectionState =
  | "disconnected"
  | "pending_consent"
  | "connected"
  | "needs_reconnect"
  | "error";

/** Rich status for the caller — budget, token life, company. */
export interface QboStatus {
  /** ADR-041 §5 state. The orchestrator surfaces this rather than re-deriving
   *  it from whether a token happens to be present. */
  state: CloudConnectionState;
  ok: boolean;
  realmId: string;
  budget: { spent: number; ceiling: number; remaining: number };
  /** Days until the refresh token lapses; negative once it has. */
  reauthorizeInDays: number | null;
  /** True once inside the warning window — the dashboard's cue to prompt. */
  reauthorizeSoon: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REAUTH_WARNING_DAYS = 14;

export class QuickBooksOnlineConnector implements Connector {
  readonly provider = QUICKBOOKS_ONLINE_PROVIDER;
  readonly servesDatasets = QBO_DATASETS;

  private readonly now: () => number;
  private readonly resolveTokens: TokenResolver;
  private readonly persistTokens?: TokenPersister;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly budget: CallBudget;
  private readonly reauthWarningMs: number;

  private tokens: QboTokens | null = null;
  private fingerprint: string | null = null;

  constructor(
    private readonly config: QuickBooksOnlineConfig,
    deps: QuickBooksOnlineDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.resolveTokens = deps.resolveTokens ?? blockedTokenResolver;
    this.persistTokens = deps.persistTokens;
    this.fetchImpl = deps.fetchImpl;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Validated at CONSTRUCTION, not at request time: a connection that
    // names a destination we will not dial should fail to build, loudly,
    // rather than look fine until the first read ships a token.
    this.baseUrl = assertSafeBaseUrl(config.baseUrl ?? QBO_PRODUCTION_BASE_URL);
    this.budget =
      deps.budget ?? new CallBudget(config.callCeiling ?? DEFAULT_CALL_CEILING, this.now);
    this.reauthWarningMs =
      (config.reauthorizeWarningDays ?? DEFAULT_REAUTH_WARNING_DAYS) * 24 * 60 * 60 * 1000;
  }

  private blocked(op: string, detail?: string): ConnectorBlockedError {
    return new ConnectorBlockedError(detail ? `${op} (${detail})` : op, QBO_TRACK_REMEDIATION);
  }

  /** Milliseconds until a human must re-consent, or null when unknown. */
  private reauthorizeAfter(): number | null {
    if (!this.tokens) return null;
    return this.tokens.refreshExpiresAt - this.now();
  }

  /**
   * Ensure a usable access token, refreshing when it is close to expiry.
   *
   * A lapsed REFRESH token is not retried and not reported as a transport
   * problem — it is the one failure only a person can clear.
   */
  private async ensureToken(op: string): Promise<QboTokens> {
    let tokens = this.tokens ?? (await this.resolveTokens());
    this.tokens = tokens;

    if (tokens.refreshExpiresAt <= this.now()) {
      throw new ReauthorizationRequiredError("the refresh token has expired");
    }

    // Refresh a minute early rather than on the boundary: a token that expires
    // mid-flight surfaces as a 401 that looks like a revocation.
    if (tokens.accessExpiresAt - this.now() > 60_000) return tokens;

    const refreshed = await this.refresh(tokens, op);
    this.tokens = refreshed;
    // Intuit ROTATES the refresh token on use. Not writing the new one back
    // strands the connection at the next refresh, one access-token lifetime
    // from now — a failure that shows up hours later and looks unrelated.
    if (this.persistTokens) await this.persistTokens(refreshed);
    return refreshed;
  }

  /**
   * Exchange the refresh token. Overridden wholesale in tests; the real
   * exchange is an operator-configured OAuth endpoint the orchestrator owns,
   * so this connector asks for tokens rather than minting them.
   */
  protected async refresh(current: QboTokens, op: string): Promise<QboTokens> {
    // No token endpoint is wired into the connector by design: OAuth client
    // secrets belong to the orchestrator, not to a per-connection object that
    // gets built and thrown away per read. A deployment without a refresh hook
    // therefore blocks honestly instead of half-authenticating.
    void current;
    throw this.blocked(op, "no OAuth refresh hook is configured for this connection");
  }

  /**
   * One metered data-out request.
   *
   * Budget is checked BEFORE the request, so an exhausted budget costs no
   * network. The counter is incremented only on a 2xx, because that is what
   * Intuit meters — charging ourselves for failures would drain the allowance
   * fastest exactly when the integration is already unhealthy.
   */
  private async query(op: string, statement: string): Promise<Record<string, unknown>> {
    this.budget.assertHeadroom();
    const tokens = await this.ensureToken(op);

    const url =
      `${this.baseUrl}/v3/company/${encodeURIComponent(this.config.realmId)}/query` +
      `?minorversion=${QBO_MINOR_VERSION}&query=${encodeURIComponent(statement)}`;

    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) throw this.blocked(op, "no fetch implementation available");

    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Unreachable Intuit is honest degradation, not a permanent state.
      throw this.blocked(op, `Intuit API unreachable: ${(err as Error).message}`);
    }

    if (res.status === 401 || res.status === 403) {
      // Distinguishable from an exhausted budget and from a transport failure:
      // a revoked or withdrawn grant is cleared only by a person.
      throw new ReauthorizationRequiredError(`Intuit returned ${res.status}`);
    }
    if (res.status === 429) {
      // Intuit's own throttle, not our budget. Reported as blocked (transient)
      // rather than as quota (which implies our ceiling, and a different fix).
      throw this.blocked(op, "Intuit rate limit reached (429) — back off and retry");
    }
    if (!res.ok) {
      throw this.blocked(op, `Intuit API returned ${res.status}`);
    }

    this.budget.record();
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      throw this.blocked(op, `unparseable Intuit response: ${(err as Error).message}`);
    }
  }

  async connect(): Promise<void> {
    // A cheap, real read proves three things at once: the tokens work, the
    // realm exists, and egress to Intuit is actually permitted. It costs one
    // metered call, which is the correct price for knowing the connection is
    // real rather than assuming it.
    await this.query("connect", "SELECT COUNT(*) FROM Invoice");
    this.fingerprint = computeSchemaFingerprint(this.tables());
  }

  async close(): Promise<void> {
    this.tokens = null;
  }

  async health(): Promise<{ ok: boolean }> {
    // Derived from the SAME explicit state `status()` reports, not from
    // whichever fields happen to be populated. Before this, a connection the
    // owner had never consented to reported itself healthy — because `health`
    // asked about the budget and the token clock, and an absent token failed
    // neither test. That is the inferred-from-absence failure ADR-041 §5 names.
    const state = await this.state();
    if (state === "needs_reconnect") {
      throw new ReauthorizationRequiredError("the refresh token has expired");
    }
    if (state === "error") {
      const b = this.budget.snapshot();
      throw new QuotaExhaustedError(b.spent, b.ceiling);
    }
    if (state === "disconnected") {
      throw this.blocked("health", "no QuickBooks company is connected");
    }
    return { ok: true };
  }

  /** The canonical shape this track serves. Synthesized rather than
   *  introspected: QuickBooks' schema is Intuit's, published and versioned, so
   *  there is nothing to discover — but the fingerprint still has to exist so
   *  the drift-freeze semantics stay coherent across all four tracks. */
  private tables(): IntrospectedTable[] {
    return QBO_DATASETS.map((dataset) => ({
      name: dataset,
      owner: "qbo",
      columns: CANONICAL_COLUMNS[dataset as DatasetName].map((name) => ({ name, type: "text" })),
    }));
  }

  async introspect(): Promise<IntrospectionResult> {
    const tables = this.tables();
    // Pin the minor version INTO the fingerprint: an Intuit minor-version bump
    // can change field shapes without changing our canonical column list, and a
    // fingerprint blind to that would report "no drift" across a real one.
    const fingerprint = computeSchemaFingerprint(tables) + `:mv${QBO_MINOR_VERSION}`;
    this.fingerprint = fingerprint;
    return { tables, fingerprint };
  }

  /**
   * Map what we know onto ADR-041's vocabulary.
   *
   * RESOLVES the tokens rather than reading whatever a previous call happened
   * to cache. The first cut of this read `this.tokens`, which is populated
   * lazily on the first request — so a connection whose budget was exhausted
   * (or which had simply never been read from) reported `disconnected` while
   * being perfectly well configured. That is precisely the
   * inferred-from-absence failure ADR-041 §5 exists to prevent, reproduced
   * inside the field meant to prevent it.
   *
   * Order matters: a lapsed grant outranks an exhausted budget, because
   * re-consenting is the only action that helps and waiting for the period to
   * roll would not.
   */
  private async state(): Promise<CloudConnectionState> {
    let tokens = this.tokens;
    if (!tokens) {
      try {
        tokens = await this.resolveTokens();
        this.tokens = tokens;
      } catch {
        // No tokens resolvable = the owner has not connected this company.
        // Not an error: it is the shipped-off state ADR-041 §2 requires.
        return "disconnected";
      }
    }
    if (tokens.refreshExpiresAt - this.now() <= 0) return "needs_reconnect";
    if (this.budget.snapshot().remaining <= 0) return "error";
    return "connected";
  }

  async status(): Promise<QboStatus> {
    const state = await this.state();
    const b = this.budget.snapshot();
    const after = this.reauthorizeAfter();
    return {
      state,
      // One source of truth. `ok` used to be computed independently, which let
      // it disagree with `state` inside a single returned object.
      ok: state === "connected",
      realmId: this.config.realmId,
      budget: { spent: b.spent, ceiling: b.ceiling, remaining: b.remaining },
      reauthorizeInDays: after === null ? null : Math.floor(after / (24 * 60 * 60 * 1000)),
      reauthorizeSoon: after !== null && after <= this.reauthWarningMs,
    };
  }

  /**
   * Pull every page of a QBO entity.
   *
   * Deliberately UNFILTERED on balance, then filtered client-side, so this
   * track's "open" predicate is byte-identical to the export-drop track's. A
   * server-side `WHERE Balance != '0'` would cut the row count, but QBO's
   * operator support for that comparison is not something this code has
   * verified against a live company — and a filter that silently means
   * something slightly different per track is exactly the divergence the shared
   * read registry exists to prevent. Metering is per CALL, not per row, so
   * paging costs the same as filtering for any small business; revisit with a
   * measured call count if a large company proves otherwise.
   */
  private async pull(op: string, entity: string): Promise<Record<string, unknown>[]> {
    const PAGE = 1000;
    const rows: Record<string, unknown>[] = [];
    let start = 1;

    for (;;) {
      const body = await this.query(
        op,
        `SELECT * FROM ${entity} STARTPOSITION ${start} MAXRESULTS ${PAGE}`,
      );
      const qr = (body.QueryResponse ?? {}) as Record<string, unknown>;
      const page = (qr[entity] ?? []) as Record<string, unknown>[];
      rows.push(...page);
      if (page.length < PAGE) return rows;
      start += PAGE;
    }
  }

  /** Money from Intuit arrives as a JSON number; a missing one stays undefined
   *  rather than becoming 0, for the same reason the export track keeps an
   *  unparseable balance: absent money and zero money are different facts. */
  private static money(v: unknown): number | undefined {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }

  /** QBO dates are `YYYY-MM-DD`; the canonical form is a full ISO instant, and
   *  every other track produces UTC midnight for a date-only cell. */
  private static date(v: unknown): string | undefined {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    return `${v}T00:00:00.000Z`;
  }

  private static ref(v: unknown): string | undefined {
    if (!v || typeof v !== "object") return undefined;
    const r = v as Record<string, unknown>;
    // Prefer the human-readable name — it is what a person reading "who do we
    // owe" needs; the opaque id is useless in a chat answer.
    const name = typeof r.name === "string" ? r.name : undefined;
    const value = typeof r.value === "string" ? r.value : undefined;
    return name ?? value;
  }

  async runRead(name: string, _params: Record<string, unknown>): Promise<unknown[]> {
    const query = getReadQuery(name);
    assertDatasetsServed(this.provider, this.servesDatasets, name, query.dependsOnTables);
    const op = `runRead:${name}`;

    // The same non-zero predicate the export-drop track applies, and for the
    // same reason: a part-paid document is still money, status vocabularies
    // differ, and a balance we could not read is money we cannot account for
    // and must stay visible rather than be quietly dropped.
    const isOpen = (row: Record<string, unknown>) => {
      const n = row.balance;
      return typeof n !== "number" || n !== 0;
    };

    switch (name) {
      case "get_open_invoices": {
        const raw = await this.pull(op, "Invoice");
        const rows = raw.map((r) => ({
          invoice_id: typeof r.DocNumber === "string" ? r.DocNumber : String(r.Id ?? ""),
          issued_at: QuickBooksOnlineConnector.date(r.TxnDate),
          due_at: QuickBooksOnlineConnector.date(r.DueDate),
          customer_id: QuickBooksOnlineConnector.ref(r.CustomerRef),
          amount: QuickBooksOnlineConnector.money(r.TotalAmt),
          balance: QuickBooksOnlineConnector.money(r.Balance),
          status: undefined as string | undefined,
        }));
        return sortByKey(sortByKey(rows.filter(isOpen), "invoice_id"), "due_at");
      }

      case "get_open_bills": {
        const raw = await this.pull(op, "Bill");
        const rows = raw.map((r) => ({
          bill_id: typeof r.DocNumber === "string" ? r.DocNumber : String(r.Id ?? ""),
          issued_at: QuickBooksOnlineConnector.date(r.TxnDate),
          due_at: QuickBooksOnlineConnector.date(r.DueDate),
          vendor_id: QuickBooksOnlineConnector.ref(r.VendorRef),
          amount: QuickBooksOnlineConnector.money(r.TotalAmt),
          balance: QuickBooksOnlineConnector.money(r.Balance),
          status: undefined as string | undefined,
        }));
        return sortByKey(sortByKey(rows.filter(isOpen), "bill_id"), "due_at");
      }

      case "get_ap_summary": {
        // Aggregated from the bills rather than from a separate report: one
        // metered call-set instead of two, and it cannot disagree with
        // get_open_bills, which a second source could.
        const raw = await this.pull(op, "Bill");
        // Aggregate over exactly the rows `get_open_bills` returns, so the two
        // reads on one pull cannot contradict each other. The first cut skipped
        // any bill whose Balance would not parse — so the same document was
        // listed as money owed AND contributed nothing to what the business was
        // told it owed, with no signal that anything was missing.
        const open = raw
          .map((r) => ({
            vendor_id: QuickBooksOnlineConnector.ref(r.VendorRef) ?? "(unknown vendor)",
            balance: QuickBooksOnlineConnector.money(r.Balance),
          }))
          .filter((r) => typeof r.balance !== "number" || r.balance !== 0);

        const byVendor = new Map<string, Record<string, unknown>[]>();
        for (const r of open) {
          const list = byVendor.get(r.vendor_id) ?? [];
          list.push(r);
          byVendor.set(r.vendor_id, list);
        }
        const { total, unaccounted } = sumMoneyWithGaps(open);
        return [
          { vendor_count: byVendor.size, total_balance: total, unaccounted_count: unaccounted },
        ];
      }

      default:
        // Unreachable while every served read is handled above; a new registry
        // entry lands here rather than silently returning nothing.
        throw this.blocked(op, "read is not served by the QuickBooks Online track");
    }
  }

  async applyWrite(name: string, _params: Record<string, unknown>): Promise<unknown> {
    // Same validation order as every other track, so a caller bug produces the
    // same typed error here as anywhere else...
    const cmd = getWriteCommand(name);
    assertTargetAllowed(cmd.targetTable);
    // ...and then this track refuses. Note the irony worth stating out loud:
    // writes are the FREE half of Intuit's meter. That is precisely the wrong
    // reason to enable them against a customer's books, and it is not a reason
    // this ticket entertained.
    throw this.blocked(
      `applyWrite:${name}`,
      "the QuickBooks Online track is read-only — writes to a customer's books need " +
        "their own ticket, an outbox and a human confirmation step",
    );
  }
}
