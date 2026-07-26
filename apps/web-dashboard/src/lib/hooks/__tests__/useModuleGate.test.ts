/**
 * WARP-1397 — the sidebar module-gate decision (fail-open).
 * WARP-1528 — …now preferring the per-user view when the orchestrator sends it.
 */
import { describe, it, expect } from "vitest";
import { isModuleEffective } from "../useModuleGate";

const view = {
  modules: [
    { id: "smart_home", effective: false },
    { id: "cameras", effective: true },
    { id: "chat", effective: true },
  ],
};

describe("isModuleEffective", () => {
  it("hides a module only when it is positively not effective", () => {
    expect(isModuleEffective(view, "smart_home")).toBe(false);
    expect(isModuleEffective(view, "cameras")).toBe(true);
  });

  it("fails OPEN before the probe resolves (never hides on a blip)", () => {
    expect(isModuleEffective(undefined, "smart_home")).toBe(true);
    expect(isModuleEffective(undefined, "anything")).toBe(true);
  });

  it("shows a module the registry doesn't know (can't classify → don't hide)", () => {
    expect(isModuleEffective(view, "mystery_module")).toBe(true);
  });
});

// ── WARP-1528: the per-user layer ────────────────────────────────────
//
// `effectiveForUser` is workspace ∩ the caller's §9 grants, resolved
// server-side (ADR-032 §3). When it's present it is the ANSWER — it already
// contains the workspace intersection, so consulting `modules[].effective`
// on top would be redundant at best and wrong at worst.

const perUser = {
  modules: [
    { id: "cameras", effective: true },
    { id: "files", effective: true },
    { id: "chat", effective: true },
  ],
  effectiveForUser: [
    { moduleId: "chat", level: "act" as const },
    { moduleId: "cameras", level: "view" as const },
  ],
};

describe("isModuleEffective — effectiveForUser", () => {
  it("hides a workspace-ON module this PERSON wasn't granted", () => {
    // The box serves Files; this person's role never granted it.
    expect(isModuleEffective(perUser, "files")).toBe(false);
  });

  it("shows a module present in the person's grants", () => {
    expect(isModuleEffective(perUser, "cameras")).toBe(true);
    expect(isModuleEffective(perUser, "chat")).toBe(true);
  });

  it("hides a module absent from BOTH (workspace off ∩ not granted)", () => {
    expect(isModuleEffective(perUser, "network")).toBe(false);
  });

  it("falls back to the workspace view when the field is absent (older box)", () => {
    // An orchestrator that predates T4 sends no `effectiveForUser`; the nav
    // must keep working off the workspace payload exactly as before.
    expect(isModuleEffective(view, "smart_home")).toBe(false);
    expect(isModuleEffective(view, "cameras")).toBe(true);
  });

  it("falls back to the workspace view when the field is an EMPTY array", () => {
    // The server omits the field when it can't resolve the caller; an empty
    // array would mean "this person has nothing", which the always-on chat
    // floor makes impossible. Treat it as unresolved and fail open rather
    // than blanking every surface on a malformed payload.
    const empty = { ...view, effectiveForUser: [] };
    expect(isModuleEffective(empty, "cameras")).toBe(true);
    expect(isModuleEffective(empty, "smart_home")).toBe(false);
  });
});
