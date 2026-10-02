/**
 * ADR-065 drift guard — the system-prompt layer table and the "where each
 * rule is enforced" map are claims about code. A claim nobody re-reads goes
 * stale the day a layer is added, so each one that can be checked is.
 *
 * What this pins, and the review finding behind each:
 *
 *   - Every capped layer the code builds has a row carrying its cap, in the
 *     order the route emits it, and the drop order is the one `degradeToFit`
 *     actually runs. The first draft omitted the brain block (ADR-051) and put
 *     the date line after memory.
 *   - Every function the enforcement map names is exported by the file the
 *     ADR names for it. The first draft named `tool-access.service.ts` for a
 *     function that lives in `routes/llm.ts`.
 *   - The confirmation row says what the interceptor really gates. Several
 *     write tools run on the first call by design (`requiresConfirmation:
 *     false`); the registry assertion below is the premise the ADR's wording
 *     rests on, so if it ever stops holding the ADR is due a rewrite.
 *   - The ENVIRONMENT.md row for DROPLET_IDENTITY_PATH names what the
 *     fallback keeps.
 *
 * Reads the docs and sources as text, no route import: `routes/llm.ts` pulls
 * in the whole app graph and this file only needs to know what it exports.
 */
import { describe, it, expect } from "vitest";
import { TOOLS } from "@droplet/tools-core";
import { IDENTITY_MAX_CHARS } from "../services/identity-prompt.js";
import {
  BUSINESS_CONTEXT_MAX_CHARS,
  DATE_LINE_MAX_CHARS,
  INTERVIEW_PROMPT_MAX_CHARS,
  OUTPUT_RESERVE,
  PERSONA_PROMPT_MAX_CHARS,
  TOOL_GUIDANCE_MAX_CHARS,
} from "../services/prompt-budget.consts.js";
import { MEMORY_FACTS_CHAR_BUDGET } from "../services/tool-budget.service.js";
import { BRAIN_BLOCK_CHAR_BUDGET } from "../services/brain/brain-block.service.js";
import { degradeToFit } from "../services/context-budget.service.js";
import { buildBaseSystemPrompt } from "../services/system-prompt.service.js";
import { readPackageFile, readRepoFile } from "./helpers/test-paths.js";

// Normalise CRLF so a Windows checkout reads the same as CI.
const adr = readRepoFile("docs", "ADR-065-assistant-identity-persona-memory-layers.md").replace(
  /\r\n/g,
  "\n",
);
const env = readRepoFile("docs", "ENVIRONMENT.md").replace(/\r\n/g, "\n");

/** The markdown table row whose text matches `label`, or fail naming it. */
function tableRow(label: RegExp): string {
  const row = adr.split("\n").find((l) => l.startsWith("|") && label.test(l));
  if (!row) throw new Error(`ADR-065 layer table has no row matching ${label}`);
  return row;
}

/** Section 2 of the ADR: from its heading to the next `### `. */
function enforcementSection(): string {
  const start = adr.indexOf("### 2.");
  const end = adr.indexOf("### 3.");
  if (start < 0 || end < 0) throw new Error("ADR-065 sections 2/3 not found");
  return adr.slice(start, end);
}

describe("ADR-065 layer table", () => {
  // In the order the chat route emits them into the one system message:
  // buildBaseSystemPrompt (identity, personality, business, tool guidance,
  // date line), then the route appends memory, the brain block and the
  // interview conductor.
  const layers: Array<{ label: RegExp; cap: number; extra?: string }> = [
    { label: /\*\*Identity\*\*/, cap: IDENTITY_MAX_CHARS },
    { label: /\*\*Personality\*\*/, cap: PERSONA_PROMPT_MAX_CHARS },
    { label: /\*\*Business context\*\*/, cap: BUSINESS_CONTEXT_MAX_CHARS },
    { label: /\*\*Tool guidance\*\*/, cap: TOOL_GUIDANCE_MAX_CHARS },
    { label: /\*\*Date line\*\*/, cap: DATE_LINE_MAX_CHARS },
    { label: /\*\*Durable memory\*\*/, cap: MEMORY_FACTS_CHAR_BUDGET },
    { label: /\*\*Brain block\*\*/, cap: BRAIN_BLOCK_CHAR_BUDGET, extra: "ADR-051" },
    { label: /\*\*Interview conductor\*\*/, cap: INTERVIEW_PROMPT_MAX_CHARS },
  ];

  it.each(layers)("has a row for $label carrying its cap", ({ label, cap, extra }) => {
    const row = tableRow(label);
    expect(row).toMatch(new RegExp(`\\b${cap}\\b`));
    if (extra) expect(row).toContain(extra);
  });

  it("lists the layers in the order the route emits them", () => {
    const at = layers.map(({ label }) => adr.indexOf(tableRow(label)));
    expect(at).toEqual([...at].sort((a, b) => a - b));

    // The code half of the same claim: the date line comes straight after
    // tool guidance inside buildBaseSystemPrompt, before anything the route
    // appends (memory, brain).
    const prompt = buildBaseSystemPrompt(undefined, "PERSONA", "BUSINESS", "DATE-LINE");
    const order = ["PERSONA", "BUSINESS", "Tool guidance:", "DATE-LINE"].map((s) =>
      prompt.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("states the drop order degradeToFit really runs", () => {
    const big = "x".repeat(2000);
    const result = degradeToFit(
      {
        identityBlock: "identity",
        personaBlock: big,
        businessBlock: big,
        toolGuidance: "",
        memoryFactsBlock: "",
        brainBlock: big,
        toolSchemasJson: "",
        pinsText: "",
        attachmentsText: "",
        historyText: "",
      },
      // A window just past the reserve forces every optional block out.
      { contextWindow: OUTPUT_RESERVE + 1 },
    );
    expect(result.dropped).toEqual(["business", "persona", "brain"]);
    expect(adr).toContain("business, then personality, then the brain block");
  });

  it("does not present the budget test's sum as covering the whole prompt", () => {
    // base-prompt-budget.test.ts sums seven blocks and leaves the brain
    // block out, so the ADR has to say so rather than imply the sum is total.
    const source = readPackageFile("src", "services", "base-prompt-budget.test.ts");
    expect(source).not.toMatch(/BRAIN_BLOCK_CHAR_BUDGET/);
    expect(adr).toMatch(/brain block[^.]*(outside|not in|excludes)[^.]*sum/i);
  });
});

describe("ADR-065 enforcement map", () => {
  // [identifier, file relative to apps/orchestrator/src (or the repo path
  // for packages/), how the ADR must spell the path]
  const cited: Array<[string, string, string]> = [
    ["narrowAllowedToolsForRole", "routes/llm.ts", "routes/llm.ts"],
    ["narrowToolNamesForPrincipal", "services/tool-access.service.ts", "services/tool-access.service.ts"],
    ["replayedWriteToolAttempt", "routes/llm.ts", "routes/llm.ts"],
    ["resolveOffLanProvider", "services/cloud-access.service.ts", "services/cloud-access.service.ts"],
    [
      "withholdPromptBlocksForOffLan",
      "services/stored-content-egress.service.ts",
      "services/stored-content-egress.service.ts",
    ],
    ["degradeToFit", "services/context-budget.service.ts", "context-budget.service.ts"],
    ["buildBrainBlock", "services/brain/brain-block.service.ts", "brain-block.service.ts"],
  ];

  it.each(cited)("%s is exported by the file the ADR names", (name, file, spelled) => {
    expect(adr).toContain(name);
    expect(adr).toContain(spelled);
    const source = readPackageFile("src", ...file.split("/"));
    expect(source).toMatch(new RegExp(`export (async )?function ${name}\\b`));
  });

  it("names the interceptor at the path it lives at", () => {
    expect(adr).toContain("packages/tools-core/src/interceptor.ts");
    expect(readRepoFile("packages", "tools-core", "src", "interceptor.ts")).toMatch(
      /export function createToolCallInterceptor\b/,
    );
  });

  it("says the interceptor only gates tools that declare requiresConfirmation", () => {
    // PREMISE: these write tools auto-execute. If this list stops being true
    // the ADR's "not gated" paragraph, and the identity file's scoped
    // wording, are due a rewrite.
    for (const name of ["delete_event", "create_reminder", "set_timer", "write_file"]) {
      const tool = TOOLS.get(name);
      expect(tool, name).toBeDefined();
      expect(tool!.requiresWrite, `${name} requiresWrite`).toBe(true);
      expect(tool!.requiresConfirmation, `${name} requiresConfirmation`).toBe(false);
    }
    // And the interceptor reads that flag, nothing else, to decide.
    expect(readRepoFile("packages", "tools-core", "src", "interceptor.ts")).toMatch(
      /if \(!tool\.requiresConfirmation\) \{/,
    );

    const section = enforcementSection();
    expect(section).toContain("requiresConfirmation");
    expect(section).toMatch(/first call/);
    expect(section).toContain("delete_event");
    expect(section).toContain("llm-safety-tiers.md");
  });

  it("is honest that the reference-data rule has no code behind it", () => {
    expect(enforcementSection()).toMatch(/reference-data rule[^.]*prose only/i);
  });

  it("names the off-LAN gate as the code behind 'no data leaves the box unasked'", () => {
    const section = enforcementSection();
    expect(section).toContain("resolveOffLanProvider");
    expect(section).toContain("withholdPromptBlocksForOffLan");
  });

  it("does not claim the identity file is the only prose statement of a limit", () => {
    // tool-guidance.service.ts carries its own credential rule.
    expect(readPackageFile("src", "services", "tool-guidance.service.ts")).toContain(
      "const CREDENTIAL_RULE",
    );
    expect(adr).not.toMatch(/only prose statement/i);
    expect(adr).not.toMatch(/one place to read/i);
    expect(adr).toContain("CREDENTIAL_RULE");
  });
});

describe("ENVIRONMENT.md DROPLET_IDENTITY_PATH row", () => {
  const row = env.split("\n").find((l) => l.startsWith("| `DROPLET_IDENTITY_PATH`")) ?? "";

  it("exists", () => {
    expect(row).not.toBe("");
  });

  it("says the fallback keeps a short rules summary, not the full section", () => {
    expect(row).toMatch(/falls back to[^.]*short built-in identity/i);
    expect(row).toMatch(/not the full "What you will and won't do" section/);
  });
});
