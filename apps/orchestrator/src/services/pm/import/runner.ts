/**
 * WARP-3527 — the background half of an import.
 *
 * ── HOW A JOB RUNS ─────────────────────────────────────────────────────────
 * `POST …/run` flips the job PREVIEWED → PENDING and returns at once; this file
 * does the rest, never inside a request:
 *   - `kickImportRunner` (a `setImmediate` after the response) and the
 *     `cron-runtime` tick registered in index.ts both call `runImportTick`.
 *     The kick is for latency; the tick is for correctness: if the process dies
 *     between "Run" and the kick, the next tick claims the PENDING job.
 *   - A claim is a guarded `updateMany` (PENDING → RUNNING), atomic across
 *     replicas — the same durable-claim shape the filing worker uses, for the
 *     same reason: an advisory lock dies with the process and leaves the job
 *     stuck, a status column does not.
 *   - The runner heartbeats with every batch. A RUNNING job whose heartbeat is
 *     five minutes stale (the process restarted) is failed by the tick with a
 *     plain message; the file is kept, and "Run again" resumes at the cursor.
 *   - Every progress write is guarded on `status = RUNNING`. That one guard is
 *     the whole cancel protocol: Cancel flips the row, the runner's next write
 *     matches nothing, and it stops. A cancelled job can never be revived by a
 *     late progress write.
 *
 * ── WHAT A JOB WRITES ──────────────────────────────────────────────────────
 * Only through `pm.service.ts`: `createWorkItem` / `updateWorkItem` (sequence
 * counter, parent guard, completion sync, sanitising, activity), `createState`
 * / `updateState`, `createLabel`. No raw inserts. See `PmImportedWrite`.
 *
 * ── RE-RUN AND RESUME ARE THE SAME CODE PATH ───────────────────────────────
 * Every row has an external id (the file's, or a deterministic per-file one).
 * A row whose id exists is UPDATED, and only if something differs; the same
 * file run twice writes nothing the second time. That is also why resuming a
 * crashed run is safe even though the cursor is only persisted per batch: rows
 * of the last batch that did land come back as "unchanged".
 *
 * ── A BLANK CELL IS NOT AN ERASER ──────────────────────────────────────────
 * When updating, only what the file actually says is applied: a blank
 * assignee, due date, description or status leaves the item's own value alone,
 * labels are only ever added, and an assignee the file names but we cannot
 * resolve changes nothing. Re-importing an export must not undo what the team
 * has done in Droplet since.
 */

import type { PmImportJob, Prisma, PrismaClient } from "@prisma/client";
import { recordActivity } from "../../activity.singleton.js";
import {
  createLabel,
  createState,
  createWorkItem,
  getProject,
  isPrismaCode,
  updateState,
  updateWorkItem,
} from "../pm.service.js";
import { sanitizePmHtml } from "../sanitize-html.js";
import { loadPlanContext, readStats, describeIssue, importLogger as logger, ISSUE_CAP, type ImportStats } from "./context.js";
import { normalizeTable, orderForProcessing, textToHtml } from "./normalize.js";
import { planRows, type PlanResult, type PlannedPerson, type PlannedRow, type PlanState } from "./plan.js";
import { SOURCES, effectiveMapping, normKey } from "./sources.js";
import { loadTable } from "./upload.js";
import type { ImportMapping, ImportRecord, PmPriorityValue, PmStateGroup, SkipReason } from "./types.js";

/** Rows per batch: the unit of progress, heartbeat and cancel latency. */
export const IMPORT_CHUNK = 25;
/** A RUNNING job silent for this long is presumed dead. */
export const STALE_HEARTBEAT_MS = 5 * 60_000;
const PREVIEW_TTL_MS = 24 * 60 * 60_000;
const FAILED_FILE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_CONCURRENT_JOBS = 2;
/** Consecutive row failures that mean "the database is down", not "bad rows". */
const MAX_CONSECUTIVE_ERRORS = 5;

export const INTERRUPTED_MESSAGE =
  "The import was interrupted (the appliance restarted or the process stopped). Run it again to continue where it left off.";
const FILE_GONE_MESSAGE = "The uploaded file is no longer available. Upload it again.";
const STOPPED_MESSAGE = "The import stopped because of an unexpected error. Run it again to continue where it left off.";

const GROUP_RANK: Record<PmStateGroup, number> = {
  backlog: 0,
  unstarted: 1,
  started: 2,
  completed: 3,
  cancelled: 4,
};

const toJson = (stats: ImportStats): Prisma.InputJsonValue => stats as unknown as Prisma.InputJsonValue;

// ── pure: what an update changes ────────────────────────────────────────────

export interface DesiredFields {
  name: string;
  descriptionHtml: string | null;
  stateId?: string;
  priority?: PmPriorityValue;
  assigneeIds: string[];
  labelIds: string[];
  startDate: Date | null;
  dueDate: Date | null;
  parentId?: string;
}

export interface ExistingItem {
  name: string;
  descriptionHtml: string | null;
  stateId: string | null;
  priority: PmPriorityValue;
  parentId: string | null;
  startDate: Date | null;
  dueDate: Date | null;
  assigneeIds: string[];
  labelIds: string[];
}

export interface UpdatePatch {
  name?: string;
  descriptionHtml?: string;
  stateId?: string;
  priority?: PmPriorityValue;
  assignees?: string[];
  labelIds?: string[];
  startDate?: Date;
  dueDate?: Date;
  parentId?: string;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v) => b.includes(v));

/**
 * The minimal patch that brings an existing item in line with what the file
 * says, or null when nothing differs (the row is then "unchanged" and NOTHING
 * is written — not even an `updatedAt` bump).
 */
export function computeUpdatePatch(existing: ExistingItem, desired: DesiredFields): UpdatePatch | null {
  const patch: UpdatePatch = {};
  if (desired.name !== existing.name) patch.name = desired.name;
  if (desired.descriptionHtml !== null) {
    // compare the stored (sanitised) form, or an unchanged description would look changed forever
    if (sanitizePmHtml(desired.descriptionHtml) !== existing.descriptionHtml) {
      patch.descriptionHtml = desired.descriptionHtml;
    }
  }
  if (desired.stateId !== undefined && desired.stateId !== existing.stateId) patch.stateId = desired.stateId;
  if (desired.priority !== undefined && desired.priority !== existing.priority) patch.priority = desired.priority;
  // The file names who it is assigned to: replace the set with the people we could resolve.
  // Nobody resolved means "no information", not "unassign".
  if (desired.assigneeIds.length > 0 && !sameSet(desired.assigneeIds, existing.assigneeIds)) {
    patch.assignees = desired.assigneeIds;
  }
  // Labels are additive: the union, written only if it grows.
  const union = [...new Set([...existing.labelIds, ...desired.labelIds])];
  if (union.length !== existing.labelIds.length) patch.labelIds = union;
  if (desired.startDate && desired.startDate.getTime() !== existing.startDate?.getTime()) patch.startDate = desired.startDate;
  if (desired.dueDate && desired.dueDate.getTime() !== existing.dueDate?.getTime()) patch.dueDate = desired.dueDate;
  if (desired.parentId !== undefined && desired.parentId !== existing.parentId) patch.parentId = desired.parentId;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Where a new state goes: after the last state whose group is the same or earlier. */
export function placeNewState(current: ReadonlyArray<Pick<PlanState, "group" | "sortOrder">>, group: PmStateGroup): number {
  let after: number | undefined;
  for (const s of [...current].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (GROUP_RANK[s.group] <= GROUP_RANK[group]) after = s.sortOrder;
  }
  return after === undefined ? 0 : after + 1;
}

// ── job table helpers ───────────────────────────────────────────────────────

async function heartbeat(prisma: PrismaClient, jobId: string, stats: ImportStats): Promise<boolean> {
  const r = await prisma.pmImportJob.updateMany({
    where: { id: jobId, status: "RUNNING" },
    data: { stats: toJson(stats), heartbeatAt: new Date() },
  });
  return r.count === 1;
}

/** The runner noticed it is no longer RUNNING. If that was a cancel, keep the final counts. */
async function settleCancelled(prisma: PrismaClient, jobId: string, stats: ImportStats): Promise<void> {
  await prisma.pmImportJob.updateMany({ where: { id: jobId, status: "CANCELLED" }, data: { stats: toJson(stats) } });
}

async function audit(job: PmImportJob, severity: "ok" | "warn" | "err" | "info", what: string, sub: string | null): Promise<void> {
  await recordActivity({
    kind: "system",
    severity,
    sourceIcon: "upload",
    what,
    sub,
    refs: { jobId: job.id, projectId: job.projectId, source: job.source, fileName: job.fileName },
    actor: { type: "user", id: job.createdById },
  });
}

function summarise(stats: ImportStats): string {
  const parts = [`${stats.created} created`, `${stats.updated} updated`, `${stats.skipped} skipped`];
  return parts.join(", ");
}

// ── claim / tick ────────────────────────────────────────────────────────────

const running = new Map<string, Promise<void>>();

/** Resolves when every job started by this process has finished. Tests await it. */
export async function awaitRunningImports(): Promise<void> {
  await Promise.all([...running.values()]);
}

export async function claimJob(prisma: PrismaClient, only?: string): Promise<PmImportJob | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await prisma.pmImportJob.findFirst({
      where: { status: "PENDING", project: { kind: "PROJECT" }, ...(only ? { id: only } : {}) },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) return null;
    const now = new Date();
    const r = await prisma.pmImportJob.updateMany({
      where: { id: candidate.id, status: "PENDING", project: { kind: "PROJECT" } },
      data: { status: "RUNNING", startedAt: candidate.startedAt ?? now, heartbeatAt: now },
    });
    if (r.count === 1) {
      return { ...candidate, status: "RUNNING", startedAt: candidate.startedAt ?? now, heartbeatAt: now };
    }
    if (only) return null;
  }
  return null;
}

export interface TickResult {
  claimed: number;
  failedStale: number;
  purged: number;
}

async function failStaleJobs(prisma: PrismaClient): Promise<number> {
  const mine = [...running.keys()];
  const r = await prisma.pmImportJob.updateMany({
    where: {
      status: "RUNNING",
      heartbeatAt: { lt: new Date(Date.now() - STALE_HEARTBEAT_MS) },
      ...(mine.length > 0 ? { id: { notIn: mine } } : {}),
    },
    data: { status: "FAILED", error: INTERRUPTED_MESSAGE, finishedAt: new Date() },
  });
  return r.count;
}

/** Drop uploaded bytes nobody can use any more: abandoned previews, long-failed jobs. */
async function purgeAbandoned(prisma: PrismaClient): Promise<number> {
  const now = Date.now();
  let purged = 0;
  const abandoned = await prisma.pmImportJob.findMany({
    where: { status: "PREVIEWED", updatedAt: { lt: new Date(now - PREVIEW_TTL_MS) } },
    select: { id: true },
    take: 200,
  });
  if (abandoned.length > 0) {
    const ids = abandoned.map((j) => j.id);
    await prisma.pmImportJob.updateMany({
      where: { id: { in: ids }, status: "PREVIEWED" },
      data: { status: "CANCELLED", finishedAt: new Date() },
    });
    purged += (await prisma.pmImportJobFile.deleteMany({ where: { jobId: { in: ids } } })).count;
  }
  const failed = await prisma.pmImportJobFile.deleteMany({
    where: { job: { status: "FAILED", updatedAt: { lt: new Date(now - FAILED_FILE_TTL_MS) } } },
  });
  return purged + failed.count;
}

function track(prisma: PrismaClient, job: PmImportJob): Promise<void> {
  const p = executeImportJob(prisma, job)
    .catch((err: unknown) => logger.error({ err, jobId: job.id }, "import job crashed outside its handler"))
    .finally(() => running.delete(job.id));
  running.set(job.id, p);
  return p;
}

/** One pass: fail the dead, purge the abandoned, start what is waiting. Never awaits a job. */
export async function runImportTick(prisma: PrismaClient): Promise<TickResult> {
  const failedStale = await failStaleJobs(prisma);
  const purged = await purgeAbandoned(prisma);
  let claimed = 0;
  while (running.size < MAX_CONCURRENT_JOBS) {
    const job = await claimJob(prisma);
    if (!job) break;
    claimed += 1;
    void track(prisma, job);
  }
  return { claimed, failedStale, purged };
}

/** After the response: start the job now rather than at the next tick. */
export function kickImportRunner(prisma: PrismaClient): void {
  setImmediate(() => {
    void runImportTick(prisma).catch((err: unknown) => logger.error({ err }, "import runner kick failed"));
  });
}

/** Claim one job and run it to the end. Awaited — for tests and scripts. */
export async function runImportJob(prisma: PrismaClient, jobId: string): Promise<boolean> {
  const job = await claimJob(prisma, jobId);
  if (!job) return false;
  await track(prisma, job);
  return true;
}

// ── states and labels ───────────────────────────────────────────────────────

async function ensureStates(
  prisma: PrismaClient,
  projectId: string,
  plan: PlanResult,
  stats: ImportStats,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const ns of plan.newStates) {
    const key = normKey(ns.name);
    const current = await prisma.pmState.findMany({ where: { projectId }, orderBy: { sortOrder: "asc" } });
    const hit = current.find((s) => normKey(s.name) === key);
    if (hit) {
      out.set(key, hit.id);
      continue;
    }
    const sortOrder = placeNewState(current, ns.group);
    for (const s of current) {
      if (s.sortOrder >= sortOrder) await updateState(prisma, s.id, { sortOrder: s.sortOrder + 1 });
    }
    try {
      const created = await createState(prisma, projectId, { name: ns.name, group: ns.group, sortOrder });
      out.set(key, created.id);
      stats.createdStates.push(created.name);
    } catch (err) {
      if (!isPrismaCode(err, "P2002")) throw err;
      const again = await prisma.pmState.findFirst({ where: { projectId, name: ns.name } });
      if (!again) throw err;
      out.set(key, again.id);
    }
  }
  return out;
}

async function ensureLabels(
  prisma: PrismaClient,
  projectId: string,
  plan: PlanResult,
  existing: ReadonlyArray<{ id: string; name: string }>,
  stats: ImportStats,
): Promise<Map<string, string>> {
  const out = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
  for (const name of plan.newLabels) {
    if (out.has(name.toLowerCase())) continue;
    try {
      const created = await createLabel(prisma, projectId, { name });
      out.set(name.toLowerCase(), created.id);
      stats.createdLabels.push(created.name);
    } catch (err) {
      if (!isPrismaCode(err, "P2002")) throw err;
      const again = await prisma.pmLabel.findFirst({ where: { projectId, name } });
      if (!again) throw err;
      out.set(name.toLowerCase(), again.id);
    }
  }
  return out;
}

// ── the row loop ────────────────────────────────────────────────────────────

function addIssue(stats: ImportStats, rec: ImportRecord, code: string, detail?: string): void {
  if (stats.issues.length >= ISSUE_CAP) {
    stats.issuesTruncated = true;
    return;
  }
  stats.issues.push({
    row: rec.row,
    key: rec.externalId.startsWith("file:") ? null : rec.externalId,
    code,
    message: describeIssue(code, detail),
  });
}

function bumpSkip(stats: ImportStats, reason: SkipReason): void {
  stats.skipped += 1;
  stats.skippedReasons[reason] = (stats.skippedReasons[reason] ?? 0) + 1;
}

function noteUnknownAssignee(stats: ImportStats, person: PlannedPerson): void {
  const reason = person.detail ?? "no active member matches";
  const entry = stats.unknownAssignees.find((u) => u.value === person.value);
  if (entry) entry.count += 1;
  else stats.unknownAssignees.push({ value: person.value, count: 1, reason });
}

const problemCode = (p: PlannedPerson): string =>
  p.by === "ambiguous" ? "assignee_ambiguous" : p.by === "ineligible" ? "assignee_ineligible" : "assignee_not_found";

interface RowEnv {
  prisma: PrismaClient;
  job: PmImportJob;
  system: string;
  stats: ImportStats;
  planned: Map<ImportRecord, PlannedRow>;
  stateIdByKey: Map<string, string>;
  labelIdByName: Map<string, string>;
  /** external id → work item id, for parents (this file's, or earlier imports'). */
  idByExternal: Map<string, string>;
}

type ExistingRow = Prisma.PmWorkItemGetPayload<{ include: { assignees: true; labels: true } }>;

function desiredFor(env: RowEnv, rec: ImportRecord, p: PlannedRow, parentId: string | undefined): DesiredFields {
  let stateId: string | undefined;
  if (p.status) {
    const d = p.status.decision;
    if (d.kind === "state") stateId = d.stateId;
    else if (d.kind === "create") stateId = env.stateIdByKey.get(normKey(d.name));
  }
  const labelIds: string[] = [];
  for (const name of p.labels) {
    const id = env.labelIdByName.get(name.toLowerCase());
    if (id && !labelIds.includes(id)) labelIds.push(id);
  }
  return {
    name: rec.name,
    descriptionHtml: textToHtml(rec.descriptionText),
    stateId,
    priority: p.priority ?? undefined,
    assigneeIds: [...new Set(p.assignees.flatMap((a) => (a.userId ? [a.userId] : [])))],
    labelIds,
    startDate: rec.startDate,
    dueDate: rec.dueDate,
    parentId,
  };
}

async function processRecord(
  env: RowEnv,
  rec: ImportRecord,
  existing: ExistingRow | undefined,
): Promise<"created" | "updated" | "unchanged"> {
  const { prisma, job, stats } = env;
  const p = env.planned.get(rec) as PlannedRow;
  const marker = { jobId: job.id, source: job.source };

  for (const i of rec.issues) addIssue(stats, rec, i.code, i.detail);
  for (const a of p.assignees) {
    if (a.userId !== null || a.by === "override") continue;
    noteUnknownAssignee(stats, a);
    addIssue(stats, rec, problemCode(a), a.value);
  }

  let parentId: string | undefined;
  const parentKey = rec.parentExternalId ?? rec.parentRef;
  if (parentKey) {
    parentId = env.idByExternal.get(parentKey);
    if (!parentId) addIssue(stats, rec, "parent_unresolved", rec.parentRef ?? parentKey);
  }

  const desired = desiredFor(env, rec, p, parentId);

  if (!existing) {
    const created = await createWorkItem(prisma, job.createdById, job.projectId, {
      name: desired.name,
      descriptionHtml: desired.descriptionHtml ?? undefined,
      stateId: desired.stateId,
      priority: desired.priority,
      assignees: desired.assigneeIds.length > 0 ? desired.assigneeIds : undefined,
      labelIds: desired.labelIds.length > 0 ? desired.labelIds : undefined,
      parentId: desired.parentId,
      startDate: desired.startDate ?? undefined,
      dueDate: desired.dueDate ?? undefined,
      imported: {
        ...marker,
        externalSystem: env.system,
        externalId: rec.externalId,
        createdById: p.reporter?.userId ?? null,
        createdAt: rec.createdAt ?? undefined,
        updatedAt: rec.updatedAt ?? undefined,
        completedAt: rec.completedAt ?? undefined,
      },
    });
    env.idByExternal.set(rec.externalId, created.id);
    return "created";
  }

  env.idByExternal.set(rec.externalId, existing.id);
  const patch = computeUpdatePatch(
    {
      name: existing.name,
      descriptionHtml: existing.descriptionHtml,
      stateId: existing.stateId,
      priority: existing.priority,
      parentId: existing.parentId,
      startDate: existing.startDate,
      dueDate: existing.dueDate,
      assigneeIds: existing.assignees.map((a) => a.userId),
      labelIds: existing.labels.map((l) => l.labelId),
    },
    desired,
  );
  if (!patch) return "unchanged";
  await updateWorkItem(prisma, job.createdById, existing.id, patch, { imported: marker });
  return "updated";
}

async function loadExisting(
  prisma: PrismaClient,
  job: PmImportJob,
  system: string,
  chunk: readonly ImportRecord[],
  idByExternal: Map<string, string>,
): Promise<Map<string, ExistingRow>> {
  const wanted = new Set(chunk.map((r) => r.externalId));
  // parents that are not in memory yet: from an earlier run of this job, or an earlier import
  for (const r of chunk) {
    const k = r.parentExternalId ?? r.parentRef;
    if (k && !idByExternal.has(k)) wanted.add(k);
  }
  const rows = await prisma.pmWorkItem.findMany({
    where: { projectId: job.projectId, externalSystem: system, externalId: { in: [...wanted] } },
    include: { assignees: true, labels: true },
  });
  const own = new Set(chunk.map((r) => r.externalId));
  const byExternal = new Map<string, ExistingRow>();
  for (const row of rows) {
    if (!row.externalId) continue;
    idByExternal.set(row.externalId, row.id);
    if (own.has(row.externalId)) byExternal.set(row.externalId, row);
  }
  return byExternal;
}

/** Run one claimed (RUNNING) native Project job to its end. */
export async function executeImportJob(prisma: PrismaClient, job: PmImportJob): Promise<void> {
  // A directly invoked or stale queued job must pass the same native Projects
  // boundary before its file/context is read or any state/label/item is written.
  await getProject(prisma, job.projectId);
  const stats = readStats(job.stats);
  const fail = async (message: string): Promise<void> => {
    const r = await prisma.pmImportJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: { status: "FAILED", error: message, finishedAt: new Date(), stats: toJson(stats) },
    });
    if (r.count === 1) await audit(job, "err", "Work item import failed", message);
  };

  try {
    const file = await prisma.pmImportJobFile.findUnique({ where: { jobId: job.id } });
    if (!file) return await fail(FILE_GONE_MESSAGE);

    const descriptor = SOURCES[job.source];
    const table = loadTable(Buffer.from(file.bytes), job.source);
    const mapping = effectiveMapping(job.source, table.headers, (job.mapping ?? {}) as Partial<ImportMapping>);
    const norm = normalizeTable(table, job.source, mapping, job.fileSha256);
    const ctx = await loadPlanContext(prisma, job.projectId);
    const plan = planRows(norm.records, job.source, mapping, ctx);
    const planned = new Map(plan.rows.map((p) => [p.record, p]));

    if (!stats.begun) {
      stats.begun = true;
      stats.totalRows = norm.records.length;
      for (const r of norm.records) {
        if (!r.skip) continue;
        bumpSkip(stats, r.skip.reason);
        addIssue(stats, r, r.skip.reason, r.skip.detail);
      }
      await audit(job, "info", "Work item import started", `${job.fileName} · ${descriptor.label}`);
    }

    const stateIdByKey = await ensureStates(prisma, job.projectId, plan, stats);
    const labelIdByName = await ensureLabels(prisma, job.projectId, plan, ctx.labels, stats);

    const order = orderForProcessing(norm.records);
    stats.toProcess = order.length;
    if (!(await heartbeat(prisma, job.id, stats))) return await settleCancelled(prisma, job.id, stats);

    const env: RowEnv = {
      prisma,
      job,
      system: descriptor.system,
      stats,
      planned,
      stateIdByKey,
      labelIdByName,
      idByExternal: new Map(),
    };

    let consecutiveErrors = 0;
    for (let i = stats.processed; i < order.length; i += IMPORT_CHUNK) {
      const chunk = order.slice(i, i + IMPORT_CHUNK);
      const existing = await loadExisting(prisma, job, descriptor.system, chunk, env.idByExternal);
      for (const rec of chunk) {
        try {
          const outcome = await processRecord(env, rec, existing.get(rec.externalId));
          consecutiveErrors = 0;
          if (outcome === "created") stats.created += 1;
          else if (outcome === "updated") stats.updated += 1;
          else bumpSkip(stats, "unchanged");
        } catch (err) {
          consecutiveErrors += 1;
          const code = err instanceof Error ? err.message : "unknown";
          logger.warn({ err, jobId: job.id, row: rec.row }, "import row failed");
          addIssue(stats, rec, "error", code.length > 80 ? "unexpected error" : code);
          bumpSkip(stats, "error");
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            throw new Error(`${MAX_CONSECUTIVE_ERRORS} rows in a row failed`);
          }
        }
        stats.processed += 1;
      }
      if (!(await heartbeat(prisma, job.id, stats))) return await settleCancelled(prisma, job.id, stats);
    }

    const done = await prisma.pmImportJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: { status: "SUCCEEDED", finishedAt: new Date(), heartbeatAt: new Date(), error: null, stats: toJson(stats) },
    });
    if (done.count === 1) {
      await prisma.pmImportJobFile.deleteMany({ where: { jobId: job.id } });
      await audit(job, stats.skippedReasons.error ? "warn" : "ok", "Work item import finished", `${job.fileName} · ${summarise(stats)}`);
    } else {
      await settleCancelled(prisma, job.id, stats);
    }
  } catch (err) {
    logger.error({ err, jobId: job.id }, "import job failed");
    const message = err instanceof Error && err.name === "ImportParseError" ? err.message : STOPPED_MESSAGE;
    await fail(message).catch((e: unknown) => logger.error({ err: e, jobId: job.id }, "could not record import failure"));
  }
}
