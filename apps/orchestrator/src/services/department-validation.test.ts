/**
 * WARP-1255: unit tests for department hierarchy validation.
 */

import { describe, it, expect } from "vitest";
import {
  validateDepartmentHierarchy,
  isValidDepartmentHierarchy,
} from "./department-validation";
import type { DepartmentKind } from "@prisma/client";

describe("department-validation", () => {
  describe("validateDepartmentHierarchy", () => {
    it("allows DEPARTMENT with null parent", () => {
      const errors = validateDepartmentHierarchy("DEPARTMENT", null);
      expect(errors).toHaveLength(0);
    });

    it("allows HOUSEHOLD with null parent", () => {
      const errors = validateDepartmentHierarchy("HOUSEHOLD", null);
      expect(errors).toHaveLength(0);
    });

    it("rejects DEPARTMENT with a parent", () => {
      const errors = validateDepartmentHierarchy(
        "DEPARTMENT",
        "parent-id-123",
        "DEPARTMENT",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("parentId");
      expect(errors[0].message).toMatch(/cannot have a parent/);
    });

    it("rejects HOUSEHOLD with a parent", () => {
      const errors = validateDepartmentHierarchy(
        "HOUSEHOLD",
        "parent-id-123",
        "HOUSEHOLD",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("parentId");
      expect(errors[0].message).toMatch(/cannot have a parent/);
    });

    it("allows TEAM with DEPARTMENT parent", () => {
      const errors = validateDepartmentHierarchy(
        "TEAM",
        "dept-id-123",
        "DEPARTMENT",
      );
      expect(errors).toHaveLength(0);
    });

    it("rejects TEAM without a parent", () => {
      const errors = validateDepartmentHierarchy("TEAM", null);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("parentId");
      expect(errors[0].message).toMatch(/TEAM kind requires/);
    });

    it("rejects TEAM with HOUSEHOLD parent", () => {
      const errors = validateDepartmentHierarchy(
        "TEAM",
        "parent-id-123",
        "HOUSEHOLD",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("parentId");
      expect(errors[0].message).toMatch(/parent must be kind DEPARTMENT/);
    });

    it("rejects TEAM with TEAM parent (no nesting of teams)", () => {
      const errors = validateDepartmentHierarchy(
        "TEAM",
        "parent-id-123",
        "TEAM",
      );
      // Multiple errors can occur: both the "must be DEPARTMENT" rule and
      // the explicit "TEAM cannot be a parent" rule may trigger.
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("parent must be kind DEPARTMENT")))
        .toBe(true);
    });

    it("rejects when parentKind is explicitly TEAM (rule 3)", () => {
      // This tests the explicit check for TEAM as a parent
      const errors = validateDepartmentHierarchy(
        "TEAM",
        "team-as-parent",
        "TEAM",
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("parent must be kind DEPARTMENT")))
        .toBe(true);
    });
  });

  describe("isValidDepartmentHierarchy", () => {
    it("returns true for DEPARTMENT with null parent", () => {
      expect(isValidDepartmentHierarchy("DEPARTMENT", null)).toBe(true);
    });

    it("returns true for DEPARTMENT with undefined parent", () => {
      expect(isValidDepartmentHierarchy("DEPARTMENT", undefined)).toBe(true);
    });

    it("returns true for HOUSEHOLD with null parent", () => {
      expect(isValidDepartmentHierarchy("HOUSEHOLD", null)).toBe(true);
    });

    it("returns false for DEPARTMENT with a parent", () => {
      expect(isValidDepartmentHierarchy("DEPARTMENT", "parent-id")).toBe(false);
    });

    it("returns false for HOUSEHOLD with a parent", () => {
      expect(isValidDepartmentHierarchy("HOUSEHOLD", "parent-id")).toBe(false);
    });

    it("returns true for TEAM with a parent", () => {
      expect(isValidDepartmentHierarchy("TEAM", "parent-id")).toBe(true);
    });

    it("returns false for TEAM with null parent", () => {
      expect(isValidDepartmentHierarchy("TEAM", null)).toBe(false);
    });

    it("returns false for TEAM with undefined parent", () => {
      expect(isValidDepartmentHierarchy("TEAM", undefined)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles empty string parentId as falsy (like null)", () => {
      const errors = validateDepartmentHierarchy("TEAM", "");
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/requires a non-null parentId/);
    });

    it("allows TEAM with parent and no parentKind passed (assume it's checked elsewhere)", () => {
      // If caller only knows kind and parentId, not parent.kind, we should not error
      const errors = validateDepartmentHierarchy("TEAM", "parent-id");
      expect(errors).toHaveLength(0);
    });

    it("multiple errors can be present (DEPARTMENT with parent, though unlikely in practice)", () => {
      const errors = validateDepartmentHierarchy(
        "DEPARTMENT",
        "some-parent",
        "TEAM", // parent is invalid kind
      );
      // Should have at least the error about DEPARTMENT not having a parent
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => e.message.includes("cannot have a parent")))
        .toBe(true);
    });
  });
});
