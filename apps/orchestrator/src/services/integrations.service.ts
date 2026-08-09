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
import type { Prisma, PrismaClient } from "@prisma/client";
import { ConnectorBlockedError, type Connector } from "@droplet/erp-connector";
import { createLogger } from "../lib/logger.js";
import { ErpError } from "./erp-error.js";
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
  | "ERROR"
  | "DISABLED";

/** Hub row (brief §13 `GET /api/integrations`). No PHI, no secret. */
export interface IntegrationSummary {
  provider: string;
  status: IntegrationStatusName;
  configured: boolean;
  writeEnabled: boolean;
}

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
type IntegrationsPrisma = Pick<PrismaClient, "integrationConnection" | "erpAuditLog">;

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

export interface IntegrationsService {
  list(): Promise<IntegrationSummary[]>;
  getEaglesoft(): Promise<IntegrationDetail>;
  connect(input: ConnectInput): Promise<IntegrationDetail>;
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

  function toDetail(
    row: Awaited<ReturnType<typeof findRow>>,
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
    };
  }

  return {
    async list() {
      const rows = await prisma.integrationConnection.findMany();
      const byProvider = new Map(rows.map((r) => [r.provider, r]));
      // The framework knows about Eaglesoft even before it is configured, so
      // the hub always lists it (explicit NOT_CONFIGURED when no row exists).
      const providers = new Set<string>([
        EAGLESOFT_PROVIDER,
        EAGLESOFT_API_PROVIDER,
        ...rows.map((r) => r.provider),
      ]);
      return Array.from(providers).map((provider) => {
        const row = byProvider.get(provider);
        return {
          provider,
          status: (row?.status as IntegrationStatusName) ?? "NOT_CONFIGURED",
          configured: !!row,
          writeEnabled: row?.writeEnabled ?? false,
        };
      });
    },

    async getEaglesoft() {
      return toDetail(await findRow());
    },

    async connect(input) {
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

      const connector = connectorFor(provider, input);
      try {
        await connector.connect();
        await connector.introspect();
        // The live path is unreachable in this slice, so this branch is not hit
        // today — but when the driver lands it flips the row to CONNECTED.
        const connected = await prisma.integrationConnection.update({
          where: { id: base.id },
          data: { status: "CONNECTED", lastHealthyAt: new Date() },
        });
        return toDetail(connected);
      } catch (err) {
        if (err instanceof ConnectorBlockedError) {
          // HONEST degradation: the connector can't reach the ERP yet (SQL:
          // driver + copy DB absent; API: vendor creds + discovered /help routes
          // absent). We do NOT fake CONNECTED — the row stays PROVISIONING so
          // the dashboard shows the truth ("connecting").
          logger.info(
            { provider },
            "connect blocked: connector not reachable / not yet wired; status stays PROVISIONING",
          );
          return toDetail(base);
        }
        // A genuine, unexpected failure → explicit ERROR status.
        logger.error({ err }, "eaglesoft connect failed");
        const errored = await prisma.integrationConnection.update({
          where: { id: base.id },
          data: { status: "ERROR" },
        });
        return toDetail(errored);
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
            // Provider-accurate reason: the SQL and API tracks are blocked on
            // different prerequisites, so don't tell an API operator they need
            // a SQL Anywhere driver.
            message:
              provider === EAGLESOFT_API_PROVIDER
                ? "not connected: Patterson vendor credentials + the discovered /help route map are required"
                : "not connected: the SAP SQL Anywhere driver + a copy of PattersonPM.db are required",
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

    async disconnect(ctx) {
      const row = await findRow();
      if (!row) return toDetail(null); // idempotent — nothing to disconnect
      const updated = await prisma.integrationConnection.update({
        where: { id: row.id },
        data: { status: "DISABLED", writeEnabled: false },
      });
      await prisma.erpAuditLog.create({
        data: {
          connectionId: row.id,
          actor: ctx.actor,
          action: "disconnect",
          entity: "integration",
          scope: { provider: EAGLESOFT_PROVIDER },
        },
      });
      return toDetail(updated);
    },
  };
}
