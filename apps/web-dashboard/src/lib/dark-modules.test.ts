/**
 * The modules that ship dark (`dark-modules.ts`) are named one by one, never
 * derived: "unlisted from GET /api/modules" is a decision made per module in
 * the registry. None ships dark in this build, so the list is pinned empty —
 * adding a module to it makes this fail, and the ship-dark behaviour itself is
 * pinned (against a synthetic id) in `useModuleGate.test.ts` and
 * `ModuleRouteGuard.test.tsx`.
 */
import { describe, it, expect } from "vitest";

import { ABSENT_UNLESS_LISTED } from "./dark-modules";

describe("ABSENT_UNLESS_LISTED", () => {
  it("names no module: nothing ships dark in this build", () => {
    expect([...ABSENT_UNLESS_LISTED]).toEqual([]);
  });
});
