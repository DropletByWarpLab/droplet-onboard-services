/**
 * WARP-3527 — what the importer reads from the database, and the wire shapes
 * of a job. Reads only: every write the importer makes goes through
 * `pm.service.ts` (work items, states, labels) or the job table itself.
 */

import type { PmImportJob, PrismaClient } from "@prisma/client";
import { createLogger } from "../../../lib/logger.js";
import { readUserEmail } from "../../user-directory.service.js";
import type { PlanContext, PlanUser } from "./plan.js";
import type { ImportMapping, ImportSource } from "./types.js";

const logger = createLogger("pm-import");

/** Who can be assigned work by an import: active, and not a guest or service principal. */
const ASSIGNABLE_ROLES = new Set(["owner", "admin", "family"]);

const USER_CAP = 5000;

export async function loadPlanContext(prisma: PrismaClient, projectId: string): Promise<PlanContext> {
  const [states, labels, users] = await Promise.all([
    prisma.pmState.findMany({ where: { projectId }, orderBy: { sortOrder: "asc" } }),
    prisma.pmLabel.findMany({ where: { projectId }, select: { id: true, name: true } }),
    prisma.user.findMany({
      where: { role: { not: "service" } },
      select: { id: true, username: true, displayName: true, email: true, role: true, directoryStatus: true },
      orderBy: { createdAt: "asc" },
      take: USER_CAP,
    }),
  ]);
  const planUsers: PlanUser[] = users.map((u) => {
    let email: string | null = null;
    try {
      email = readUserEmail(u.email);
    } catch {
      // an undecryptable email only costs the email match tier for this person
      email = null;
    }
    const active = u.directoryStatus === "ACTIVE";
    const assignable = ASSIGNABLE_ROLES.has(u.role);
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      email,
      eligible: active && assignable,
      ...(active ? (assignable ? {} : { ineligibleReason: "guest" as const }) : { ineligibleReason: "deactivated" as const }),
    };
  });
  return {
    states: states.map((s) => ({
      id: s.id,
      name: s.name,
      group: s.group,
      isDefault: s.isDefault,
      sortOrder: s.sortOrder,
    })),
    labels,
    users: planUsers,
  };
}

// ── job wire shape ──────────────────────────────────────────────────────────

export interface ImportIssue {
  row: number;
  /** The item's id in the source (`PAY-3`), when it has one worth showing. */
  key: string | null;
  code: string;
  message: string;
}

export interface ImportStats {
  /** True once the runner has read the file and counted it — the "fresh start" flag. */
  begun: boolean;
  totalRows: number;
  /** Rows that will go through the loop (the rest were skipped up front). */
  toProcess: number;
  /** Rows handled so far. Also the resume cursor into the processing order. */
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  issues: ImportIssue[];
  issuesTruncated: boolean;
  unknownAssignees: Array<{ value: string; count: number; reason: string }>;
  createdStates: string[];
  createdLabels: string[];
}

export const ISSUE_CAP = 200;

export function emptyStats(): ImportStats {
  return {
    begun: false,
    totalRows: 0,
    toProcess: 0,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    skippedReasons: {},
    issues: [],
    issuesTruncated: false,
    unknownAssignees: [],
    createdStates: [],
    createdLabels: [],
  };
}

/** Read `PmImportJob.stats` back; anything missing falls to the empty default. */
export function readStats(raw: unknown): ImportStats {
  const base = emptyStats();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return base;
  return { ...base, ...(raw as Partial<ImportStats>) };
}

export interface ApiImportJob {
  id: string;
  projectId: string;
  source: ImportSource;
  status: PmImportJob["status"];
  fileName: string;
  fileBytes: number;
  mapping: Partial<ImportMapping>;
  stats: ImportStats;
  error: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function toApiJob(row: PmImportJob): ApiImportJob {
  return {
    id: row.id,
    projectId: row.projectId,
    source: row.source,
    status: row.status,
    fileName: row.fileName,
    fileBytes: row.fileBytes,
    mapping: (row.mapping ?? {}) as Partial<ImportMapping>,
    stats: readStats(row.stats),
    error: row.error,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/** One plain sentence per row-level issue code, for the summary and preview. */
export function describeIssue(code: string, detail?: string): string {
  switch (code) {
    case "invalid_date":
      return `The ${detail ?? "date"} couldn't be read and was left empty.`;
    case "title_truncated":
      return "The title was longer than 500 characters and was shortened.";
    case "description_truncated":
      return "The description was very long and was shortened.";
    case "parent_unresolved":
      return `The parent "${detail ?? ""}" isn't in this file or in an earlier import, so the item has no parent.`;
    case "parent_cycle":
      return "The parent links in the file form a loop, so this item was imported without a parent.";
    case "parent_self":
      return "The item names itself as its parent, so it was imported without one.";
    case "label_truncated":
      return `A label was longer than 100 characters and was shortened to "${detail ?? ""}".`;
    case "assignee_not_found":
      return `No member matches "${detail ?? ""}", so the item was left unassigned for them.`;
    case "assignee_ambiguous":
      return `More than one member matches "${detail ?? ""}", so the item was left unassigned for them.`;
    case "assignee_ineligible":
      return `"${detail ?? ""}" is a guest or deactivated account, so the item was left unassigned for them.`;
    case "archived_in_source":
      return "Archived in the source.";
    case "missing_title":
      return "The row has no title.";
    case "duplicate_id_in_file":
      return `The same id appears earlier in the file (${detail ?? "earlier row"}).`;
    case "unchanged":
      return "Already imported and unchanged.";
    case "error":
      return detail ? `Couldn't be saved: ${detail}` : "Couldn't be saved.";
    default:
      return code;
  }
}

export { logger as importLogger };
