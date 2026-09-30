import { describe, it, expect } from "vitest";
import {
  INTERNAL_DRAG_TYPE,
  isInternalDrag,
  movablePaths,
  readDragPaths,
  writeDragPaths,
} from "./internal-drag";

/** Just enough DataTransfer for the helpers: types track what setData wrote. */
export function makeDataTransfer(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    get types() {
      return Object.keys(store);
    },
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? "",
    effectAllowed: "uninitialized",
    dropEffect: "none",
  } as unknown as DataTransfer;
}

describe("movablePaths", () => {
  it("keeps a file dropped into a different folder", () => {
    expect(movablePaths("/Docs", ["/a.txt"])).toEqual(["/a.txt"]);
  });

  it("drops the target itself (self-drop is a no-op)", () => {
    expect(movablePaths("/Docs", ["/Docs"])).toEqual([]);
  });

  it("refuses a folder dropped into its own descendant", () => {
    expect(movablePaths("/Docs/Sub/Deep", ["/Docs"])).toEqual([]);
  });

  it("does not confuse a sibling that merely shares a name prefix", () => {
    expect(movablePaths("/Docs2", ["/Docs"])).toEqual(["/Docs"]);
  });

  it("treats a drop into the item's current parent as a no-op", () => {
    expect(movablePaths("/Docs", ["/Docs/a.txt"])).toEqual([]);
    expect(movablePaths("/", ["/a.txt"])).toEqual([]);
  });

  it("moves nothing when the selection is dropped on one of its own members", () => {
    expect(movablePaths("/B", ["/A", "/B", "/c.txt"])).toEqual([]);
  });

  it("filters per item, keeping the ones that do change", () => {
    expect(movablePaths("/Docs", ["/Docs/a.txt", "/b.txt", "/Docs"])).toEqual([]);
    expect(movablePaths("/Docs", ["/Docs/a.txt", "/b.txt"])).toEqual(["/b.txt"]);
  });

  it("tolerates a trailing slash on the target", () => {
    expect(movablePaths("/Docs/", ["/Docs"])).toEqual([]);
  });
});

describe("drag payload", () => {
  it("round-trips paths under the internal type and marks the drag internal", () => {
    const dt = makeDataTransfer();
    expect(isInternalDrag(dt)).toBe(false);
    writeDragPaths(dt, ["/a", "/b c"]);
    expect(isInternalDrag(dt)).toBe(true);
    expect(dt.effectAllowed).toBe("move");
    expect(readDragPaths(dt)).toEqual(["/a", "/b c"]);
  });

  it("does not treat an external file drag as internal", () => {
    expect(isInternalDrag(makeDataTransfer({ Files: "" }))).toBe(false);
    expect(isInternalDrag(null)).toBe(false);
  });

  it("reads a malformed payload as empty", () => {
    expect(readDragPaths(makeDataTransfer({ [INTERNAL_DRAG_TYPE]: "{nope" }))).toEqual([]);
    expect(readDragPaths(makeDataTransfer({ [INTERNAL_DRAG_TYPE]: '{"a":1}' }))).toEqual([]);
  });
});
