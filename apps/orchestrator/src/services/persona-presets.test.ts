/**
 * WARP-1118 — the four code-versioned personality preset fragments.
 *
 * Presets are product copy, versioned with the app (§7.1), not DB rows.
 * Each is a short style fragment injected (composed by persona.service)
 * into the base prompt. Two hard contracts the tests pin:
 *   1. exactly the four canonical preset names, matching the Prisma enum;
 *   2. every fragment ≤ PERSONA_PRESET_MAX_CHARS (400) so the composed
 *      block can never blow PERSONA_PROMPT_MAX_CHARS on the preset alone.
 */
import { describe, it, expect } from "vitest";
import {
  PERSONA_PRESETS,
  PERSONA_PRESET_MAX_CHARS,
  type PersonaPresetName,
} from "./persona-presets.js";

const EXPECTED_PRESET_NAMES: PersonaPresetName[] = [
  "warm_friendly",
  "professional_precise",
  "founder",
  "direct_technical",
];

describe("PERSONA_PRESETS", () => {
  it("defines exactly the four canonical presets, matching the Prisma enum", () => {
    expect(Object.keys(PERSONA_PRESETS).sort()).toEqual(
      [...EXPECTED_PRESET_NAMES].sort(),
    );
  });

  it("caps every fragment at PERSONA_PRESET_MAX_CHARS (400)", () => {
    expect(PERSONA_PRESET_MAX_CHARS).toBe(400);
    for (const name of EXPECTED_PRESET_NAMES) {
      const fragment = PERSONA_PRESETS[name];
      expect(fragment.length, `${name} fragment length`).toBeGreaterThan(0);
      expect(fragment.length, `${name} fragment length`).toBeLessThanOrEqual(
        PERSONA_PRESET_MAX_CHARS,
      );
    }
  });

  it("gives each preset a distinct fragment (no copy-paste collision)", () => {
    const values = EXPECTED_PRESET_NAMES.map((n) => PERSONA_PRESETS[n]);
    expect(new Set(values).size).toBe(values.length);
  });

  it("never instructs the model to change its name or model (One-Model Rule)", () => {
    for (const name of EXPECTED_PRESET_NAMES) {
      const lower = PERSONA_PRESETS[name].toLowerCase();
      expect(lower, `${name}`).not.toContain("ollama");
      expect(lower, `${name}`).not.toContain("your name is");
    }
  });
});
