/**
 * WARP-2979 (ADR-059 P4 §6.8) — a change to the summary prompt or to its
 * input contract without a SECURITY_NARRATIVE_PROMPT_VERSION bump fails
 * here, the ruleset-fingerprint pattern.
 *
 * Every written summary stores the prompt version that produced it
 * (`SecurityIncident.narrativePromptVersion`). A wording change under the
 * same version would make two summaries with the same version come from
 * different instructions. When this fails: bump the version, then pin the
 * new pair below, both lines in the same commit, deliberately.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  NARRATIVE_INPUT_SCHEMA_ID,
  SECURITY_NARRATIVE_PROMPT_VERSION,
  SECURITY_NARRATIVE_SYSTEM_PROMPT,
} from "./security-narrative-prompt.js";

const fingerprint = (system: string, schema: string): string => createHash("sha256").update(system + schema).digest("hex");

describe("the summary prompt fingerprint", () => {
  it("the system prompt and the input schema are pinned to their version", () => {
    expect({
      version: SECURITY_NARRATIVE_PROMPT_VERSION,
      fingerprint: fingerprint(SECURITY_NARRATIVE_SYSTEM_PROMPT, NARRATIVE_INPUT_SCHEMA_ID),
    }).toEqual({
      // v1 — WARP-2979 P4 PR-2: §6.8's prompt, verbatim, and NarrativeInputV1.
      version: 1,
      fingerprint: "3728305b464d7bc9859287e9224941886fe45ccbb4df4726887baddf39a2dc48",
    });
  });

  it("the fingerprint moves when a word does (the check can fail)", () => {
    const base = fingerprint(SECURITY_NARRATIVE_SYSTEM_PROMPT, NARRATIVE_INPUT_SCHEMA_ID);
    expect(fingerprint(SECURITY_NARRATIVE_SYSTEM_PROMPT.replace("someone", "somebody"), NARRATIVE_INPUT_SCHEMA_ID)).not.toBe(base);
    expect(fingerprint(SECURITY_NARRATIVE_SYSTEM_PROMPT, `${NARRATIVE_INPUT_SCHEMA_ID} `)).not.toBe(base);
  });
});
