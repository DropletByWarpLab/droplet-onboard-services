/**
 * erp.service — the ERP read + write-request control plane (WARP-1137,
 * EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF §11, §13, §14).
 *
 * The orchestrator half of the walking skeleton: the dashboard's `/api/erp/*`
 * calls land here, this calls the `erp-connector`, the connector (in this
 * DB-independent slice) rejects every live SQL path with `ConnectorBlockedError`.
 *
 * HONEST DEGRADATION (WARP-1137 scope boundary): a blocked connector NEVER
 * fabricates PHI. Reads return `{ connected: false, reason: "ERP_NOT_CONNECTED",
 * <empty> }`; a write that can't apply is recorded `FAILED`, never a fake
 * `APPLIED`. The live SQL Anywhere path is a later, copy-DB-gated ticket
 * (WARP-1095+); wiring it only replaces the connector's stubbed methods.
 *
 * HARD RULES honored here:
 *  • Explicit-enum write-request lifecycle — every transition is an explicit
 *    `WriteStatus` value, never derived from absence (invariant 7 / WARP-218).
 *  • A write is staged, then human-confirmed, then applied (brief §11.1). Intent
 *    (`createWriteRequest`) touches nothing in Eaglesoft.
 *  • RBAC / PHI minimum-necessary (§14): reads gated to PHI roles, writes to
 *    owner/admin. Every read AND every write transition writes an append-only
 *    `ErpAuditLog` row whose `scope` carries only non-PHI tokens (table, count,
 *    internal ids) — never names/DOB/notes.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ConnectorBlockedError,
  WRITE_COMMANDS,
  scheduleDayBounds,
  type Connector,
} from "@droplet/erp-connector";
import { createLogger } from "../lib/logger.js";
import { ErpError } from "./erp-error.js";
import { connectorForProvider, EAGLESOFT_PROVIDER } from "./erp-provider.js";

const logger = createLogger("erp-service");

/** Roles allowed to view PHI (schedule/patients/AR/recall) — minimum-necessary.
 *  Clinical staff only. NOT the household-default `family` role: roleFromGroups
 *  assigns `family` to any un-grouped account, so admitting it here would make
 *  patient PHI readable by default (fail-open). Non-clinical roles get the lock.
 *
 *  WARP-1530 (ADR-032 §8 O-2) deliberately does NOT add `family` to this set.
 *  A family person reaches PHI only by arriving with a RESOLVED
 *  `AccessRoleConnectorGrant` (`ErpUser.connectorLevel`), which the route gate
 *  reads from the effective-access resolver. Keeping the tier set narrow means
 *  the fail-open case — a future route registered without the gate — still
 *  cannot hand patient data to the household default. */
const PHI_READ_ROLES = new Set(["owner", "admin"]);
/** Roles that may hold a connector grant at all — O-2's "family-and-up". */
const GRANTABLE_PHI_READ_ROLES = new Set(["family"]);
/** Roles allowed to stage/confirm a write back into Eaglesoft. Admin-tier only
 *  — O-2 leaves this exactly as it was; a connector grant never widens it. */
const WRITE_ROLES = new Set(["owner", "admin"]);
/** The registered write-command names — the validation allow-list (brief §11.3). */
const WRITE_COMMAND_NAMES = new Set(WRITE_COMMANDS.map((c) => c.name));

export interface ErpUser {
  id: string;
  role: string;
  /**
   * WARP-1530 — the person's RESOLVED connector reach for this provider, as
   * the effective-access resolver computed it
   * (`min(roleConnectorGrant, connection.writeEnabled ? read_write : read)`).
   * Set by the route's O-2 gate; `null`/absent means "no grant", which is
   * every caller that predates RBAC v2. Read-side only: writes stay
   * admin-tier, so this never widens `assertCanWrite`.
   */
  connectorLevel?: "read" | "read_write" | null;
  /**
   * WARP-1579 — the RAW role connector grant for this provider, BEFORE the
   * `min()` against `connection.writeEnabled`. Set by the route's write gate.
   *
   * `connectorLevel` cannot stand in for it: `read` there is ambiguous
   * between a read-only ROLE (a 403) and a write-disabled CONNECTION (today's
   * honest 409 `WRITE_NOT_ENABLED`).
   *
   * `null`/absent = **no role grant narrows this person** — every caller that
   * predates RBAC v2 and every role-less admin. Absence is NOT a denial; only
   * an explicit `read` refuses. This never WIDENS `assertCanWrite` either:
   * the admin-tier floor above it is unchanged.
   */
  connectorGrantLevel?: "read" | "read_write" | null;
}

export interface ScheduleResult {
  connected: boolean;
  reason?: string;
  date: string;
  items: unknown[];
}
export interface PatientsResult {
  connected: boolean;
  reason?: string;
  items: unknown[];
}
export interface PatientResult {
  connected: boolean;
  reason?: string;
  patient: unknown | null;
}
export interface ArSummaryResult {
  connected: boolean;
  reason?: string;
  totalBalance: number | null;
  accountCount: number | null;
}
export interface RecallResult {
  connected: boolean;
  reason?: string;
  items: unknown[];
}

export interface CreateWriteRequestInput {
  command: string;
  params: Record<string, unknown>;
}

type ErpPrisma = Pick<
  PrismaClient,
  "integrationConnection" | "erpWriteRequest" | "erpAuditLog"
>;
type ConnRow = NonNullable<
  Awaited<ReturnType<ErpPrisma["integrationConnection"]["findFirst"]>>
>;
type WriteRequestRow = Awaited<
  ReturnType<ErpPrisma["erpWriteRequest"]["findUnique"]>
>;

/** Dependency seam so tests inject a stubbed connector. */
export interface ErpServiceDeps {
  connectorFor?: (conn: ConnRow) => Connector;
}

function defaultConnectorFor(conn: ConnRow): Connector {
  // Dual-track: build the connector for the row's persisted provider
  // ("eaglesoft" → SQL Anywhere, "eaglesoft-api" → Patterson REST API). NOTE:
  // eaglesoftRow() below currently resolves only the SQL "eaglesoft" row, so the
  // "eaglesoft-api" branch is exercised by the factory tests today and reached
  // from this call site once row-resolution is generalized to the API provider
  // (a follow-up, with the live API read path). The pointer-only secretRef is
  // dereferenced inside the connector (brief §7.4).
  return connectorForProvider({
    provider: conn.provider,
    host: conn.host ?? "",
    databaseName: conn.databaseName ?? undefined,
    secretRef: conn.secretRef ?? undefined,
  });
}

export interface ErpService {
  getSchedule(input: { date: string }, user: ErpUser): Promise<ScheduleResult>;
  searchPatients(input: { query: string }, user: ErpUser): Promise<PatientsResult>;
  getPatient(patientId: string, user: ErpUser): Promise<PatientResult>;
  getArSummary(user: ErpUser): Promise<ArSummaryResult>;
  getRecallDue(user: ErpUser): Promise<RecallResult>;
  createWriteRequest(
    input: CreateWriteRequestInput,
    user: ErpUser,
  ): Promise<NonNullable<WriteRequestRow>>;
  confirmWriteRequest(
    id: string,
    user: ErpUser,
  ): Promise<NonNullable<WriteRequestRow>>;
  getWriteRequest(
    id: string,
    user: ErpUser,
  ): Promise<NonNullable<WriteRequestRow>>;
}

export function createErpService(
  prisma: ErpPrisma,
  deps: ErpServiceDeps = {},
): ErpService {
  const connectorFor = deps.connectorFor ?? defaultConnectorFor;

  async function eaglesoftRow(): Promise<ConnRow | null> {
    return prisma.integrationConnection.findFirst({
      where: { provider: EAGLESOFT_PROVIDER },
    }) as Promise<ConnRow | null>;
  }

  function assertCanReadPhi(user: ErpUser): void {
    if (PHI_READ_ROLES.has(user.role)) return;
    // O-2: family-and-up WITH a grant. The tier check and the grant check are
    // both required — a grant on a guest is not reach, and a family tier
    // without one is today's denial.
    if (GRANTABLE_PHI_READ_ROLES.has(user.role) && user.connectorLevel) return;
    throw ErpError.forbidden();
  }
  function assertCanWrite(user: ErpUser): void {
    if (!WRITE_ROLES.has(user.role)) throw ErpError.forbidden();
    // WARP-1579 — the tier is necessary, not sufficient. An Admin-based role
    // may hold a deliberately READ-ONLY connector grant, and a grant level the
    // enforcement ignores is a false statement in the admin UI.
    //
    // SCOPE, honestly: this is a second line under `erpConnectorWriteGate`,
    // not an independent one. `connectorGrantLevel` is populated BY that gate,
    // so a future route registered WITHOUT it arrives here with the field
    // absent and this check cannot fire — the gate is the enforcement point,
    // and a new write route must register it. What this does catch is the
    // gate being kept but its refusal weakened, and any future caller that
    // resolves the grant itself and threads it in. (`assertCanReadPhi` has the
    // same shape and the same limit — `connectorLevel` likewise comes from the
    // read gate.) Kept because it costs nothing and pins the level's meaning
    // at the layer that owns the write.
    //
    // Only an EXPLICIT `read` refuses. Absent = nothing narrows (today's
    // world). Owner is never narrowed (§3's one bypass) — `assertCanReadPhi`
    // admits owner unconditionally too, and an owner locked out of their own
    // ERP by a stray grant row would be worse than the bug being fixed.
    if (user.role !== "owner" && user.connectorGrantLevel === "read") {
      throw ErpError.forbidden(
        "forbidden: this role's connector grant for the ERP integration is read-only",
      );
    }
  }

  /** Append-only audit (§14). `scope` MUST be PHI-free — tokens/ids only. */
  async function audit(
    conn: ConnRow | null,
    actor: string,
    action: string,
    scope: Prisma.InputJsonValue,
  ): Promise<void> {
    await prisma.erpAuditLog.create({
      data: {
        connectionId: conn?.id ?? EAGLESOFT_PROVIDER,
        actor,
        action,
        entity: "erp",
        scope,
      },
    });
  }

  /** Attempt a named read; degrade honestly when the connector is blocked. */
  async function runReadOrBlocked(
    conn: ConnRow | null,
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ connected: boolean; reason?: string; rows: unknown[] }> {
    if (!conn) return { connected: false, reason: "NOT_CONFIGURED", rows: [] };
    const connector = connectorFor(conn);
    try {
      const rows = await connector.runRead(name, params);
      return { connected: true, rows };
    } catch (err) {
      if (err instanceof ConnectorBlockedError) {
        return { connected: false, reason: "ERP_NOT_CONNECTED", rows: [] };
      }
      logger.error({ err, query: name }, "erp read failed");
      return { connected: false, reason: "ERROR", rows: [] };
    } finally {
      await connector.close().catch(() => {});
    }
  }

  return {
    async getSchedule({ date }, user) {
      assertCanReadPhi(user);
      const conn = await eaglesoftRow();
      const r = await runReadOrBlocked(conn, "get_schedule_today", scheduleDayBounds(date));
      await audit(conn, user.id, "read:schedule", { date });
      return { connected: r.connected, reason: r.reason, date, items: r.rows };
    },

    async searchPatients({ query }, user) {
      assertCanReadPhi(user);
      // Reject empty/too-short terms so the query builder can never emit a
      // match-all LIKE '%' that dumps the whole patient table (PHI over-fetch).
      const term = query.trim();
      if (term.length < 2) {
        throw ErpError.validation("patient search term must be at least 2 characters");
      }
      const conn = await eaglesoftRow();
      const r = await runReadOrBlocked(conn, "find_patient", { query: term });
      // The raw search term can contain a name → keep it OUT of the audit scope
      // (redaction contract, review D-1). Length only.
      await audit(conn, user.id, "read:patients", { termLength: term.length });
      return { connected: r.connected, reason: r.reason, items: r.rows };
    },

    async getPatient(patientId, user) {
      assertCanReadPhi(user);
      const conn = await eaglesoftRow();
      const r = await runReadOrBlocked(conn, "get_patient", { patientId });
      // patientId is an internal key (not a name/DOB) → allowed in scope (§14).
      await audit(conn, user.id, "read:patient", { patientId });
      const patient = r.connected && r.rows.length > 0 ? r.rows[0] : null;
      return { connected: r.connected, reason: r.reason, patient };
    },

    async getArSummary(user) {
      assertCanReadPhi(user);
      const conn = await eaglesoftRow();
      const r = await runReadOrBlocked(conn, "get_ar_summary", {});
      await audit(conn, user.id, "read:ar-summary", {});
      const row =
        r.connected && r.rows.length > 0
          ? (r.rows[0] as { total_balance?: number; account_count?: number })
          : null;
      return {
        connected: r.connected,
        reason: r.reason,
        totalBalance: row?.total_balance ?? null,
        accountCount: row?.account_count ?? null,
      };
    },

    async getRecallDue(user) {
      assertCanReadPhi(user);
      const conn = await eaglesoftRow();
      const r = await runReadOrBlocked(conn, "get_recall_due", {});
      await audit(conn, user.id, "read:recall-due", {});
      return { connected: r.connected, reason: r.reason, items: r.rows };
    },

    async createWriteRequest({ command, params }, user) {
      assertCanWrite(user);
      const conn = await eaglesoftRow();
      if (!conn) throw ErpError.notConfigured(EAGLESOFT_PROVIDER);
      // Per-practice opt-in gate FIRST (invariant 1): a valid command with
      // writes off is still refused.
      if (!conn.writeEnabled) throw ErpError.writeNotEnabled();
      if (!WRITE_COMMAND_NAMES.has(command)) {
        throw ErpError.validation(`unknown write command "${command}"`);
      }
      // Stage the intent only — nothing touches Eaglesoft until a human
      // confirms (brief §11.1 step 1). The connector is not even built here.
      const row = await prisma.erpWriteRequest.create({
        data: {
          connectionId: conn.id,
          command,
          params: params as Prisma.InputJsonValue,
          status: "PENDING_CONFIRMATION",
          requestedBy: user.id,
        },
      });
      await audit(conn, user.id, "write:request", {
        command,
        requestId: row.id,
      });
      return row;
    },

    async confirmWriteRequest(id, user) {
      assertCanWrite(user);
      const existing = await prisma.erpWriteRequest.findUnique({ where: { id } });
      if (!existing) throw ErpError.notFound("write request");
      // No double-apply: only a still-pending request can be confirmed.
      if (existing.status !== "PENDING_CONFIRMATION") {
        throw ErpError.invalidState(existing.status, "confirm");
      }

      const conn = await eaglesoftRow();
      // Re-check the connection + the per-practice write kill-switch at APPLY
      // time (invariant 1) — the request may have been staged before writes
      // were turned off, or the connection removed. Guard BEFORE the APPLYING
      // transition so neither case can strand the request (clean 409 instead).
      if (!conn) throw ErpError.notConfigured(EAGLESOFT_PROVIDER);
      if (!conn.writeEnabled) throw ErpError.writeNotEnabled();
      // Human confirmation recorded (brief §11.1 step 2). Move to APPLYING.
      await prisma.erpWriteRequest.update({
        where: { id },
        data: { status: "APPLYING", confirmedBy: user.id },
      });
      await audit(conn, user.id, "write:confirm", {
        requestId: id,
        command: existing.command,
      });

      // Apply inside the connector's own transaction (brief §11.1 step 3). The
      // connector manages its connection; in this slice applyWrite is stubbed
      // and rejects blocked → we record FAILED, never a fake APPLIED.
      const connector = connectorFor(conn as ConnRow);
      let status: "APPLIED" | "FAILED" = "FAILED";
      let discrepancy: Prisma.InputJsonValue | null = null;
      try {
        await connector.applyWrite(
          existing.command,
          existing.params as Record<string, unknown>,
        );
        // A verify-read (brief §11.1 step 4) lands with the live path; a clean
        // apply maps to APPLIED here.
        status = "APPLIED";
      } catch (err) {
        if (err instanceof ConnectorBlockedError) {
          logger.info(
            { requestId: id },
            "write apply blocked (DB-independent slice) — recorded FAILED, never fake APPLIED",
          );
        } else {
          logger.error({ err, requestId: id }, "write apply failed");
          discrepancy = {
            message: err instanceof Error ? err.message : String(err),
          };
        }
      } finally {
        await connector.close().catch(() => {});
      }

      const updated = await prisma.erpWriteRequest.update({
        where: { id },
        data: {
          status,
          confirmedBy: user.id,
          discrepancy: discrepancy === null ? Prisma.JsonNull : discrepancy,
        },
      });
      await audit(conn, user.id, "write:apply-result", {
        requestId: id,
        status,
      });
      return updated;
    },

    async getWriteRequest(id, user) {
      assertCanWrite(user);
      const row = await prisma.erpWriteRequest.findUnique({ where: { id } });
      if (!row) throw ErpError.notFound("write request");
      return row;
    },
  };
}
