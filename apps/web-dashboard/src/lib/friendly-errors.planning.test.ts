/**
 * WARP-3521 — the cycle / module error codes the orchestrator's planning routes
 * emit (routes/pm/planning.ts, and cycle_id on the work-item routes) must each
 * leave the dashboard as a sentence, never as the snake_case code.
 */
import { describe, it, expect, vi } from "vitest";
import { translateError } from "./friendly-errors";

// Silence the operator breadcrumb.
vi.spyOn(console, "error").mockImplementation(() => {});

const PLANNING_CODES = [
  "cycle_not_found",
  "invalid_cycle",
  "cycle_completed",
  "cycle_already_active",
  "cycle_not_draft",
  "cycle_not_active",
  "cycle_dates_required",
  "invalid_dates",
  "module_not_found",
  "invalid_work_item",
  "lead_is_guest",
  "concurrent_mutation",
];

describe("translateError — projects domain, planning codes (WARP-3521)", () => {
  it.each(PLANNING_CODES)("%s becomes a sentence, not the code", (code) => {
    const err = Object.assign(new Error(code), { code, status: 409 });
    const copy = translateError(err, "projects");
    expect(copy).not.toContain("_");
    expect(copy).not.toBe("We couldn't save that change right now. Try again in a moment.");
    expect(copy.length).toBeGreaterThan(20);
    expect(copy).toMatch(/[.]$/);
    // ADR-002 voice: no exclamation marks, no blame
    expect(copy).not.toContain("!");
  });

  it("cycle_already_active tells the owner what to do about it", () => {
    const err = Object.assign(new Error("cycle_already_active"), { code: "cycle_already_active" });
    expect(translateError(err, "projects")).toMatch(/complete it/i);
  });

  it("a code it does not know still falls back to the domain sentence", () => {
    const err = Object.assign(new Error("cycle_exploded"), { code: "cycle_exploded" });
    expect(translateError(err, "projects")).toBe("We couldn't save that change right now. Try again in a moment.");
  });
});
