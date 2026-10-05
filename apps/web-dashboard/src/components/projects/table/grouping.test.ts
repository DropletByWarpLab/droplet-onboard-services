/**
 * WARP-3537 — grouping for the list and the table. The server answers exact
 * per-group COUNTS (the query API's `groupBy`); the rows themselves arrive in the
 * sort order, so the page puts them under their group headers. These tests pin
 * what a group is, which items it holds, how groups are ordered, and how the
 * flattened row model (what the table virtualises over) treats a collapsed one.
 */
import { describe, it, expect } from "vitest";
import {
  defaultGroupBy,
  effectiveGroupBy,
  flattenGroups,
  groupItems,
  groupOptions,
  serverCount,
} from "./grouping";
import type { PmDepartmentRef, PmLabel, PmState, PmWorkItem } from "../types";

const TODO: PmState = { id: "s-todo", projectId: "p1", name: "Todo", group: "unstarted", color: "#111111", sortOrder: 1, isDefault: true };
const DOING: PmState = { id: "s-doing", projectId: "p1", name: "Doing", group: "started", color: "#222222", sortOrder: 2, isDefault: false };
const DONE: PmState = { id: "s-done", projectId: "p1", name: "Done", group: "completed", color: "#333333", sortOrder: 3, isDefault: false };
const BUG: PmLabel = { id: "l-bug", projectId: "p1", name: "Bug", color: null };
const DOCS: PmLabel = { id: "l-docs", projectId: "p1", name: "Docs", color: null };
const FRONT: PmDepartmentRef = { id: "d-front", name: "Front desk", kind: "DEPARTMENT", parentId: null, source: "project" };
const BACK: PmDepartmentRef = { id: "d-back", name: "Back office", kind: "DEPARTMENT", parentId: null, source: "item" };

function item(n: number, over: Partial<PmWorkItem> = {}): PmWorkItem {
  return {
    id: `w${n}`,
    projectId: "p1",
    sequenceId: n,
    key: `INBOX-${n}`,
    name: `Item ${n}`,
    descriptionHtml: null,
    stateId: TODO.id,
    state: TODO,
    priority: "none",
    parentId: null,
    cycleId: null,
    department: null,
    assignees: [],
    labels: [],
    startDate: null,
    dueDate: null,
    sortOrder: n,
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

const NAMES: Record<string, string> = { ana: "Ana", bo: "Bo", cy: "Cy" };
const ctx = {
  personName: (id: string) => NAMES[id] ?? "Former member",
  projectName: (id: string) => ({ p1: "Onboarding", p2: "Billing" })[id],
};
const names = (gs: ReturnType<typeof groupItems>) => gs.map((g) => g.name);
const keysOf = (gs: ReturnType<typeof groupItems>) => gs.map((g) => g.key);

describe("groupItems: state", () => {
  it("orders groups by the column's position, names them from the item's own state, and keeps the server's row order inside", () => {
    const items = [item(1, { stateId: DONE.id, state: DONE }), item(2), item(3, { stateId: DOING.id, state: DOING }), item(4)];
    const gs = groupItems(items, "state", ctx);
    expect(names(gs)).toEqual(["Todo", "Doing", "Done"]);
    expect(gs[0].items.map((i) => i.id)).toEqual(["w2", "w4"]);
    expect(keysOf(gs)).toEqual([TODO.id, DOING.id, DONE.id]);
  });

  it("gives a group its state's own colour, and puts an item with no state last, as 'No state'", () => {
    const gs = groupItems([item(1, { stateId: null, state: null }), item(2)], "state", ctx);
    expect(names(gs)).toEqual(["Todo", "No state"]);
    expect(gs[0].color).toBe("#111111");
    expect(gs[1].key).toBeNull();
  });
});

describe("groupItems: stage (a workspace's stand-in for state — states are per project)", () => {
  it("orders backlog → unstarted → started → completed → cancelled, by what a state MEANS", () => {
    const other: PmState = { ...DOING, id: "other-doing", projectId: "p2", name: "In flight" };
    const gs = groupItems(
      [item(1, { stateId: DONE.id, state: DONE }), item(2, { projectId: "p2", stateId: other.id, state: other }), item(3), item(4, { stateId: DOING.id, state: DOING })],
      "stateGroup",
      ctx,
    );
    expect(names(gs)).toEqual(["To do", "In progress", "Done"]);
    expect(gs[1].items.map((i) => i.id)).toEqual(["w2", "w4"]);
    expect(keysOf(gs)).toEqual(["unstarted", "started", "completed"]);
  });
});

describe("groupItems: priority", () => {
  it("orders urgent → none, with the priority's own words", () => {
    const gs = groupItems([item(1), item(2, { priority: "urgent" }), item(3, { priority: "low" })], "priority", ctx);
    expect(names(gs)).toEqual(["Urgent", "Low", "None"]);
    expect(keysOf(gs)).toEqual(["urgent", "low", "none"]);
  });
});

describe("groupItems: assignee", () => {
  it("puts an item under EACH of its assignees, orders people by name, and ends with 'Unassigned'", () => {
    const gs = groupItems(
      [item(1, { assignees: ["cy", "ana"] }), item(2), item(3, { assignees: ["bo"] }), item(4, { assignees: ["ana"] })],
      "assignee",
      ctx,
    );
    expect(names(gs)).toEqual(["Ana", "Bo", "Cy", "Unassigned"]);
    expect(gs[0].items.map((i) => i.id)).toEqual(["w1", "w4"]);
    expect(gs[2].items.map((i) => i.id)).toEqual(["w1"]);
    expect(gs[3].items.map((i) => i.id)).toEqual(["w2"]);
    expect(keysOf(gs)).toEqual(["ana", "bo", "cy", null]);
  });

  it("names a person the directory no longer holds as a former member, not as an id", () => {
    const gs = groupItems([item(1, { assignees: ["u-gone"] })], "assignee", ctx);
    expect(names(gs)).toEqual(["Former member"]);
  });
});

describe("groupItems: label", () => {
  it("puts an item under each of its labels, orders them by name, and ends with 'No label'", () => {
    const gs = groupItems([item(1, { labels: [DOCS, BUG] }), item(2), item(3, { labels: [BUG] })], "label", ctx);
    expect(names(gs)).toEqual(["Bug", "Docs", "No label"]);
    expect(gs[0].items.map((i) => i.id)).toEqual(["w1", "w3"]);
    expect(keysOf(gs)).toEqual([BUG.id, DOCS.id, null]);
  });
});

describe("groupItems: department", () => {
  it("groups by the EFFECTIVE department — the item's own, else its project's — and ends with 'No department'", () => {
    const gs = groupItems([item(1, { department: FRONT }), item(2, { department: BACK }), item(3), item(4, { department: FRONT })], "department", ctx);
    expect(names(gs)).toEqual(["Back office", "Front desk", "No department"]);
    expect(gs[1].items.map((i) => i.id)).toEqual(["w1", "w4"]);
    expect(keysOf(gs)).toEqual(["d-back", "d-front", null]);
  });
});

describe("groupItems: project", () => {
  it("names a group after its project and carries the identifier as a quiet chip", () => {
    const gs = groupItems([item(1, { projectId: "p2", key: "BILL-1" }), item(2)], "project", ctx);
    expect(names(gs)).toEqual(["Billing", "Onboarding"]);
    expect(gs.map((g) => g.chip)).toEqual(["BILL", "INBOX"]);
    expect(keysOf(gs)).toEqual(["p2", "p1"]);
  });

  it("falls back to the identifier when the project is not in the list", () => {
    const gs = groupItems([item(1, { projectId: "p9", key: "GONE-1" })], "project", ctx);
    expect(names(gs)).toEqual(["GONE"]);
  });
});

describe("groupItems: shape", () => {
  it("gives every group a stable id (distinct per field, so a collapsed 'Todo' state is not a collapsed 'None' priority) and hides empty groups", () => {
    const a = groupItems([item(1)], "state", ctx)[0];
    const b = groupItems([item(1)], "priority", ctx)[0];
    expect(a.id).not.toBe(b.id);
    expect(groupItems([], "state", ctx)).toEqual([]);
  });
});

describe("the options a control offers, and what null means", () => {
  it("a project's list offers state first and no 'none' — it is grouped by default; a table does offer none", () => {
    const list = groupOptions("project", "list", { departments: true });
    expect(list.map((o) => o.value)).toEqual(["state", "assignee", "priority", "label", "department"]);
    const table = groupOptions("project", "table", { departments: true });
    expect(table.map((o) => o.value)).toEqual([null, "state", "assignee", "priority", "label", "department"]);
    expect(table[0].label).toBe("None");
  });

  it("a workspace offers project and stage instead of state and label — both are per project", () => {
    const opts = groupOptions("workspace", "table", { departments: true }).map((o) => o.value);
    expect(opts).toEqual([null, "project", "stateGroup", "assignee", "priority", "department"]);
    expect(opts).not.toContain("state");
    expect(opts).not.toContain("label");
  });

  it("offers department only when the box has any", () => {
    expect(groupOptions("project", "table", { departments: false }).map((o) => o.value)).not.toContain("department");
  });

  it("never offers what it cannot name yet: no cycle, no module (nothing lists them), no type (it does not exist)", () => {
    for (const scope of ["project", "workspace"] as const) {
      for (const layout of ["list", "table"] as const) {
        const values = groupOptions(scope, layout, { departments: true }).map((o) => o.value);
        for (const v of ["cycle", "module", "type"]) expect(values).not.toContain(v);
      }
    }
  });

  it("null means the layout's own default: a project list groups by state, a workspace list by project, a table by nothing", () => {
    expect(defaultGroupBy("project", "list")).toBe("state");
    expect(defaultGroupBy("workspace", "list")).toBe("project");
    expect(defaultGroupBy("project", "table")).toBeNull();
    expect(defaultGroupBy("workspace", "table")).toBeNull();
    expect(effectiveGroupBy(null, "project", "list")).toBe("state");
    expect(effectiveGroupBy("priority", "project", "list")).toBe("priority");
    expect(effectiveGroupBy(null, "project", "table")).toBeNull();
  });

  it("a saved group-by this layout does not offer falls back to the default instead of drawing nonsense", () => {
    // `state` in a workspace: states are per project, so it would be one group per project's "Todo".
    expect(effectiveGroupBy("state", "workspace", "list")).toBe("project");
    expect(effectiveGroupBy("label", "workspace", "table")).toBeNull();
  });
});

describe("flattenGroups", () => {
  const gs = groupItems([item(1), item(2), item(3, { stateId: DONE.id, state: DONE })], "state", ctx);

  it("is a header then its rows, group after group", () => {
    const rows = flattenGroups(gs, new Set());
    expect(rows.map((r) => (r.kind === "group" ? `# ${r.group.name}` : r.item.id))).toEqual(["# Todo", "w1", "w2", "# Done", "w3"]);
  });

  it("leaves a collapsed group's rows out, and says it is collapsed", () => {
    const rows = flattenGroups(gs, new Set([gs[0].id]));
    expect(rows.map((r) => (r.kind === "group" ? `# ${r.group.name}${r.collapsed ? " (collapsed)" : ""}` : r.item.id))).toEqual([
      "# Todo (collapsed)",
      "# Done",
      "w3",
    ]);
  });

  it("is only rows when there are no groups", () => {
    const rows = flattenGroups(null, new Set(), [item(1), item(2)]);
    expect(rows.map((r) => r.kind)).toEqual(["item", "item"]);
  });
});

describe("serverCount", () => {
  const server = [
    { key: TODO.id, count: 40 },
    { key: null, count: 3 },
  ];

  it("reads a group's exact count off the server's answer", () => {
    expect(serverCount(server, TODO.id)).toBe(40);
    expect(serverCount(server, null)).toBe(3);
  });

  it("is undefined when the server has not said", () => {
    expect(serverCount(server, "nope")).toBeUndefined();
    expect(serverCount(undefined, TODO.id)).toBeUndefined();
  });
});
