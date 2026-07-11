/**
 * WARP-1255: department hierarchy validation utilities.
 *
 * Service-layer validators that Prisma schema constraints cannot express:
 *   - TEAM requires DEPARTMENT parent (can't be a team of a team)
 *   - DEPARTMENT/HOUSEHOLD must have null parent
 *   - TEAM cannot be a parent (one-level nesting only)
 *
 * Use these validators before write operations to catch invariant violations
 * early and emit honest error messages to the API layer.
 */

import type { DepartmentKind } from "@prisma/client";

export interface DepartmentValidationError {
  field: string;
  message: string;
}

/**
 * Validate department hierarchy constraints. Called before insert/update.
 *
 * Rules (WARP-1255 2026-07-11 amendment):
 *   1. TEAM kind requires a non-null parentId pointing to a DEPARTMENT
 *   2. DEPARTMENT/HOUSEHOLD kinds must have null parentId
 *   3. A TEAM cannot be a parent (enforced by checking parent.kind at write time)
 *
 * @param kind — DepartmentKind of the department being created/updated
 * @param parentId — optional self-reference to parent department
 * @param parentKind — kind of the parent department (only pass if parentId is set)
 * @returns array of validation errors; empty if valid
 */
export function validateDepartmentHierarchy(
  kind: DepartmentKind,
  parentId: string | null | undefined,
  parentKind?: DepartmentKind | null,
): DepartmentValidationError[] {
  const errors: DepartmentValidationError[] = [];

  // Rule 1: TEAM requires a DEPARTMENT parent
  if (kind === "TEAM") {
    if (!parentId) {
      errors.push({
        field: "parentId",
        message: "TEAM kind requires a non-null parentId pointing to a DEPARTMENT",
      });
    } else if (parentKind && parentKind !== "DEPARTMENT") {
      errors.push({
        field: "parentId",
        message: `TEAM parent must be kind DEPARTMENT, not ${parentKind}`,
      });
    }
  }

  // Rule 2: DEPARTMENT/HOUSEHOLD must have null parent
  if (kind === "DEPARTMENT" || kind === "HOUSEHOLD") {
    if (parentId) {
      errors.push({
        field: "parentId",
        message: `${kind} kind cannot have a parent (parentId must be null)`,
      });
    }
  }

  // Rule 3: TEAM cannot be a parent (parentKind check)
  // This is checked implicitly in rule 1 (parent must be DEPARTMENT, not TEAM),
  // but we can add an explicit check here for clarity if needed.
  if (parentKind === "TEAM") {
    errors.push({
      field: "parentId",
      message: "TEAM cannot be a parent; only DEPARTMENT can have child TEAMs",
    });
  }

  return errors;
}

/**
 * Validate a department for creation. Simpler variant when there's no parent data yet.
 *
 * @param kind — DepartmentKind of the department being created
 * @param parentId — optional self-reference to parent
 * @returns true if valid, false if parentId/kind combo is invalid
 */
export function isValidDepartmentHierarchy(
  kind: DepartmentKind,
  parentId: string | null | undefined,
): boolean {
  if (kind === "TEAM") {
    return !!parentId; // TEAM must have a parent
  }
  if (kind === "DEPARTMENT" || kind === "HOUSEHOLD") {
    return !parentId; // DEPARTMENT/HOUSEHOLD must NOT have a parent
  }
  return false; // unknown kind
}
