/**
 * WARP-3537 — the bulk-edit contract the dashboard and the orchestrator share:
 * the cap, and which patch keys exist on this branch.
 */
import { describe, it, expect } from "vitest";
import { PM_BULK_MAX_IDS, PM_BULK_MAX_VALUES, PM_BULK_PATCH_KEYS, isPmBulkPatchEmpty } from "./pm-bulk";

describe("limits", () => {
  it("is 500 ids a request and 50 values in one list, the same numbers the work-item API already uses for lists", () => {
    expect(PM_BULK_MAX_IDS).toBe(500);
    expect(PM_BULK_MAX_VALUES).toBe(50);
  });
});

describe("the patch keys", () => {
  it("are exactly the fields this branch owns — no type, estimate or module", () => {
    expect([...PM_BULK_PATCH_KEYS].sort()).toEqual(
      ["addLabelIds", "assigneeIds", "cycleId", "isArchived", "priority", "removeLabelIds", "stateId"].sort(),
    );
  });
});

describe("isPmBulkPatchEmpty", () => {
  it("is true for no keys and for keys that are undefined", () => {
    expect(isPmBulkPatchEmpty({})).toBe(true);
    expect(isPmBulkPatchEmpty({ priority: undefined })).toBe(true);
  });

  it("is false for any key that says something — including the falsy ones", () => {
    expect(isPmBulkPatchEmpty({ cycleId: null })).toBe(false);
    expect(isPmBulkPatchEmpty({ isArchived: false })).toBe(false);
    expect(isPmBulkPatchEmpty({ assigneeIds: [] })).toBe(false);
  });
});
