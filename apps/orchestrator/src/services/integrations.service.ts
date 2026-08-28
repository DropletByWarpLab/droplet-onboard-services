/**
 * integrations.service — the ERP-integration control plane (WARP-1137,
 * EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF §12, §13, §14).
 *
 * Owns the `IntegrationConnection` lifecycle: hub listing, connection detail,
 * the connect / test / provision orchestration, and the per-practice
 * `writeEnabled` opt-in toggle. Eaglesoft is provider #1 behind a generic
 * connector abstraction; this service is provider-agnostic.
 *
 * DB-INDEPENDENT SLICE (WARP-1137 scope boundary): the connector's live SQL
 * Anywhere calls are stubbed — `connect()` / `health()` / `introspect()` throw
 * `ConnectorBlockedError`. This service catches that and maps it to an HONEST
 * status: a connect attempt that can't reach Eaglesoft lands in PROVISIONING
 * (still trying / blocked on the driver), NEVER a fake CONNECTED. The live
 * driver + a restored copy of PattersonPM.db are a later ticket.
 *
 * HARD RULES honored here:
 *  • Explicit-enum status — every status comes from the `status` COLUMN, never
 *    derived from row absence (invariant 7 / WARP-218). A missing row maps to
 *    the explicit NOT_CONFIGURED constant, not an implicit `null`.
 *  • `secretRef` is a POINTER into the encrypted secret store — the row never
 *    stores a cleartext password (brief §7.4, invariant 10).
 *  • Every writeEnabled flip writes an append-only `ErpAuditLog` row (§14).
 */
import type { PrismaClient } from "@prisma/client";
// A VALUE import, unlike the type-only one above: `Prisma.DbNull` is the
// only way to null a nullable `Json` column — plain `null` is a type error
// (`NullableJsonNullValueInput`). Same shape as `activity.service.ts:23-24`
// and `routes/cameras.ts:973`.
import { Prisma } from "@prisma/client";
import { ConnectorBlockedError, type Connector } from "@droplet/erp-connector";
import { createLogger } from "../lib/logger.js";
import { recordActivity } from "./activity.singleton.js";
import type { ActivityActor } from "./activity.service.js";
import { ErpError } from "./erp-error.js";
// WARP-2466 — the ADR-041 §5 mapping. `statusAfterHealthProbe` is the only
// thing that decides a row's status after a probe, and it has no input that
// produces PROVISIONING.
import { statusAfterHealthProbe } from "./cloud-connection-state.js";
import { providerDescriptor } from "@droplet/shared-types";
import {
  connectorForProvider,
  encodeApiCredentials,
  isKnownErpProvider,
  parseRouteMap,
  EAGLESOFT_PROVIDER,
  EAGLESOFT_API_PROVIDER,
  type ResolvedApiCredentials,
} from "./erp-provider.js";

const logger = createLogger("integrations-service");

// Provider keys + the dual-track connector factory now live in erp-provider.ts.
// Re-exported here so existing importers (erp.service, tests) keep resolving
// EAGLESOFT_PROVIDER from this module.
export { EAGLESOFT_PROVIDER, EAGLESOFT_API_PROVIDER };

/** The explicit lifecycle states (mirror of the Prisma `IntegrationStatus`
 *  enum). A provider with no row is reported as NOT_CONFIGURED — the explicit
 *  constant, never a derived-from-null value. */
export type IntegrationStatusName =
  | "NOT_CONFIGURED"
  | "PROVISIONING"
  | "CONNECTED"
  | "DEGRADED"
  | "DRIFT_LOCKED"
  // WARP-2458 — the eighth member. ADR-041 §5 names it mandatory; a revoked
  // customer credential is neither "never configured" nor "broken", and a
  // surface reading only `status` must not render it as healthy.
  | "NEEDS_RECONNECT"
  | "ERROR"
  | "DISABLED";

/** Hub row (brief §13 `GET /api/integrations`). No PHI, no secret. */
export interface IntegrationSummary {
  provider: string;
  status: IntegrationStatusName;
  configured: boolean;
  writeEnabled: boolean;
  /**
   * WARP-1998 — ISO of the last successful read, or `null` when the provider
   * has never synced. Derived from the existing `lastHealthyAt` column, the
   * same source `toDetail` uses; no new state, no migration.
   *
   * It lives on the SUMMARY (not just the detail) because the only detail
   * route is `/api/integrations/eaglesoft` — provider-specific — so any
   * surface listing N connectors previously had no way to say how stale each
   * one is. Reports needs it twice: the connector sub-line and the money
   * tile's staleness chip, which is what stops a stale figure being shown as
   * current.
   *
   * Not PHI: a sync timestamp says WHEN the connector last succeeded, never
   * what it read.
   *
   * `null` is explicit, never an omitted key — absence must not be ambiguous
   * with "never synced".
   */
  lastSyncedAt: string | null;

  /**
   * WARP-2218 — the poller's explicit state for this connection, read from the
   * `ErpSyncCursor.state` COLUMN. `null` means no cursor is registered yet,
   * which is a different fact from any of the five states and is carried as an
   * explicit null rather than an omitted key.
   *
   * Deliberately a SEPARATE field from `status` rather than extra members on
   * `IntegrationStatus`. A connection can be perfectly `CONNECTED` — correctly
   * configured, credential valid — while its sync is in `BACKOFF` because the
   * vendor throttled us ten seconds ago. Folding one into the other would make
   * a healthy connection render as broken every time a vendor got busy.
   */
  syncState: ErpSyncStateName | null;

  /**
   * WARP-2218 / ADR-041 — the customer's credential was revoked, rotated in
   * the vendor's console, or expired, and the owner needs to paste a new one.
   *
   * A ROUTINE state, never an error. It must stay distinguishable from both
   * "never configured" (`status: NOT_CONFIGURED`) and "broken"
   * (`status: ERROR`), for the same reason `M365ConnectionState` insists
   * `NEEDS_RECONNECT` is distinguishable from `DISCONNECTED`
   * (`schema.prisma:4990-5012`): they look identical from "is there a working
   * token" and mean opposite things to the person reading the dashboard. One
   * needs thirty seconds of their time; the other needs a support call.
   *
   * Read from the explicit `needsReconnect` column, never inferred from a null
   * token or an absent row.
   */
  needsReconnect: boolean;
  /**
   * WARP-2453 — whether this connection's credentials have actually been
   * removed, so the hub can render "disconnected, credentials removed"
   * distinctly from "disabled by policy, key still on the row".
   *
   * Derived from two EXPLICIT persisted facts — the `status` enum column and
   * whether either credential column holds a blob — never from a null standing
   * in for a state. The distinction is load-bearing: a row DISABLED by a build
   * that predates the purge still holds its credential, and claiming otherwise
   * would be the dashboard asserting something false about the box.
   *
   * `false`, never omitted, for an unconfigured provider: nothing was purged.
   */
  credentialsPurged: boolean;
}

/** The five `ErpSyncState` members, mirrored for the API surface. */
export type ErpSyncStateName =
  | "IDLE"
  | "SYNCING"
  | "BACKOFF"
  | "RESYNC_REQUIRED"
  | "FAILED";

/** Connection detail (brief §13 `GET /api/integrations/eaglesoft`). Shaped to
 *  the dashboard's IntegrationConnection type; the route nests it under
 *  `connection`. */
export interface IntegrationDetail extends IntegrationSummary {
  host: string | null;
  databaseName: string | null;
  schemaVersion: string | null;
  schemaHash: string | null;
  /** The dedicated read account (droplet_ro) once configured. */
  account: string | null;
  /** ISO of the last successful read — the dashboard reads this as lastSyncedAt. */
  lastSyncedAt: string | null;
  lastHealthyAt: string | null;
}

/** Input for connect / test. In this slice the backend owns the credential —
 *  the wizard shows a generated password for the DBA to run the GRANT and the
 *  orchestrator mints the `secretRef` pointer — so the client need not send it. */
export interface ConnectInput {
  host: string;
  databaseName?: string;
  /** Pointer into the encrypted secret store; NEVER a cleartext password.
   *  Optional — generated server-side when the client doesn't supply one. */
  secretRef?: string;
  serverName?: string;
  port?: number;
  /** Read scopes the operator chose in the wizard (metadata; not yet persisted). */
  scopes?: string[];
  /** Connect-time write opt-in — sets `writeEnabled` on the new connection. */
  enableWrites?: boolean;
  /** Which ERP provider to connect ("eaglesoft" | "eaglesoft-api"). Defaults to
   *  the direct-SQL Eaglesoft provider when omitted (dual-track, WARP-1294). */
  provider?: string;

  // --- REST-track material (ignored by the direct-SQL provider) -------------

  /** CLEARTEXT vendor + provider login, supplied once at connect time. Stored
   *  encrypted (`apiCredentialsEnc`) and never returned by any read path. */
  apiCredentials?: ResolvedApiCredentials;
  /** The route contract DISCOVERED from this box's /help page. Supplied by the
   *  operator — deliberately not auto-parsed, because the real page's format is
   *  Patterson's and unseen; a parser written against a synthetic one would be
   *  a guess wearing the costume of discovery. */
  apiRouteMap?: unknown;
  /** PEM of the CA to trust for this box's certificate. */
  apiCaCert?: string;
}

export interface TestResult {
  ok: boolean;
  /** On failure, the honest reason code the dashboard renders. */
  reason?: string;
  message: string;
}

/** Dependency seam so tests can inject a stubbed connector. Production builds
 *  the real `EaglesoftConnector` (whose live methods are themselves stubbed in
 *  this DB-independent slice). */
export interface IntegrationsServiceDeps {
  connectorFor?: (provider: string, input: ConnectInput) => Connector;
}

/** Minimal Prisma surface this service needs (structural — tests pass a stub). */
type IntegrationsPrisma = Pick<PrismaClient, "integrationConnection" | "erpAuditLog"> &
  // WARP-2218 — optional so every existing test stub keeps working; a stub
  // without it reports "no cursor registered", which is the honest answer for
  // a store that has none.
  Partial<Pick<PrismaClient, "erpSyncCursor">>;

/**
 * One connection's sync facts, folded from its per-entity cursors.
 *
 * A connection has one cursor per entity, and the hub renders one row. The
 * fold is deliberately ranked rather than "latest wins": the state worth
 * surfacing is the most actionable one. A connection with a healthy invoice
 * cursor and a FAILED bill cursor is not healthy, and showing IDLE because it
 * happened to be read second would hide the only thing an owner can act on.
 */
const SYNC_STATE_RANK: Record<ErpSyncStateName, number> = {
  FAILED: 5,
  RESYNC_REQUIRED: 4,
  BACKOFF: 3,
  SYNCING: 2,
  IDLE: 1,
};

function foldSyncState(
  cursors: Array<{ state: string; needsReconnect: boolean }>,
): { syncState: ErpSyncStateName | null; needsReconnect: boolean } {
  if (cursors.length === 0) return { syncState: null, needsReconnect: false };
  let best: ErpSyncStateName = "IDLE";
  let reconnect = false;
  for (const c of cursors) {
    const state = c.state as ErpSyncStateName;
    if (SYNC_STATE_RANK[state] !== undefined && SYNC_STATE_RANK[state] > SYNC_STATE_RANK[best]) {
      best = state;
    }
    // Explicit column, never inferred. Any entity needing a credential means
    // the connection needs one.
    if (c.needsReconnect) reconnect = true;
  }
  return { syncState: best, needsReconnect: reconnect };
}

const DEFAULT_DATABASE_NAME = "PattersonPM";

/** Resolve the provider for a connect/test call. Defaults to the direct-SQL
 *  Eaglesoft provider; an explicit but unknown value is rejected rather than
 *  silently routed to a surprise transport. */
function resolveProvider(provider: string | undefined): string {
  if (provider === undefined) return EAGLESOFT_PROVIDER;
  if (!isKnownErpProvider(provider)) {
    throw ErpError.validation(`unknown ERP provider "${provider}"`);
  }
  return provider;
}

function defaultConnectorFor(provider: string, input: ConnectInput): Connector {
  // Dual-track selection lives in erp-provider.ts; the SQL branch is unchanged.
  // The REST material comes straight off the ConnectInput here (rather than the
  // row) so `test()` can validate credentials BEFORE anything is persisted.
  return connectorForProvider({
    provider,
    host: input.host,
    port: input.port,
    serverName: input.serverName,
    databaseName: input.databaseName,
    secretRef: input.secretRef,
    apiCredentials: input.apiCredentials,
    apiRouteMap: parseRouteMap(input.apiRouteMap),
    apiCaCert: input.apiCaCert,
  });
}

/**
 * Who is connecting.
 *
 * WARP-2283 — optional so the 293 existing call sites keep compiling, but the
 * route SHOULD pass it: under ADR-041 §2 connecting is the consent record, and
 * a consent record with no actor answers "was this allowed?" but not "by whom",
 * which is the question an audit is for. Absent, the row is attributed to the
 * box itself rather than being silently dropped.
 */
export interface ConnectContext {
  actor?: ActivityActor;
}

export interface IntegrationsService {
  list(): Promise<IntegrationSummary[]>;
  getEaglesoft(): Promise<IntegrationDetail>;
  connect(input: ConnectInput, ctx?: ConnectContext): Promise<IntegrationDetail>;
  test(input: ConnectInput): Promise<TestResult>;
  setWriteEnabled(
    enabled: boolean,
    ctx: { actor: string },
  ): Promise<IntegrationDetail>;
  disconnect(ctx: { actor: string }): Promise<IntegrationDetail>;
}

export function createIntegrationsService(
  prisma: IntegrationsPrisma,
  deps: IntegrationsServiceDeps = {},
): IntegrationsService {
  const connectorFor = deps.connectorFor ?? defaultConnectorFor;

  /** The single connection row for a provider, or null. Provider-scoped. */
  async function findRow(provider: string = EAGLESOFT_PROVIDER) {
    return prisma.integrationConnection.findFirst({
      where: { provider },
    });
  }

  /**
   * WARP-2218 — the poller's explicit state for one connection.
   *
   * Returns "no cursor registered" when the model is unavailable (a test stub
   * that predates this field) or empty, which is the honest answer rather than
   * a guess. Never derived from a null column.
   */
  async function loadSyncFacts(
    connectionId: string | null,
  ): Promise<{ syncState: ErpSyncStateName | null; needsReconnect: boolean }> {
    if (!connectionId || !prisma.erpSyncCursor) {
      return { syncState: null, needsReconnect: false };
    }
    const cursors = (await prisma.erpSyncCursor.findMany({
      where: { connectionId },
      select: { state: true, needsReconnect: true },
    })) as unknown as Array<{ state: string; needsReconnect: boolean }>;
    return foldSyncState(cursors);
  }

  /**
   * WARP-2453 — has this connection's credential material actually been
   * removed?
   *
   * True only for a row that is explicitly DISABLED **and** holds neither
   * credential blob. Both halves are required: DISABLED alone is what
   * `origin/stage` gave a caller who clicked Disconnect while the key stayed
   * decryptable in Postgres, and an empty credential column alone is just an
   * unconfigured connection.
   */
  function credentialsPurgedFor(row: {
    status: string;
    apiCredentialsEnc?: string | null;
    providerTokensEnc?: string | null;
  }): boolean {
    return row.status === "DISABLED" && !row.apiCredentialsEnc && !row.providerTokensEnc;
  }

  function toDetail(
    row: Awaited<ReturnType<typeof findRow>>,
    sync: { syncState: ErpSyncStateName | null; needsReconnect: boolean } = {
      syncState: null,
      needsReconnect: false,
    },
  ): IntegrationDetail {
    if (!row) {
      // Explicit constant — NOT derived from the absence of a row. The hub /
      // detail surfaces render "connect Eaglesoft" from this status.
      return {
        provider: EAGLESOFT_PROVIDER,
        status: "NOT_CONFIGURED",
        configured: false,
        writeEnabled: false,
        host: null,
        databaseName: null,
        schemaVersion: null,
        schemaHash: null,
        account: null,
        lastSyncedAt: null,
        lastHealthyAt: null,
        // Never configured is not "needs reconnect": one has never had a
        // credential, the other had one that stopped working.
        syncState: null,
        needsReconnect: false,
        // Nothing was ever stored, so nothing was purged. Explicit `false`,
        // never an omitted key — absence must not read as "unknown".
        credentialsPurged: false,
      };
    }
    const lastSynced = row.lastHealthyAt ? row.lastHealthyAt.toISOString() : null;
    return {
      provider: row.provider,
      status: row.status as IntegrationStatusName,
      configured: true,
      writeEnabled: row.writeEnabled,
      host: row.host,
      databaseName: row.databaseName,
      schemaVersion: row.schemaVersion,
      schemaHash: row.schemaHash,
      // The dedicated read account is SQL-only; the API provider authenticates
      // with a vendor key + an Eaglesoft Provider login, so there is no
      // droplet_ro account to surface.
      account: row.provider === EAGLESOFT_API_PROVIDER ? null : "droplet_ro",
      lastSyncedAt: lastSynced,
      lastHealthyAt: lastSynced,
      syncState: sync.syncState,
      needsReconnect: sync.needsReconnect,
      credentialsPurged: credentialsPurgedFor(row),
    };
  }

  /** `toDetail` with the sync facts loaded. */
  async function detailFor(
    row: Awaited<ReturnType<typeof findRow>>,
  ): Promise<IntegrationDetail> {
    return toDetail(row, await loadSyncFacts(row?.id ?? null));
  }

  return {
    async list() {
      const rows = await prisma.integrationConnection.findMany();
      const byProvider = new Map(rows.map((r) => [r.provider, r]));
      // WARP-2218 — one query for every connection's cursors rather than one
      // per row: the hub lists N providers and an N+1 here would be N+1 round
      // trips on a page that renders on every dashboard load.
      const cursors = prisma.erpSyncCursor
        ? ((await prisma.erpSyncCursor.findMany({
            select: { connectionId: true, state: true, needsReconnect: true },
          })) as unknown as Array<{
            connectionId: string;
            state: string;
            needsReconnect: boolean;
          }>)
        : [];
      const cursorsByConnection = new Map<string, typeof cursors>();
      for (const c of cursors) {
        const list = cursorsByConnection.get(c.connectionId) ?? [];
        list.push(c);
        cursorsByConnection.set(c.connectionId, list);
      }
      // The framework knows about Eaglesoft even before it is configured, so
      // the hub always lists it (explicit NOT_CONFIGURED when no row exists).
      const providers = new Set<string>([
        EAGLESOFT_PROVIDER,
        EAGLESOFT_API_PROVIDER,
        ...rows.map((r) => r.provider),
      ]);
      return Array.from(providers).map((provider) => {
        const row = byProvider.get(provider);
        const sync = foldSyncState(row ? (cursorsByConnection.get(row.id) ?? []) : []);
        return {
          provider,
          status: (row?.status as IntegrationStatusName) ?? "NOT_CONFIGURED",
          configured: !!row,
          writeEnabled: row?.writeEnabled ?? false,
          // Same source as toDetail's lastSyncedAt. `?? null` rather than
          // `?.` alone so an unconfigured provider carries the key with an
          // explicit null instead of `undefined`, which JSON would drop.
          lastSyncedAt: row?.lastHealthyAt ? row.lastHealthyAt.toISOString() : null,
          // Same treatment: explicit null for "no cursor registered", which is
          // a different fact from any of the five states.
          syncState: sync.syncState,
          needsReconnect: sync.needsReconnect,
          credentialsPurged: row ? credentialsPurgedFor(row) : false,
        };
      });
    },

    async getEaglesoft() {
      return detailFor(await findRow());
    },

    async connect(input, ctx) {
      const provider = resolveProvider(input.provider);
      // Upsert-by-hand: reuse the existing row if present so we never orphan a
      // second connection for the same provider.
      const existing = await findRow(provider);
      const databaseName = input.databaseName || DEFAULT_DATABASE_NAME;
      // The backend owns the credential — mint a pointer if the client didn't
      // send one (the real secret is created during live provisioning).
      const secretRef = input.secretRef ?? `${provider}:pending`;
      // Honor the wizard's connect-time write opt-in (default off / read-only).
      const writeEnabled = !!input.enableWrites;
      // REST-track material. Each is written only when supplied, so a reconnect
      // that changes just the host doesn't silently wipe the credentials or the
      // discovered route map already on the row.
      const apiMaterial = {
        ...(input.apiCredentials
          ? { apiCredentialsEnc: encodeApiCredentials(input.apiCredentials) }
          : {}),
        ...(input.apiRouteMap !== undefined
          ? { apiRouteMap: input.apiRouteMap as Prisma.InputJsonValue }
          : {}),
        ...(input.apiCaCert !== undefined ? { apiCaCert: input.apiCaCert } : {}),
      };
      const base = existing
        ? await prisma.integrationConnection.update({
            where: { id: existing.id },
            data: {
              host: input.host,
              port: input.port ?? null,
              databaseName,
              secretRef,
              writeEnabled,
              status: "PROVISIONING",
              ...apiMaterial,
            },
          })
        : await prisma.integrationConnection.create({
            data: {
              provider,
              status: "PROVISIONING",
              host: input.host,
              port: input.port ?? null,
              databaseName,
              // POINTER only — see module docstring / invariant 10.
              secretRef,
              writeEnabled,
              ...apiMaterial,
            },
          });

      /**
       * WARP-2283 — the consent record.
       *
       * `connect()` persists a customer's encrypted credentials and, until this
       * story, wrote NO activity row at all: the moment a credential entered
       * the box was the one moment nothing observed. ADR-041 §2 makes
       * connecting itself the consent event, so this is a compliance gap, not a
       * nicety.
       *
       * Emitted from ONE place covering all three outcomes — CONNECTED, blocked
       * (row stays PROVISIONING) and ERROR — because all three persisted the
       * credential; only an exception before this point writes nothing, which
       * is correct, since nothing was stored. Rows are written and the outcome
       * is known, so it is after the effect, never a prediction of it.
       */
      const auditConnect = async (detail: IntegrationDetail): Promise<IntegrationDetail> => {
        await recordActivity({
          kind: "system",
          severity: detail.status === "ERROR" ? "warn" : "info",
          sourceIcon: "plug",
          what: "Integration connected",
          sub: provider,
          actor: ctx?.actor ?? { type: "system", id: null },
          refs: {
            provider,
            status: detail.status,
            writeEnabled,
            // WHETHER credentials were supplied — never the credentials. The
            // triple is already sealed into `apiCredentialsEnc`; a second copy
            // in an append-only, exportable audit row would be a durable
            // cleartext leak that no rotation could recall.
            hasSecret: input.apiCredentials !== undefined,
          },
        });
        return detail;
      };

      const connector = connectorFor(provider, input);
      /**
       * WARP-2466 — cloud tracks are PROBED; LAN tracks are not.
       *
       * The split is the descriptor's `track`, not a vendor comparison, and it
       * is load-bearing in both directions.
       *
       * A LAN track that raises `ConnectorBlockedError` has not been probed at
       * all: the SQL driver or the discovered route map is absent, nothing was
       * dialed, and the row genuinely is mid-provisioning. Leaving it at
       * PROVISIONING is the honest answer and is what the branch below has
       * always done.
       *
       * A CLOUD track is the case WARP-2275's implementer flagged — "the state
       * mapping and NEEDS_RECONNECT are implemented and tested; no prober
       * drives them" — where a freshly pasted key sat at PROVISIONING forever
       * because nothing ever asked the vendor whether it worked. Here the probe
       * completes, so the row MUST move: `statusAfterHealthProbe` has no input
       * that yields PROVISIONING, which makes that a property of the code
       * rather than a rule this call site has to remember.
       */
      const isCloudTrack = providerDescriptor(provider)?.track === "cloud";
      try {
        await connector.connect();
        await connector.introspect();
        // The probe itself. Rejecting rather than returning `{ ok: false }` is
        // the connectors' blocked-boundary contract — a caller that ignores a
        // return value cannot ignore a rejection — so a successful call here
        // IS the evidence the credential works.
        await connector.health();
        const connected = await prisma.integrationConnection.update({
          where: { id: base.id },
          data: { status: statusAfterHealthProbe(), lastHealthyAt: new Date() },
        });
        return await auditConnect(toDetail(connected));
      } catch (err) {
        if (err instanceof ConnectorBlockedError && !isCloudTrack) {
          // HONEST degradation: the connector can't reach the ERP yet (SQL:
          // driver + copy DB absent; API: vendor creds + discovered /help routes
          // absent). We do NOT fake CONNECTED — the row stays PROVISIONING so
          // the dashboard shows the truth ("connecting").
          logger.info(
            { provider },
            "connect blocked: connector not reachable / not yet wired; status stays PROVISIONING",
          );
          return await auditConnect(toDetail(base));
        }
        if (isCloudTrack) {
          // Classified, never guessed. A reauthorize-class rejection becomes
          // NEEDS_RECONNECT so the owner is told to paste a new key; a throttle
          // becomes DEGRADED so they are not; an access-policy or plan refusal
          // becomes ERROR because a new key would not fix it. The classifier
          // has no branch that can return CONNECTED.
          const status = statusAfterHealthProbe(err);
          logger.info({ provider, status }, "cloud connect probe failed; status classified");
          const probed = await prisma.integrationConnection.update({
            where: { id: base.id },
            data: { status },
          });
          return await auditConnect(toDetail(probed));
        }
        // A genuine, unexpected failure on a LAN track → explicit ERROR status.
        logger.error({ err }, "eaglesoft connect failed");
        const errored = await prisma.integrationConnection.update({
          where: { id: base.id },
          data: { status: "ERROR" },
        });
        return await auditConnect(toDetail(errored));
      } finally {
        await connector.close().catch(() => {});
      }
    },

    async test(input) {
      const provider = resolveProvider(input.provider);
      const connector = connectorFor(provider, input);
      try {
        await connector.connect();
        await connector.health();
        return { ok: true, message: "reachable" };
      } catch (err) {
        if (err instanceof ConnectorBlockedError) {
          return {
            ok: false,
            reason: "ERP_NOT_CONNECTED",
            // Provider-accurate reason, taken from the error the connector
            // actually raised rather than re-derived from the provider key.
            // Each track carries its own remediation constant (SQL_TRACK_*,
            // API_TRACK_*, EXPORT_DROP_TRACK_*), so this stays correct when a
            // track is added — the two-way ternary that used to live here told
            // export-drop installers to go license a SAP driver, on the one
            // track that needs no driver at all (WARP-1964).
            message: `not connected: ${err.remediation}`,
          };
        }
        return {
          ok: false,
          reason: "ERROR",
          message: err instanceof Error ? err.message : "connection test failed",
        };
      } finally {
        await connector.close().catch(() => {});
      }
    },

    async setWriteEnabled(enabled, ctx) {
      const row = await findRow();
      if (!row) throw ErpError.notConfigured(EAGLESOFT_PROVIDER);

      const updated = await prisma.integrationConnection.update({
        where: { id: row.id },
        data: { writeEnabled: enabled },
      });

      // Append-only audit of the opt-in flip (invariant 11 / §14). The kill-
      // switch is a security-relevant event; who flipped it is recorded.
      await prisma.erpAuditLog.create({
        data: {
          connectionId: row.id,
          actor: ctx.actor,
          action: enabled ? "write-enable" : "write-disable",
          entity: "integration",
          scope: { provider: EAGLESOFT_PROVIDER, writeEnabled: enabled },
        },
      });

      return toDetail(updated);
    },

    /**
     * Disconnect the connection and PURGE what it was holding.
     *
     * ADR-041 §2 is explicit that this is not a flag flip: *"Disconnecting must
     * be equally real: it revokes and purges the stored tokens, not merely
     * flips a flag."* Until WARP-2453 this function wrote
     * `{ status: "DISABLED", writeEnabled: false }` and nothing else, so an
     * owner who clicked Disconnect got a row that READ as disconnected while
     * `apiCredentialsEnc` and `providerTokensEnc` stayed decryptable in
     * Postgres — and ADR-042 §6 notes these credentials mostly never expire, so
     * "indefinitely" is the literal duration. `m365-auth.service.ts`
     * `disconnect()` is the same operation done correctly and is the shape
     * copied here.
     *
     * Everything describing THIS connection's identity or secrets goes: both
     * credential columns, the provider config, the discovered route map, the
     * pinned CA, the introspected schema fingerprint, and the last-healthy
     * timestamp (a freshness claim about data we can no longer fetch).
     *
     * The ROW stays, with its explicit `DISABLED` status and its `provider`.
     * Deleting it would make "disconnected" something a later reader infers
     * from absence, which is exactly what the enum column exists to prevent.
     *
     * ONE `update`, not two. A crash between a status flip and a separate purge
     * would leave a row reading DISABLED while still holding a live credential
     * — precisely the lie being fixed, made durable.
     *
     * What this does NOT do: revoke at the vendor. We cannot rotate what we did
     * not mint (ADR-042 §6); the customer revokes in their own console and the
     * setup guides say so. And it does not touch `secretRef` — ADR-041 §4
     * forbids becoming the unimplemented secret store's first writer
     * (WARP-2028), and the column is a non-null pending pointer regardless.
     */
    async disconnect(ctx) {
      const row = await findRow();
      if (!row) return toDetail(null); // idempotent — nothing to disconnect
      const updated = await prisma.integrationConnection.update({
        where: { id: row.id },
        data: {
          status: "DISABLED",
          writeEnabled: false,
          // --- the purge, in the SAME write as the status flip -------------
          apiCredentialsEnc: null,
          providerTokensEnc: null,
          providerConfig: Prisma.DbNull,
          apiRouteMap: Prisma.DbNull,
          apiCaCert: null,
          schemaHash: null,
          schemaVersion: null,
          lastHealthyAt: null,
        },
      });
      await prisma.erpAuditLog.create({
        data: {
          connectionId: row.id,
          actor: ctx.actor,
          action: "disconnect",
          entity: "integration",
          // `purged` is a literal, not a computed flag: the very `update` above
          // is what nulls the columns, so re-deriving it here would only be
          // this function checking its own arithmetic. The marker exists so an
          // auditor can tell a disconnect that purged from one written by a
          // build that did not. It is a BOOLEAN and nothing else — the values
          // never appear, because an append-only, exportable audit row is the
          // worst possible second home for a credential (rule 19).
          scope: { provider: EAGLESOFT_PROVIDER, purged: true },
        },
      });
      return toDetail(updated);
    },
  };
}
