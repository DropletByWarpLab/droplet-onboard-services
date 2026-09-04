/**
 * WARP-2218 / ADR-041 — the connector sync runner.
 *
 * ## What was broken
 *
 * No connector sync was scheduled at all. `lastHealthyAt` — the column the hub
 * renders as "last synced" — was written in exactly ONE place in the whole
 * tree: `integrations.service.ts:332`, inside `connect()`. A connection that
 * succeeded in March and has served reads ever since still displayed its March
 * timestamp, because nothing in the product ever advanced it. "Last synced"
 * actually meant "last connected", and the two words are not synonyms.
 *
 * This module is the first thing in the repo that turns a scheduler on for
 * connector sync. It is registered on `cron-runtime` from `index.ts` — never a
 * `while (true)`, which is a hard rule for scheduling in this repo.
 *
 * ## Two cadences, and why both ship together
 *
 *   `runIncrementalTick`     frequent. Reads from the persisted watermark.
 *   `runReconciliationSweep` rare, expensive. Re-enumerates from the beginning
 *                            and emits a drift report.
 *
 * The sweep is not an optimisation to add later. Xero's `UpdatedDateUTC` does
 * not fire on every change, HubSpot's Search API is eventually consistent, and
 * Stripe does not guarantee event ordering — so the incremental path can
 * report success while quietly missing records, and the owner has no way to
 * know. `reconcile.ts` carries the full argument; read it before touching the
 * sweep.
 *
 * ## The boundary this module does NOT cross
 *
 * It moves CURSORS and WATERMARKS, and — since WARP-2549 — hands a page of
 * canonical rows to `land.ts`, which writes `company`, `contact` and `deal`
 * into the CRM tables a human already types into.
 *
 * `ErpEntityCache` still has ZERO writers, and must: ADR-041 §4 forbids
 * becoming its first writer until WARP-2028 lands the encryption that model's
 * schema already promises. The amended §4 is about inheriting an UNKEPT
 * PROMISE, not about persistence as such — `CrmCompany` makes no such claim.
 * PHI datasets (`patient`, `appointment`, `account`) land nowhere at all.
 * `secretRef` is likewise never written here. A sweep that cached what it
 * enumerated would still be the single easiest way to breach that, which is
 * why the sweep diffs in memory and keeps counts.
 *
 * ## Budget
 *
 * Every vendor call — the sweep's included — goes through the same
 * per-connection `CallBudget` the connectors use (`erp-provider.ts` module-level
 * map, keyed by connection id). The sweep is the expensive half and is exactly
 * the shape that trips a vendor rate limit, so it is not exempt for being
 * "internal": an exhausted budget defers the sweep into BACKOFF rather than
 * running it to completion.
 */
import type { Connector } from "@droplet/erp-connector";
import {
  ConnectorBlockedError,
  HubSpotCapabilityUnavailableError,
  MailchimpCapabilityMissingError,
  QuotaExhaustedError,
  ReauthorizationRequiredError,
  DEFAULT_CALL_CEILING,
} from "@droplet/erp-connector";
import { providerDescriptor } from "@droplet/shared-types";

import { MAX_BACKOFF_MS } from "../m365/sync-policy.js";

import { createLogger } from "../../lib/logger.js";
import type { ActivityRowRecorder } from "../activity.service.js";
import {
  connectorForProvider,
  cloudMaterialFromRow,
  apiMaterialFromRow,
  parseProviderConfig,
  sharedCallBudget,
} from "../erp-provider.js";
import {
  claimDueErpCursors,
  POLLABLE_CONNECTION_STATUSES,
  releaseErpCursorFailure,
  releaseErpCursorSuccess,
  upsertErpCursor,
  type ClaimedErpCursor,
  type ErpCursorPrisma,
  type ErpSyncStateName,
} from "./cursor.service.js";
import {
  cleanSweepStreak,
  recordEntityDrift,
  sweepIntervalMsFor,
  type ErpDriftPrisma,
} from "./drift-record.service.js";
import { ERP_SYNC_ENTITIES, erpSyncEntity, type ErpSyncEntity } from "./entities.js";
import {
  buildDriftReport,
  diffForDrift,
  highWaterMark,
  identify,
  type ErpDriftReport,
  type ErpEntityDrift,
} from "./reconcile.js";
import {
  landCanonicalRows,
  landsOnBox,
  type LandOutcome,
  type LandingConnection,
  type LandingDb,
} from "./land.js";
import { redactSyncText } from "./redact.js";

const logger = createLogger("erp-sync");

/** How many cursors one tick claims. Bounded so a box with many connections
 *  spreads its work across ticks instead of opening every vendor at once. */
const DEFAULT_TICK_LIMIT = 8;

/** The connection columns the runner reads. */
export interface SyncConnectionRow {
  id: string;
  provider: string;
  status: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  secretRef: string | null;
  providerConfig?: unknown;
  providerTokensEnc?: string | null;
  apiCredentialsEnc?: string | null;
  apiRouteMap?: unknown;
  apiCaCert?: string | null;
}

/** The Prisma surface the runner needs, beyond the cursor writers'. */
export interface ErpSyncPrisma extends ErpCursorPrisma, ErpDriftPrisma {
  integrationConnection: ErpCursorPrisma["integrationConnection"] & {
    findUnique(args: unknown): Promise<SyncConnectionRow | null>;
    update(args: unknown): Promise<unknown>;
  };
}

/**
 * WARP-2549 — how a page of rows reaches the CRM.
 *
 * A seam rather than a direct call because landing must run in a transaction,
 * and the mocked prisma objects the tick tests build have no `$transaction`.
 * Production passes the real client and gets `defaultLand` below.
 */
export type LandFn = (args: {
  connection: LandingConnection;
  entity: string;
  rows: readonly unknown[];
  now: Date;
}) => Promise<LandOutcome | null>;

/** A budget shaped like `CallBudget`, so tests can inject a spent one. */
export interface SyncCallBudget {
  assertHeadroom(): void;
  record(): void;
}

export interface ErpSyncDeps {
  prisma: ErpSyncPrisma;
  recorder: ActivityRowRecorder;
  /** Test seam. Production builds the real connector for the row's provider. */
  connectorFor?: (conn: SyncConnectionRow) => Connector;
  /** Test seam. Production shares the connectors' per-connection budget. */
  budgetFor?: (conn: SyncConnectionRow) => SyncCallBudget;
  /**
   * Test seam. Production lands through `land.ts` inside one transaction.
   * Returns `null` when this build has no landing path at all — which is only
   * true of a mocked client, and is why the tick test that matters injects
   * this rather than relying on the default.
   */
  land?: LandFn;
  now?: () => Date;
  tickLimit?: number;
  /**
   * BASE staleness before the sweep leg re-enumerates a cursor.
   *
   * The effective interval is this scaled per connection by its stored
   * drift-free streak (WARP-2463) — a connection that keeps coming back clean
   * earns a longer wait, and one miss puts it straight back to this base.
   */
  sweepIntervalMs?: number;
}

/** What one tick did, for the caller and for the tests. */
export interface ErpTickOutcome {
  cursorsClaimed: number;
  succeeded: number;
  failed: number;
  states: ErpSyncStateName[];
}

export interface ErpSweepOutcome {
  reports: ErpDriftReport[];
  deferred: number;
}

/**
 * Build the connector for a persisted row.
 *
 * Mirrors `erp.service.ts`'s `defaultConnectorFor` deliberately: the same
 * decryption + structural validation, and the same honest degradation when any
 * of it is absent. `erp-provider.ts` is imported, never edited — the provider
 * factory belongs to WARP-2217.
 */
function defaultConnectorFor(conn: SyncConnectionRow): Connector {
  return connectorForProvider({
    provider: conn.provider,
    host: conn.host ?? "",
    port: conn.port ?? undefined,
    databaseName: conn.databaseName ?? undefined,
    secretRef: conn.secretRef ?? undefined,
    ...apiMaterialFromRow(conn as never),
    ...cloudMaterialFromRow(conn as never),
  });
}

/**
 * The connection's shared call budget.
 *
 * The ceiling is derived exactly as `connectorForProvider` derives it, because
 * `sharedCallBudget` REBUILDS (and so resets the spend) when handed a ceiling
 * that differs from the one already registered. Passing a different number
 * here would silently hand the sweep a fresh allowance — the precise opposite
 * of riding the same guard.
 */
function defaultBudgetFor(conn: SyncConnectionRow): SyncCallBudget {
  const cfg = parseProviderConfig(conn.provider, conn.providerConfig);
  const ceiling =
    cfg && "callCeiling" in cfg && typeof cfg.callCeiling === "number"
      ? cfg.callCeiling
      : DEFAULT_CALL_CEILING;
  return sharedCallBudget(conn.id, ceiling);
}

/**
 * WARP-2623 — is this the vendor refusing a dataset the plan does not include?
 *
 * ONE predicate with TWO consumers, deliberately: `asSyncFailure` reads it to
 * pick the classification and `retryAfterOf` reads it to pick the interval. As
 * two independent checks they would drift, and the failure mode of that drift
 * is silent — a capability error classified non-FATAL but ridden up the
 * exponential ramp still works, it just spends vendor calls to learn what the
 * error already said.
 *
 * `instanceof` rather than a `code` string set, matching the three named
 * branches below: both classes are exported from `@droplet/erp-connector`, so
 * this is a compile-time coupling. A renamed class breaks the build; a renamed
 * `code` literal would silently stop matching.
 *
 * A third connector growing a capability error must be added HERE. That is the
 * same maintenance contract the three named branches already carry, and the
 * cost of forgetting is stated in `asSyncFailure`.
 */
function isCapabilityBlocked(err: unknown): boolean {
  return (
    err instanceof HubSpotCapabilityUnavailableError ||
    err instanceof MailchimpCapabilityMissingError
  );
}

/** Pull a `Retry-After` off whatever shape the vendor error arrived in. */
function retryAfterOf(err: unknown): string | null {
  // Checked FIRST, and synthesised rather than read: neither vendor sends a
  // `Retry-After` with a plan boundary, because from their side nothing is
  // throttled. We know more than the header does — a plan changes on a
  // human's timescale, never on the 30s base of the exponential ramp — so the
  // first refused tick goes straight to the ceiling instead of spending seven
  // pointless calls climbing to it. Expressed in `MAX_BACKOFF_MS` and not a
  // literal so the two cannot drift; `computeBackoffMs` honours a
  // `Retry-After` exactly, so this IS the wait.
  if (isCapabilityBlocked(err)) return String(MAX_BACKOFF_MS / 1000);
  const e = err as { headers?: Record<string, string>; retryAfter?: string } | null;
  if (!e) return null;
  if (typeof e.retryAfter === "string") return e.retryAfter;
  const h = e.headers;
  if (h && typeof h === "object") {
    return h["retry-after"] ?? h["Retry-After"] ?? null;
  }
  return null;
}

/**
 * Normalise a connector error into the shape `classifySyncFailure` reads.
 *
 * The three named connector states are mapped explicitly, because collapsing
 * any of them into a generic failure loses the only thing that distinguishes
 * them — and NONE of the three may ever render as an empty successful result
 * (`quickbooks/online-connector.ts:60-68`). A sync tick honours that too: an
 * exhausted budget records BACKOFF, never a silent zero-row success.
 */
function asSyncFailure(err: unknown): {
  statusCode?: number;
  code?: string;
  message?: string;
} {
  if (err instanceof QuotaExhaustedError) {
    // Not broken, and not a permanent failure: the allowance returns next
    // period. TRANSIENT is the honest classification, so it backs off.
    return { code: "QUOTA_EXHAUSTED", statusCode: 429, message: err.message };
  }
  if (err instanceof ReauthorizationRequiredError) {
    // A person must re-consent. Classified AUTH so the cursor keeps its
    // watermark and the connection is flagged needsReconnect — never ERROR.
    return { code: "REAUTHORIZE_REQUIRED", statusCode: 401, message: err.message };
  }
  if (err instanceof ConnectorBlockedError) {
    // Not configured, or the vendor is unreachable. Retrying is reasonable.
    return { code: "CONNECTOR_BLOCKED", statusCode: 503, message: err.message };
  }
  if (isCapabilityBlocked(err)) {
    // WARP-2623 — the vendor's plan or scope grant does not include this
    // dataset. Neither class carries a `statusCode`, and `classifySyncFailure`
    // reads `statusCode` plus two fixed code sets and nothing else, so without
    // this branch both answered FATAL — and FATAL is TERMINAL here in a way no
    // other classification is: `releaseErpCursorFailure` parks the cursor
    // `FAILED` with `nextAttemptAt: null`, `FAILED` is absent from
    // `CLAIMABLE_ERP_SYNC_STATES`, `upsertErpCursor`'s `update: {}` never
    // revives it, and `foldSyncState` ranks `FAILED` highest — so ONE refused
    // dataset renders the WHOLE connection's sync as failed on
    // `GET /api/integrations`, forever, including after the owner buys the
    // plan. `entities.ts:80-102` documents that exact chain as a known hazard.
    //
    // 429/TRANSIENT is the honest classification, for the same reason
    // `QuotaExhaustedError` above takes it: nothing is broken and nothing is
    // permanent. A quota returns next period; a plan boundary returns when the
    // owner buys the plan — different timescales, same shape, and the
    // timescale is carried by `retryAfterOf`'s matching arm, not by the class.
    //
    // NOT `AUTH`, which is the tempting near-miss: AUTH sets `needsReconnect`,
    // which sends the owner to re-paste a credential that is working perfectly.
    // Both error messages say so in as many words.
    //
    // Deliberately NOT a new `ErpSyncState` enum member. A dedicated
    // capability-blocked cursor state would need a second Prisma enum
    // migration in this PR, a rank in `SYNC_STATE_RANK`, a decision in
    // `foldSyncState`, and a rendering in the hub — for behaviour `BACKOFF` at
    // the ceiling already delivers exactly. The connection-level fact the
    // owner needs is already modelled: it is the `CAPABILITY_LIMITED`
    // IntegrationStatus this ticket adds.
    return {
      code: "CAPABILITY_BLOCKED",
      statusCode: 429,
      message: (err as Error).message,
    };
  }
  const e = err as { statusCode?: number; status?: number; code?: string; message?: string };
  return {
    statusCode: e?.statusCode ?? e?.status,
    code: e?.code,
    message: e?.message ?? String(err),
  };
}

export interface ErpSyncRunner {
  runIncrementalTick(): Promise<ErpTickOutcome>;
  runReconciliationSweep(): Promise<ErpSweepOutcome>;
  registerCursors(): Promise<void>;
}

export function createErpSyncRunner(deps: ErpSyncDeps): ErpSyncRunner {
  const { prisma, recorder } = deps;
  const now = deps.now ?? (() => new Date());
  const connectorFor = deps.connectorFor ?? defaultConnectorFor;
  const budgetFor = deps.budgetFor ?? defaultBudgetFor;
  const tickLimit = deps.tickLimit ?? DEFAULT_TICK_LIMIT;

  /**
   * Land inside ONE transaction, so a page of rows is either all on the box or
   * none of it is. The caller advances the watermark only after this resolves —
   * see `runOneCursor`.
   */
  const defaultLand: LandFn = async (args) => {
    const client = prisma as unknown as {
      $transaction?: <T>(fn: (tx: LandingDb) => Promise<T>) => Promise<T>;
    };
    if (typeof client.$transaction !== "function") return null;
    return client.$transaction((tx) => landCanonicalRows(tx, args));
  };
  const land = deps.land ?? defaultLand;
  const sweepIntervalMs = deps.sweepIntervalMs ?? 24 * 60 * 60 * 1000;

  /**
   * One audit row per tick, on BOTH paths.
   *
   * `IntegrationConnection.connect()` writes no audit row at all and
   * `routes/m365.ts` has no `recordActivity` anywhere — those are gaps, not a
   * pattern to copy. A job that reaches a customer's Stripe or Xero account on
   * a schedule and leaves no trace is exactly what the audit chain exists for.
   *
   * The scope carries connection id, provider key, dataset name and counts.
   * Never a record identifier, a customer name, an amount or an email — and
   * the failure text goes through the same redaction `lastError` does, so a
   * vendor echoing a credential back cannot land one in the chain.
   *
   * `recordSafely`'s swallow is deliberately NOT used: an audit row that
   * silently fails to write is the failure mode the chain exists to prevent,
   * and cron-runtime's `safeRun` already turns a throw here into a logged
   * failure with a consecutive-failure canary attached.
   */
  async function audit(
    what: string,
    ok: boolean,
    scope: Record<string, unknown>,
  ): Promise<void> {
    await recorder.record({
      kind: "system",
      severity: ok ? "ok" : "warn",
      sourceIcon: "refresh-cw",
      what,
      actor: { type: "system", id: "erp-sync" },
      refs: scope,
    });
  }

  async function loadConnection(connectionId: string): Promise<SyncConnectionRow | null> {
    return prisma.integrationConnection.findUnique({ where: { id: connectionId } });
  }

  /**
   * Advance `lastHealthyAt` on the connection.
   *
   * This is the line that stops "last synced" lying. Before WARP-2218 the only
   * write of this column in the tree was inside `connect()`; a successful tick
   * must move it with NO human action, which is what the tick test asserts by
   * never going near the connect path.
   */
  async function advanceLastHealthy(connectionId: string, at: Date): Promise<void> {
    await prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { lastHealthyAt: at },
    });
  }

  /** Read one entity, spending exactly one budgeted call. */
  async function readEntity(
    connector: Connector,
    budget: SyncCallBudget,
    readQuery: string,
    params: Record<string, unknown>,
  ): Promise<unknown[]> {
    // BEFORE the request, so an exhausted budget costs no network at all.
    budget.assertHeadroom();
    const rows = await connector.runRead(readQuery, params);
    budget.record();
    return rows;
  }

  async function runOneCursor(cursor: ClaimedErpCursor): Promise<ErpSyncStateName> {
    const at = now();
    const spec = erpSyncEntity(cursor.entity);
    const conn = await loadConnection(cursor.connectionId);

    if (!spec || !conn) {
      // An entity we no longer serve, or a connection deleted between the
      // claim and the read. Neither is a vendor failure and neither is worth a
      // retry storm — park it explicitly rather than leaving it SYNCING, which
      // would strand the cursor forever (a state no tick can claim).
      await releaseErpCursorFailure(
        prisma,
        cursor,
        { code: "SYNC_TARGET_ABSENT", message: spec ? "connection absent" : "entity not served" },
        null,
        at,
      );
      await audit("Connector sync skipped", false, {
        connectionId: cursor.connectionId,
        entity: cursor.entity,
        reason: spec ? "CONNECTION_ABSENT" : "ENTITY_NOT_SERVED",
      });
      return "FAILED";
    }

    let connector: Connector;
    try {
      // Construction is INSIDE the try: a cloud row with no company id, or an
      // unsafe base URL, throws here, and built outside it would escape the
      // handler as an unhandled error rather than degrading honestly.
      connector = connectorFor(conn);
    } catch (err) {
      const state = await releaseErpCursorFailure(prisma, cursor, asSyncFailure(err), null, at);
      await audit("Connector sync failed", false, {
        connectionId: conn.id,
        provider: conn.provider,
        entity: cursor.entity,
        phase: "construct",
        state,
        error: redactSyncText(String((err as Error)?.message ?? err)),
      });
      return state;
    }

    const budget = budgetFor(conn);
    try {
      await connector.connect();
      // The watermark is passed to the vendor read. On tick N+1 this is the
      // high-water mark tick N stored — re-reading from the PREVIOUS watermark
      // instead is the mutation the watermark-advance test is written against.
      const params = cursor.watermark === null ? {} : { since: cursor.watermark };
      const rows = await readEntity(connector, budget, spec.readQuery, params);

      const records = identify(
        rows,
        spec.sourceKeyField,
        spec.markerField,
        spec.updatedAtField,
      );
      // WARP-2474 — the position advances on the vendor's own `updated_at`
      // when the track defines one and on the ordering key otherwise, decided
      // per row inside `highWaterMark`. A row edited after it was issued moves
      // only the former, so a watermark built from the ordering key alone
      // re-reads it on every tick forever.
      //
      // Never regress the watermark: an empty page must not reset the position
      // to null and re-enumerate the whole account on the next tick.
      const next = highWaterMark(records) ?? cursor.watermark;

      // WARP-2549 — land BEFORE the watermark moves, and never after.
      //
      // The watermark is a promise that everything up to it has been dealt
      // with. Advancing it first and landing second means a crash, a rollback
      // or a constraint violation in between loses those rows permanently: the
      // next tick asks the vendor for rows AFTER the mark and never sees them
      // again. Landing first costs a re-read of one page in that same crash —
      // and the re-read is harmless, because `(connectionId, externalId)`
      // reconciles a row that is already here.
      //
      // A landing failure therefore falls into the catch below and parks the
      // cursor as a sync failure, which is the honest report: the vendor was
      // read, and this box did not keep what it read.
      const landing = landsOnBox(cursor.entity)
        ? await land({
            connection: { id: conn.id, provider: conn.provider },
            entity: cursor.entity,
            rows,
            now: at,
          })
        : null;

      await releaseErpCursorSuccess(prisma, cursor.id, next, at);
      await advanceLastHealthy(conn.id, at);
      await audit("Connector synced", true, {
        connectionId: conn.id,
        provider: conn.provider,
        entity: cursor.entity,
        recordCount: records.length,
        watermarkAdvanced: next !== cursor.watermark,
        // Counts only. An audit row is exportable and append-only, which makes
        // it the worst possible second home for customer content (rule 19).
        landed: landing?.landed ?? 0,
        landSkipped: landing?.skipped ?? 0,
        landSkipReason: landing?.reason ?? null,
      });
      return "IDLE";
    } catch (err) {
      const state = await releaseErpCursorFailure(
        prisma,
        cursor,
        asSyncFailure(err),
        retryAfterOf(err),
        at,
      );
      await audit("Connector sync failed", false, {
        connectionId: conn.id,
        provider: conn.provider,
        entity: cursor.entity,
        phase: "read",
        state,
        error: redactSyncText(String((err as Error)?.message ?? err)),
      });
      return state;
    } finally {
      await connector.close().catch(() => {});
    }
  }

  /**
   * WARP-2533 — does this connection's track serve this sync entity?
   *
   * The entity names are canonical dataset names (`entities.ts`), so a cloud
   * track's descriptor `datasets` answers directly. Before this filter,
   * `registerCursors` gave EVERY connected connection an `invoice` and a
   * `bill` cursor; a healthy HubSpot or Mailchimp connection's first tick
   * then asked for a dataset the track will never have,
   * `DatasetNotServedError` was classified FATAL, the cursor parked FAILED,
   * and `foldSyncState` rendered the connection as a failed sync forever.
   *
   * A cloud descriptor answers directly. For anything else — a lan track,
   * whose served set is runtime-computed, or a provider with no descriptor at
   * all — there is no evidence to read, and the ENTITY decides via
   * `openToUndeclaredTracks`.
   *
   * WARP-2509 replaced a bare `return true` there, and the difference only
   * became load-bearing when that ticket took the table from two entities to
   * ten. `true` was right while both were accounting datasets the export-drop
   * connector genuinely serves whenever the practice's export carries them:
   * filtering a lan track by its static declaration would have stopped the
   * accounting sync it shipped with. Applied unchanged to eight CRM and
   * marketing entities, the same line would have handed every Eaglesoft box
   * eight cursors for datasets no lan track can serve — each failing its first
   * tick with `DatasetNotServedError`, classified FATAL, parked FAILED, and
   * folded by `foldSyncState` into "this connection's sync is failing".
   *
   * The two halves of the old comment were really two different claims, and
   * only one of them generalised. The flag is where they now live apart.
   */
  /*
   * WARP-2650 — the split is "does this track DECLARE its served set", not
   * "is it cloud". A `cloud` track declares `datasets` and an `mcp` track
   * declares the empty tuple, and both are statements the descriptor makes
   * about itself; a `lan` track's served set is runtime-computed and a
   * descriptor-less provider has said nothing at all, so those two are the ones
   * the ENTITY decides for.
   *
   * Reading `track !== "cloud"` would have sent every CONNECTED Atlassian row
   * down the `openToUndeclaredTracks` path and handed it a cursor for every
   * accounting entity — each failing its first tick with
   * `DatasetNotServedError`, parked FAILED, and folded into "this connection's
   * sync is failing" forever. That is WARP-2533's defect exactly, reintroduced
   * by a fourth track rather than by a new entity.
   */
  function entityServedBy(provider: string, spec: ErpSyncEntity): boolean {
    const descriptor = providerDescriptor(provider);
    if (!descriptor || descriptor.track === "lan" || descriptor.track === "catalog") {
      return spec.openToUndeclaredTracks;
    }
    return (descriptor.datasets as readonly string[]).includes(spec.entity);
  }

  return {
    /**
     * Register a cursor per (live connection, entity the provider's track
     * serves). Idempotent, and never resets an existing cursor's watermark.
     */
    async registerCursors() {
      // WARP-2623 — the claim's own list, not a third copy of it. A status the
      // scheduler polls but never registers a cursor for is a connection that
      // silently syncs nothing.
      const live = await prisma.integrationConnection.findMany({
        where: { status: { in: [...POLLABLE_CONNECTION_STATUSES] } },
        select: { id: true, provider: true, status: true },
      });
      for (const conn of live) {
        for (const spec of ERP_SYNC_ENTITIES) {
          if (!entityServedBy(conn.provider, spec)) continue;
          await upsertErpCursor(prisma, conn.id, spec.entity);
        }
      }
    },

    async runIncrementalTick() {
      const claimed = await claimDueErpCursors(prisma, tickLimit, now());
      const states: ErpSyncStateName[] = [];
      for (const cursor of claimed) {
        states.push(await runOneCursor(cursor));
      }
      return {
        cursorsClaimed: claimed.length,
        succeeded: states.filter((s) => s === "IDLE").length,
        failed: states.filter((s) => s !== "IDLE").length,
        states,
      };
    },

    /**
     * The full reconciliation sweep.
     *
     * Runs on its own, longer cadence and re-enumerates from the beginning —
     * NOT from the watermark. Resuming from the watermark would make the full
     * read identical to the incremental one, the diff empty, and the report
     * permanently and falsely clean. That is the mutation the sweep's test
     * pins, and it is the one assertion in this story that must not be
     * weakened.
     */
    async runReconciliationSweep() {
      const at = now();
      const reports: ErpDriftReport[] = [];
      let deferred = 0;

      const live = await prisma.integrationConnection.findMany({
        where: { status: { in: [...POLLABLE_CONNECTION_STATUSES] } },
        select: { id: true, provider: true, status: true },
      });

      for (const summary of live) {
        const conn = await loadConnection(summary.id);
        if (!conn) continue;

        const cursors = (await prisma.erpSyncCursor.findMany({
          where: { connectionId: conn.id },
        })) as Array<Record<string, unknown>>;

        // WARP-2463 — the cadence is EARNED, per connection, from stored
        // evidence. A connection whose last N sweeps all came back clean waits
        // longer before paying for the next re-enumeration; one that caught a
        // miss drops straight back to the base interval. Xero's egress is
        // metered per app and scales with units sold (WARP-2383), so every
        // unnecessary sweep is money — and drift history is the only thing
        // that can justify skipping one.
        const streak = await cleanSweepStreak(prisma, conn.id);
        const connSweepIntervalMs = sweepIntervalMsFor(sweepIntervalMs, streak);

        const due = cursors.filter((c) => {
          const last = c.lastSweepAt as Date | null | undefined;
          // Persisted, so a restart does not re-trigger the expensive
          // re-enumeration immediately.
          return !last || at.getTime() - last.getTime() >= connSweepIntervalMs;
        });
        if (due.length === 0) continue;

        let connector: Connector;
        try {
          connector = connectorFor(conn);
        } catch {
          continue;
        }

        const budget = budgetFor(conn);
        const entityDrift: ErpEntityDrift[] = [];
        try {
          await connector.connect();
          for (const row of due) {
            const entity = String(row.entity);
            const spec = erpSyncEntity(entity);
            if (!spec) continue;
            const watermark = typeof row.watermark === "string" ? row.watermark : null;

            // The sweep is the expensive half and rides the SAME budget the
            // connectors do. Exempting it "because it is internal" is how one
            // box trips a pooled vendor limit for the whole fleet.
            const incrementalRows = await readEntity(
              connector,
              budget,
              spec.readQuery,
              watermark === null ? {} : { since: watermark },
            );
            // Re-enumerate. NO watermark. This is the load-bearing line.
            const fullRows = await readEntity(connector, budget, spec.readQuery, {});

            const incremental = identify(
              incrementalRows,
              spec.sourceKeyField,
              spec.markerField,
              spec.updatedAtField,
            );
            const full = identify(
              fullRows,
              spec.sourceKeyField,
              spec.markerField,
              spec.updatedAtField,
            );
            const drift = diffForDrift(entity, watermark, incremental, full);
            entityDrift.push(drift);

            // WARP-2463 — persist it. UNCONDITIONALLY: a clean sweep writes a
            // row saying so. There is no `if (missedCount > 0)` guard here and
            // adding one is the mutation that breaks this table, because
            // absence of a row would then mean both "the incremental path was
            // trustworthy" and "no sweep ever ran" — which are the two answers
            // the whole story exists to keep apart.
            await recordEntityDrift(prisma, {
              connectionId: conn.id,
              provider: conn.provider,
              sweepAt: at,
              watermark,
              drift,
            });

            // The sweep saw the whole account, so its high-water mark is the
            // authoritative one — adopting it is how the Xero class of drift
            // (a marker that never moved) actually gets repaired.
            await releaseErpCursorSuccess(
              prisma,
              String(row.id),
              highWaterMark(full) ?? watermark,
              at,
              at,
            );
          }
        } catch (err) {
          // An exhausted budget DEFERS the sweep — it does not run to
          // completion and it does not report a clean sweep it never did.
          deferred += 1;
          const cursorLike = {
            id: String(due[entityDrift.length]?.id ?? due[0].id),
            consecutiveFailures: Number(due[entityDrift.length]?.consecutiveFailures ?? 0),
          };
          const state = await releaseErpCursorFailure(
            prisma,
            cursorLike,
            asSyncFailure(err),
            retryAfterOf(err),
            at,
          );
          await audit("Connector reconciliation deferred", false, {
            connectionId: conn.id,
            provider: conn.provider,
            state,
            entitiesCompleted: entityDrift.length,
            error: redactSyncText(String((err as Error)?.message ?? err)),
          });
          continue;
        } finally {
          await connector.close().catch(() => {});
        }

        const report = buildDriftReport(conn.id, conn.provider, at, entityDrift);
        reports.push(report);
        if (report.driftDetected) {
          logger.warn(
            { connectionId: conn.id, provider: conn.provider, totalMissed: report.totalMissed },
            "connector reconciliation found records the incremental path missed",
          );
        }
        await audit("Connector reconciliation swept", true, {
          connectionId: conn.id,
          provider: conn.provider,
          totalMissed: report.totalMissed,
          driftDetected: report.driftDetected,
          entities: report.entities.map((e) => ({
            entity: e.entity,
            fullCount: e.fullCount,
            incrementalCount: e.incrementalCount,
            missedCount: e.missedCount,
            classes: e.classes,
          })),
        });
      }

      return { reports, deferred };
    },
  };
}
