/**
 * WARP-1809 — orgUnitDisplayName, the UPPERCASE-DepartmentKind flavor of the
 * WARP-1808 display mapping (spaceRenderName owns the lowercase FileSpace
 * flavor). ONE shared helper for every surface holding a Department-shaped
 * row — DepartmentsPanel's deptDisplayName delegates here, and the People
 * page's effective-access drawer uses it on deptRights chips — so the
 * "render HOUSEHOLD as Workspace, keyed off kind, never the name" rule has
 * exactly two implementations product-wide (one per kind vocabulary), not
 * three.
 */
import { describe, it, expect } from "vitest";
import { orgUnitDisplayName } from "./org-unit-name";

describe("orgUnitDisplayName (WARP-1809)", () => {
  it("maps a HOUSEHOLD unit to 'Workspace' even when the raw name differs", () => {
    expect(orgUnitDisplayName("HOUSEHOLD", "Household")).toBe("Workspace");
    // Keyed off kind, never the name string — a renamed server row maps too.
    expect(orgUnitDisplayName("HOUSEHOLD", "The Smiths")).toBe("Workspace");
  });

  it("passes DEPARTMENT and TEAM names through verbatim", () => {
    expect(orgUnitDisplayName("DEPARTMENT", "Finance")).toBe("Finance");
    expect(orgUnitDisplayName("TEAM", "Platform")).toBe("Platform");
    // A user-created unit that happens to be NAMED "Household" renders
    // verbatim — the mapping is about the seeded kind, not the word.
    expect(orgUnitDisplayName("DEPARTMENT", "Household")).toBe("Household");
  });

  it("fails safe to the raw name when kind is absent (older orchestrator)", () => {
    expect(orgUnitDisplayName(undefined, "Finance")).toBe("Finance");
    expect(orgUnitDisplayName(undefined, "Household")).toBe("Household");
  });
});
