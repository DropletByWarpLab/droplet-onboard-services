/**
 * WARP-3527 — turn source vocabulary into THIS project's vocabulary.
 *
 * Pure: the caller loads the project's states, labels and users once
 * (`PlanContext`) and everything here is a function of that plus the records
 * and the owner's mapping. The same function feeds the preview and the runner,
 * so what the owner approved on screen is what runs.
 *
 * ── STATUS → STATE ─────────────────────────────────────────────────────────
 *   1. the owner's override for that status;
 *   2. an existing state whose name matches (case, spaces and punctuation
 *      ignored — "To Do" is "Todo", "Canceled" is "Cancelled");
 *   3. a SYNONYM of a state that exists ("Open"/"Reopened"/"New" → Todo,
 *      "Closed"/"Resolved" → Done, "Doing" → In Progress, "Won't do" →
 *      Cancelled). Written down, not guessed: the table is `SYNONYMS` below;
 *   4. with "create missing states" on: a NEW state named as the file names it,
 *      in the group a best guess puts it ("In Review" → started);
 *   5. otherwise the project's default state, and the preview says so.
 *
 * ── PEOPLE ─────────────────────────────────────────────────────────────────
 * By email, then display name, then username, against ACTIVE members. A guest
 * is deliberately NOT assignable by import: assigning an item to an external
 * guest SHARES it with them (WARP-3369), and an import of 500 items must not
 * share 500 items. Two members with the same name is "ambiguous" and is not
 * guessed. Anything unresolved is carried through to the summary by name and
 * count — never dropped silently.
 */

import { GENERIC_PRIORITIES, SOURCES, normKey, own } from "./sources.js";
import type {
  ImportMapping,
  ImportRecord,
  ImportSource,
  PmPriorityValue,
  PmStateGroup,
  StateDecision,
} from "./types.js";

export interface PlanState {
  id: string;
  name: string;
  group: PmStateGroup;
  isDefault: boolean;
  sortOrder: number;
}

export interface PlanUser {
  id: string;
  displayName: string;
  username: string;
  /** Decrypted, or null. */
  email: string | null;
  eligible: boolean;
  ineligibleReason?: "guest" | "deactivated";
}

export interface PlanContext {
  states: PlanState[];
  labels: Array<{ id: string; name: string }>;
  users: PlanUser[];
}

// ── status ──────────────────────────────────────────────────────────────────

/** normKey(word a tracker uses) → normKey(name of the default state it means). */
export const SYNONYMS: Record<string, string> = {
  open: "todo", new: "todo", reopened: "todo", ready: "todo", planned: "todo",
  notstarted: "todo", tobedone: "todo", upnext: "todo", unstarted: "todo",
  selectedfordevelopment: "todo", readyfordevelopment: "todo",
  icebox: "backlog", triage: "backlog", ideas: "backlog",
  doing: "inprogress", indevelopment: "inprogress", started: "inprogress", wip: "inprogress",
  inwork: "inprogress", active: "inprogress", ongoing: "inprogress", workinprogress: "inprogress",
  underway: "inprogress",
  closed: "done", resolved: "done", complete: "done", completed: "done", finished: "done",
  shipped: "done", released: "done", fixed: "done", merged: "done",
  wontdo: "cancelled", wontfix: "cancelled", rejected: "cancelled", declined: "cancelled",
  abandoned: "cancelled", notplanned: "cancelled", dropped: "cancelled",
};

const NOT_YET = /incomplete|notdone|notcomplete|undone|unresolved|notresolved|notfixed/;
const CANCELLED = /cancel|wont|reject|decline|abandon|notplanned|dropped|duplicate|obsolete|invalid/;
const COMPLETED = /done|complete|closed|resolved|shipped|released|merged|fixed|finished|deployed|delivered|accepted/;
const STARTED = /progress|doing|develop|review|qa|test|verif|block|hold|wip|started|active|implement|building|staging|ongoing|inwork|underway/;
const BACKLOG = /backlog|icebox|triage|ideas|inbox|someday|later|parked|wishlist|unscheduled/;

/**
 * Which state group a status belongs in. Words that SAY "cancelled" win over a
 * source's generic "done" hint (Jira files "Won't Do" under the Done category);
 * the source's own hint wins over keyword guessing; no signal at all is
 * `unstarted`, the group a new item lands in.
 */
export function guessGroup(statusKey: string, hint: PmStateGroup | null): PmStateGroup {
  if (CANCELLED.test(statusKey)) return "cancelled";
  if (hint) return hint;
  if (NOT_YET.test(statusKey)) return "unstarted";
  if (COMPLETED.test(statusKey)) return "completed";
  if (STARTED.test(statusKey)) return "started";
  if (BACKLOG.test(statusKey)) return "backlog";
  return "unstarted";
}

export interface PlannedStatus {
  key: string;
  /** The most common spelling in the file. */
  value: string;
  count: number;
  decision: StateDecision;
  auto: "override" | "name" | "synonym" | "create" | "default";
  group: PmStateGroup;
  /** The existing state it maps to, for display. */
  stateName?: string;
}

// ── people ──────────────────────────────────────────────────────────────────

export type PersonMatch = "email" | "name" | "username" | "override" | "none" | "ambiguous" | "ineligible";

export interface PlannedPerson {
  /** The first alternate — what the file calls them. */
  value: string;
  key: string;
  userId: string | null;
  displayName?: string;
  by: PersonMatch;
  /** Why not, in a phrase ("a guest account", "two members share this name"). */
  detail?: string;
}

export interface PlannedPersonSummary extends PlannedPerson {
  count: number;
}

/**
 * How two people's NAMES are compared: case, accents and runs of spaces are
 * ignored; letters are not. Deliberately stricter than `normKey` (which drops
 * spaces and punctuation, right for a status word): folding "Octo Cat" into
 * "octocat" would assign work to the wrong person on a coincidence.
 */
function nameKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

class UserIndex {
  private readonly byEmail = new Map<string, PlanUser[]>();
  private readonly byName = new Map<string, PlanUser[]>();
  private readonly byUsername = new Map<string, PlanUser[]>();
  private readonly byId = new Map<string, PlanUser>();

  constructor(users: readonly PlanUser[]) {
    const push = (m: Map<string, PlanUser[]>, k: string, u: PlanUser) => {
      if (k !== "") m.set(k, [...(m.get(k) ?? []), u]);
    };
    for (const u of users) {
      this.byId.set(u.id, u);
      if (u.email) push(this.byEmail, u.email.trim().toLowerCase(), u);
      push(this.byName, nameKey(u.displayName), u);
      push(this.byUsername, u.username.trim().toLowerCase(), u);
    }
  }

  get(id: string): PlanUser | undefined {
    return this.byId.get(id);
  }

  /** Resolve ONE alternate. `undefined` = no such person at all. */
  private lookup(raw: string): { user?: PlanUser; by: PersonMatch; detail?: string } | undefined {
    const v = raw.trim();
    const tiers: Array<[PersonMatch, PlanUser[] | undefined]> = [
      ["email", v.includes("@") ? this.byEmail.get(v.toLowerCase()) : undefined],
      ["name", this.byName.get(nameKey(v))],
      ["username", this.byUsername.get(v.toLowerCase())],
    ];
    for (const [by, hits] of tiers) {
      if (!hits || hits.length === 0) continue;
      const eligible = hits.filter((h) => h.eligible);
      if (eligible.length === 1) return { user: eligible[0], by };
      if (eligible.length > 1) return { by: "ambiguous", detail: "more than one member matches" };
      const why = hits[0].ineligibleReason === "guest" ? "a guest account" : "a deactivated account";
      return { by: "ineligible", detail: why };
    }
    return undefined;
  }

  /** Resolve a person given as alternates (email first, then name, …). */
  resolve(alternates: readonly string[]): PlannedPerson {
    const value = alternates[0] ?? "";
    const key = normKey(value);
    let firstFailure: { by: PersonMatch; detail?: string } | undefined;
    for (const alt of alternates) {
      const hit = this.lookup(alt);
      if (hit?.user) {
        return { value, key, userId: hit.user.id, displayName: hit.user.displayName, by: hit.by };
      }
      if (hit && !firstFailure) firstFailure = hit;
    }
    return { value, key, userId: null, by: firstFailure?.by ?? "none", detail: firstFailure?.detail };
  }
}

// ── the plan ────────────────────────────────────────────────────────────────

export interface PlannedRow {
  record: ImportRecord;
  status: { key: string; decision: StateDecision } | null;
  priority: PmPriorityValue | null;
  assignees: PlannedPerson[];
  reporter: PlannedPerson | null;
  /** Label names this item will carry, after "create missing labels". */
  labels: string[];
}

export interface PlannedPriority {
  key: string;
  value: string;
  count: number;
  priority: PmPriorityValue;
  /** False when neither the owner nor any table knew the word (it landed on "none"). */
  known: boolean;
}

export interface PlanResult {
  rows: PlannedRow[];
  statuses: PlannedStatus[];
  priorities: PlannedPriority[];
  people: PlannedPersonSummary[];
  /** States the run will create, in the order they will be created. */
  newStates: Array<{ name: string; group: PmStateGroup }>;
  newLabels: string[];
  /** Labels dropped because "create missing labels" is off. */
  droppedLabels: string[];
}

function mostCommon<T>(items: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let bestN = 0;
  for (const it of items) {
    const n = (counts.get(it) ?? 0) + 1;
    counts.set(it, n);
    if (n > bestN) {
      best = it;
      bestN = n;
    }
  }
  return best;
}

export function planRows(
  records: readonly ImportRecord[],
  source: ImportSource,
  mapping: ImportMapping,
  ctx: PlanContext,
): PlanResult {
  const descriptor = SOURCES[source];
  const live = records.filter((r) => r.skip === null);

  // ── statuses ──
  const stateByKey = new Map<string, PlanState>();
  for (const s of [...ctx.states].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const k = normKey(s.name);
    if (!stateByKey.has(k)) stateByKey.set(k, s);
  }
  const stateById = new Map(ctx.states.map((s) => [s.id, s]));

  const statusRows = new Map<string, { raws: string[]; hints: PmStateGroup[] }>();
  for (const r of live) {
    if (r.statusRaw === null) continue;
    const k = normKey(r.statusRaw);
    if (k === "") continue;
    const e = statusRows.get(k) ?? { raws: [], hints: [] };
    e.raws.push(r.statusRaw);
    if (r.groupHint) e.hints.push(r.groupHint);
    statusRows.set(k, e);
  }

  const statuses: PlannedStatus[] = [];
  const decisionByKey = new Map<string, StateDecision>();
  const newStates: PlanResult["newStates"] = [];
  for (const [key, e] of statusRows) {
    const value = (mostCommon(e.raws) as string).trim();
    const group = guessGroup(key, mostCommon(e.hints) ?? null);
    const override = own(mapping.statuses, key);
    const synonym = own(SYNONYMS, key);
    let decision: StateDecision;
    let auto: PlannedStatus["auto"];
    let stateName: string | undefined;
    if (override && (override.kind !== "state" || stateById.has(override.stateId))) {
      decision = override;
      auto = "override";
      if (override.kind === "state") stateName = stateById.get(override.stateId)?.name;
    } else if (stateByKey.has(key)) {
      const s = stateByKey.get(key) as PlanState;
      decision = { kind: "state", stateId: s.id };
      auto = "name";
      stateName = s.name;
    } else if (synonym !== undefined && stateByKey.has(synonym)) {
      const s = stateByKey.get(synonym) as PlanState;
      decision = { kind: "state", stateId: s.id };
      auto = "synonym";
      stateName = s.name;
    } else if (mapping.createMissingStates) {
      decision = { kind: "create", name: value.slice(0, 100), group };
      auto = "create";
    } else {
      decision = { kind: "default" };
      auto = "default";
      stateName = ctx.states.find((s) => s.isDefault)?.name;
    }
    if (decision.kind === "create" && !newStates.some((n) => normKey(n.name) === normKey(decision.name as string))) {
      newStates.push({ name: decision.name, group: decision.group });
    }
    decisionByKey.set(key, decision);
    statuses.push({ key, value, count: e.raws.length, decision, auto, group, stateName });
  }

  // ── priorities ──
  const priorityRows = new Map<string, string[]>();
  for (const r of live) {
    if (r.priorityRaw === null) continue;
    const k = normKey(r.priorityRaw);
    if (k === "") continue;
    priorityRows.set(k, [...(priorityRows.get(k) ?? []), r.priorityRaw]);
  }
  const priorityByKey = new Map<string, PmPriorityValue>();
  const priorities: PlannedPriority[] = [];
  for (const [key, raws] of priorityRows) {
    const chosen = own(mapping.priorities, key) ?? own(descriptor.priorities, key) ?? own(GENERIC_PRIORITIES, key);
    const priority = chosen ?? "none";
    priorityByKey.set(key, priority);
    priorities.push({ key, value: (mostCommon(raws) as string).trim(), count: raws.length, priority, known: chosen !== undefined });
  }

  // ── people ──
  const index = new UserIndex(ctx.users);
  const peopleCache = new Map<string, PlannedPerson>();
  const personFor = (alternates: string[]): PlannedPerson => {
    const key = normKey(alternates[0] ?? "");
    const cached = peopleCache.get(key);
    if (cached) return cached;
    let person: PlannedPerson;
    if (Object.prototype.hasOwnProperty.call(mapping.people, key)) {
      const chosen = mapping.people[key] ?? null;
      const user = chosen ? index.get(chosen) : undefined;
      person =
        chosen && user?.eligible
          ? { value: alternates[0], key, userId: user.id, displayName: user.displayName, by: "override" }
          : chosen === null
            ? { value: alternates[0], key, userId: null, by: "override", detail: "left unassigned" }
            : index.resolve(alternates);
    } else {
      person = index.resolve(alternates);
    }
    peopleCache.set(key, person);
    return person;
  };
  const peopleCounts = new Map<string, number>();
  const countPerson = (p: PlannedPerson): void => {
    peopleCounts.set(p.key, (peopleCounts.get(p.key) ?? 0) + 1);
  };

  // ── labels ──
  const existingLabels = new Map(ctx.labels.map((l) => [l.name.toLowerCase(), l.name]));
  const newLabelNames = new Map<string, string>();
  const droppedLabels = new Map<string, string>();

  const rows: PlannedRow[] = records.map((record) => {
    if (record.skip) {
      return { record, status: null, priority: null, assignees: [], reporter: null, labels: [] };
    }
    const k = record.statusRaw !== null ? normKey(record.statusRaw) : "";
    const status = k !== "" ? { key: k, decision: decisionByKey.get(k) as StateDecision } : null;
    const pk = record.priorityRaw !== null ? normKey(record.priorityRaw) : "";
    const priority = pk !== "" ? (priorityByKey.get(pk) as PmPriorityValue) : null;
    const assignees = record.assignees.map(personFor);
    for (const p of assignees) countPerson(p);
    const labels: string[] = [];
    for (const name of record.labels) {
      const lower = name.toLowerCase();
      if (existingLabels.has(lower)) labels.push(existingLabels.get(lower) as string);
      else if (mapping.createMissingLabels) {
        if (!newLabelNames.has(lower)) newLabelNames.set(lower, name);
        labels.push(newLabelNames.get(lower) as string);
      } else if (!droppedLabels.has(lower)) droppedLabels.set(lower, name);
    }
    return {
      record,
      status,
      priority,
      assignees,
      reporter: record.reporter ? personFor(record.reporter) : null,
      labels,
    };
  });

  const people: PlannedPersonSummary[] = [];
  const seenKeys = new Set<string>();
  for (const row of rows) {
    for (const p of row.assignees) {
      if (seenKeys.has(p.key)) continue;
      seenKeys.add(p.key);
      people.push({ ...p, count: peopleCounts.get(p.key) ?? 0 });
    }
  }

  return {
    rows,
    statuses,
    priorities,
    people,
    newStates,
    newLabels: [...newLabelNames.values()],
    droppedLabels: [...droppedLabels.values()],
  };
}
