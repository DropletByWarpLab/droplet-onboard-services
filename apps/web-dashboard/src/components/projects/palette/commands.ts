// WARP-3537 — what the command palette offers (brief §3.9): jump to a project or an
// item, create an item, switch view, and — with a selection in the table — run a
// bulk action on it. Pure: which commands exist for a place and a role, and how a
// query ranks them. The palette component only draws them and runs the one chosen.
//
// Writes are hidden from a reader (brief §8: not disabled-and-teasing), and a
// command that needs something that is not here is not offered: no "Create" on the
// workspace-wide list (there is no project to create IN), no "Move to…" where there
// are no states to move to.

import { PRIORITY, PRIORITY_ORDER } from "../config";
import type { BulkOp } from "../bulk/plan";
import type { PmLabel, PmProject, PmState, PmWorkItem } from "../types";

export type CommandGroup = "Actions" | "Selection" | "Views" | "Projects" | "Items";

export interface PaletteCommand {
  id: string;
  group: CommandGroup;
  title: string;
  /** A work-item key, drawn in mono before the title (brief §2.5). */
  key?: string;
  /** A quiet word after the title: a project's identifier, an item's project. */
  hint?: string;
  /** The shortcut that does the same, shown on the right. */
  shortcut?: string;
  /** Words that match but are not shown. */
  keywords?: string;
  run: () => void;
}

export type PaletteLayout = "board" | "list" | "table" | "calendar" | "timeline";

export interface PaletteContext {
  readOnly: boolean;
  scope: "project" | "workspace" | "index" | "views";
  /** The project open now; null off a project page. */
  project: { name: string; identifier: string } | null;
  projects: PmProject[];
  /** The views offered here: the built-ins, then the saved ones. */
  views: Array<{ id: string; name: string }>;
  /** The layouts this place has. */
  layouts: Array<{ id: PaletteLayout; label: string }>;
  selectionCount: number;
  /** False when the view already shows only archived items — archiving them again is no action. */
  canArchive: boolean;
  states: PmState[];
  labels: PmLabel[];
  people: Array<{ value: string; label: string }>;
  meId: string | null;
  handlers: {
    createItem: () => void;
    showShortcuts: () => void;
    openProject: (p: PmProject) => void;
    openAll: () => void;
    openViewsIndex: () => void;
    pickView: (id: string) => void;
    switchLayout: (id: PaletteLayout) => void;
    clearSelection: () => void;
    bulk: (op: BulkOp) => void;
  };
}

export function buildCommands(c: PaletteContext): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  const h = c.handlers;
  const add = (cmd: PaletteCommand) => out.push(cmd);

  // ── actions
  if (!c.readOnly && c.scope === "project" && c.project) {
    add({ id: "create", group: "Actions", title: "Create a work item", shortcut: "C", keywords: "new add task", run: h.createItem });
  }
  for (const l of c.layouts) {
    add({ id: `layout:${l.id}`, group: "Actions", title: `Go to the ${l.label.toLowerCase()}`, keywords: "view layout switch", run: () => h.switchLayout(l.id) });
  }
  add({ id: "all", group: "Actions", title: "Go to all projects", run: h.openAll });
  add({ id: "views-index", group: "Actions", title: "Go to saved views", keywords: "filters", run: h.openViewsIndex });
  add({ id: "shortcuts", group: "Actions", title: "Show keyboard shortcuts", shortcut: "?", keywords: "keys help", run: h.showShortcuts });

  // ── the selection
  if (!c.readOnly && c.selectionCount > 0) {
    const n = c.selectionCount;
    const sel = (id: string, title: string, op: BulkOp, keywords?: string) =>
      add({ id: `bulk:${id}`, group: "Selection", title, keywords, run: () => h.bulk(op) });
    for (const s of [...c.states].sort((a, b) => a.sortOrder - b.sortOrder)) {
      sel(`state:${s.id}`, `Move ${n} selected to ${s.name}`, { kind: "state", stateId: s.id }, "state status transition");
    }
    for (const p of PRIORITY_ORDER) {
      sel(`priority:${p}`, `Set priority to ${PRIORITY[p].label} on ${n} selected`, { kind: "priority", priority: p });
    }
    for (const person of c.people) {
      sel(`assign:${person.value}`, `Assign ${n} selected to ${person.label}`, { kind: "assignees", assigneeIds: [person.value] }, "assignee owner");
    }
    if (c.meId) sel("assign:me", `Assign ${n} selected to me`, { kind: "assignees", assigneeIds: [c.meId] }, "assignee owner");
    sel("assign:none", `Clear the assignee on ${n} selected`, { kind: "assignees", assigneeIds: [] }, "unassign nobody");
    for (const l of c.labels) {
      sel(`label+:${l.id}`, `Add the label ${l.name} to ${n} selected`, { kind: "label", labelId: l.id, mode: "add" });
      sel(`label-:${l.id}`, `Remove the label ${l.name} from ${n} selected`, { kind: "label", labelId: l.id, mode: "remove" });
    }
    if (c.canArchive) sel("archive", `Archive ${n} selected`, { kind: "archive" }, "hide");
    add({ id: "clear-selection", group: "Selection", title: "Clear the selection", shortcut: "Esc", run: h.clearSelection });
  }

  // ── saved views here
  for (const v of c.views) add({ id: `view:${v.id}`, group: "Views", title: `Show ${v.name}`, keywords: "view filter", run: () => h.pickView(v.id) });

  // ── projects
  for (const p of c.projects) {
    if (p.archived) continue;
    add({ id: `project:${p.id}`, group: "Projects", title: `Open ${p.name}`, hint: p.identifier, keywords: "project jump go", run: () => h.openProject(p) });
  }
  return out;
}

/** Work items found by the palette's search, as commands that open the item. */
export function itemCommands(items: PmWorkItem[], projects: PmProject[], open: (key: string) => void): PaletteCommand[] {
  return items.map((it) => ({
    id: `item:${it.id}`,
    group: "Items" as const,
    title: it.name,
    key: it.key,
    hint: projects.find((p) => p.id === it.projectId)?.name,
    run: () => open(it.key),
  }));
}

// ── ranking ─────────────────────────────────────────────────────────────────

function fieldsOf(c: PaletteCommand): { title: string; rest: string } {
  return { title: c.title.toLowerCase(), rest: `${c.key ?? ""} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase() };
}

/** A command's score for one word, or -1 if it does not match. A title that STARTS with the word beats a
 *  word-start inside the title, which beats a plain substring, which beats a match in the hint or keywords. */
function scoreWord(f: { title: string; rest: string }, word: string): number {
  if (f.title.startsWith(word)) return 4;
  if (f.title.includes(` ${word}`)) return 3;
  if (f.title.includes(word)) return 2;
  if (f.rest.includes(word)) return 1;
  return -1;
}

/** Every word must match, in any order; best matches first, the original order among equals. */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  const scored: Array<{ c: PaletteCommand; score: number; at: number }> = [];
  commands.forEach((c, at) => {
    const f = fieldsOf(c);
    let total = 0;
    for (const w of words) {
      const s = scoreWord(f, w);
      if (s < 0) return;
      total += s;
    }
    scored.push({ c, score: total, at });
  });
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((x) => x.c);
}
