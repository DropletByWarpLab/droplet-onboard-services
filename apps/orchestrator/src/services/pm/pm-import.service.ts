/**
 * WARP-3527 (ADR-069 WS-11) — import jobs: upload, preview, adjust, run,
 * poll, cancel. The pipeline itself lives in `./import/`; this file is the job
 * lifecycle on top of it and the errors the route layer maps to HTTP.
 *
 *   upload ──► PREVIEWED ──(adjust source / mapping, any number of times)──┐
 *                  │                                                       │
 *                  └──────────────run──► PENDING ──► RUNNING ──► SUCCEEDED │
 *                                          ▲            ├──► FAILED ──run──┘ (resume)
 *                      cancel ──► CANCELLED ◄───────────┘
 *
 * Every transition is ONE guarded `updateMany` (status in the WHERE), never a
 * read-then-write: two tabs, a double-click, or the runner racing a cancel all
 * resolve in the database, and the loser gets a 409 instead of a lost update.
 *
 * Errors are plain `Error(code)` like the rest of the PM service, mapped to
 * HTTP by `routes/pm/import-export.ts`:
 *   project_not_found | import_job_not_found 404
 *   import_not_editable | import_not_startable | import_in_progress |
 *   import_not_cancellable | import_file_expired                       409/410
 *   invalid_import_mapping                                             422
 *   plus `ImportParseError` (a file we cannot read)                    422
 */

import { createHash } from "node:crypto";
import type { PmImportJob, Prisma, PrismaClient } from "@prisma/client";
import { PM_ERRORS, getProject, isPrismaCode } from "./pm.service.js";
import { buildAnalysis, type ImportAnalysis } from "./import/analysis.js";
import { loadPlanContext, toApiJob, type ApiImportJob } from "./import/context.js";
import type { PlanContext } from "./import/plan.js";
import { kickImportRunner } from "./import/runner.js";
import type { ImportMapping, ImportSource } from "./import/types.js";
import { loadTable, parseUpload } from "./import/upload.js";

export const PM_IMPORT_ERRORS = {
  JOB_NOT_FOUND: "import_job_not_found",
  /** Mapping and source can only change while the job is waiting for the owner. */
  NOT_EDITABLE: "import_not_editable",
  NOT_STARTABLE: "import_not_startable",
  /** One import at a time per project (the partial unique index). */
  IN_PROGRESS: "import_in_progress",
  NOT_CANCELLABLE: "import_not_cancellable",
  /** The uploaded bytes were purged (abandoned preview, week-old failure). */
  FILE_EXPIRED: "import_file_expired",
  INVALID_MAPPING: "invalid_import_mapping",
} as const;

/** The owner's mapping is structurally fine but refers to something that is not there. */
export class InvalidImportMappingError extends Error {
  constructor(readonly problems: string[]) {
    super(PM_IMPORT_ERRORS.INVALID_MAPPING);
    this.name = "InvalidImportMappingError";
  }
}

/** What the browser called the file, made safe to store and show: no path, no control characters. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const printable = [...base].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("");
  return printable.trim().slice(0, 200) || "import";
}

/** Everything in a mapping that cannot be checked by shape alone. */
export function validateMapping(
  mapping: Partial<ImportMapping>,
  headers: readonly string[],
  ctx: PlanContext,
): string[] {
  const problems: string[] = [];
  const headerSet = new Set(headers);
  for (const cols of Object.values(mapping.columns ?? {})) {
    for (const c of cols ?? []) {
      if (!headerSet.has(c)) problems.push(`There is no column named "${c}" in this file.`);
    }
  }
  const stateIds = new Set(ctx.states.map((s) => s.id));
  for (const [key, d] of Object.entries(mapping.statuses ?? {})) {
    if (d.kind === "state" && !stateIds.has(d.stateId)) {
      problems.push(`The state chosen for "${key}" isn't in this project.`);
    }
    if (d.kind === "create" && d.name.trim() === "") problems.push(`The new state for "${key}" needs a name.`);
  }
  const eligible = new Set(ctx.users.filter((u) => u.eligible).map((u) => u.id));
  for (const [key, id] of Object.entries(mapping.people ?? {})) {
    if (id !== null && !eligible.has(id)) problems.push(`"${key}" can only be assigned to an active member.`);
  }
  return problems;
}

async function loadJob(prisma: PrismaClient, jobId: string): Promise<PmImportJob> {
  const row = await prisma.pmImportJob.findUnique({ where: { id: jobId } });
  if (!row) throw new Error(PM_IMPORT_ERRORS.JOB_NOT_FOUND);
  try {
    await getProject(prisma, row.projectId);
  } catch (err) {
    if (err instanceof Error && err.message === PM_ERRORS.PROJECT_NOT_FOUND) throw new Error(PM_IMPORT_ERRORS.JOB_NOT_FOUND);
    throw err;
  }
  return row;
}

async function loadFile(prisma: PrismaClient, jobId: string): Promise<Buffer> {
  const file = await prisma.pmImportJobFile.findUnique({ where: { jobId } });
  if (!file) throw new Error(PM_IMPORT_ERRORS.FILE_EXPIRED);
  return Buffer.from(file.bytes);
}

export async function getImportJob(prisma: PrismaClient, jobId: string): Promise<ApiImportJob> {
  return toApiJob(await loadJob(prisma, jobId));
}

export async function listImportJobs(prisma: PrismaClient, projectId: string, limit = 10): Promise<ApiImportJob[]> {
  await getProject(prisma, projectId);
  const rows = await prisma.pmImportJob.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(50, limit)),
  });
  return rows.map(toApiJob);
}

/**
 * Accept an upload: parse it (a file we cannot read is refused here and
 * nothing is stored), keep the bytes for the preview and the run, and answer
 * with the first analysis. The same user's earlier unrun previews on this
 * project are superseded, so abandoned uploads do not pile up.
 */
export async function createImportJob(
  prisma: PrismaClient,
  actorId: string,
  projectId: string,
  upload: { fileName: string; buffer: Buffer; source?: ImportSource },
): Promise<{ job: ApiImportJob; analysis: ImportAnalysis }> {
  await getProject(prisma, projectId);

  const parsed = parseUpload(upload.buffer, upload.source);
  const sha = createHash("sha256").update(upload.buffer).digest("hex");

  const row = await prisma.$transaction(async (tx) => {
    const earlier = await tx.pmImportJob.findMany({
      where: { projectId, createdById: actorId, status: "PREVIEWED" },
      select: { id: true },
    });
    if (earlier.length > 0) {
      const ids = earlier.map((j) => j.id);
      await tx.pmImportJob.updateMany({
        where: { id: { in: ids }, status: "PREVIEWED" },
        data: { status: "CANCELLED", finishedAt: new Date() },
      });
      await tx.pmImportJobFile.deleteMany({ where: { jobId: { in: ids } } });
    }
    return tx.pmImportJob.create({
      data: {
        projectId,
        source: parsed.source,
        status: "PREVIEWED",
        fileName: cleanFileName(upload.fileName),
        fileBytes: upload.buffer.length,
        fileSha256: sha,
        createdById: actorId,
        file: { create: { bytes: upload.buffer } },
      },
    });
  });

  const analysis = await buildAnalysis(prisma, row, parsed.table, parsed.detected);
  return { job: toApiJob(row), analysis };
}

/** Change the source preset and/or the mapping of a job still awaiting Run; returns the fresh analysis. */
export async function updateImportJob(
  prisma: PrismaClient,
  jobId: string,
  patch: { source?: ImportSource; mapping?: Partial<ImportMapping> },
): Promise<{ job: ApiImportJob; analysis: ImportAnalysis }> {
  const job = await loadJob(prisma, jobId);
  if (job.status !== "PREVIEWED") throw new Error(PM_IMPORT_ERRORS.NOT_EDITABLE);
  const bytes = await loadFile(prisma, jobId);

  const source = patch.source ?? job.source;
  const table = loadTable(bytes, source); // wrong_format / unreadable → ImportParseError
  // Changing the preset starts that preset's mapping over; the owner's old column choices described another tool's headers.
  const saved: Partial<ImportMapping> =
    patch.mapping ?? (patch.source && patch.source !== job.source ? {} : ((job.mapping ?? {}) as Partial<ImportMapping>));

  const problems = validateMapping(saved, table.headers, await loadPlanContext(prisma, job.projectId));
  if (problems.length > 0) throw new InvalidImportMappingError(problems);

  const updated = await prisma.pmImportJob.updateMany({
    where: { id: jobId, status: "PREVIEWED" },
    data: { source, mapping: saved as unknown as Prisma.InputJsonValue },
  });
  if (updated.count === 0) throw new Error(PM_IMPORT_ERRORS.NOT_EDITABLE);

  const fresh = await loadJob(prisma, jobId);
  const detected = parseUpload(bytes, source).detected;
  const analysis = await buildAnalysis(prisma, fresh, table, detected);
  return { job: toApiJob(fresh), analysis };
}

/**
 * Press Run: PREVIEWED → PENDING (or FAILED → PENDING to resume). Returns at
 * once; the runner picks the job up after the response (`kick`) or at the next
 * cron tick. One import at a time per project: the partial unique index turns
 * a second Run into `import_in_progress`.
 */
export async function startImportJob(
  prisma: PrismaClient,
  jobId: string,
  patch: { mapping?: Partial<ImportMapping> } = {},
  opts: { kick?: boolean } = {},
): Promise<ApiImportJob> {
  const job = await loadJob(prisma, jobId);
  if (job.status !== "PREVIEWED" && job.status !== "FAILED") throw new Error(PM_IMPORT_ERRORS.NOT_STARTABLE);
  const bytes = await loadFile(prisma, jobId);

  // A resumed run keeps the mapping it started with: the cursor refers to it.
  let mapping = (job.mapping ?? {}) as Partial<ImportMapping>;
  if (job.status === "PREVIEWED" && patch.mapping) {
    const table = loadTable(bytes, job.source);
    const problems = validateMapping(patch.mapping, table.headers, await loadPlanContext(prisma, job.projectId));
    if (problems.length > 0) throw new InvalidImportMappingError(problems);
    mapping = patch.mapping;
  }

  try {
    const r = await prisma.pmImportJob.updateMany({
      where: { id: jobId, status: job.status },
      data: {
        status: "PENDING",
        mapping: mapping as unknown as Prisma.InputJsonValue,
        error: null,
        finishedAt: null,
        heartbeatAt: null,
      },
    });
    if (r.count === 0) throw new Error(PM_IMPORT_ERRORS.NOT_STARTABLE);
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error(PM_IMPORT_ERRORS.IN_PROGRESS);
    throw err;
  }
  if (opts.kick !== false) kickImportRunner(prisma);
  return getImportJob(prisma, jobId);
}

/**
 * Cancel a job that has not finished. A RUNNING one stops at its next batch
 * (its progress write is guarded on RUNNING and now matches nothing); rows
 * already written stay — a cancel stops an import, it does not undo one.
 */
export async function cancelImportJob(prisma: PrismaClient, jobId: string): Promise<ApiImportJob> {
  await loadJob(prisma, jobId);
  const r = await prisma.pmImportJob.updateMany({
    where: { id: jobId, status: { in: ["PREVIEWED", "PENDING", "RUNNING", "FAILED"] } },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
  if (r.count === 0) {
    await loadJob(prisma, jobId); // 404 if there is no such job…
    throw new Error(PM_IMPORT_ERRORS.NOT_CANCELLABLE); // …409 if it already finished
  }
  await prisma.pmImportJobFile.deleteMany({ where: { jobId } });
  return getImportJob(prisma, jobId);
}
