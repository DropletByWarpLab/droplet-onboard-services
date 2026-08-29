/**
 * Types for the ERP / Integrations surfaces (WARP-1101, epic WARP-1093).
 *
 * These mirror the orchestrator API shapes from the architecture brief
 * (EAGLESOFT-INTEGRATION-ARCHITECTURE-BRIEF.md §12/§13). The dashboard is the
 * read-side of a connector framework whose first provider is Eaglesoft — the
 * Patterson dental PMS Droplet reads directly over its SQL Anywhere database,
 * on the LAN. Every value that represents a record (money, counts, times,
 * host/IP, chart numbers, schema version) is rendered mono + read-only.
 */

/** Explicit connection lifecycle — never derived from absence (arch rule 10). */
export type IntegrationStatus =
  | "NOT_CONFIGURED"
  | "PROVISIONING"
  | "CONNECTED"
  | "DEGRADED"
  | "DRIFT_LOCKED"
  | "ERROR"
  | "DISABLED";

/** Providers the hub knows about. Eaglesoft ships first; the rest are the
 *  framework placeholders that make the hub read as N-provider, not one-off. */
export type ConnectorId = "eaglesoft" | "dentrix" | "opendental" | "quickbooks";

export type ConnectorAvailability = "available" | "coming-soon";

export interface ConnectorMeta {
  /**
   * The tile's identity. Usually a {@link ConnectorId} from the catalog, but
   * the hub also renders tiles for providers the box reports that the catalog
   * does not list — `<vendor>-export` keys, M365, anything a newer box adds
   * (WARP-2291). Narrowing this back to `ConnectorId` would make those
   * connections unrepresentable, which is how they came to be dropped.
   */
  id: string;
  name: string;
  /** e.g. "Practice management", "Accounting". */
  category: string;
  /** One line: what connecting it does. */
  description: string;
  availability: ConnectorAvailability;
  /**
   * WARP-2342 — where the customer reads how to produce this provider's
   * credential, carried through from the shared descriptor's catalog block.
   *
   * Rendered on the tile AND at the wizard's credential step, because a guide
   * the customer cannot find is a guide they will not read. Optional HERE
   * because the field is only *required* of a cloud track whose card is
   * `available` — the descriptor type enforces that at the declaration site
   * (`CloudProviderCatalogMeta`), which is the only place that can.
   */
  setupGuideHref?: string;
}

/** Resting write posture shown on the ERP hero. Read-only is the safe default. */
export type WriteMode = "read-only" | "writes-enabled" | "writes-paused";

export interface IntegrationConnection {
  /**
   * The orchestrator's provider key, verbatim — free-form TEXT on
   * `IntegrationConnection.provider` (`erp-provider.ts`), NOT a catalog id.
   * `eaglesoft` is the only value that is byte-equal to a {@link ConnectorId};
   * `eaglesoft-api`, `quickbooks-online`, `dentrix-ascend` and every
   * `<vendor>-export` key are not. Typing this as `ConnectorId` was the lie
   * that made the hub's `byId.get(meta.id)` join look correct (WARP-2291).
   */
  provider: string;
  status: IntegrationStatus;
  /** Eaglesoft server host/IP (mono). */
  host?: string;
  /** Always "PattersonPM" for Eaglesoft (mono). */
  databaseName?: string;
  /** Discovered Eaglesoft/engine version, e.g. "Eaglesoft 21" (mono). */
  schemaVersion?: string;
  /** The dedicated read account, e.g. "droplet_ro" (mono). */
  account?: string;
  writeEnabled: boolean;
  /** True when a schema-drift lock has paused writes after an Eaglesoft upgrade. */
  writesPaused?: boolean;
  /** ISO — last successful read. */
  lastSyncedAt?: string;
  /** ISO — next scheduled sync. */
  nextSyncAt?: string;
  /** One-line human reason for a degraded / error / drift state. */
  reason?: string;
  /**
   * WARP-2453 — for a `DISABLED` connection, whether the credential material
   * was actually removed from the row, or is still sitting there.
   *
   * The orchestrator derives it from two explicit persisted facts (the `status`
   * enum and whether either credential column holds a blob) and always emits
   * it, `false` included — see `integrations.service.ts:347-356`.
   *
   * OPTIONAL here on purpose. This interface is the dashboard's mirror of a
   * JSON payload, not the payload itself, and a response that does not carry
   * the key must not be read as either answer: `undefined` means "the box said
   * nothing about the credential", which is a third fact and is rendered as
   * neither "removed" nor "still stored" (WARP-2483). Making it required would
   * force every construction site to assert a purge state it does not know.
   *
   * Meaningless outside `DISABLED`, where it is `false` — nothing was purged
   * from a connection that is still connected, or was never configured.
   */
  credentialsPurged?: boolean;
}

export function writeModeOf(c: Pick<IntegrationConnection, "writeEnabled" | "writesPaused">): WriteMode {
  if (c.writesPaused) return "writes-paused";
  return c.writeEnabled ? "writes-enabled" : "read-only";
}

export interface ErpKpis {
  appointmentsToday: number;
  /** Free chairs remaining this afternoon (optional context line). */
  openChairsPm?: number;
  productionTodayCents: number;
  arBalanceCents: number;
  recallDue: number;
}

export type AppointmentStatus =
  | "scheduled"
  | "checked-in"
  | "complete"
  | "cancelled";

export interface ScheduleEntry {
  id: string;
  /** ISO datetime of the appointment start. */
  startsAt: string;
  patientId: string;
  patientName: string;
  provider: string;
  operatory: string;
  status: AppointmentStatus;
  /** Optional visit reason. */
  reason?: string;
}

export interface PatientResult {
  id: string;
  name: string;
  /** ISO date of birth. */
  dob: string;
  phone: string;
  balanceCents: number;
  /** Eaglesoft chart / account number (mono). */
  chartNumber?: string;
}

export interface PatientSummary extends PatientResult {
  /** ISO. */
  lastVisit?: string;
  /** ISO. */
  nextVisit?: string;
  preferredProvider?: string;
}

/** The dashboard detail endpoint returns the connection plus, when connected,
 *  the at-a-glance snapshot the ERP surface renders. */
export interface EaglesoftDetail {
  connection: IntegrationConnection;
  kpis?: ErpKpis;
  schedule?: ScheduleEntry[];
}

/** What the current dashboard user is allowed to see/do with the ERP.
 *  PHI is minimum-necessary + RBAC-gated (arch §14). */
export interface ErpAccess {
  canViewPhi: boolean;
  canEnableWrites: boolean;
  canConfirmWrites: boolean;
}

/**
 * Input the connect wizard collects before provisioning, for ANY LAN-database
 * track (WARP-2451).
 *
 * `scopes` is `string[]` rather than `ErpScope[]` on purpose: the wizard reads
 * the offered scopes off the provider descriptor, which lives in
 * `@droplet/shared-types` and cannot import this union. The correspondence is
 * PINNED by a test (`connectors.test.ts`) instead of asserted by a cast —
 * "types can lie" is the wave-1 lesson this follows.
 */
export interface LanConnectInput {
  host: string;
  port: number;
  scopes: string[];
  enableWrites: boolean;
}

export type ErpScope =
  | "schedule"
  | "patients"
  | "providers"
  | "financials"
  | "recall";

/** A staged write (outbox) — created, then human-confirmed, then applied.
 *  The UI never writes to Eaglesoft directly; it creates a request. */
export type WriteRequestStatus =
  | "PENDING_CONFIRMATION"
  | "CONFIRMED"
  | "APPLYING"
  | "APPLIED"
  | "DISCREPANCY"
  | "FAILED"
  | "REVERSED"
  | "REJECTED";

export interface AppointmentWriteRequest {
  id?: string;
  command: "erp_schedule_appointment" | "erp_reschedule_appointment";
  patientName: string;
  provider: string;
  operatory: string;
  /** ISO datetime. */
  startsAt: string;
  reason?: string;
  /** For a reschedule, the prior slot (before → after). */
  previousStartsAt?: string;
  status?: WriteRequestStatus;
}
