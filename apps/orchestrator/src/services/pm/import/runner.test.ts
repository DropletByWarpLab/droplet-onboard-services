/**
 * WARP-3527 — the two pure decisions the runner makes: what an UPDATE changes,
 * and where a NEW STATE goes. Everything database-shaped is in
 * `pm-import-export.pg.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { computeUpdatePatch, placeNewState, type DesiredFields, type ExistingItem } from "./runner.js";

const existing: ExistingItem = {
  name: "Fix login",
  descriptionHtml: "<p>Steps</p>",
  stateId: "s-todo",
  priority: "medium",
  parentId: null,
  startDate: null,
  dueDate: new Date("2024-03-31T00:00:00Z"),
  assigneeIds: ["u-dana"],
  labelIds: ["l-bug"],
};
const same: DesiredFields = {
  name: "Fix login",
  descriptionHtml: "<p>Steps</p>",
  stateId: "s-todo",
  priority: "medium",
  assigneeIds: ["u-dana"],
  labelIds: ["l-bug"],
  startDate: null,
  dueDate: new Date("2024-03-31T00:00:00Z"),
};

describe("computeUpdatePatch", () => {
  it("is null when the file says what the item already is (nothing is written)", () => {
    expect(computeUpdatePatch(existing, same)).toBeNull();
  });

  it("compares the SANITISED description, or an unchanged one would look changed forever", () => {
    const stored = { ...existing, descriptionHtml: "<p>a &amp; b</p>" };
    expect(computeUpdatePatch(stored, { ...same, descriptionHtml: "<p>a &amp; b<script>x</script></p>" })).toBeNull();
    expect(computeUpdatePatch(stored, { ...same, descriptionHtml: "<p>different</p>" })).toEqual({ descriptionHtml: "<p>different</p>" });
  });

  it("carries only the fields that differ", () => {
    expect(computeUpdatePatch(existing, { ...same, name: "Fix SSO login", priority: "urgent", stateId: "s-done" })).toEqual({
      name: "Fix SSO login",
      priority: "urgent",
      stateId: "s-done",
    });
  });

  it("a blank cell is no information: it never clears a field", () => {
    const blank: DesiredFields = {
      name: existing.name,
      descriptionHtml: null,
      stateId: undefined,
      priority: undefined,
      assigneeIds: [],
      labelIds: [],
      startDate: null,
      dueDate: null,
    };
    expect(computeUpdatePatch(existing, blank)).toBeNull();
  });

  it("assignees: replaced only when the file names someone we resolved, and order does not matter", () => {
    expect(computeUpdatePatch(existing, { ...same, assigneeIds: ["u-sam"] })).toEqual({ assignees: ["u-sam"] });
    const two = { ...existing, assigneeIds: ["u-a", "u-b"] };
    expect(computeUpdatePatch(two, { ...same, assigneeIds: ["u-b", "u-a"] })).toBeNull();
  });

  it("labels are additive: the union is written only when it grows", () => {
    expect(computeUpdatePatch(existing, { ...same, labelIds: ["l-bug"] })).toBeNull();
    expect(computeUpdatePatch(existing, { ...same, labelIds: [] })).toBeNull(); // not removed
    expect(computeUpdatePatch(existing, { ...same, labelIds: ["l-new"] })).toEqual({ labelIds: ["l-bug", "l-new"] });
  });

  it("dates compare by instant; a parent is set when the file gives one and it differs", () => {
    expect(computeUpdatePatch(existing, { ...same, dueDate: new Date("2024-04-01T00:00:00Z") })).toEqual({
      dueDate: new Date("2024-04-01T00:00:00Z"),
    });
    expect(computeUpdatePatch(existing, { ...same, startDate: new Date("2024-03-01T00:00:00Z") })).toEqual({
      startDate: new Date("2024-03-01T00:00:00Z"),
    });
    expect(computeUpdatePatch(existing, { ...same, parentId: "w-parent" })).toEqual({ parentId: "w-parent" });
    expect(computeUpdatePatch({ ...existing, parentId: "w-parent" }, { ...same, parentId: "w-parent" })).toBeNull();
  });
});

describe("placeNewState", () => {
  const states = [
    { group: "backlog", sortOrder: 0 },
    { group: "unstarted", sortOrder: 1 },
    { group: "started", sortOrder: 2 },
    { group: "completed", sortOrder: 3 },
    { group: "cancelled", sortOrder: 4 },
  ] as const;

  it("goes after the last state of the same or an earlier group", () => {
    expect(placeNewState(states, "started")).toBe(3); // after In Progress, before Done
    expect(placeNewState(states, "completed")).toBe(4); // after Done, before Cancelled
    expect(placeNewState(states, "cancelled")).toBe(5);
    expect(placeNewState(states, "unstarted")).toBe(2);
    expect(placeNewState(states, "backlog")).toBe(1);
  });

  it("goes first when nothing sorts before it, and ignores the order the array arrives in", () => {
    expect(placeNewState([{ group: "started", sortOrder: 0 }], "backlog")).toBe(0);
    expect(placeNewState([...states].reverse(), "started")).toBe(3);
    expect(placeNewState([], "started")).toBe(0);
  });
});
