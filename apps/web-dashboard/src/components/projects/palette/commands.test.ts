/**
 * WARP-3537 — what the command palette offers (brief §3.9): jump to a project or an
 * item, create an item, switch view, and — with a selection — run a bulk action on it.
 * Pure: which commands exist for a place and a role, and how a query ranks them.
 */
import { describe, it, expect, vi } from "vitest";
import { buildCommands, filterCommands, itemCommands, type PaletteCommand, type PaletteContext } from "./commands";
import type { PmLabel, PmProject, PmState, PmWorkItem } from "../types";

const STATES: PmState[] = [
  { id: "s1", projectId: "p1", name: "Todo", group: "unstarted", color: null, sortOrder: 1, isDefault: true },
  { id: "s2", projectId: "p1", name: "Done", group: "completed", color: null, sortOrder: 2, isDefault: false },
];
const LABELS: PmLabel[] = [{ id: "l1", projectId: "p1", name: "Bug", color: null }];
const project = (id: string, name: string, identifier: string, archived = false): PmProject =>
  ({ id, name, identifier, archived }) as PmProject;
const PROJECTS = [project("p1", "Onboarding", "INBOX"), project("p2", "Billing", "BILL"), project("p3", "Old stuff", "OLD", true)];

function ctx(over: Partial<PaletteContext> = {}): { c: PaletteContext; h: PaletteContext["handlers"] } {
  const h = {
    createItem: vi.fn(),
    showShortcuts: vi.fn(),
    openProject: vi.fn(),
    openAll: vi.fn(),
    openViewsIndex: vi.fn(),
    pickView: vi.fn(),
    switchLayout: vi.fn(),
    clearSelection: vi.fn(),
    bulk: vi.fn(),
  };
  const c: PaletteContext = {
    readOnly: false,
    scope: "project",
    project: { name: "Onboarding", identifier: "INBOX" },
    projects: PROJECTS,
    views: [
      { id: "mine", name: "My items" },
      { id: "v-1", name: "Urgent bugs" },
    ],
    layouts: [
      { id: "board", label: "Board" },
      { id: "list", label: "List" },
      { id: "table", label: "Table" },
    ],
    selectionCount: 0,
    canArchive: true,
    states: STATES,
    labels: LABELS,
    people: [
      { value: "u-ana", label: "Ana" },
      { value: "u-me", label: "Me Myself" },
    ],
    meId: "u-me",
    handlers: h,
    ...over,
  };
  return { c, h };
}
const titles = (cmds: PaletteCommand[]) => cmds.map((x) => x.title);
const find = (cmds: PaletteCommand[], title: string) => cmds.find((x) => x.title === title)!;

describe("buildCommands: the basics", () => {
  it("offers create (with its key), the shortcut sheet, every view layout, saved views and the projects", () => {
    const { c, h } = ctx();
    const cmds = buildCommands(c);
    const create = find(cmds, "Create a work item");
    expect(create.shortcut).toBe("C");
    create.run();
    expect(h.createItem).toHaveBeenCalledTimes(1);

    find(cmds, "Show keyboard shortcuts").run();
    expect(h.showShortcuts).toHaveBeenCalled();
    expect(find(cmds, "Show keyboard shortcuts").shortcut).toBe("?");

    find(cmds, "Go to the table").run();
    expect(h.switchLayout).toHaveBeenCalledWith("table");

    find(cmds, "Show Urgent bugs").run();
    expect(h.pickView).toHaveBeenCalledWith("v-1");

    expect(titles(cmds)).toContain("Open Onboarding");
    expect(titles(cmds)).toContain("Open Billing");
  });

  it("does not offer an archived project to jump to", () => {
    expect(titles(buildCommands(ctx().c))).not.toContain("Open Old stuff");
  });

  it("carries a project's identifier as the hint, so typing the key finds it", () => {
    const cmd = find(buildCommands(ctx().c), "Open Billing");
    expect(cmd.hint).toBe("BILL");
    expect(filterCommands([cmd], "bill").length).toBe(1);
  });

  it("opens the project it names when run", () => {
    const { c, h } = ctx();
    find(buildCommands(c), "Open Billing").run();
    expect(h.openProject).toHaveBeenCalledWith(PROJECTS[1]);
  });

  it("offers the way back to all projects and to the views index", () => {
    const { c, h } = ctx();
    const cmds = buildCommands(c);
    find(cmds, "Go to all projects").run();
    expect(h.openAll).toHaveBeenCalled();
    find(cmds, "Go to saved views").run();
    expect(h.openViewsIndex).toHaveBeenCalled();
  });
});

describe("buildCommands: who and where", () => {
  it("a reader gets no create and no bulk — hidden, not disabled", () => {
    const { c } = ctx({ readOnly: true, selectionCount: 3 });
    const cmds = buildCommands(c);
    expect(titles(cmds)).not.toContain("Create a work item");
    expect(cmds.some((x) => x.group === "Selection")).toBe(false);
    expect(titles(cmds)).toContain("Show keyboard shortcuts");
  });

  it("create needs a project to create IN — it is not offered on the workspace-wide list", () => {
    expect(titles(buildCommands(ctx({ scope: "workspace", project: null }).c))).not.toContain("Create a work item");
    expect(titles(buildCommands(ctx({ scope: "index", project: null }).c))).not.toContain("Create a work item");
  });

  it("the layouts offered are the ones this place has", () => {
    const cmds = buildCommands(ctx({ layouts: [{ id: "list", label: "List" }, { id: "table", label: "Table" }] }).c);
    expect(titles(cmds)).toContain("Go to the list");
    expect(titles(cmds)).not.toContain("Go to the board");
  });
});

describe("buildCommands: with a selection (bulk actions)", () => {
  it("offers nothing bulk while nothing is selected", () => {
    expect(buildCommands(ctx().c).some((x) => x.group === "Selection")).toBe(false);
  });

  it("moves the selection to each state, sets each priority, and says how many", () => {
    const { c, h } = ctx({ selectionCount: 3 });
    const cmds = buildCommands(c);
    find(cmds, "Move 3 selected to Done").run();
    expect(h.bulk).toHaveBeenLastCalledWith({ kind: "state", stateId: "s2" });
    find(cmds, "Set priority to Urgent on 3 selected").run();
    expect(h.bulk).toHaveBeenLastCalledWith({ kind: "priority", priority: "urgent" });
  });

  it("assigns to a person, to me, or to nobody — replacing, as the bulk edit does", () => {
    const { c, h } = ctx({ selectionCount: 2 });
    const cmds = buildCommands(c);
    find(cmds, "Assign 2 selected to Ana").run();
    expect(h.bulk).toHaveBeenLastCalledWith({ kind: "assignees", assigneeIds: ["u-ana"] });
    find(cmds, "Assign 2 selected to me").run();
    expect(h.bulk).toHaveBeenLastCalledWith({ kind: "assignees", assigneeIds: ["u-me"] });
    find(cmds, "Clear the assignee on 2 selected").run();
    expect(h.bulk).toHaveBeenLastCalledWith({ kind: "assignees", assigneeIds: [] });
  });

  it("adds and removes each label", () => {
    const { c, h } = ctx({ selectionCount: 1 });
    const cmds = buildCommands(c);
    find(cmds, "Add the label Bug to 1 selected").run();
    expect(h.bulk).toHaveBeenLastCalledWith({ kind: "label", labelId: "l1", mode: "add" });
    find(cmds, "Remove the label Bug from 1 selected").run();
    expect(h.bulk).toHaveBeenLastCalledWith({ kind: "label", labelId: "l1", mode: "remove" });
  });

  it("archives, unless the view is of archived items already; and clears the selection", () => {
    const { c, h } = ctx({ selectionCount: 4 });
    const cmds = buildCommands(c);
    find(cmds, "Archive 4 selected").run();
    expect(h.bulk).toHaveBeenLastCalledWith({ kind: "archive" });
    find(cmds, "Clear the selection").run();
    expect(h.clearSelection).toHaveBeenCalled();
    expect(titles(buildCommands(ctx({ selectionCount: 4, canArchive: false }).c))).not.toContain("Archive 4 selected");
  });

  it("offers no state or label commands without a project's states and labels (a workspace list)", () => {
    const cmds = buildCommands(ctx({ selectionCount: 2, scope: "workspace", project: null, states: [], labels: [] }).c);
    expect(titles(cmds).some((t) => t.startsWith("Move "))).toBe(false);
    expect(titles(cmds).some((t) => t.includes("the label"))).toBe(false);
    expect(titles(cmds)).toContain("Set priority to High on 2 selected");
  });

  it("everything it offers for a selection says Selection, so the palette can group it", () => {
    const cmds = buildCommands(ctx({ selectionCount: 2 }).c);
    const bulk = cmds.filter((x) => x.group === "Selection");
    expect(bulk.length).toBeGreaterThan(8);
  });
});

describe("itemCommands", () => {
  const item = (key: string, name: string, projectId = "p1") => ({ id: key, key, name, projectId }) as PmWorkItem;

  it("leads with the title, carries the key apart (it draws in mono) and the project's name as the hint", () => {
    const open = vi.fn();
    const [cmd] = itemCommands([item("BILL-7", "Fix invoice", "p2")], PROJECTS, open);
    expect(cmd.title).toBe("Fix invoice");
    expect(cmd.key).toBe("BILL-7");
    expect(cmd.hint).toBe("Billing");
    expect(cmd.group).toBe("Items");
    cmd.run();
    expect(open).toHaveBeenCalledWith("BILL-7");
  });

  it("matches on the key", () => {
    const [cmd] = itemCommands([item("BILL-7", "Fix invoice", "p2")], PROJECTS, vi.fn());
    expect(filterCommands([cmd], "bill-7")).toHaveLength(1);
    expect(filterCommands([cmd], "invoice")).toHaveLength(1);
  });
});

describe("filterCommands", () => {
  const mk = (title: string, extra: Partial<PaletteCommand> = {}): PaletteCommand => ({
    id: title,
    group: "Actions",
    title,
    run: () => undefined,
    ...extra,
  });

  it("is everything, in order, for an empty query", () => {
    const all = [mk("b"), mk("a")];
    expect(filterCommands(all, "")).toEqual(all);
    expect(filterCommands(all, "   ")).toEqual(all);
  });

  it("needs every word to match, in any order, ignoring case", () => {
    const all = [mk("Move 3 selected to Done"), mk("Move 3 selected to Todo")];
    expect(titles(filterCommands(all, "MOVE done"))).toEqual(["Move 3 selected to Done"]);
    expect(titles(filterCommands(all, "done move"))).toEqual(["Move 3 selected to Done"]);
    expect(filterCommands(all, "zzz")).toEqual([]);
  });

  it("puts a title that STARTS with the word first, then a word-start, then a substring", () => {
    const all = [mk("Reopen it"), mk("Open project"), mk("Go to open items")];
    expect(titles(filterCommands(all, "open"))).toEqual(["Open project", "Go to open items", "Reopen it"]);
  });

  it("matches on the hint and the keywords, not only the title", () => {
    const all = [mk("Open Onboarding", { hint: "INBOX" }), mk("Show Mine", { keywords: "assigned to me" })];
    expect(titles(filterCommands(all, "inbox"))).toEqual(["Open Onboarding"]);
    expect(titles(filterCommands(all, "assigned"))).toEqual(["Show Mine"]);
  });

  it("keeps the original order among equals", () => {
    const all = [mk("x one"), mk("x two"), mk("x three")];
    expect(titles(filterCommands(all, "x"))).toEqual(["x one", "x two", "x three"]);
  });
});
