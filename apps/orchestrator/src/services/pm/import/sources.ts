/**
 * WARP-3527 — the six source presets, and the one table every column mapping
 * in this slice is read from.
 *
 * ── COLUMN MAPPINGS (the contract the fixtures in `import.fixtures.ts` pin) ──
 *
 * A preset is a list of header ALIASES per field; headers are compared with
 * case, spaces and punctuation ignored ("Due date" = "due_date" = "DUE DATE").
 * "→ label" means PmWorkItem has no column for it on this branch, so the value
 * is kept as a label rather than dropped.
 *
 * JIRA CSV (Jira Cloud and Server "Export → CSV (all fields)")
 *   id ............ Issue key, then Issue id        (key first: it is what users see)
 *   name .......... Summary
 *   description ... Description
 *   status ........ Status          (+ Status Category / Resolved as a group hint)
 *   priority ...... Priority        Highest→urgent High→high Medium→medium Low/Lowest→low
 *   assignee ...... Assignee        reporter ... Reporter, then Creator
 *   labels ........ Labels          REPEATED columns — one `Labels` column per label
 *   issueType ..... Issue Type → label
 *   dates ......... Created, Updated, Resolved, Due date, Start date
 *   parent ........ Parent id, then Parent, then Parent key  (resolved against Issue id AND Issue key)
 *
 * ASANA CSV (project "Export → CSV")
 *   id ............ Task ID          name ... Name         description ... Notes
 *   status ........ Section/Column  (+ Completed At as a group hint)
 *   assignee ...... Assignee Email, then Assignee           labels ... Tags
 *   dates ......... Created At, Last Modified, Completed At, Due Date, Start Date
 *   parent ........ Parent task  — by NAME (Asana exports no parent id): the nearest
 *                   preceding row of that name, or the only one in the file.
 *
 * LINEAR CSV (workspace "Export → CSV")
 *   id ............ ID (ENG-123)    name ... Title        description ... Description
 *   status ........ Status          (+ Completed / Canceled timestamps as a group hint)
 *   priority ...... Priority        Urgent/High/Medium/Low/No priority, or 0-4
 *   assignee ...... Assignee        reporter ... Creator  labels ... Labels (comma-separated)
 *   dates ......... Created, Updated, Completed, Due Date
 *   parent ........ Parent issue
 *
 * GITHUB ISSUES CSV (what the common issue exporters write)
 *   id ............ number          name ... title        description ... body
 *   status ........ state (open/closed; state_reason not_planned → cancelled)
 *   assignees ..... assignees       (a LIST of logins)    labels ... labels
 *   milestone ..... milestone → label "Milestone: <title>"   reporter ... user / author
 *   dates ......... created_at, updated_at, closed_at
 *   A `repository` column, when present, prefixes the id (`org/repo#12`) so two
 *   repos' issue numbers cannot collide.
 *
 * TRELLO JSON (board "Print and export → Export as JSON") — see trello.ts
 *   card → item; its LIST → status; archived cards and cards in archived lists
 *   are skipped and reported; labels (name, else colour); members → assignees;
 *   due → due date; start → start date; desc → description; checklists are
 *   appended to the description as "[x] / [ ]" lines; created from the card id.
 *
 * GENERIC CSV — broad aliases (Title/Summary/Name/Subject, Status/State/Column,
 *   Assignee/Owner, Tags/Labels, Due/Deadline, …). Whatever the guess gets
 *   wrong, the mapping table lets the owner re-point.
 */

import type {
  FieldKey,
  ImportMapping,
  ImportSource,
  PmPriorityValue,
  PmStateGroup,
} from "./types.js";

/**
 * Read a plain-object lookup table by a key that came out of an uploaded file.
 * A status of "constructor" or "toString" must not resolve to something on
 * Object.prototype: only the table's OWN keys count.
 */
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Case-, space- and punctuation-insensitive form of a column header. */
export function normHeader(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The same fold for VALUES (statuses, priorities, people), with one extra:
 * "canceled" and "cancelled" are one word. Linear writes the first, Droplet's
 * default state is the second, and a status that does not match its own
 * spelling is the most visible bug an importer can have.
 */
export function normKey(s: string): string {
  return normHeader(s).replace(/canceled/g, "cancelled");
}

export interface SourceDescriptor {
  id: ImportSource;
  label: string;
  /** One line under the preset in the wizard. */
  hint: string;
  /** `PmWorkItem.externalSystem` for items this source creates. */
  system: string;
  format: "csv" | "json";
  /** Header aliases per field, in priority order. */
  columns: Partial<Record<FieldKey, readonly string[]>>;
  listSeparator: string;
  /** How a parent reference is matched. */
  parentBy: "id" | "name" | "both";
  /** Header aliases whose value prefixes the id (`repo#12`). */
  idPrefix?: readonly string[];
  /** normKey(value) → priority; consulted before the generic table. */
  priorities: Record<string, PmPriorityValue>;
  /** A completion hint the source gives outside its status text. `cell(header)` reads a column by alias. */
  groupHint?: (cell: (header: string) => string) => PmStateGroup | null;
  /** A row to skip and report as archived in the source. */
  archived?: (cell: (header: string) => string) => boolean;
  /** 0 = this is not that source's file; higher = more certain. */
  detect: (headers: ReadonlySet<string>) => number;
}

const has = (h: ReadonlySet<string>, ...names: string[]): boolean => names.every((n) => h.has(n));

const truthy = (v: string): boolean => /^(true|yes|1|y)$/i.test(v.trim());

export const GENERIC_PRIORITIES: Record<string, PmPriorityValue> = {
  urgent: "urgent", critical: "urgent", blocker: "urgent", highest: "urgent",
  p0: "urgent", sev0: "urgent", sev1: "urgent", emergency: "urgent", showstopper: "urgent",
  high: "high", major: "high", p1: "high", sev2: "high", important: "high",
  medium: "medium", normal: "medium", moderate: "medium", p2: "medium", sev3: "medium", default: "medium",
  low: "low", minor: "low", trivial: "low", lowest: "low", p3: "low", p4: "low", sev4: "low",
  none: "none", nopriority: "none", unprioritized: "none", unprioritised: "none", undefined: "none",
};

const JIRA: SourceDescriptor = {
  id: "JIRA_CSV",
  label: "Jira CSV",
  hint: "Export from Jira with Export, then CSV (all fields).",
  system: "jira",
  format: "csv",
  columns: {
    externalId: ["Issue key", "Issue id"],
    name: ["Summary"],
    description: ["Description"],
    status: ["Status"],
    priority: ["Priority"],
    assignee: ["Assignee"],
    reporter: ["Reporter", "Creator"],
    labels: ["Labels"],
    issueType: ["Issue Type"],
    dueDate: ["Due date"],
    startDate: ["Start date"],
    createdAt: ["Created"],
    updatedAt: ["Updated"],
    completedAt: ["Resolved"],
    parent: ["Parent id", "Parent", "Parent key"],
  },
  listSeparator: ",",
  parentBy: "id",
  priorities: {},
  groupHint: (cell) => {
    const category = normHeader(cell("Status Category"));
    if (category === "done") return "completed";
    if (category === "inprogress") return "started";
    return cell("Resolved").trim() !== "" ? "completed" : null;
  },
  detect: (h) => (has(h, "issuekey", "summary") ? 100 : 0),
};

const ASANA: SourceDescriptor = {
  id: "ASANA_CSV",
  label: "Asana CSV",
  hint: "Export from an Asana project with Export, then CSV.",
  system: "asana",
  format: "csv",
  columns: {
    externalId: ["Task ID"],
    name: ["Name"],
    description: ["Notes"],
    status: ["Section/Column"],
    priority: ["Priority"],
    assignee: ["Assignee Email", "Assignee"],
    labels: ["Tags"],
    dueDate: ["Due Date"],
    startDate: ["Start Date"],
    createdAt: ["Created At"],
    updatedAt: ["Last Modified"],
    completedAt: ["Completed At"],
    parent: ["Parent task"],
  },
  listSeparator: ",",
  parentBy: "name",
  priorities: {},
  groupHint: (cell) => (cell("Completed At").trim() !== "" ? "completed" : null),
  detect: (h) => (has(h, "taskid", "name") ? 90 + (h.has("sectioncolumn") ? 5 : 0) : 0),
};

const LINEAR: SourceDescriptor = {
  id: "LINEAR_CSV",
  label: "Linear CSV",
  hint: "Export from Linear with Settings, Export CSV.",
  system: "linear",
  format: "csv",
  columns: {
    externalId: ["ID"],
    name: ["Title"],
    description: ["Description"],
    status: ["Status"],
    priority: ["Priority"],
    assignee: ["Assignee"],
    reporter: ["Creator"],
    labels: ["Labels"],
    dueDate: ["Due Date"],
    createdAt: ["Created"],
    updatedAt: ["Updated"],
    completedAt: ["Completed"],
    parent: ["Parent issue"],
  },
  listSeparator: ",",
  parentBy: "id",
  // Linear's API numbering, which some exports write instead of the word.
  priorities: { "0": "none", "1": "urgent", "2": "high", "3": "medium", "4": "low" },
  groupHint: (cell) => {
    if (cell("Canceled").trim() !== "") return "cancelled";
    if (cell("Completed").trim() !== "") return "completed";
    return null;
  },
  detect: (h) => (has(h, "id", "title", "status") ? 80 + (h.has("team") || h.has("parentissue") ? 10 : 0) : 0),
};

const GITHUB: SourceDescriptor = {
  id: "GITHUB_CSV",
  label: "GitHub issues CSV",
  hint: "A CSV of issues with number, title, state, labels, assignees, milestone and body.",
  system: "github",
  format: "csv",
  columns: {
    externalId: ["number", "Issue Number", "#"],
    name: ["title"],
    description: ["body"],
    status: ["state"],
    assignees: ["assignees", "assignee"],
    labels: ["labels"],
    milestone: ["milestone"],
    reporter: ["user", "author", "creator"],
    createdAt: ["created_at", "created"],
    updatedAt: ["updated_at", "updated"],
    completedAt: ["closed_at", "closed"],
  },
  listSeparator: ",",
  parentBy: "id",
  idPrefix: ["repository", "repo", "repository name"],
  priorities: {},
  groupHint: (cell) => {
    if (normHeader(cell("state")) !== "closed") return null;
    return normHeader(cell("state_reason")) === "notplanned" ? "cancelled" : "completed";
  },
  detect: (h) => (has(h, "number", "title", "state") ? 70 : 0),
};

const TRELLO: SourceDescriptor = {
  id: "TRELLO_JSON",
  label: "Trello JSON",
  hint: "Export from a Trello board with Print and export, then Export as JSON.",
  system: "trello",
  format: "json",
  // The headers `trello.ts` writes; there is no other way to meet this preset.
  columns: {
    externalId: ["id"],
    name: ["name"],
    description: ["desc"],
    status: ["list"],
    assignees: ["members"],
    labels: ["labels"],
    dueDate: ["due"],
    startDate: ["start"],
    createdAt: ["created"],
    updatedAt: ["updated"],
  },
  // Trello label and member names can contain commas; trello.ts joins with newlines.
  listSeparator: "\n",
  parentBy: "id",
  priorities: {},
  groupHint: (cell) => (truthy(cell("done")) ? "completed" : null),
  archived: (cell) => truthy(cell("closed")) || truthy(cell("listclosed")),
  detect: () => 0,
};

const GENERIC: SourceDescriptor = {
  id: "CSV",
  label: "Other CSV",
  hint: "Any spreadsheet with one row per work item.",
  system: "csv",
  format: "csv",
  columns: {
    externalId: ["Key", "Issue key", "ID", "Task ID", "Ticket", "Number", "#"],
    name: ["Title", "Summary", "Name", "Subject", "Task", "Issue", "Work item", "Item"],
    description: ["Description", "Body", "Notes", "Details", "Content"],
    status: ["Status", "State", "Column", "Stage", "List", "Section"],
    priority: ["Priority", "Severity"],
    assignee: ["Assignee Email", "Assignee", "Assigned to", "Owner", "Responsible"],
    // Droplet's own CSV export writes `assignees` as a comma-separated list
    assignees: ["Assignees"],
    reporter: ["Reporter", "Creator", "Author", "Created by", "Requester"],
    labels: ["Labels", "Label", "Tags", "Tag", "Categories", "Category"],
    dueDate: ["Due date", "Due", "Deadline", "Target date", "Date due"],
    startDate: ["Start date", "Start", "Begin"],
    createdAt: ["Created", "Created at", "Created date", "Date created"],
    updatedAt: ["Updated", "Updated at", "Last modified", "Modified"],
    completedAt: ["Completed", "Completed at", "Resolved", "Closed at", "Closed"],
    parent: ["Parent", "Parent id", "Parent key", "Parent task"],
  },
  listSeparator: ",",
  parentBy: "both",
  priorities: {},
  detect: () => 1,
};

export const SOURCES: Record<ImportSource, SourceDescriptor> = {
  CSV: GENERIC,
  JIRA_CSV: JIRA,
  ASANA_CSV: ASANA,
  TRELLO_JSON: TRELLO,
  LINEAR_CSV: LINEAR,
  GITHUB_CSV: GITHUB,
};

/** Fields that may bind several columns at once (alternates, or a list). */
const MULTI_FIELDS: ReadonlySet<FieldKey> = new Set([
  "externalId",
  "assignee",
  "assignees",
  "labels",
  "parent",
]);

/** The best-guess source for a CSV's headers (JSON is detected by content). */
export function detectCsvSource(headers: readonly string[]): ImportSource {
  const set = new Set(headers.map(normHeader));
  let best: ImportSource = "CSV";
  let bestScore = 1;
  for (const d of Object.values(SOURCES)) {
    if (d.format !== "csv") continue;
    const score = d.detect(set);
    if (score > bestScore) {
      best = d.id;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The preset's column bindings for a file's headers: for each field, the first
 * alias that exists (or every alias that exists, for multi-column fields),
 * returned as the file's OWN header spelling.
 */
export function autoColumns(
  source: ImportSource,
  headers: readonly string[],
): Partial<Record<FieldKey, string[]>> {
  const d = SOURCES[source];
  const byNorm = new Map<string, string>();
  for (const h of headers) {
    const n = normHeader(h);
    if (!byNorm.has(n)) byNorm.set(n, h);
  }
  const out: Partial<Record<FieldKey, string[]>> = {};
  for (const [field, aliases] of Object.entries(d.columns) as Array<[FieldKey, readonly string[]]>) {
    const found: string[] = [];
    for (const alias of aliases) {
      const header = byNorm.get(normHeader(alias));
      if (header !== undefined && !found.includes(header)) {
        found.push(header);
        if (!MULTI_FIELDS.has(field)) break;
      }
    }
    if (found.length > 0) out[field] = found;
  }
  return out;
}

export const DEFAULT_MAPPING = (source: ImportSource): ImportMapping => ({
  columns: {},
  dateOrder: "auto",
  listSeparator: SOURCES[source].listSeparator,
  createMissingStates: true,
  createMissingLabels: true,
  statuses: {},
  priorities: {},
  people: {},
});

/** The mapping the pipeline actually runs: the owner's choices over the preset. */
export function effectiveMapping(
  source: ImportSource,
  headers: readonly string[],
  saved: Partial<ImportMapping> | null | undefined,
): ImportMapping {
  const base = DEFAULT_MAPPING(source);
  const auto = autoColumns(source, headers);
  const savedColumns = saved?.columns ?? {};
  const columns: Partial<Record<FieldKey, string[]>> = { ...auto };
  for (const [field, cols] of Object.entries(savedColumns) as Array<[FieldKey, string[] | undefined]>) {
    if (cols === undefined) continue;
    if (cols.length === 0) delete columns[field];
    else columns[field] = cols;
  }
  return {
    columns,
    dateOrder: saved?.dateOrder ?? base.dateOrder,
    listSeparator: saved?.listSeparator ?? base.listSeparator,
    createMissingStates: saved?.createMissingStates ?? base.createMissingStates,
    createMissingLabels: saved?.createMissingLabels ?? base.createMissingLabels,
    statuses: { ...(saved?.statuses ?? {}) },
    priorities: { ...(saved?.priorities ?? {}) },
    people: { ...(saved?.people ?? {}) },
  };
}
