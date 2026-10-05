/**
 * WARP-3527 — every source's fixture through parse -> normalize -> plan.
 *
 * Pure: no database. The fixtures are the contract for the column mappings
 * documented at the top of `sources.ts`; if a preset's mapping changes, one of
 * these assertions says which field moved.
 */

import { describe, it, expect } from "vitest";
import {
  ASANA_CSV,
  GENERIC_SEMICOLON_CSV,
  GITHUB_CSV,
  JIRA_CSV,
  LINEAR_CSV,
  TRELLO_JSON,
  sha256,
} from "./import.fixtures.js";
import { IMPORT_MAX_BYTES, ImportParseError } from "./csv.js";
import { normalizeTable, orderForProcessing, textToHtml } from "./normalize.js";
import { guessGroup, planRows, type PlanContext, type PlanUser } from "./plan.js";
import { SOURCES, autoColumns, detectCsvSource, effectiveMapping, normHeader, normKey } from "./sources.js";
import { parseImportDate } from "./dates.js";
import { loadTable, parseUpload, sniffFormat } from "./upload.js";

const parseImportDateFor = (raw: string) => parseImportDate(raw, "MDY");
import type { ImportMapping, ImportRecord, ImportSource } from "./types.js";

const STATES = [
  { id: "s-backlog", name: "Backlog", group: "backlog" as const, isDefault: false, sortOrder: 0 },
  { id: "s-todo", name: "Todo", group: "unstarted" as const, isDefault: true, sortOrder: 1 },
  { id: "s-prog", name: "In Progress", group: "started" as const, isDefault: false, sortOrder: 2 },
  { id: "s-done", name: "Done", group: "completed" as const, isDefault: false, sortOrder: 3 },
  { id: "s-canc", name: "Cancelled", group: "cancelled" as const, isDefault: false, sortOrder: 4 },
];
const USERS: PlanUser[] = [
  { id: "u-dana", displayName: "Dana Ortiz", username: "dana", email: "dana@example.com", eligible: true },
  { id: "u-sam", displayName: "Sam Lee", username: "samlee", email: "sam@example.com", eligible: true },
  { id: "u-pat", displayName: "Pat Nobody", username: "pat", email: "pat@guest.example", eligible: false, ineligibleReason: "guest" },
  { id: "u-old", displayName: "Old Hand", username: "oldhand", email: null, eligible: false, ineligibleReason: "deactivated" },
  { id: "u-j1", displayName: "Jo Twin", username: "jo1", email: "jo1@example.com", eligible: true },
  { id: "u-j2", displayName: "Jo Twin", username: "jo2", email: "jo2@example.com", eligible: true },
  { id: "u-octo", displayName: "Octo Cat", username: "octocat", email: null, eligible: true },
];
const CTX: PlanContext = { states: STATES, labels: [{ id: "l-bug", name: "Bug" }], users: USERS };

function run(buf: Buffer, source?: ImportSource, saved: Partial<ImportMapping> | null = null, ctx: PlanContext = CTX) {
  const upload = parseUpload(buf, source);
  const mapping = effectiveMapping(upload.source, upload.table.headers, saved);
  const norm = normalizeTable(upload.table, upload.source, mapping, sha256(buf));
  const plan = planRows(norm.records, upload.source, mapping, ctx);
  return { upload, mapping, norm, plan, records: norm.records };
}
const byRow = (records: ImportRecord[], n: number): ImportRecord => records.find((r) => r.row === n) as ImportRecord;

describe("source detection", () => {
  it.each(["csv", "json"])("refuses oversized %s bytes at the parser boundary", (format) => {
    const bytes = Buffer.alloc(IMPORT_MAX_BYTES + 1, 32);
    bytes.write(format === "json" ? '{"cards":[],"lists":[]}' : "Title\nItem");
    expect(() => parseUpload(bytes)).toThrowError(expect.objectContaining({ code: "file_too_large" }));
  });

  it.each([
    { cards: [null], lists: [] },
    { cards: [], lists: [null] },
    { cards: [{ labels: {} }], lists: [] },
    { cards: [{ idMembers: "user" }], lists: [] },
    { cards: [], lists: [], members: {} },
    { cards: [], lists: [], checklists: [{ checkItems: [null] }] },
  ])("reports malformed Trello entries as an import error rather than crashing", (value) => {
    expect(() => parseUpload(Buffer.from(JSON.stringify(value)))).toThrowError(expect.objectContaining({ code: "not_a_trello_export" }));
  });
  it("recognises each tool by its headers, and a JSON board by content", () => {
    expect(parseUpload(JIRA_CSV).detected).toBe("JIRA_CSV");
    expect(parseUpload(ASANA_CSV).detected).toBe("ASANA_CSV");
    expect(parseUpload(LINEAR_CSV).detected).toBe("LINEAR_CSV");
    expect(parseUpload(GITHUB_CSV).detected).toBe("GITHUB_CSV");
    expect(parseUpload(TRELLO_JSON).detected).toBe("TRELLO_JSON");
    expect(parseUpload(GENERIC_SEMICOLON_CSV).detected).toBe("CSV");
    expect(detectCsvSource(["Name", "Whatever"])).toBe("CSV");
  });

  it("sniffs the format from content, past a BOM and whitespace", () => {
    expect(sniffFormat(Buffer.from('\ufeff \n {"cards":[]}'))).toBe("json");
    expect(sniffFormat(Buffer.from("a,b\n"))).toBe("csv");
  });

  it("refuses a preset that wants the other format, in words", () => {
    expect(() => loadTable(JIRA_CSV, "TRELLO_JSON")).toThrow(/needs the board's JSON export/);
    expect(() => loadTable(TRELLO_JSON, "JIRA_CSV")).toThrow(/needs a CSV file/);
  });

  it("refuses JSON that is not a Trello board, and broken JSON", () => {
    const code = (b: string) => {
      try {
        parseUpload(Buffer.from(b));
      } catch (e) {
        return (e as ImportParseError).code;
      }
      return "none";
    };
    expect(code('{"hello":1}')).toBe("not_a_trello_export");
    expect(code("{not json")).toBe("invalid_json");
  });
});

describe("header and value folding", () => {
  it("ignores case, spaces and punctuation in headers; folds canceled/cancelled in values", () => {
    expect(normHeader("Due date")).toBe(normHeader("due_date"));
    expect(normHeader("Section/Column")).toBe("sectioncolumn");
    expect(normKey("Canceled")).toBe(normKey("CANCELLED"));
    expect(normKey("To Do")).toBe(normKey("todo"));
  });
});

describe("Jira CSV", () => {
  const { records, plan, mapping, norm } = run(JIRA_CSV);

  it("maps the documented columns", () => {
    const m = mapping.columns;
    expect(m.externalId).toEqual(["Issue key", "Issue id"]);
    expect(m.name).toEqual(["Summary"]);
    expect(m.status).toEqual(["Status"]);
    expect(m.assignee).toEqual(["Assignee"]);
    expect(m.reporter).toEqual(["Reporter"]);
    expect(m.labels).toEqual(["Labels"]); // ONE name, three columns
    expect(m.issueType).toEqual(["Issue Type"]);
    expect(m.parent).toEqual(["Parent id"]);
    expect(m.dueDate).toEqual(["Due date"]);
  });

  it("reads the epic: ids, multi-line description, repeated Labels, Jira dates", () => {
    const r = byRow(records, 1);
    expect(r.externalId).toBe("PAY-1");
    expect(r.refs).toEqual(["PAY-1", "10001"]);
    expect(r.name).toBe("Checkout revamp");
    expect(r.descriptionText).toBe('Rework the checkout flow.\n\nSee the design, then "ship" it.');
    expect(textToHtml(r.descriptionText)).toBe(
      "<p>Rework the checkout flow.</p><p>See the design, then &quot;ship&quot; it.</p>",
    );
    expect(r.labels).toEqual(["frontend", "Epic"]); // Labels columns, then Issue Type as a label
    expect(r.createdAt?.toISOString()).toBe("2024-03-12T09:41:00.000Z");
    expect(r.updatedAt?.toISOString()).toBe("2024-03-14T10:00:00.000Z");
    expect(r.dueDate?.toISOString()).toBe("2024-03-31T00:00:00.000Z");
    expect(r.completedAt).toBeNull();
    expect(r.groupHint).toBe("started");
    expect(r.reporter).toEqual(["Sam Lee"]);
  });

  it("resolves a parent by Issue id (Parent id) to the parent's canonical key", () => {
    expect(byRow(records, 2).parentExternalId).toBe("PAY-1");
    expect(byRow(records, 4).parentExternalId).toBe("PAY-1");
    expect(byRow(records, 1).parentExternalId).toBeNull();
  });

  it("merges the label columns without case-duplicates (bug / Bug)", () => {
    expect(byRow(records, 3).labels).toEqual(["bug"]);
    expect(byRow(records, 2).labels).toEqual(["backend", "payments", "Story"]);
  });

  it("completes from Resolved and skips the row with no summary, counting it", () => {
    expect(byRow(records, 3).completedAt?.toISOString()).toBe("2024-03-15T16:00:00.000Z");
    expect(byRow(records, 3).groupHint).toBe("completed");
    expect(byRow(records, 5).skip).toEqual({ reason: "missing_title" });
    expect(norm.dateOrder.ambiguous).toBe(false);
  });

  it("plans statuses: existing by name, a new state in the right group for the rest", () => {
    const by = Object.fromEntries(plan.statuses.map((s) => [s.value, s]));
    expect(by["In Progress"].decision).toEqual({ kind: "state", stateId: "s-prog" });
    expect(by["To Do"].decision).toEqual({ kind: "state", stateId: "s-todo" }); // "To Do" is "Todo"
    expect(by["Done"].decision).toEqual({ kind: "state", stateId: "s-done" });
    expect(by["In Review"].decision).toEqual({ kind: "create", name: "In Review", group: "started" });
    expect(plan.newStates).toEqual([{ name: "In Review", group: "started" }]);
  });

  it("plans priorities from the Jira scale", () => {
    const by = Object.fromEntries(plan.priorities.map((p) => [p.value, p]));
    expect(by["Highest"].priority).toBe("urgent");
    expect(by["High"].priority).toBe("high");
    expect(by["Medium"].priority).toBe("medium");
    expect(by["Low"].priority).toBe("low");
    expect(plan.priorities.every((p) => p.known)).toBe(true);
  });

  it("reports every assignee it could not resolve, with the reason, and counts them", () => {
    const by = Object.fromEntries(plan.people.map((p) => [p.value, p]));
    expect(by["Dana Ortiz"]).toMatchObject({ userId: "u-dana", by: "name", count: 2 });
    expect(by["Sam Lee"]).toMatchObject({ userId: "u-sam", by: "name" });
    expect(by["Pat Nobody"]).toMatchObject({ userId: null, by: "ineligible", detail: "a guest account", count: 1 });
  });

  it("creates only the labels that do not exist (case-insensitively)", () => {
    // "Bug" exists; "bug" and the Bug issue type fold into it
    expect(plan.newLabels).not.toContain("bug");
    expect(plan.newLabels).toEqual(expect.arrayContaining(["frontend", "Epic", "backend", "payments", "Story", "Task"]));
    const row3 = plan.rows.find((r) => r.record.row === 3) as (typeof plan.rows)[number];
    expect(row3.labels).toEqual(["Bug"]);
  });
});

describe("Asana CSV", () => {
  const { records, plan, mapping } = run(ASANA_CSV);

  it("maps the documented columns (assignee: email, then name)", () => {
    expect(mapping.columns.assignee).toEqual(["Assignee Email", "Assignee"]);
    expect(mapping.columns.status).toEqual(["Section/Column"]);
    expect(mapping.columns.parent).toEqual(["Parent task"]);
    expect(mapping.columns.description).toEqual(["Notes"]);
  });

  it("links a sub-task to its parent BY NAME", () => {
    expect(byRow(records, 2).parentExternalId).toBe("1001");
    expect(byRow(records, 1).parentExternalId).toBeNull();
  });

  it("reads tags, plain ISO dates and Completed At as completion", () => {
    expect(byRow(records, 1).labels).toEqual(["launch", "marketing"]);
    expect(byRow(records, 1).dueDate?.toISOString()).toBe("2024-04-01T00:00:00.000Z");
    expect(byRow(records, 3).groupHint).toBe("completed");
    expect(byRow(records, 3).completedAt?.toISOString()).toBe("2024-03-06T00:00:00.000Z");
  });

  it("resolves a person by email first, falling back to the name column", () => {
    const rows = plan.rows;
    expect(rows[0].assignees[0]).toMatchObject({ userId: "u-dana", by: "email" });
    expect(rows[1].assignees[0]).toMatchObject({ userId: "u-sam", by: "email" });
  });

  it("maps board sections to states: name, then a written synonym, never a guess", () => {
    const by = Object.fromEntries(plan.statuses.map((s) => [s.value, s]));
    expect(by["To do"].auto).toBe("name");
    expect(by["Doing"]).toMatchObject({ auto: "synonym", decision: { kind: "state", stateId: "s-prog" } });
    expect(by["Done"].auto).toBe("name");
  });
});

describe("Linear CSV", () => {
  const { records, plan } = run(LINEAR_CSV);

  it("reads ids, parents, labels and ISO instants", () => {
    expect(byRow(records, 1).externalId).toBe("ENG-1");
    expect(byRow(records, 2).parentExternalId).toBe("ENG-1");
    expect(byRow(records, 1).labels).toEqual(["Bug", "Customer"]);
    expect(byRow(records, 1).createdAt?.toISOString()).toBe("2024-03-01T10:00:00.000Z");
    expect(byRow(records, 1).dueDate?.toISOString()).toBe("2024-04-15T00:00:00.000Z");
  });

  it("matches Canceled to Cancelled and uses the Canceled/Completed timestamps as hints", () => {
    expect(byRow(records, 2).groupHint).toBe("cancelled");
    expect(byRow(records, 3).groupHint).toBe("completed");
    const canceled = plan.statuses.find((s) => s.value === "Canceled");
    expect(canceled?.decision).toEqual({ kind: "state", stateId: "s-canc" });
  });

  it("maps 'No priority' to none and Urgent to urgent", () => {
    const by = Object.fromEntries(plan.priorities.map((p) => [p.value, p.priority]));
    expect(by["No priority"]).toBe("none");
    expect(by["Urgent"]).toBe("urgent");
  });
});

describe("GitHub issues CSV", () => {
  const { records, plan } = run(GITHUB_CSV);

  it("reads number, state, comma lists and the milestone as a label", () => {
    const r = byRow(records, 1);
    expect(r.externalId).toBe("12");
    expect(r.labels).toEqual(["bug", "help wanted", "Milestone: v1.0"]);
    expect(r.assignees).toEqual([["octocat"], ["jdoe"]]);
    expect(r.descriptionText).toBe("Steps:\n1. open the app\n2. crash");
  });

  it("states open/closed land on Todo/Done through the synonym table, closed implies completed", () => {
    const by = Object.fromEntries(plan.statuses.map((s) => [s.value, s]));
    expect(by["open"]).toMatchObject({ auto: "synonym", decision: { kind: "state", stateId: "s-todo" } });
    expect(by["closed"]).toMatchObject({ auto: "synonym", decision: { kind: "state", stateId: "s-done" } });
    expect(byRow(records, 2).groupHint).toBe("completed");
  });

  it("matches a login against usernames and reports the one that is nobody", () => {
    const by = Object.fromEntries(plan.people.map((p) => [p.value, p]));
    expect(by["octocat"]).toMatchObject({ userId: "u-octo", by: "username" });
    expect(by["jdoe"]).toMatchObject({ userId: null, by: "none" });
  });

  it("prefixes the id with a repository column when the file has one", () => {
    const buf = Buffer.from("number,title,state,repository\n7,Hello,open,org/repo\n");
    const { records: rs } = run(buf, "GITHUB_CSV");
    expect(rs[0].externalId).toBe("org/repo#7");
    expect(rs[0].refs).toEqual(["7", "org/repo#7"]);
  });
});

describe("Trello JSON", () => {
  const { records, plan, upload } = run(TRELLO_JSON);

  it("is one item per card, its list as the status", () => {
    expect(upload.source).toBe("TRELLO_JSON");
    expect(records).toHaveLength(4);
    expect(byRow(records, 1)).toMatchObject({ name: "Write launch post", statusRaw: "Doing" });
  });

  it("joins members and labels without losing names that contain commas, falls back to a colour", () => {
    const r = byRow(records, 1);
    expect(r.assignees).toEqual([["Dana Ortiz"], ["samlee"]]); // a member with no full name is their username
    expect(r.labels).toEqual(["Marketing", "purple"]);
  });

  it("appends the checklist to the description instead of losing it", () => {
    expect(byRow(records, 1).descriptionText).toBe(
      "Draft, then review.\n\nChecklist: Before launch\n[x] Proof the copy\n[ ] Brief support",
    );
  });

  it("takes the creation time from the card's ObjectId and the due date as written", () => {
    expect(byRow(records, 1).createdAt?.toISOString()).toBe("2024-03-13T14:01:21.000Z");
    expect(byRow(records, 1).dueDate?.toISOString()).toBe("2024-03-20T00:00:00.000Z");
  });

  it("skips archived cards and cards in archived lists, with a reason", () => {
    expect(byRow(records, 3).skip).toEqual({ reason: "archived_in_source" });
    expect(byRow(records, 4).skip).toEqual({ reason: "archived_in_source" });
    expect(byRow(records, 1).skip).toBeNull();
  });

  it("a completed due date marks the card done; skipped cards add no states", () => {
    expect(byRow(records, 2).groupHint).toBe("completed");
    expect(plan.statuses.map((s) => s.value).sort()).toEqual(["Doing", "Done"]);
  });
});

describe("generic CSV", () => {
  const { records, plan, mapping, norm } = run(GENERIC_SEMICOLON_CSV);

  it("auto-maps common headers and reads a semicolon file", () => {
    expect(mapping.columns).toMatchObject({
      name: ["Title"], status: ["Status"], assignee: ["Assignee"], dueDate: ["Due"], labels: ["Tags"], priority: ["Priority"],
    });
    expect(records).toHaveLength(2);
  });

  it("gives a file with no id column a deterministic id per file content and row", () => {
    expect(records[0].externalId).toBe(`file:${sha256(GENERIC_SEMICOLON_CSV).slice(0, 12)}:1`);
    const again = run(GENERIC_SEMICOLON_CSV).records;
    expect(again.map((r) => r.externalId)).toEqual(records.map((r) => r.externalId));
  });

  it("settles day-first from the column itself (31/03/2024 can only be day-first)", () => {
    expect(norm.dateOrder).toMatchObject({ order: "DMY", ambiguous: false, inferred: true });
    expect(records[0].dueDate?.toISOString()).toBe("2024-03-31T00:00:00.000Z");
    expect(records[1].dueDate?.toISOString()).toBe("2024-04-04T00:00:00.000Z");
  });

  it("an explicit order overrides the inference, and an unreadable date is reported, not dropped silently", () => {
    const m = run(GENERIC_SEMICOLON_CSV, "CSV", { dateOrder: "MDY" }).records;
    expect(m[0].dueDate).toBeNull();
    expect(m[0].issues).toEqual([{ code: "invalid_date", detail: "dueDate" }]);
  });

  it("maps Open/Closed through synonyms and resolves an email assignee", () => {
    expect(plan.statuses.map((s) => s.decision)).toEqual([
      { kind: "state", stateId: "s-todo" },
      { kind: "state", stateId: "s-done" },
    ]);
    expect(plan.rows[0].assignees[0]).toMatchObject({ userId: "u-dana", by: "email" });
    expect(plan.rows[1].assignees[0]).toMatchObject({ userId: "u-sam", by: "name" });
  });
});

describe("status, priority and people decisions", () => {
  const sheet = (rows: string[]) => Buffer.from(["Title,Status,Priority,Assignee", ...rows].join("\n") + "\n");

  it("with create-missing off, an unknown status lands on the default state", () => {
    const { plan } = run(sheet(["A,Waiting on legal,,"]), "CSV", { createMissingStates: false });
    expect(plan.statuses[0]).toMatchObject({ auto: "default", decision: { kind: "default" }, stateName: "Todo" });
    expect(plan.newStates).toEqual([]);
  });

  it("an owner override beats every automatic match", () => {
    const { plan } = run(sheet(["A,Done,,"]), "CSV", { statuses: { done: { kind: "state", stateId: "s-canc" } } });
    expect(plan.statuses[0]).toMatchObject({ auto: "override", decision: { kind: "state", stateId: "s-canc" } });
  });

  it("an override naming a state that is not in the project is ignored, not trusted", () => {
    const { plan } = run(sheet(["A,Done,,"]), "CSV", { statuses: { done: { kind: "state", stateId: "elsewhere" } } });
    expect(plan.statuses[0].auto).toBe("name");
  });

  it("flags a priority word nobody knows and lands it on none", () => {
    const { plan } = run(sheet(["A,,Banana,"]));
    expect(plan.priorities[0]).toMatchObject({ priority: "none", known: false });
    const { plan: p2 } = run(sheet(["A,,Banana,"]), "CSV", { priorities: { banana: "high" } });
    expect(p2.priorities[0]).toMatchObject({ priority: "high", known: true });
  });

  it("never guesses between two members with the same name", () => {
    const { plan } = run(sheet(["A,,,Jo Twin"]));
    expect(plan.people[0]).toMatchObject({ userId: null, by: "ambiguous" });
  });

  it("an owner can point a name at a member, or leave it unassigned on purpose", () => {
    const pointed = run(sheet(["A,,,Jo Twin"]), "CSV", { people: { jotwin: "u-j2" } }).plan.people[0];
    expect(pointed).toMatchObject({ userId: "u-j2", by: "override" });
    const left = run(sheet(["A,,,Jo Twin"]), "CSV", { people: { jotwin: null } }).plan.people[0];
    expect(left).toMatchObject({ userId: null, by: "override" });
  });

  it("an override pointing at a guest is refused (falls back to automatic matching)", () => {
    const p = run(sheet(["A,,,Pat Nobody"]), "CSV", { people: { patnobody: "u-pat" } }).plan.people[0];
    expect(p.userId).toBeNull();
  });

  it("a deactivated member is reported as such", () => {
    expect(run(sheet(["A,,,Old Hand"])).plan.people[0]).toMatchObject({ by: "ineligible", detail: "a deactivated account" });
  });

  it("drops no label silently when create-missing-labels is off: it is listed", () => {
    const buf = Buffer.from("Title,Tags\nA,\"urgent-thing, Bug\"\n");
    const { plan } = run(buf, "CSV", { createMissingLabels: false });
    expect(plan.droppedLabels).toEqual(["urgent-thing"]);
    expect(plan.rows[0].labels).toEqual(["Bug"]);
  });
});

describe("values that look like JavaScript internals are just values", () => {
  const sheet = (rows: string[]) => Buffer.from(["Title,Status,Priority,Assignee", ...rows].join("\n") + "\n");
  const WORDS =["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"];

  it.each(WORDS)("status, priority and assignee %s plan like any other unknown value", (word) => {
    const { plan, norm } = run(sheet([`A,${word},${word},${word}`]));
    expect(norm.records).toHaveLength(1);
    expect(plan.statuses[0].auto).toBe("create"); // not "override", not "synonym"
    expect(plan.statuses[0].decision).toMatchObject({ kind: "create" });
    expect(plan.priorities[0]).toMatchObject({ priority: "none", known: false });
    expect(plan.people[0]).toMatchObject({ userId: null, by: "none" });
  });

  it("and a month name that is really a property name is not a month", () => {
    expect(parseImportDateFor("12 valueOf 2024")).toBeNull();
    expect(parseImportDateFor("toString 12, 2024")).toBeNull();
  });
});

describe("guessGroup", () => {
  it.each([
    ["inreview", null, "started"],
    ["done", null, "completed"],
    ["wontdo", "completed", "cancelled"], // Jira files Won't Do under Done; the words win
    ["shipped", null, "completed"],
    ["backlog", null, "backlog"],
    ["icebox", null, "backlog"],
    ["blocked", null, "started"],
    ["incomplete", null, "unstarted"],
    ["notdone", null, "unstarted"],
    ["whatever", null, "unstarted"],
    ["whatever", "started", "started"], // the source's own hint beats a shrug
    ["duplicate", null, "cancelled"],
  ] as const)("%s (hint %s) -> %s", (key, hint, group) => {
    expect(guessGroup(key, hint)).toBe(group);
  });
});

describe("parents, cycles, duplicates and processing order", () => {
  const sheet = (rows: string[]) =>
    Buffer.from(["Key,Title,Parent", ...rows].join("\n") + "\n");

  it("orders a parent before its child even when the child comes first", () => {
    const { records } = run(sheet(["B,Child,A", "A,Parent,"]));
    const order = orderForProcessing(records).map((r) => r.externalId);
    expect(order).toEqual(["A", "B"]);
  });

  it("keeps file order when parents already come first", () => {
    const { records } = run(sheet(["A,One,", "B,Two,A", "C,Three,", "D,Four,B"]));
    expect(orderForProcessing(records).map((r) => r.externalId)).toEqual(["A", "B", "C", "D"]);
  });

  it("breaks a parent cycle once, deterministically, and says so", () => {
    const { records } = run(sheet(["A,One,B", "B,Two,A"]));
    expect(records[0].parentExternalId).toBeNull();
    expect(records[0].issues).toEqual([{ code: "parent_cycle", detail: "B" }]);
    expect(records[1].parentExternalId).toBe("A");
    expect(orderForProcessing(records).map((r) => r.externalId)).toEqual(["A", "B"]);
  });

  it("ignores a row that is its own parent", () => {
    const { records } = run(sheet(["A,One,A"]));
    expect(records[0].parentExternalId).toBeNull();
    expect(records[0].issues).toEqual([{ code: "parent_self" }]);
  });

  it("a repeated id is a skipped duplicate (the first wins), and its children follow the first", () => {
    const { records } = run(sheet(["A,First,", "A,Again,", "C,Kid,A"]));
    expect(records[1].skip).toEqual({ reason: "duplicate_id_in_file", detail: "row 1" });
    expect(records[2].parentExternalId).toBe("A");
    expect(orderForProcessing(records)).toHaveLength(2);
  });

  it("leaves a parent that is not in the file for the runner to look up", () => {
    const { records } = run(sheet(["A,Orphan,ELSEWHERE-1"]));
    expect(records[0].parentExternalId).toBeNull();
    expect(records[0].parentRef).toBe("ELSEWHERE-1");
  });

  it("survives a 10,000-deep chain (no recursion)", () => {
    const rows = ["R0,root,"];
    for (let i = 1; i <= 10_000; i += 1) rows.push(`R${i},child ${i},R${i - 1}`);
    const { records } = run(sheet(rows.reverse()));
    const order = orderForProcessing(records);
    expect(order).toHaveLength(10_001);
    expect(order[0].externalId).toBe("R0");
    expect(order[10_000].externalId).toBe("R10000");
  });
});

describe("effectiveMapping", () => {
  it("lets an owner re-point a column, or unmap one with an empty list", () => {
    const headers = ["Task", "Owner", "Notes"];
    expect(effectiveMapping("CSV", headers, null).columns).toMatchObject({ name: ["Task"], assignee: ["Owner"], description: ["Notes"] });
    const m = effectiveMapping("CSV", headers, { columns: { name: ["Notes"], assignee: [] } });
    expect(m.columns.name).toEqual(["Notes"]);
    expect(m.columns.assignee).toBeUndefined();
  });

  it("ignores a mapped header that is not in the file and says which", () => {
    const buf = Buffer.from("Title\nA\n");
    const upload = parseUpload(buf);
    const mapping = effectiveMapping("CSV", upload.table.headers, { columns: { status: ["Gone"] } });
    const norm = normalizeTable(upload.table, "CSV", mapping, sha256(buf));
    expect(norm.unknownColumns).toEqual(["Gone"]);
  });

  it("autoColumns uses the file's own spelling of each header", () => {
    expect(autoColumns("JIRA_CSV", ["SUMMARY", "issue_key"]).name).toEqual(["SUMMARY"]);
    expect(SOURCES.JIRA_CSV.system).toBe("jira");
  });
});
