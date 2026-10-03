/**
 * ADR-055 — the doors read floor is ONE fact stated twice, and the two must agree.
 *
 * `DOORS_READ_ROLES` is what the routes' role guards admit. The access catalog's
 * `view` for doors (`refuseBelowFloor`) is what the browser's module tier floor
 * and the assistant's acting-user gate apply. If they drift, one of two things
 * is true: the assistant reads doors for a person whose browser is refused (the
 * list is wider than the catalog), or the browser reads what the assistant does
 * not (the catalog is wider than the list). Both are named by a failing case.
 */
import { describe, it, expect } from "vitest";
import { DOORS_READ_ROLES, DOORS_WRITE_ROLES } from "./doors-access.js";
import { maxLevelFor, clampLevel, fullCatalogFeatures } from "./access-catalog.js";
import type { Role } from "./jwt.service.js";

const TIERS: readonly Role[] = ["owner", "admin", "family", "guest", "service"];

describe("doors read floor: the routes' role list and the access catalog say the same thing", () => {
  it.each(TIERS)("%s: admitted by the read routes ⇔ the catalog does not refuse them doors", (tier) => {
    const routeAdmits = (DOORS_READ_ROLES as readonly string[]).includes(tier);
    const catalogHolds = maxLevelFor(tier, "doors") !== null;
    expect(catalogHolds, `catalog vs routes for ${tier}`).toBe(routeAdmits);
    expect(clampLevel(tier, "doors", "view") !== null, `clamp vs routes for ${tier}`).toBe(routeAdmits);
    expect(fullCatalogFeatures(tier).some((f) => f.moduleId === "doors"), `full catalog vs routes for ${tier}`).toBe(routeAdmits);
  });

  it("the read list is owner and admin, and the write list is the owner alone (§11.4: not admin)", () => {
    expect([...DOORS_READ_ROLES]).toEqual(["owner", "admin"]);
    expect([...DOORS_WRITE_ROLES]).toEqual(["owner"]);
  });

  it("every writer is a reader: nobody may change a door they may not see", () => {
    for (const role of DOORS_WRITE_ROLES) expect(DOORS_READ_ROLES as readonly string[]).toContain(role);
  });
});
