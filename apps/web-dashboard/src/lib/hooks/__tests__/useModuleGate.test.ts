/**
 * WARP-1397 — the sidebar module-gate decision (fail-open).
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
