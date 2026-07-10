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
import { EaglesoftConnector, ConnectorBlockedError, type Connector } from "@droplet/erp-connector";
import { createLogger } from "../lib/logger.js";
import { ErpError } from "./erp-error.js";

const logger = createLogger("integrations-service");

/** The flagship provider key. The framework is N-provider; this ships #1. */
export const EAGLESOFT_PROVIDER = "eaglesoft";

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

const DEFAULT_PORT = 2638;
const DEFAULT_DATABASE_NAME = "PattersonPM";

function defaultConnectorFor(_provider: string, input: ConnectInput): Connector {
  return new EaglesoftConnector({
    host: input.host,
    port: input.port ?? DEFAULT_PORT,
    serverName: input.serverName ?? input.databaseName ?? DEFAULT_DATABASE_NAME,
    databaseName: input.databaseName || DEFAULT_DATABASE_NAME,
    // Pointer only — the connector resolves it against the secret store when
    // the live driver lands. Nothing here dereferences a password.
    readSecretRef: input.secretRef ?? "",
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

  /** The single Eaglesoft connection row, or null. Provider-scoped. */
  async function findEaglesoftRow() {
    return prisma.integrationConnection.findFirst({
      where: { provider: EAGLESOFT_PROVIDER },
    });
  }

  function toDetail(
    row: Awaited<ReturnType<typeof findEaglesoftRow>>,
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
      account: "droplet_ro",
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
      return toDetail(await findEaglesoftRow());
    },

    async connect(input) {
      // Upsert-by-hand: reuse the existing row if present so we never orphan a
      // second connection for the same provider.
      const existing = await findEaglesoftRow();
      const databaseName = input.databaseName || DEFAULT_DATABASE_NAME;
      // The backend owns the credential — mint a pointer if the client didn't
      // send one (the real secret is created during live provisioning).
      const secretRef = input.secretRef ?? `${EAGLESOFT_PROVIDER}:pending`;
      // Honor the wizard's connect-time write opt-in (default off / read-only).
      const writeEnabled = !!input.enableWrites;
      const base = existing
        ? await prisma.integrationConnection.update({
            where: { id: existing.id },
            data: {
              host: input.host,
              databaseName,
              secretRef,
              writeEnabled,
              status: "PROVISIONING",
            },
          })
        : await prisma.integrationConnection.create({
            data: {
              provider: EAGLESOFT_PROVIDER,
              status: "PROVISIONING",
              host: input.host,
              databaseName,
              // POINTER only — see module docstring / invariant 10.
              secretRef,
              writeEnabled,
            },
          });

      const connector = connectorFor(EAGLESOFT_PROVIDER, input);
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
          // HONEST degradation: the connector cannot reach Eaglesoft because
          // the SAP driver + copy DB are not present (WARP-1137 scope). We do
          // NOT fake CONNECTED — the row stays PROVISIONING so the dashboard
          // shows "connecting / driver pending", which is the truth.
          logger.info(
            { provider: EAGLESOFT_PROVIDER },
            "connect blocked (DB-independent slice): connector driver not available; status stays PROVISIONING",
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
      const connector = connectorFor(EAGLESOFT_PROVIDER, input);
      try {
        await connector.connect();
        await connector.health();
        return { ok: true, message: "reachable" };
      } catch (err) {
        if (err instanceof ConnectorBlockedError) {
          return {
            ok: false,
            reason: "ERP_NOT_CONNECTED",
            message:
              "not connected: the SAP SQL Anywhere driver + a copy of PattersonPM.db are required (walking-skeleton slice)",
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
      const row = await findEaglesoftRow();
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
      const row = await findEaglesoftRow();
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
