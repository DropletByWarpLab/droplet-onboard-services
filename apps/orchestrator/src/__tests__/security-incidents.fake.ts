/**
 * WARP-2978 — an in-memory stand-in for the Prisma delegates the incident
 * engine, the notifier, the incident actions and the incident routes use.
 * Shared by security-incidents.service.test.ts, security-alerts.service.test.ts
 * and security-incidents.routes.test.ts. Not a test file itself.
 *
 * What it models honestly (the P2b fake's contract, generalised):
 *   · Prisma's where language for what these files issue — equality, `in`,
 *     `notIn`, `not`, the comparisons (SQL NULL semantics: a NULL column
 *     matches no comparison), `has` / `hasSome`, `startsWith`, AND / OR / NOT,
 *     and relation filters (`is` / `isNot` / `some` / `none` / `every`, and a
 *     bare nested where on a to-one);
 *   · the unique indexes and primary keys (a duplicate throws P2002;
 *     `createMany({skipDuplicates})` skips it), `{increment}`, orderBy, take,
 *     and `select` / `include` of relations;
 *   · FKs on delete: Cascade and Restrict (a Restrict throws P2003);
 *   · the WARP-2978 CHECKs — and WARP-2980 PR-B's (20260925060100: the
 *     verdict shape, the pattern flag, expected activity, the per-day
 *     count) — mirrored in JS, on every write, so an engine bug that would
 *     violate one fails here the way Postgres would. Like Prisma
 *     on Postgres, a `create` that omits a scalar list stores NULL (and the
 *     CHECKs refuse a NULL list); seeded rows get empty lists;
 *   · TRANSACTIONS on the shared WARP-1570 seam (`createTransactionSeam`):
 *     `$transaction(fn, opts)` snapshots every table and restores them when
 *     the callback throws (re-applying any transaction that committed in the
 *     meantime), and a RepeatableRead / Serializable transaction that lost a
 *     write-conflict throws P2034. The isolation level asked for is recorded
 *     (`txLevels`).
 *
 * WARP-2980 PR-B adds the baseline tables the pattern rules read (a build,
 * its cells, the learning state per camera), the pattern flags, expected
 * activity and the per-day count, and a minimal `groupBy({by: [one column],
 * where, _count: {_all: true}})`.
 *
 * Concurrency, the real CHECK text, the trigger and the advisory locks are
 * the pg lane's job (security-incidents.pg.test.ts, security-pattern-flags.pg.test.ts).
 *
 * `failOn(table, method, predicate?)` injects a throw into the next matching
 * call (or every one, with `{always: true}`), for the "a failing triage is
 * recorded failed" cases.
 */
import { randomUUID } from "node:crypto";
import { createTransactionSeam } from "./helpers/prisma-tx-harness.js";
import type { IncidentListFilters, IncidentViewer } from "../services/security-incident-view.js";

type Row = Record<string, unknown>;
type Where = Record<string, unknown> | undefined;

export type TableName =
  | "securityEvent"
  | "securityEventTriage"
  | "securityIncident"
  | "securityIncidentReason"
  | "securityIncidentAck"
  | "securityIncidentNotice"
  | "securityAlertRecipient"
  | "securityIncidentEngineState"
  | "securityIngestState"
  | "securityZone"
  | "securityZoneLink"
  | "securityModeState"
  | "securitySiteHours"
  | "securitySchedule"
  | "securityScheduleException"
  | "activityRow"
  | "user"
  | "notificationLog"
  | "pushSubscription"
  | "camera"
  | "cameraAccessGrant"
  | "department"
  | "departmentProfile"
  | "departmentMembership"
  | "workspace"
  // WARP-2980 P5 PR-B
  | "securityPatternFlag"
  | "securitySuppression"
  | "securityBaselineBuild"
  | "securityBaselineCell"
  | "securityBaselineSource"
  | "securityPatternDay";

const TABLES: readonly TableName[] = [
  "securityEvent",
  "securityEventTriage",
  "securityIncident",
  "securityIncidentReason",
  "securityIncidentAck",
  "securityIncidentNotice",
  "securityAlertRecipient",
  "securityIncidentEngineState",
  "securityIngestState",
  "securityZone",
  "securityZoneLink",
  "securityModeState",
  "securitySiteHours",
  "securitySchedule",
  "securityScheduleException",
  "activityRow",
  "user",
  "notificationLog",
  "pushSubscription",
  "camera",
  "cameraAccessGrant",
  "department",
  "departmentProfile",
  "departmentMembership",
  "workspace",
  "securityPatternFlag",
  "securitySuppression",
  "securityBaselineBuild",
  "securityBaselineCell",
  "securityBaselineSource",
  "securityPatternDay",
];

interface Relation {
  table: TableName;
  kind: "one" | "many";
  local: string;
  foreign: string;
}

const RELATIONS: Partial<Record<TableName, Record<string, Relation>>> = {
  securityEvent: { triage: { table: "securityEventTriage", kind: "one", local: "id", foreign: "eventId" } },
  securityEventTriage: {
    event: { table: "securityEvent", kind: "one", local: "eventId", foreign: "id" },
    incident: { table: "securityIncident", kind: "one", local: "incidentId", foreign: "id" },
  },
  securityIncident: {
    members: { table: "securityEventTriage", kind: "many", local: "id", foreign: "incidentId" },
    reasons: { table: "securityIncidentReason", kind: "many", local: "id", foreign: "incidentId" },
    acks: { table: "securityIncidentAck", kind: "many", local: "id", foreign: "incidentId" },
    notices: { table: "securityIncidentNotice", kind: "many", local: "id", foreign: "incidentId" },
    zone: { table: "securityZone", kind: "one", local: "zoneId", foreign: "id" },
    patternFlags: { table: "securityPatternFlag", kind: "many", local: "id", foreign: "incidentId" },
  },
  securityPatternFlag: {
    incident: { table: "securityIncident", kind: "one", local: "incidentId", foreign: "id" },
    suppression: { table: "securitySuppression", kind: "one", local: "suppressionId", foreign: "id" },
  },
  securitySuppression: {
    zone: { table: "securityZone", kind: "one", local: "zoneId", foreign: "id" },
    flags: { table: "securityPatternFlag", kind: "many", local: "id", foreign: "suppressionId" },
  },
  securityIncidentReason: { incident: { table: "securityIncident", kind: "one", local: "incidentId", foreign: "id" } },
  securityIncidentNotice: { incident: { table: "securityIncident", kind: "one", local: "incidentId", foreign: "id" } },
  securityIncidentAck: { incident: { table: "securityIncident", kind: "one", local: "incidentId", foreign: "id" } },
  securityZone: {
    links: { table: "securityZoneLink", kind: "many", local: "id", foreign: "zoneId" },
    suppressions: { table: "securitySuppression", kind: "many", local: "id", foreign: "zoneId" },
  },
  securityZoneLink: { zone: { table: "securityZone", kind: "one", local: "zoneId", foreign: "id" } },
  user: {
    securityAlertRecipient: { table: "securityAlertRecipient", kind: "one", local: "id", foreign: "userId" },
    departmentMemberships: { table: "departmentMembership", kind: "many", local: "id", foreign: "userId" },
  },
  securityAlertRecipient: { user: { table: "user", kind: "one", local: "userId", foreign: "id" } },
  cameraAccessGrant: { camera: { table: "camera", kind: "one", local: "cameraId", foreign: "id" } },
  departmentMembership: {
    department: { table: "department", kind: "one", local: "departmentId", foreign: "id" },
    user: { table: "user", kind: "one", local: "userId", foreign: "id" },
  },
  department: { profile: { table: "departmentProfile", kind: "one", local: "id", foreign: "departmentId" } },
};

/** Primary keys and unique indexes. */
const UNIQUES: Partial<Record<TableName, string[][]>> = {
  securityEvent: [["id"], ["dedupeKey"]],
  securityEventTriage: [["eventId"]],
  securityIncident: [["id"]],
  securityIncidentReason: [["id"], ["incidentId", "code", "evidenceEventId"]],
  securityIncidentAck: [["id"]],
  securityIncidentNotice: [["id"], ["incidentId", "userId"]],
  securityAlertRecipient: [["userId"]],
  securityIncidentEngineState: [["id"]],
  securityIngestState: [["id"]],
  securityZone: [["id"]],
  securityZoneLink: [["id"]],
  securityModeState: [["id"]],
  securitySiteHours: [["id"]],
  activityRow: [["id"]],
  user: [["id"], ["username"]],
  notificationLog: [["id"]],
  securityPatternFlag: [["id"], ["incidentId", "code", "evidenceEventId"]],
  securitySuppression: [["id"]],
  securityBaselineBuild: [["id"]],
  securityBaselineCell: [["id"], ["buildId", "zoneKey", "label", "dayType", "hour"]],
  securityBaselineSource: [["sourceKey"]],
  securityPatternDay: [["date", "outcome"]],
};

/** FK behaviour when the parent row is deleted. */
const ON_DELETE: Partial<Record<TableName, Array<{ child: TableName; fk: string; key: string; rule: "cascade" | "restrict" }>>> = {
  securityEvent: [{ child: "securityEventTriage", fk: "eventId", key: "id", rule: "cascade" }],
  securityIncident: [
    { child: "securityEventTriage", fk: "incidentId", key: "id", rule: "restrict" },
    { child: "securityIncidentReason", fk: "incidentId", key: "id", rule: "cascade" },
    { child: "securityIncidentAck", fk: "incidentId", key: "id", rule: "cascade" },
    { child: "securityIncidentNotice", fk: "incidentId", key: "id", rule: "cascade" },
    { child: "securityPatternFlag", fk: "incidentId", key: "id", rule: "cascade" },
  ],
  securitySuppression: [{ child: "securityPatternFlag", fk: "suppressionId", key: "id", rule: "restrict" }],
  securityZone: [{ child: "securitySuppression", fk: "zoneId", key: "id", rule: "restrict" }],
  securityBaselineBuild: [{ child: "securityBaselineCell", fk: "buildId", key: "id", rule: "cascade" }],
};

let seq = 1000n;
const DEFAULTS: Partial<Record<TableName, (now: Date) => Row>> = {
  securityEvent: (now) => ({ id: ++seq, createdAt: now, labels: [], cameraZones: [], score: null, endedAt: null, camera: null }),
  securityEventTriage: (now) => ({ triagedAt: now, error: null, incidentId: null }),
  securityIncident: (now) => ({
    id: randomUUID(),
    zoneId: null,
    zoneName: null,
    zoneKind: null,
    scopeCamera: null,
    grouping: "collecting",
    state: "no_action",
    severity: "info",
    notifyState: "not_needed",
    notifyAttempts: 0,
    eventsKept: "kept",
    openedAt: now,
    closedAt: null,
    alertedAt: null,
    stateChangedAt: now,
    stateChangedById: null,
    resolvedAt: null,
    resolvedById: null,
    version: 0,
    updatedAt: now,
    // WARP-2980 PR-B: `verdictCodes` has @default([]) — a create that omits it stores [], not NULL.
    verdict: "unreviewed",
    verdictById: null,
    verdictByName: null,
    verdictAt: null,
    verdictFirstAt: null,
    verdictCodes: [],
  }),
  securityIncidentReason: (now) => ({ id: randomUUID(), createdAt: now, evidenceCamera: null, evidenceLabel: null }),
  securityIncidentAck: (now) => ({
    id: randomUUID(),
    at: now,
    sessionId: null,
    sessionChecked: false,
    client: null,
    viaNotificationId: null,
    note: "",
  }),
  securityIncidentNotice: (now) => ({
    id: randomUUID(),
    createdAt: now,
    notificationLogId: null,
    channels: "",
    pushOutcome: null,
    settledAt: null,
  }),
  securityAlertRecipient: (now) => ({ version: 0, setById: null, setAt: now }),
  securityIncidentEngineState: (now) => ({ startedAt: now, updatedAt: now }),
  securityIngestState: () => ({
    threatCursor: 0n,
    threatMirrorRanAt: null,
    retentionRanAt: null,
    retentionDeleted: 0,
    retentionIncidentsDeleted: 0,
  }),
  notificationLog: (now) => ({
    id: `c${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    createdAt: now,
    body: null,
    url: null,
    data: null,
    channels: "",
    deliveredAt: null,
    error: null,
    pushOutcome: null,
    ackState: "unacked",
    ackedAt: null,
    ackMethod: null,
    ackSessionId: null,
    ackSessionChecked: false,
    ackClient: null,
  }),
  activityRow: (now) => ({ id: ++seq, at: now, sub: null }),
  securityPatternFlag: (now) => ({ id: randomUUID(), createdAt: now, suppressionId: null }),
  securitySuppression: (now) => ({
    id: randomUUID(),
    zoneId: null,
    camera: null,
    state: "active",
    createdAt: now,
    endedAt: null,
    endedById: null,
  }),
  securityBaselineBuild: (now) => ({ id: randomUUID(), cellsVersion: 0, startedAt: now, finishedAt: null, cellCount: 0, eventCount: 0, error: null }),
  securityBaselineCell: (now) => ({
    id: ++seq,
    zoneId: null,
    camera: null,
    zoneVersion: null,
    dwellSamples: 0,
    durationP99Sec: null,
    computedAt: now,
  }),
  securityBaselineSource: (now) => ({ updatedAt: now }),
  securityPatternDay: (now) => ({ updatedAt: now }),
};

/** Scalar-list columns a seeded row gets as [] (a create that omits them stores NULL, as on Postgres). */
const SEED_LISTS: Partial<Record<TableName, string[]>> = {
  securityIncident: ["zoneLinkIds", "reasonCodes", "cameras"],
  securityEventTriage: ["matchedLinkIds", "alsoZoneIds"],
  securityPatternFlag: ["keyCameras"],
  securitySuppression: ["codes"],
  securityBaselineCell: ["cameras"],
};

/** Required JSON-object columns a seeded row may leave out (a `create` must still give them, as in Prisma). */
const SEED_OBJECTS: Partial<Record<TableName, string[]>> = {
  securityIncident: ["spanByCamera"],
};

class FakePrismaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
  }
}

// ── value helpers ─────────────────────────────────────────────────────────

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === "bigint" || typeof b === "bigint") {
    try {
      return a !== null && a !== undefined && b !== null && b !== undefined && BigInt(a as bigint) === BigInt(b as bigint);
    } catch {
      return false;
    }
  }
  return a === b;
}

function cmp(a: unknown, b: unknown): number {
  const n = (x: unknown): number | bigint | string =>
    x instanceof Date ? x.getTime() : typeof x === "bigint" ? x : (x as number | string);
  const x = n(a);
  const y = n(b);
  if (typeof x === "bigint" || typeof y === "bigint") {
    const bx = BigInt(x as bigint);
    const by = BigInt(y as bigint);
    return bx < by ? -1 : bx > by ? 1 : 0;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

function isOperatorObject(cond: unknown): cond is Record<string, unknown> {
  return cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond);
}

function scalarMatch(v: unknown, cond: unknown): boolean {
  if (cond === null) return v === null || v === undefined;
  if (!isOperatorObject(cond)) return eq(v, cond);
  const isNull = v === null || v === undefined;
  for (const [op, x] of Object.entries(cond)) {
    if (x === undefined) continue;
    switch (op) {
      case "equals":
        if (x === null ? !isNull : !eq(v, x)) return false;
        break;
      case "in":
        if (isNull || !(x as unknown[]).some((y) => eq(v, y))) return false;
        break;
      case "notIn":
        if (isNull || (x as unknown[]).some((y) => eq(v, y))) return false;
        break;
      case "not":
        if (x === null) {
          if (isNull) return false;
        } else if (isOperatorObject(x)) {
          if (isNull || scalarMatch(v, x)) return false;
        } else if (isNull || eq(v, x)) return false;
        break;
      case "lt":
        if (isNull || !(cmp(v, x) < 0)) return false;
        break;
      case "lte":
        if (isNull || !(cmp(v, x) <= 0)) return false;
        break;
      case "gt":
        if (isNull || !(cmp(v, x) > 0)) return false;
        break;
      case "gte":
        if (isNull || !(cmp(v, x) >= 0)) return false;
        break;
      case "has":
        if (!Array.isArray(v) || !v.some((y) => eq(y, x))) return false;
        break;
      case "hasSome":
        if (!Array.isArray(v) || !(x as unknown[]).some((y) => v.some((z) => eq(z, y)))) return false;
        break;
      case "hasEvery":
        if (!Array.isArray(v) || !(x as unknown[]).every((y) => v.some((z) => eq(z, y)))) return false;
        break;
      case "isEmpty":
        if (!Array.isArray(v) || (v.length === 0) !== x) return false;
        break;
      case "startsWith":
        if (typeof v !== "string" || !v.startsWith(x as string)) return false;
        break;
      case "mode":
        break;
      default:
        throw new Error(`fake prisma: unsupported operator ${op}`);
    }
  }
  return true;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

// ── the CHECK mirrors (20260925030000_warp_2978_security_incidents; PR-D's 20260925030200;
//    WARP-2980 PR-B's 20260925060100_warp_2980_security_patterns_verdicts) ──

function check(table: TableName, r: Row): void {
  const fail = (name: string) => {
    throw new FakePrismaError("P2010", `new row for relation "${table}" violates check constraint "${name}"`);
  };
  if (table === "securityEvent" && r.kind === "detection_ongoing") {
    // 20260925030200_warp_2978_security_event_ongoing_shape (PR-D).
    const ok =
      r.source === "frigate" &&
      r.camera != null &&
      r.endedAt == null &&
      typeof r.dedupeKey === "string" &&
      r.dedupeKey.startsWith("frigate-ongoing:");
    if (!ok) fail("SecurityEvent_ongoing_shape");
  }
  if (table === "securityIncident") {
    const codes = r.reasonCodes as unknown[];
    if (!Array.isArray(r.zoneLinkIds) || !Array.isArray(r.cameras) || !Array.isArray(codes)) fail("SecurityIncident_scope_shape");
    const area = r.scope === "area";
    if (area !== (r.zoneId != null && r.zoneName != null && r.zoneKind != null)) fail("SecurityIncident_scope_shape");
    if (!area && (r.zoneLinkIds as unknown[]).length !== 0) fail("SecurityIncident_scope_shape");
    if ((r.scope === "camera") !== (r.scopeCamera != null)) fail("SecurityIncident_scope_shape");
    if (r.scopeCamera != null && !/^[a-zA-Z0-9_-]{1,64}$/.test(r.scopeCamera as string)) fail("SecurityIncident_scope_shape");
    const info = r.severity === "info";
    if (info !== (r.state === "no_action")) fail("SecurityIncident_state_shape");
    if (info !== (codes.length === 0)) fail("SecurityIncident_state_shape");
    if (r.state === "resolved" && r.grouping !== "closed") fail("SecurityIncident_state_shape");
    if ((r.grouping === "closed") !== (r.closedAt != null)) fail("SecurityIncident_state_shape");
    if ((r.state === "resolved") !== (r.resolvedAt != null && r.resolvedById != null)) fail("SecurityIncident_state_shape");
    if ((r.severity === "alert") !== (r.notifyState !== "not_needed")) fail("SecurityIncident_state_shape");
    if ((r.severity === "alert") !== (r.alertedAt != null)) fail("SecurityIncident_state_shape");
    if (cmp(r.lastActivityAt, r.firstActivityAt) < 0 || (r.eventCount as number) < 1) fail("SecurityIncident_span");
    const spans = r.spanByCamera;
    if (spans === null || typeof spans !== "object" || Array.isArray(spans)) fail("SecurityIncident_span");
    if ((r.rulesetVersion as number) < 1 || (r.notifyAttempts as number) < 0 || (r.notifyAttempts as number) > 10) fail("SecurityIncident_span");
    // 20260925060100_warp_2980_security_patterns_verdicts (WARP-2980 PR-B). A
    // row a test pushed straight into the world without these columns reads
    // their defaults (unreviewed, []), as Postgres would give it; an explicit
    // NULL still fails.
    const vc = (r.verdictCodes === undefined ? [] : r.verdictCodes) as unknown[];
    if (!Array.isArray(vc) || vc.some((c) => c == null)) fail("SecurityIncident_verdict_shape");
    const unreviewed = (r.verdict ?? "unreviewed") === "unreviewed";
    if (unreviewed !== (r.verdictAt == null)) fail("SecurityIncident_verdict_shape");
    if ((r.verdictAt == null) !== (r.verdictFirstAt == null)) fail("SecurityIncident_verdict_shape");
    if ((r.verdictAt == null) !== (r.verdictById == null)) fail("SecurityIncident_verdict_shape");
    if ((r.verdictById == null) !== (r.verdictByName == null)) fail("SecurityIncident_verdict_shape");
    if (unreviewed !== (vc.length === 0)) fail("SecurityIncident_verdict_shape");
    if (r.verdictAt != null && cmp(r.verdictFirstAt, r.verdictAt) > 0) fail("SecurityIncident_verdict_shape");
  }
  if (table === "securityPatternFlag") {
    const FRIGATE = /^[a-zA-Z0-9_-]{1,64}$/;
    const pair =
      ((r.code === "out_of_place" || r.code === "long_dwell") && (r.severity === "notice" || r.severity === "alert")) ||
      (r.code === "unusual_volume" && (r.severity === "info" || r.severity === "notice"));
    const cams = r.keyCameras as unknown[];
    const key = typeof r.zoneKey === "string" ? r.zoneKey : "";
    const ok =
      pair &&
      (r.severity !== "alert" || r.evidenceLabel === "person") &&
      (r.code !== "long_dwell" || r.evidenceLabel === "person") &&
      (r.effect === "suppressed") === (r.suppressionId != null) &&
      typeof r.evidenceCamera === "string" &&
      FRIGATE.test(r.evidenceCamera) &&
      typeof r.evidenceLabel === "string" &&
      FRIGATE.test(r.evidenceLabel) &&
      /^(area:[0-9a-f-]{36}|camera:[a-zA-Z0-9_-]{1,64})$/.test(key) &&
      Array.isArray(cams) &&
      cams.length >= 1 &&
      !cams.some((c) => c == null) &&
      cams.includes(r.evidenceCamera) &&
      (!key.startsWith("camera:") || (cams.length === 1 && cams[0] === key.slice(7))) &&
      r.detail !== null &&
      typeof r.detail === "object" &&
      !Array.isArray(r.detail) &&
      (r.rulesetVersion as number) >= 3;
    if (!ok) fail("SecurityPatternFlag_shape");
  }
  if (table === "securitySuppression") {
    const codes = r.codes as unknown[];
    const allowed = ["out_of_place", "unusual_volume", "long_dwell"];
    const created = (r.createdAt as Date).getTime();
    const expires = (r.expiresAt as Date).getTime();
    const ok =
      (r.targetKind === "area") === (r.zoneId != null) &&
      (r.targetKind === "camera") === (r.camera != null) &&
      (r.camera == null || /^[a-zA-Z0-9_-]{1,64}$/.test(r.camera as string)) &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(r.label as string) &&
      (r.hourFrom as number) >= 0 &&
      (r.hourFrom as number) <= 23 &&
      (r.hourCount as number) >= 1 &&
      (r.hourCount as number) <= 24 &&
      Array.isArray(codes) &&
      !codes.some((c) => c == null) &&
      codes.length >= 1 &&
      codes.length <= 3 &&
      codes.every((c) => allowed.includes(c as string)) &&
      (!codes.includes("long_dwell") || r.label === "person") &&
      String(r.reason).trim() !== "" &&
      String(r.createdByName).trim() !== "" &&
      expires > created &&
      expires <= created + 365 * 86_400_000 &&
      (r.state === "active") === (r.endedAt == null) &&
      (r.state === "removed") === (r.endedById != null);
    if (!ok) fail("SecuritySuppression_shape");
  }
  if (table === "securityPatternDay") {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(r.date as string) || (r.count as number) < 0) fail("SecurityPatternDay_shape");
  }
  if (table === "securityIncidentReason") {
    const ok =
      (r.code === "after_hours_presence" && r.severity === "alert") ||
      ((r.code === "camera_offline" || r.code === "threat_signal") && r.severity === "notice");
    if (!ok) fail("SecurityIncidentReason_code_severity");
    const siteWide =
      r.evidenceCamera != null ||
      (r.code === "threat_signal" && r.evidenceKind === "threat") ||
      (r.code === "camera_offline" && r.evidenceKind === "source_offline");
    if (!siteWide) fail("SecurityIncidentReason_site_evidence");
  }
  if (table === "securityEventTriage") {
    if ((r.outcome === "grouped") !== (r.incidentId != null)) fail("SecurityEventTriage_shape");
    if ((r.outcome === "failed") !== (r.error != null)) fail("SecurityEventTriage_shape");
    if (r.outcome !== "grouped" && ((r.matchedLinkIds as unknown[]).length > 0 || (r.alsoZoneIds as unknown[]).length > 0)) {
      fail("SecurityEventTriage_shape");
    }
  }
  if (table === "securityIncidentAck") {
    if (r.action !== "resolve" && r.note !== "") fail("SecurityIncidentAck_note");
    if (r.sessionChecked === true && r.sessionId == null) fail("SecurityIncidentAck_session");
  }
  if (table === "securityIncidentNotice") {
    const logged = r.outcome === "queued" || r.outcome === "sent" || r.outcome === "not_sent" || r.outcome === "outcome_unknown";
    if (logged !== (r.notificationLogId != null)) fail("SecurityIncidentNotice_shape");
    if ((r.outcome === "queued") !== (r.settledAt == null)) fail("SecurityIncidentNotice_shape");
    if (!(r.outcome === "sent" || r.outcome === "not_sent") && (r.channels !== "" || r.pushOutcome != null)) {
      fail("SecurityIncidentNotice_shape");
    }
  }
  if (table === "securityIncidentEngineState") {
    if (r.id !== "singleton" || cmp(r.startedAtId, r.triageFloor) > 0 || cmp(r.triageFloor, r.floorCandidate) > 0) {
      fail("SecurityIncidentEngineState_shape");
    }
  }
}

// ── the fake ──────────────────────────────────────────────────────────────

export type FakeWorld = Record<TableName, Row[]>;

export interface FakeSecurityPrisma {
  world: FakeWorld;
  /** Every write, in order: `<table>.<method>`. */
  log: string[];
  /** Isolation levels asked for, in order ("default" when none). */
  txLevels: string[];
  /** Raw SQL issued (advisory locks), in order. */
  raw: string[];
  now: () => Date;
  setNow(d: Date): void;
  failOn(table: TableName, method: string, predicate?: (args: unknown) => boolean, opts?: { always?: boolean; error?: Error }): void;
  /** Run `effect` (once) just BEFORE the next matching call — a concurrent writer landing between a read and a CAS. */
  onCall(table: TableName, method: string, effect: (world: FakeWorld) => void): void;
  /** How many `$transaction` callbacks are running right now (0 = autocommit). */
  txDepth(): number;
  client: Record<string, unknown>;
}

export function emptyWorld(): FakeWorld {
  return Object.fromEntries(TABLES.map((t) => [t, []])) as unknown as FakeWorld;
}

export function createFakeSecurityPrisma(init: Partial<FakeWorld> = {}, start: Date = new Date("2026-09-23T21:14:00Z")): FakeSecurityPrisma {
  // Seeded rows get the same column defaults a create would give them.
  const world: FakeWorld = emptyWorld();
  for (const [t, rows] of Object.entries(clone(init as FakeWorld)) as Array<[TableName, Row[]]>) {
    const lists = Object.fromEntries([...(SEED_LISTS[t] ?? []).map((k) => [k, []]), ...(SEED_OBJECTS[t] ?? []).map((k) => [k, {}])]);
    world[t] = rows.map((r) => ({ ...(DEFAULTS[t]?.(start) ?? {}), ...lists, ...r }));
  }
  let clock = start;
  const log: string[] = [];
  const txLevels: string[] = [];
  const raw: string[] = [];
  const faults: Array<{ table: TableName; method: string; predicate?: (a: unknown) => boolean; always: boolean; error?: Error }> = [];
  const effects: Array<{ table: TableName; method: string; effect: (w: FakeWorld) => void }> = [];
  let depth = 0;

  function maybeFail(table: TableName, method: string, args: unknown): void {
    const e = effects.findIndex((x) => x.table === table && x.method === method);
    if (e >= 0) {
      const [hit] = effects.splice(e, 1);
      hit!.effect(world);
    }
    const i = faults.findIndex((f) => f.table === table && f.method === method && (!f.predicate || f.predicate(args)));
    if (i < 0) return;
    const f = faults[i]!;
    if (!f.always) faults.splice(i, 1);
    throw f.error ?? new Error(`injected failure: ${table}.${method}`);
  }

  function matches(table: TableName, row: Row, where: Where): boolean {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === "AND") {
        const all = Array.isArray(cond) ? cond : [cond];
        if (!all.every((w) => matches(table, row, w as Where))) return false;
        continue;
      }
      if (k === "OR") {
        if (!(cond as Where[]).some((w) => matches(table, row, w))) return false;
        continue;
      }
      if (k === "NOT") {
        const all = Array.isArray(cond) ? cond : [cond];
        if (all.some((w) => matches(table, row, w as Where))) return false;
        continue;
      }
      const rel = RELATIONS[table]?.[k];
      if (rel) {
        if (!relMatch(rel, row, cond)) return false;
        continue;
      }
      if (!scalarMatch(row[k], cond)) return false;
    }
    return true;
  }

  function related(rel: Relation, row: Row): Row[] {
    const key = row[rel.local];
    if (key === null || key === undefined) return [];
    return world[rel.table].filter((r) => eq(r[rel.foreign], key));
  }

  function relMatch(rel: Relation, row: Row, cond: unknown): boolean {
    const rows = related(rel, row);
    if (rel.kind === "one") {
      const one = rows[0] ?? null;
      if (cond === null) return one === null;
      const c = cond as Record<string, unknown>;
      if ("is" in c) return c.is === null ? one === null : one !== null && matches(rel.table, one, c.is as Where);
      if ("isNot" in c) return c.isNot === null ? one !== null : one === null || !matches(rel.table, one, c.isNot as Where);
      return one !== null && matches(rel.table, one, c as Where);
    }
    const c = cond as Record<string, Where>;
    if ("some" in c) return rows.some((r) => matches(rel.table, r, c.some));
    if ("none" in c) return !rows.some((r) => matches(rel.table, r, c.none));
    if ("every" in c) return rows.every((r) => matches(rel.table, r, c.every));
    throw new Error("fake prisma: unsupported to-many filter");
  }

  function flattenUnique(where: Where): Where {
    if (!where) return where;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(where)) {
      if (k.includes("_") && isOperatorObject(v) && !RELATIONS[k as TableName]) {
        const parts = k.split("_");
        if (parts.every((p) => p in (v as Record<string, unknown>))) {
          Object.assign(out, v);
          continue;
        }
      }
      out[k] = v;
    }
    return out;
  }

  function sort(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
    return [...rows].sort((a, b) => {
      for (const k of keys) {
        const [field, dir] = Object.entries(k)[0]!;
        const c = cmp(a[field], b[field]);
        if (c !== 0) return dir === "desc" ? -c : c;
      }
      return 0;
    });
  }

  function project(table: TableName, row: Row, shape: Record<string, unknown> | undefined): Row {
    const out = clone(row);
    if (!shape) return out;
    for (const [k, v] of Object.entries(shape)) {
      const rel = RELATIONS[table]?.[k];
      if (!rel || !v) continue;
      const sub = typeof v === "object" ? (v as Record<string, unknown>) : {};
      let rows = related(rel, row);
      if (sub.where) rows = rows.filter((r) => matches(rel.table, r, sub.where as Where));
      rows = sort(rows, sub.orderBy);
      if (typeof sub.take === "number") rows = rows.slice(0, sub.take);
      const nested = (sub.select ?? sub.include) as Record<string, unknown> | undefined;
      if (rel.kind === "one") out[k] = rows[0] ? project(rel.table, rows[0], nested) : null;
      else out[k] = rows.map((r) => project(rel.table, r, nested));
    }
    return out;
  }

  function uniqueClash(table: TableName, row: Row, except?: Row): string[] | null {
    for (const keys of UNIQUES[table] ?? []) {
      if (keys.some((k) => row[k] === null || row[k] === undefined)) continue;
      const clash = world[table].find((r) => r !== except && keys.every((k) => eq(r[k], row[k])));
      if (clash) return keys;
    }
    return null;
  }

  function applyData(row: Row, data: Record<string, unknown>): Row {
    const next = { ...row };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isOperatorObject(v) && ("increment" in v || "decrement" in v || "set" in v)) {
        if ("set" in v) next[k] = clone(v.set);
        else if (typeof next[k] === "bigint") next[k] = (next[k] as bigint) + BigInt((v.increment ?? 0) as number) - BigInt((v.decrement ?? 0) as number);
        else next[k] = (next[k] as number) + ((v.increment ?? 0) as number) - ((v.decrement ?? 0) as number);
      } else next[k] = clone(v);
    }
    if ("updatedAt" in row) next.updatedAt = clock;
    return next;
  }

  function insert(table: TableName, data: Row): Row {
    const nulls = Object.fromEntries((SEED_LISTS[table] ?? []).map((k) => [k, null]));
    const row = { ...(DEFAULTS[table]?.(clock) ?? {}), ...nulls, ...clone(data) };
    const clash = uniqueClash(table, row);
    if (clash) throw new FakePrismaError("P2002", `Unique constraint failed on the fields: (${clash.join(",")})`);
    check(table, row);
    world[table].push(row);
    return row;
  }

  function remove(table: TableName, rows: Row[]): void {
    for (const r of rows) {
      for (const fk of ON_DELETE[table] ?? []) {
        const children = world[fk.child].filter((c) => eq(c[fk.fk], r[fk.key]));
        if (children.length === 0) continue;
        if (fk.rule === "restrict") {
          throw new FakePrismaError("P2003", `Foreign key constraint failed on the field: ${fk.child}.${fk.fk}`);
        }
        remove(fk.child, children);
      }
    }
    world[table] = world[table].filter((x) => !rows.includes(x));
  }

  function delegate(table: TableName) {
    const find = (args: { where?: Where; orderBy?: unknown }) =>
      sort(
        world[table].filter((r) => matches(table, r, flattenUnique(args?.where))),
        args?.orderBy,
      );
    return {
      findMany: async (args: { where?: Where; orderBy?: unknown; take?: number; skip?: number; select?: Record<string, unknown>; include?: Record<string, unknown>; distinct?: string[] } = {}) => {
        maybeFail(table, "findMany", args);
        let rows = find(args);
        if (args.skip) rows = rows.slice(args.skip);
        if (typeof args.take === "number") rows = rows.slice(0, args.take);
        return rows.map((r) => project(table, r, args.select ?? args.include));
      },
      findFirst: async (args: { where?: Where; orderBy?: unknown; select?: Record<string, unknown>; include?: Record<string, unknown> } = {}) => {
        maybeFail(table, "findFirst", args);
        const r = find(args)[0];
        return r ? project(table, r, args.select ?? args.include) : null;
      },
      findUnique: async (args: { where: Where; select?: Record<string, unknown>; include?: Record<string, unknown> }) => {
        maybeFail(table, "findUnique", args);
        const r = find(args)[0];
        return r ? project(table, r, args.select ?? args.include) : null;
      },
      findUniqueOrThrow: async (args: { where: Where; select?: Record<string, unknown>; include?: Record<string, unknown> }) => {
        maybeFail(table, "findUniqueOrThrow", args);
        const r = find(args)[0];
        if (!r) throw new FakePrismaError("P2025", `No ${table} found`);
        return project(table, r, args.select ?? args.include);
      },
      count: async (args: { where?: Where } = {}) => {
        maybeFail(table, "count", args);
        return find(args).length;
      },
      /** WARP-2980 PR-B: one `by` column and `_count: {_all: true}` — exactly what the suppression list asks. */
      groupBy: async (args: { by: string[]; where?: Where; _count?: { _all: true } }) => {
        maybeFail(table, "groupBy", args);
        if (args.by.length !== 1 || !args._count?._all) throw new Error("fake prisma: groupBy supports one `by` column and _count._all only");
        const col = args.by[0]!;
        const groups = new Map<unknown, number>();
        for (const r of find(args)) groups.set(r[col] ?? null, (groups.get(r[col] ?? null) ?? 0) + 1);
        return [...groups].map(([v, n]) => ({ [col]: v, _count: { _all: n } }));
      },
      aggregate: async (args: { where?: Where; _max?: Record<string, true> }) => {
        maybeFail(table, "aggregate", args);
        const rows = find(args);
        const _max: Record<string, unknown> = {};
        for (const k of Object.keys(args._max ?? {})) {
          _max[k] = rows.length === 0 ? null : rows.reduce((m, r) => (cmp(r[k], m) > 0 ? r[k] : m), rows[0]![k]);
        }
        return { _max };
      },
      create: async (args: { data: Row; select?: Record<string, unknown>; include?: Record<string, unknown> }) => {
        maybeFail(table, "create", args);
        log.push(`${table}.create`);
        return project(table, insert(table, args.data), args.select ?? args.include);
      },
      createMany: async (args: { data: Row[] | Row; skipDuplicates?: boolean }) => {
        maybeFail(table, "createMany", args);
        log.push(`${table}.createMany`);
        let count = 0;
        for (const d of Array.isArray(args.data) ? args.data : [args.data]) {
          try {
            insert(table, d);
            count++;
          } catch (err) {
            if (!(args.skipDuplicates && err instanceof FakePrismaError && err.code === "P2002")) throw err;
          }
        }
        return { count };
      },
      update: async (args: { where: Where; data: Row; select?: Record<string, unknown>; include?: Record<string, unknown> }) => {
        maybeFail(table, "update", args);
        log.push(`${table}.update`);
        const r = find(args)[0];
        if (!r) throw new FakePrismaError("P2025", `Record to update not found (${table})`);
        const next = applyData(r, args.data);
        const clash = uniqueClash(table, next, r);
        if (clash) throw new FakePrismaError("P2002", `Unique constraint failed on the fields: (${clash.join(",")})`);
        check(table, next);
        world[table][world[table].indexOf(r)] = next;
        return project(table, next, args.select ?? args.include);
      },
      updateMany: async (args: { where?: Where; data: Row }) => {
        maybeFail(table, "updateMany", args);
        log.push(`${table}.updateMany`);
        const rows = find(args);
        const nexts = rows.map((r) => applyData(r, args.data));
        nexts.forEach((n) => check(table, n));
        rows.forEach((r, i) => {
          world[table][world[table].indexOf(r)] = nexts[i]!;
        });
        return { count: rows.length };
      },
      upsert: async (args: { where: Where; create: Row; update: Row }) => {
        maybeFail(table, "upsert", args);
        log.push(`${table}.upsert`);
        const r = find(args)[0];
        if (!r) return clone(insert(table, args.create));
        const next = applyData(r, args.update);
        check(table, next);
        world[table][world[table].indexOf(r)] = next;
        return clone(next);
      },
      delete: async (args: { where: Where }) => {
        maybeFail(table, "delete", args);
        log.push(`${table}.delete`);
        const r = find(args)[0];
        if (!r) throw new FakePrismaError("P2025", `Record to delete does not exist (${table})`);
        remove(table, [r]);
        return clone(r);
      },
      deleteMany: async (args: { where?: Where } = {}) => {
        maybeFail(table, "deleteMany", args);
        log.push(`${table}.deleteMany`);
        const rows = find(args);
        remove(table, rows);
        return { count: rows.length };
      },
    };
  }

  const client: Record<string, unknown> = Object.fromEntries(TABLES.map((t) => [t, delegate(t)]));
  // WARP-1570: the shared seam owns the transaction — the options argument,
  // rollback (the whole world, through `snapshot`/`restore`), the replay of
  // any transaction that committed while a rolled-back one was open, and the
  // P2034 a RepeatableRead / Serializable write-conflict raises. This wrapper
  // only adds what these suites read: the isolation levels asked for, and
  // how many callbacks are running.
  const seam = createTransactionSeam({
    client: () => client,
    snapshot: () => clone(world),
    restore: (snap) => {
      for (const t of TABLES) world[t] = (snap as FakeWorld)[t];
    },
  });
  client.$transaction = async (fn: unknown, opts?: { isolationLevel?: string }) => {
    if (Array.isArray(fn)) return seam.$transaction(fn as never, opts);
    txLevels.push(opts?.isolationLevel ?? "default");
    return seam.$transaction(async (tx: unknown) => {
      depth++;
      try {
        return await (fn as (t: unknown) => Promise<unknown>)(tx);
      } finally {
        depth--;
      }
    }, opts);
  };
  client.$executeRawUnsafe = async (sql: string) => {
    raw.push(sql);
    return 1;
  };
  client.$queryRawUnsafe = async (sql: string) => {
    raw.push(sql);
    return [];
  };
  client.$executeRaw = async (strings: TemplateStringsArray) => {
    raw.push(strings.join("?"));
    return 1;
  };
  client.$queryRaw = async (strings: TemplateStringsArray) => {
    raw.push(strings.join("?"));
    return [];
  };

  return {
    world,
    log,
    txLevels,
    raw,
    now: () => clock,
    setNow(d: Date) {
      clock = d;
    },
    failOn(table, method, predicate, opts = {}) {
      faults.push({ table, method, predicate, always: opts.always ?? false, error: opts.error });
    },
    onCall(table, method, effect) {
      effects.push({ table, method, effect });
    },
    txDepth: () => depth,
    client,
  };
}

// ── fixtures ──────────────────────────────────────────────────────────────

let eventSeq = 1n;

/** A SecurityEvent row with sane defaults (a person on camera `back`). */
export function eventRow(over: Row = {}): Row {
  const startedAt = (over.startedAt as Date | undefined) ?? new Date("2026-09-23T21:14:00Z");
  const id = (over.id as bigint | undefined) ?? eventSeq++;
  return {
    id,
    source: "frigate",
    kind: "detection",
    severity: "info",
    camera: "back",
    sourceRef: `back/${id}.5-abc`,
    dedupeKey: `frigate:${id}.5-abc`,
    labels: ["person"],
    cameraZones: [],
    score: 0.9,
    startedAt,
    endedAt: new Date(startedAt.getTime() + 20_000),
    summary: "Person seen by back",
    createdAt: new Date(startedAt.getTime() + 21_000),
    ...over,
  };
}

/** An area with links: `links` are `camera` or `camera/part` refs. */
export function areaRows(
  zoneId: string,
  name: string,
  kind: string,
  links: string[],
): { zone: Row; links: Row[] } {
  return {
    zone: { id: zoneId, name, nameKey: name.toLowerCase(), kind, state: "active", version: 0 },
    links: links.map((ref, i) => ({
      id: `${zoneId.slice(0, 8)}-l${i}`,
      zoneId,
      sourceKind: ref.includes("/") ? "camera_zone" : "camera",
      sourceRef: ref,
      sourceLabel: ref.split("/")[0],
      state: "active",
    })),
  };
}

/** Mon–Fri 09:00–17:00 in `tz`, set. */
export function officeHours(tz = "Europe/London"): { header: Row; days: Row[] } {
  return {
    header: { id: "singleton", state: "set", timezone: tz, version: 1 },
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
      weekday <= 5
        ? { weekday, kind: "hours", opensMin: 540, closesMin: 1020 }
        : { weekday, kind: "closed", opensMin: null, closesMin: null },
    ),
  };
}

// ── the reference for projectedIncidentPage (review R1) ─────────────────────

/**
 * What `projectedIncidentPage` (the SQL in security-incident-page.ts) must
 * return, built from pieces the mocked lanes can run: Prisma's
 * `incidentListWhere` (without its stored-column cursor) and
 * `projectedLastActivity`, sorted `(projectedLast desc, id desc)` and cut
 * after the `(projectedLast, id)` cursor. The mocked lanes substitute it for
 * the SQL (`vi.mock`); the pg lane pins the SQL to it.
 */
export async function referenceProjectedIncidentPage(
  prisma: unknown,
  v: IncidentViewer,
  f: IncidentListFilters,
  take: number,
): Promise<Array<{ id: string; projectedLast: Date }>> {
  const view = await import("../services/security-incident-view.js");
  const db = prisma as { securityIncident: { findMany(a: unknown): Promise<Array<Parameters<typeof view.projectedLastActivity>[0] & { id: string }>> } };
  const rows = await db.securityIncident.findMany({
    where: view.incidentListWhere(v, { ...f, cursor: undefined }),
    select: { id: true, scope: true, lastActivityAt: true, spanByCamera: true },
  });
  const keyed = rows.map((r) => ({ id: r.id, projectedLast: view.projectedLastActivity(r, v) }));
  const c = f.cursor;
  const kept = c
    ? keyed.filter((k) => k.projectedLast.getTime() < c.at.getTime() || (k.projectedLast.getTime() === c.at.getTime() && k.id < c.id))
    : keyed;
  kept.sort((a, b) => b.projectedLast.getTime() - a.projectedLast.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return kept.slice(0, take);
}

// ── WARP-2980 P5 PR-B: a ready baseline build ───────────────────────────────

export interface BaselineKeyFixture {
  /** `area:<id>` or `camera:<name>`. */
  zoneKey: string;
  /** An area key's version when its cells were built (default 0, `areaRows`' version). */
  zoneVersion?: number;
  cameras: string[];
  /** Default ["person"]. */
  labels?: string[];
  /** Overrides per (dayType, hour); default: 20 weekday / 8 weekend observed days, nothing ever seen (every hour rare). */
  at?: (dayType: "weekday" | "weekend", hour: number, label: string) => Row;
}

/**
 * A `ready` build (cut in `tz`, its window ending `windowTo`), all 48 cells of
 * each key and label — as the build writes them — and one learning-state row
 * per camera. Seed with `createFakeSecurityPrisma({securityBaselineBuild:
 * [b.build], securityBaselineCell: b.cells, securityBaselineSource: b.sources})`.
 */
export function baselineRows(opts: {
  buildId?: string;
  tz?: string;
  windowFrom?: string;
  windowTo?: string;
  keys: BaselineKeyFixture[];
  sources: Array<{ camera: string; state: "learning" | "active" | "stale" }>;
  at?: Date;
}): { build: Row; cells: Row[]; sources: Row[] } {
  const buildId = opts.buildId ?? "b-ready";
  const at = opts.at ?? new Date("2026-09-23T04:10:00Z");
  const cells: Row[] = [];
  for (const k of opts.keys) {
    const area = k.zoneKey.startsWith("area:");
    for (const label of k.labels ?? ["person"]) {
      for (const dayType of ["weekday", "weekend"] as const) {
        for (let hour = 0; hour < 24; hour += 1) {
          const n = dayType === "weekday" ? 20 : 8;
          cells.push({
            buildId,
            zoneKey: k.zoneKey,
            keyKind: area ? "area" : "camera",
            zoneId: area ? k.zoneKey.slice(5) : null,
            camera: area ? null : k.zoneKey.slice(7),
            zoneVersion: area ? (k.zoneVersion ?? 0) : null,
            cameras: [...k.cameras].sort(),
            label,
            dayType,
            hour,
            daysObserved: n,
            daysWithEvent: 0,
            eventCount: 0,
            observedMinutes: n * 60,
            dwellSamples: 0,
            durationP99Sec: null,
            ...(k.at?.(dayType, hour, label) ?? {}),
          });
        }
      }
    }
  }
  return {
    build: {
      id: buildId,
      state: "ready",
      trigger: "nightly",
      timezone: opts.tz ?? "Europe/London",
      windowFrom: opts.windowFrom ?? "2026-08-26",
      windowTo: opts.windowTo ?? "2026-09-22",
      rulesetVersion: 3,
      startedAt: at,
      finishedAt: at,
    },
    cells,
    sources: opts.sources.map((s) => ({
      sourceKey: `camera:${s.camera}`,
      camera: s.camera,
      state: s.state,
      daysObserved: s.state === "learning" ? 9 : 20,
      firstSeenAt: new Date("2026-08-01T00:00:00Z"),
      lastSeenAt: at,
      stateChangedAt: at,
    })),
  };
}
