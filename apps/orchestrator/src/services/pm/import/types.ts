/**
 * WARP-3527 (ADR-069 WS-11) — shared shapes for the import pipeline.
 *
 *   bytes ──parse──► ImportTable ──normalize──► ImportRecord[] ──plan──► PlannedRow[]
 *   (csv.ts / trello.ts)   (normalize.ts)            (plan.ts)
 *
 * Nothing in this folder touches the database except `pm-import.service.ts`;
 * the rest is pure so it is exhaustively testable against fixtures.
 */

export type ImportSource =
  | "CSV"
  | "JIRA_CSV"
  | "ASANA_CSV"
  | "TRELLO_JSON"
  | "LINEAR_CSV"
  | "GITHUB_CSV";

export const IMPORT_SOURCES: readonly ImportSource[] = [
  "CSV",
  "JIRA_CSV",
  "ASANA_CSV",
  "TRELLO_JSON",
  "LINEAR_CSV",
  "GITHUB_CSV",
];

export type PmStateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";
export type PmPriorityValue = "urgent" | "high" | "medium" | "low" | "none";

/** A parsed upload: header names in file order (repeated names are kept — Jira
 *  writes one `Labels` column per label) and string cells, ragged rows padded. */
export interface ImportTable {
  headers: string[];
  rows: string[][];
  delimiter: string;
  /** Plain-language notes about the file itself (blank rows skipped, …). */
  warnings: string[];
}

/** The fields an import can fill. Everything else in a file is ignored. */
export type FieldKey =
  | "externalId"
  | "name"
  | "description"
  | "status"
  | "priority"
  | "assignee" // ONE person; several columns are alternates (email, then name)
  | "assignees" // a LIST: one column, split on the list separator
  | "reporter"
  | "labels"
  | "issueType" // becomes a label — PmWorkItem has no type column on this branch
  | "milestone" // becomes a label ("Milestone: v1.2") — modules are WS-5
  | "dueDate"
  | "startDate"
  | "createdAt"
  | "updatedAt"
  | "completedAt"
  | "parent";

export const FIELD_KEYS: readonly FieldKey[] = [
  "externalId",
  "name",
  "description",
  "status",
  "priority",
  "assignee",
  "assignees",
  "reporter",
  "labels",
  "issueType",
  "milestone",
  "dueDate",
  "startDate",
  "createdAt",
  "updatedAt",
  "completedAt",
  "parent",
];

export type DateOrder = "DMY" | "MDY" | "YMD";

/** What to do with one distinct source status. */
export type StateDecision =
  | { kind: "state"; stateId: string }
  | { kind: "create"; name: string; group: PmStateGroup }
  | { kind: "default" };

/**
 * The owner's choices for a job, as persisted in `PmImportJob.mapping`.
 *
 * Only CHOICES are stored. The auto-suggestions (which state a status matches,
 * who an assignee is) are recomputed every time against the project as it is
 * now: add the missing teammate, press Run again, and they are matched.
 *
 * Override maps are keyed by the NORMALIZED source value (`normKey`), so
 * "In Review", "in review" and "In-Review" are one entry.
 */
export interface ImportMapping {
  /** target field → source column header NAMES. A field absent here falls back
   *  to the preset's auto-mapping; present-but-empty means "do not import it". */
  columns: Partial<Record<FieldKey, string[]>>;
  dateOrder: DateOrder | "auto";
  /** Splits a multi-value cell (labels, a list of assignees). */
  listSeparator: string;
  createMissingStates: boolean;
  createMissingLabels: boolean;
  statuses: Record<string, StateDecision>;
  priorities: Record<string, PmPriorityValue>;
  /** userId, or null = "leave unassigned" (still reported). */
  people: Record<string, string | null>;
}

export type RowIssueCode =
  | "invalid_date"
  | "title_truncated"
  | "description_truncated"
  | "parent_cycle"
  | "parent_self"
  | "label_truncated";

export interface RowIssue {
  code: RowIssueCode;
  /** The field or value the issue is about, for the message. */
  detail?: string;
}

/** Why a row is not imported. */
export type SkipReason =
  | "missing_title"
  | "archived_in_source"
  | "duplicate_id_in_file"
  | "unchanged"
  | "error";

/** One source row, read through the mapping. Still source vocabulary. */
export interface ImportRecord {
  /** 1-based data-row number (the header is not a row) — what a human counts. */
  row: number;
  /** Canonical id in `externalSystem`. Never empty: synthetic when the file has none. */
  externalId: string;
  /** Every identifier another row may use to point at this one (key, id, …). */
  refs: string[];
  name: string;
  descriptionText: string | null;
  statusRaw: string | null;
  /** A completion hint the source gave outside its status text. */
  groupHint: PmStateGroup | null;
  priorityRaw: string | null;
  /** Each inner array is ONE person: [email, name] alternates for Asana, a single value elsewhere. */
  assignees: string[][];
  reporter: string[] | null;
  labels: string[];
  dueDate: Date | null;
  startDate: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  completedAt: Date | null;
  /** The raw parent reference exactly as the file wrote it. */
  parentRef: string | null;
  /** The parent's canonical external id once resolved (in this file or by lookup). */
  parentExternalId: string | null;
  issues: RowIssue[];
  skip: { reason: SkipReason; detail?: string } | null;
}
