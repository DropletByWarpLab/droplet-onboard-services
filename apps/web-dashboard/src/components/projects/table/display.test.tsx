/**
 * WARP-3537 — a view's display options: how it is grouped, sorted and which columns
 * it shows. They persist in the SAME saved view as the filter (`groupBy` / `sortBy`
 * / `columns` on PmSavedView) — no second mechanism — and until saved they are the
 * page's session state, seeded from the active view. `null` for any of them is
 * "the layout's own default".
 */
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PM_TABLE_DEFAULT_COLUMNS, type PmSortSpec } from "@droplet/shared-types";
import { NO_DISPLAY, displayEqual, resolveDisplay, useTableDisplay, type ViewDisplay } from "./display";

const DUE: PmSortSpec[] = [{ field: "dueDate", dir: "asc" }];

describe("resolveDisplay", () => {
  it("is the layout's defaults for a view that says nothing", () => {
    expect(resolveDisplay(NO_DISPLAY, "project", "table")).toEqual({
      groupBy: null,
      sort: null,
      columns: [...PM_TABLE_DEFAULT_COLUMNS.project],
    });
    expect(resolveDisplay(NO_DISPLAY, "project", "list").groupBy).toBe("state");
    expect(resolveDisplay(NO_DISPLAY, "workspace", "list").groupBy).toBe("project");
  });

  it("reads columns tolerantly — an id this build lacks is dropped, the title is put back", () => {
    const r = resolveDisplay({ ...NO_DISPLAY, columns: ["state", "estimate"] }, "project", "table");
    expect(r.columns).toEqual(["name", "state"]);
  });

  it("carries a saved sort and group-by through", () => {
    const r = resolveDisplay({ groupBy: "priority", sortBy: DUE, columns: null }, "project", "table");
    expect(r.groupBy).toBe("priority");
    expect(r.sort).toEqual(DUE);
  });
});

describe("displayEqual", () => {
  const eq = (a: ViewDisplay, b: ViewDisplay) => displayEqual(a, b, "project", "table");

  it("compares what is DRAWN, so null and the default spelled out are the same", () => {
    expect(eq(NO_DISPLAY, { ...NO_DISPLAY, columns: [...PM_TABLE_DEFAULT_COLUMNS.project] })).toBe(true);
    expect(eq(NO_DISPLAY, { ...NO_DISPLAY, sortBy: [] })).toBe(true);
  });

  it("sees a real difference in any of the three", () => {
    expect(eq(NO_DISPLAY, { ...NO_DISPLAY, groupBy: "state" })).toBe(false);
    expect(eq(NO_DISPLAY, { ...NO_DISPLAY, sortBy: DUE })).toBe(false);
    expect(eq(NO_DISPLAY, { ...NO_DISPLAY, columns: ["name"] })).toBe(false);
  });

  it("a list's null group-by is state, so saying 'state' is no change there — and a change in a table", () => {
    expect(displayEqual(NO_DISPLAY, { ...NO_DISPLAY, groupBy: "state" }, "project", "list")).toBe(true);
    expect(displayEqual(NO_DISPLAY, { ...NO_DISPLAY, groupBy: "state" }, "project", "table")).toBe(false);
  });
});

describe("useTableDisplay", () => {
  const SAVED: ViewDisplay = { groupBy: "priority", sortBy: DUE, columns: ["name", "state"] };
  type Props = { saved: ViewDisplay | null; scopeKey: string };
  const mount = (initial: Props) =>
    renderHook((p: Props) => useTableDisplay({ ...p, scope: "project", layout: "table" }), { initialProps: initial });

  it("starts as the saved view says, and is not dirty", () => {
    const { result } = mount({ saved: SAVED, scopeKey: "v1" });
    expect(result.current.resolved).toMatchObject({ groupBy: "priority", sort: DUE, columns: ["name", "state"] });
    expect(result.current.dirty).toBe(false);
  });

  it("starts as the defaults when there is no saved view", () => {
    const { result } = mount({ saved: null, scopeKey: "none" });
    expect(result.current.resolved.groupBy).toBeNull();
    expect(result.current.resolved.sort).toBeNull();
    expect(result.current.dirty).toBe(false);
  });

  it("a change shows at once and makes the view dirty; the raw value is what a save would send", () => {
    const { result } = mount({ saved: SAVED, scopeKey: "v1" });
    act(() => result.current.setSort([{ field: "name", dir: "desc" }]));
    expect(result.current.resolved.sort).toEqual([{ field: "name", dir: "desc" }]);
    expect(result.current.dirty).toBe(true);
    expect(result.current.raw).toEqual({ groupBy: "priority", sortBy: [{ field: "name", dir: "desc" }], columns: ["name", "state"] });
  });

  it("changing something back to what the view says is not dirty any more", () => {
    const { result } = mount({ saved: SAVED, scopeKey: "v1" });
    act(() => result.current.setGroupBy("state"));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.setGroupBy("priority"));
    expect(result.current.dirty).toBe(false);
  });

  it("stores the layout's default as null, so a saved view is never full of spelled-out defaults", () => {
    const { result } = mount({ saved: null, scopeKey: "none" });
    act(() => result.current.setColumns([...PM_TABLE_DEFAULT_COLUMNS.project]));
    expect(result.current.raw.columns).toBeNull();
    act(() => result.current.setGroupBy(null));
    expect(result.current.raw.groupBy).toBeNull();
    act(() => result.current.setSort([]));
    expect(result.current.raw.sortBy).toBeNull();
  });

  it("normalises columns it is given: the title is never missing, order is kept", () => {
    const { result } = mount({ saved: null, scopeKey: "none" });
    act(() => result.current.setColumns(["state", "dueDate"]));
    expect(result.current.resolved.columns).toEqual(["name", "state", "dueDate"]);
  });

  it("reset puts the saved view back", () => {
    const { result } = mount({ saved: SAVED, scopeKey: "v1" });
    act(() => {
      result.current.setSort(null);
      result.current.setGroupBy(null);
    });
    expect(result.current.dirty).toBe(true);
    act(() => result.current.reset());
    expect(result.current.dirty).toBe(false);
    expect(result.current.resolved.groupBy).toBe("priority");
  });

  it("switching to another view drops the edits made to the last one and shows the new view's own", () => {
    const { result, rerender } = mount({ saved: SAVED, scopeKey: "v1" });
    act(() => result.current.setSort(null));
    expect(result.current.resolved.sort).toBeNull();

    rerender({ saved: { groupBy: null, sortBy: [{ field: "priority", dir: "asc" }], columns: null }, scopeKey: "v2" });
    expect(result.current.resolved.sort).toEqual([{ field: "priority", dir: "asc" }]);
    expect(result.current.dirty).toBe(false);
  });

  it("keeps the edits across a re-render that is still the same view", () => {
    const { result, rerender } = mount({ saved: SAVED, scopeKey: "v1" });
    act(() => result.current.setGroupBy("label"));
    rerender({ saved: { ...SAVED }, scopeKey: "v1" });
    expect(result.current.resolved.groupBy).toBe("label");
  });

  it("once the view is updated (its key moves on) the saved values ARE what was edited, and nothing is dirty", () => {
    const { result, rerender } = mount({ saved: SAVED, scopeKey: "v1" });
    act(() => result.current.setGroupBy("label"));
    rerender({ saved: { ...SAVED, groupBy: "label" }, scopeKey: "v1@later" });
    expect(result.current.resolved.groupBy).toBe("label");
    expect(result.current.dirty).toBe(false);
  });
});
