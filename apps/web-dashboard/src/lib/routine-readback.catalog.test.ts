/**
 * WARP-3355 — the Daily report's ERP reads, read back through the REAL registry.
 *
 * Kept apart from `routine-readback.test.ts` because it imports
 * `@droplet/tools-core`, which the dashboard's tsc lane cannot resolve (see the
 * `exclude` note in tsconfig.json); vitest resolves it through `resolve.alias`.
 *
 * The defect was in the shipped labels, so a hand-written catalog would pass
 * while a box with no practice connector still told its owner it checks "what
 * patients still owe" in "your practice software".
 */
import { describe, it, expect } from "vitest";
import { TOOL_CATALOG } from "@droplet/tools-core";
import { describeRoutine, readbackSentence } from "./routine-readback";
import type { RoutineStep, ToolCatalogEntry } from "./types";

const real = new Map<string, ToolCatalogEntry>(
  TOOL_CATALOG.map((t) => [
    t.name,
    {
      name: t.name,
      domain: t.domain,
      description: t.description,
      homeDescription: t.homeDescription,
      requiresWrite: t.requiresWrite,
      requiresConfirmation: t.requiresConfirmation,
    },
  ]),
);

const sentence = (tools: string[]) =>
  readbackSentence(
    describeRoutine({
      steps: tools.map(
        (tool, idx): RoutineStep => ({ id: `s${idx}`, idx, kind: "call", args: { tool, args: {} } }),
      ),
      catalog: real,
      writes: false,
      reversible: true,
    }),
  );

describe("describeRoutine — the Daily report's ERP reads (WARP-3355)", () => {
  it("says nothing about patients or practice software for the reads every box runs", () => {
    const out = sentence(["erp_get_ar_summary", "erp_get_schedule_today"]);
    expect(out).toBe(
      "When you run it — see what customers still owe at a glance, then see today's appointments at a glance.",
    );
    expect(out).not.toMatch(/patient|practice/i);
  });

  it("keeps the patient wording where the routine itself asks for a patient lookup", () => {
    expect(sentence(["erp_find_patient"])).toMatch(/patient/i);
  });
});
