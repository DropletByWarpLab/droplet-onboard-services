/**
 * WARP-3527 — everything the wizard shows between "file uploaded" and "Run":
 * the columns it found, the mapping it will use, what each distinct status /
 * priority / person resolves to, the first 20 rows as they will land, and the
 * counts. Computed fresh on every call (it depends on the project's states and
 * members as they are right now) and never stored.
 *
 * The runner calls the SAME normalize + plan functions, so the screen and the
 * run cannot disagree.
 */

import type { PrismaClient } from "@prisma/client";
import { loadPlanContext } from "./context.js";
import { describeIssue } from "./context.js";
import { normalizeTable } from "./normalize.js";
import {
  planRows,
  type PlannedPersonSummary,
  type PlannedPriority,
  type PlannedStatus,
} from "./plan.js";
import { SOURCES, effectiveMapping } from "./sources.js";
import type {
  DateOrder,
  ImportMapping,
  ImportSource,
  ImportTable,
  PmPriorityValue,
  PmStateGroup,
} from "./types.js";
import { IMPORT_SOURCES } from "./types.js";

export const PREVIEW_ROWS = 20;

export interface PreviewRow {
  row: number;
  key: string;
  name: string;
  action: "create" | "update" | "skip";
  skipReason: string | null;
  status: { text: string; isNew: boolean } | null;
  priority: PmPriorityValue | null;
  assignees: Array<{ value: string; name: string | null; problem: string | null }>;
  labels: string[];
  dueDate: string | null;
  parent: string | null;
  issues: string[];
}

export interface ImportAnalysis {
  source: ImportSource;
  /** What the file's content looks like, independent of what was chosen. */
  detected: ImportSource;
  sources: Array<{ id: ImportSource; label: string; hint: string; compatible: boolean }>;
  /** Distinct header names in file order (a repeated Jira `Labels` column is one entry). */
  columns: string[];
  /** The mapping that will run: the owner's choices over the preset. */
  mapping: ImportMapping;
  dateOrder: { order: DateOrder; ambiguous: boolean; inferred: boolean };
  totalRows: number;
  fileWarnings: string[];
  states: Array<{ id: string; name: string; group: PmStateGroup }>;
  members: Array<{ id: string; name: string }>;
  statuses: PlannedStatus[];
  priorities: PlannedPriority[];
  people: PlannedPersonSummary[];
  newStates: Array<{ name: string; group: PmStateGroup }>;
  newLabels: string[];
  droppedLabels: string[];
  counts: { create: number; update: number; skip: number; parentsOutsideFile: number };
  /** Plain-language things to know before pressing Run. */
  notes: string[];
  preview: PreviewRow[];
}

const CHUNK = 1000;

/** Which of these external ids already exist on the project (a re-import updates them). */
export async function existingExternalIds(
  prisma: PrismaClient,
  projectId: string,
  system: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await prisma.pmWorkItem.findMany({
      where: { projectId, externalSystem: system, externalId: { in: ids.slice(i, i + CHUNK) } },
      select: { externalId: true },
    });
    for (const r of rows) if (r.externalId) found.add(r.externalId);
  }
  return found;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export async function buildAnalysis(
  prisma: PrismaClient,
  job: { projectId: string; source: ImportSource; fileSha256: string; mapping: unknown },
  table: ImportTable,
  detected: ImportSource,
): Promise<ImportAnalysis> {
  const descriptor = SOURCES[job.source];
  const mapping = effectiveMapping(job.source, table.headers, (job.mapping ?? {}) as Partial<ImportMapping>);
  const norm = normalizeTable(table, job.source, mapping, job.fileSha256);
  const ctx = await loadPlanContext(prisma, job.projectId);
  const plan = planRows(norm.records, job.source, mapping, ctx);

  const live = norm.records.filter((r) => r.skip === null);
  const existing = await existingExternalIds(
    prisma,
    job.projectId,
    descriptor.system,
    live.map((r) => r.externalId),
  );

  const counts = { create: 0, update: 0, skip: 0, parentsOutsideFile: 0 };
  const skipReasons = new Map<string, number>();
  for (const r of norm.records) {
    if (r.skip) {
      counts.skip += 1;
      skipReasons.set(r.skip.reason, (skipReasons.get(r.skip.reason) ?? 0) + 1);
    } else {
      if (existing.has(r.externalId)) counts.update += 1;
      else counts.create += 1;
      if (r.parentRef && !r.parentExternalId) counts.parentsOutsideFile += 1;
    }
  }

  const stateName = (key: string): { text: string; isNew: boolean } | null => {
    const s = plan.statuses.find((x) => x.key === key);
    if (!s) return null;
    if (s.decision.kind === "create") return { text: s.decision.name, isNew: true };
    return { text: s.stateName ?? ctx.states.find((x) => x.isDefault)?.name ?? "Default", isNew: false };
  };

  const preview: PreviewRow[] = plan.rows.slice(0, PREVIEW_ROWS).map((p) => {
    const rec = p.record;
    const action: PreviewRow["action"] = rec.skip ? "skip" : existing.has(rec.externalId) ? "update" : "create";
    return {
      row: rec.row,
      key: rec.externalId.startsWith("file:") ? "" : rec.externalId,
      name: rec.name,
      action,
      skipReason: rec.skip ? describeIssue(rec.skip.reason, rec.skip.detail) : null,
      status: p.status ? stateName(p.status.key) : null,
      priority: p.priority,
      assignees: p.assignees.map((a) => ({
        value: a.value,
        name: a.displayName ?? null,
        problem: a.userId ? null : (a.detail ?? "no member matches"),
      })),
      labels: p.labels,
      dueDate: rec.dueDate ? rec.dueDate.toISOString().slice(0, 10) : null,
      parent: rec.parentExternalId ?? rec.parentRef,
      issues: rec.issues.map((i) => describeIssue(i.code, i.detail)),
    };
  });

  // ── notes ──
  const notes: string[] = [];
  for (const [reason, n] of skipReasons) {
    notes.push(`${plural(n, "row", "rows")} will be skipped: ${describeIssue(reason).replace(/\.$/, "").toLowerCase()}.`);
  }
  if (norm.dateOrder.ambiguous) {
    notes.push("Dates like 03/04/2024 can be read day first or month first. Month first is assumed. Change it in the mapping if that's wrong.");
  }
  const badDates = norm.records.reduce((n, r) => n + r.issues.filter((i) => i.code === "invalid_date").length, 0);
  if (badDates > 0) notes.push(`${plural(badDates, "date", "dates")} couldn't be read and will be left empty.`);
  const unknownPriorities = plan.priorities.filter((p) => !p.known);
  if (unknownPriorities.length > 0) {
    notes.push(`Priority ${unknownPriorities.map((p) => `"${p.value}"`).join(", ")} isn't recognised and will be set to none. Pick a priority for it below.`);
  }
  const unmatched = plan.people.filter((p) => p.userId === null && p.by !== "override");
  if (unmatched.length > 0) {
    notes.push(
      `${plural(unmatched.length, "person", "people")} in the file ${unmatched.length === 1 ? "doesn't" : "don't"} match an active member. Their items will be imported unassigned for them and listed in the summary. Add them and import again to assign.`,
    );
  }
  if (counts.parentsOutsideFile > 0) {
    notes.push(`${plural(counts.parentsOutsideFile, "item names", "items name")} a parent that isn't in this file. It is linked if that parent was imported earlier.`);
  }
  if (plan.droppedLabels.length > 0) notes.push(`${plural(plan.droppedLabels.length, "label", "labels")} will be left off because creating new labels is switched off.`);
  if (norm.unknownColumns.length > 0) notes.push(`Mapped ${norm.unknownColumns.length === 1 ? "column" : "columns"} ${norm.unknownColumns.map((c) => `"${c}"`).join(", ")} ${norm.unknownColumns.length === 1 ? "isn't" : "aren't"} in this file.`);
  if (!mapping.columns.name) notes.push("Choose a column for the title. Without one, every row is skipped.");
  if (!mapping.columns.externalId) {
    notes.push("This file has no id column, so rows are matched by their position in this exact file. Importing the same file again updates; a changed file adds new items.");
  }

  const members = ctx.users.filter((u) => u.eligible).map((u) => ({ id: u.id, name: u.displayName }));
  const headerNames: string[] = [];
  for (const h of table.headers) if (!headerNames.includes(h)) headerNames.push(h);
  const format = table.delimiter === "json" ? "json" : "csv";

  return {
    source: job.source,
    detected,
    sources: IMPORT_SOURCES.map((id) => ({
      id,
      label: SOURCES[id].label,
      hint: SOURCES[id].hint,
      compatible: SOURCES[id].format === format,
    })),
    columns: headerNames,
    mapping,
    dateOrder: norm.dateOrder,
    totalRows: table.rows.length,
    fileWarnings: table.warnings,
    states: ctx.states.map((s) => ({ id: s.id, name: s.name, group: s.group })),
    members,
    statuses: plan.statuses,
    priorities: plan.priorities,
    people: plan.people,
    newStates: plan.newStates,
    newLabels: plan.newLabels,
    droppedLabels: plan.droppedLabels,
    counts,
    notes,
    preview,
  };
}
