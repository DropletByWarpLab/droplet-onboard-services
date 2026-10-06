/**
 * WARP-3527 — read a parsed table through a mapping into `ImportRecord`s.
 *
 * Still SOURCE vocabulary at this point: statuses are the source's words,
 * assignees are the source's names. Turning them into this project's states
 * and users needs the database and lives in `plan.ts`; nothing here does.
 *
 * Rules worth reading before changing anything:
 *   - A row is never silently dropped. A row that cannot be imported is kept as
 *     a record with `skip` set (missing title, archived in the source, a repeat
 *     of an earlier id), and the summary counts it by reason.
 *   - Every row has an external id. When the file has no id column the id is
 *     `file:<sha12>:<row>`: deterministic per FILE CONTENT, so re-importing the
 *     same file is idempotent and a half-finished run resumes without
 *     duplicating, while a different file never collides with it.
 *   - A blank cell is "no information", never "clear it" (see plan / service):
 *     the record carries null and the importer leaves that field alone.
 */

import { parseImportDate, toDateOnlyUtc, toInstantUtc, inferDateOrder } from "./dates.js";
import { SOURCES, normHeader, normKey } from "./sources.js";
import type {
  DateOrder,
  FieldKey,
  ImportMapping,
  ImportRecord,
  ImportSource,
  ImportTable,
  RowIssue,
} from "./types.js";

export const TITLE_MAX = 500;
export const DESCRIPTION_TEXT_MAX = 50_000;
export const LABEL_MAX = 100;
export const LABELS_PER_ITEM_MAX = 50;

const DATE_FIELDS: readonly FieldKey[] = ["dueDate", "startDate", "createdAt", "updatedAt", "completedAt"];

export interface NormalizeResult {
  records: ImportRecord[];
  /** The order the dates were read in, and whether the file could settle it. */
  dateOrder: { order: DateOrder; ambiguous: boolean; inferred: boolean };
  /** Mapped header names that are not in the file (a stale mapping). */
  unknownColumns: string[];
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Plain text → the paragraphs-and-breaks HTML the work-item description holds
 *  (the same shape the dashboard's New-item modal writes). Empty in, null out. */
export function textToHtml(text: string | null): string | null {
  if (text === null) return null;
  const t = text.trim();
  if (t === "") return null;
  return t
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).split("\n").join("<br>")}</p>`)
    .join("");
}

function splitList(value: string, separator: string): string[] {
  const parts = separator === "\n" ? value.split(/\r?\n/) : value.split(separator);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** Read one table through a mapping. Pure. */
export function normalizeTable(
  table: ImportTable,
  source: ImportSource,
  mapping: ImportMapping,
  fileSha256: string,
): NormalizeResult {
  const descriptor = SOURCES[source];
  const { headers, rows } = table;

  // header NAME (exact, as mapped) → column indices, in file order
  const byName = new Map<string, number[]>();
  const byNorm = new Map<string, number[]>();
  headers.forEach((h, i) => {
    byName.set(h, [...(byName.get(h) ?? []), i]);
    const n = normHeader(h);
    byNorm.set(n, [...(byNorm.get(n) ?? []), i]);
  });

  const unknownColumns: string[] = [];
  const fieldCols = new Map<FieldKey, number[]>();
  for (const [field, names] of Object.entries(mapping.columns) as Array<[FieldKey, string[]]>) {
    const idx: number[] = [];
    for (const name of names) {
      const cols = byName.get(name);
      if (!cols) {
        if (!unknownColumns.includes(name)) unknownColumns.push(name);
        continue;
      }
      idx.push(...cols);
    }
    if (idx.length > 0) fieldCols.set(field, idx);
  }

  // Date order: the owner's choice, else read from every date column at once.
  let dateOrder: NormalizeResult["dateOrder"];
  if (mapping.dateOrder === "auto") {
    const samples: string[] = [];
    for (const f of DATE_FIELDS) {
      for (const c of fieldCols.get(f) ?? []) for (const r of rows) samples.push(r[c] ?? "");
    }
    const inferred = inferDateOrder(samples);
    dateOrder = { ...inferred, inferred: true };
  } else {
    dateOrder = { order: mapping.dateOrder, ambiguous: false, inferred: false };
  }

  const sha = fileSha256.slice(0, 12);
  const records: ImportRecord[] = [];

  rows.forEach((row, i) => {
    const rowNo = i + 1;
    const cells = (field: FieldKey): string[] =>
      (fieldCols.get(field) ?? []).map((c) => (row[c] ?? "").trim()).filter((v) => v !== "");
    const first = (field: FieldKey): string | null => cells(field)[0] ?? null;
    // Preset-level reads go by header alias, independent of the owner's mapping.
    const cell = (alias: string): string => {
      const idx = byNorm.get(normHeader(alias));
      return idx && idx.length > 0 ? (row[idx[0]] ?? "") : "";
    };
    const issues: RowIssue[] = [];

    const ids = cells("externalId");
    const prefix = descriptor.idPrefix?.map((a) => cell(a).trim()).find((v) => v !== "") ?? "";
    const externalId =
      ids.length > 0 ? (prefix ? `${prefix}#${ids[0]}` : ids[0]) : `file:${sha}:${rowNo}`;
    const refs = [...new Set(prefix ? [...ids, ...ids.map((v) => `${prefix}#${v}`)] : ids)];

    let name = (first("name") ?? "").replace(/\s*\n\s*/g, " ").trim();
    if (name.length > TITLE_MAX) {
      name = name.slice(0, TITLE_MAX);
      issues.push({ code: "title_truncated" });
    }

    let description = first("description");
    if (description !== null && description.length > DESCRIPTION_TEXT_MAX) {
      description = description.slice(0, DESCRIPTION_TEXT_MAX);
      issues.push({ code: "description_truncated" });
    }

    const date = (field: FieldKey, dateOnly: boolean): Date | null => {
      const raw = first(field);
      if (raw === null) return null;
      const parsed = parseImportDate(raw, dateOrder.order);
      if (!parsed) {
        issues.push({ code: "invalid_date", detail: field });
        return null;
      }
      return dateOnly ? toDateOnlyUtc(parsed) : toInstantUtc(parsed);
    };

    // People. `assignee` columns are alternates for ONE person; each element of
    // an `assignees` list is a person of its own.
    const people: string[][] = [];
    const seenPeople = new Set<string>();
    const addPerson = (alternates: string[]): void => {
      const k = normKey(alternates[0] ?? "");
      if (k === "" || seenPeople.has(k)) return;
      seenPeople.add(k);
      people.push(alternates);
    };
    const single = cells("assignee");
    if (single.length > 0) addPerson(single);
    for (const v of cells("assignees")) for (const p of splitList(v, mapping.listSeparator)) addPerson([p]);
    const reporterValues = cells("reporter");

    // Labels: the label columns, plus the type / milestone carried as labels.
    const labelNames: string[] = [];
    const seenLabels = new Set<string>();
    const addLabel = (raw: string): void => {
      let n = raw.trim();
      if (n === "") return;
      if (n.length > LABEL_MAX) {
        n = n.slice(0, LABEL_MAX);
        issues.push({ code: "label_truncated", detail: n });
      }
      const k = n.toLowerCase();
      if (seenLabels.has(k) || labelNames.length >= LABELS_PER_ITEM_MAX) return;
      seenLabels.add(k);
      labelNames.push(n);
    };
    for (const v of cells("labels")) for (const l of splitList(v, mapping.listSeparator)) addLabel(l);
    const type = first("issueType");
    if (type) addLabel(type);
    const milestone = first("milestone");
    if (milestone) addLabel(`Milestone: ${milestone}`);

    const record: ImportRecord = {
      row: rowNo,
      externalId,
      refs,
      name,
      descriptionText: description,
      statusRaw: first("status"),
      groupHint: descriptor.groupHint?.(cell) ?? null,
      priorityRaw: first("priority"),
      assignees: people,
      reporter: reporterValues.length > 0 ? reporterValues : null,
      labels: labelNames,
      dueDate: date("dueDate", true),
      startDate: date("startDate", true),
      createdAt: date("createdAt", false),
      updatedAt: date("updatedAt", false),
      completedAt: date("completedAt", false),
      parentRef: first("parent"),
      parentExternalId: null,
      issues,
      skip: null,
    };
    if (descriptor.archived?.(cell)) record.skip = { reason: "archived_in_source" };
    else if (name === "") record.skip = { reason: "missing_title" };
    records.push(record);
  });

  // A repeat of an earlier id is the same item twice; the first one wins.
  const seen = new Map<string, number>();
  for (const rec of records) {
    if (rec.skip) continue;
    const earlier = seen.get(rec.externalId);
    if (earlier !== undefined) {
      rec.skip = { reason: "duplicate_id_in_file", detail: `row ${earlier}` };
    } else seen.set(rec.externalId, rec.row);
  }

  resolveParents(records, source);
  return { records, dateOrder, unknownColumns };
}

/** Link each record to its parent record in the file, break cycles. */
function resolveParents(records: ImportRecord[], source: ImportSource): void {
  const parentBy = SOURCES[source].parentBy;
  const live = records.filter((r) => r.skip === null);

  const byRef = new Map<string, ImportRecord>();
  for (const r of live) {
    for (const ref of [r.externalId, ...r.refs]) if (!byRef.has(ref)) byRef.set(ref, r);
  }
  const byName = new Map<string, ImportRecord[]>();
  if (parentBy !== "id") {
    for (const r of live) {
      const k = r.name.trim().toLowerCase();
      byName.set(k, [...(byName.get(k) ?? []), r]);
    }
  }

  for (const rec of live) {
    const ref = rec.parentRef?.trim();
    if (!ref) continue;
    let parent: ImportRecord | undefined;
    if (parentBy !== "name") parent = byRef.get(ref);
    if (!parent && parentBy !== "id") {
      const candidates = (byName.get(ref.toLowerCase()) ?? []).filter((c) => c !== rec);
      // Asana lists a parent immediately before its sub-tasks: nearest preceding wins.
      const preceding = candidates.filter((c) => c.row < rec.row);
      parent = preceding.length > 0 ? preceding[preceding.length - 1] : candidates.length === 1 ? candidates[0] : undefined;
    }
    if (!parent) continue; // not in this file; the runner tries a lookup by external id
    if (parent === rec) {
      rec.issues.push({ code: "parent_self" });
      continue;
    }
    rec.parentExternalId = parent.externalId;
  }

  // Cycle break, in file order, so the same cycle is broken the same way each run.
  const byId = new Map(live.map((r) => [r.externalId, r]));
  for (const rec of live) {
    let cur = rec.parentExternalId ? byId.get(rec.parentExternalId) : undefined;
    for (let steps = 0; cur && steps <= live.length; steps += 1) {
      if (cur === rec) {
        rec.parentExternalId = null;
        rec.issues.push({ code: "parent_cycle", detail: rec.parentRef ?? undefined });
        break;
      }
      cur = cur.parentExternalId ? byId.get(cur.parentExternalId) : undefined;
    }
  }
}

/**
 * File order, except that a parent is always processed before its children
 * (the child's `parentId` needs the parent's row to exist). Iterative: a
 * 10,000-deep chain must not overflow the stack.
 */
export function orderForProcessing(records: readonly ImportRecord[]): ImportRecord[] {
  const live = records.filter((r) => r.skip === null);
  const byId = new Map(live.map((r) => [r.externalId, r]));
  const done = new Set<ImportRecord>();
  const out: ImportRecord[] = [];
  for (const rec of live) {
    const stack: ImportRecord[] = [];
    let cur: ImportRecord | undefined = rec;
    while (cur && !done.has(cur)) {
      stack.push(cur);
      cur = cur.parentExternalId ? byId.get(cur.parentExternalId) : undefined;
    }
    while (stack.length > 0) {
      const r = stack.pop() as ImportRecord;
      done.add(r);
      out.push(r);
    }
  }
  return out;
}
