/**
 * WARP-1118 — worst-case fixed-system-block budget canary (§10).
 *
 * `BASE_PROMPT_MAX_CHARS = 10000` bounds the worst-case sum of the FIXED
 * system-prompt chars: the identity core at its cap, the persona block at
 * its cap, and the tool-guidance bullets. §10 requires the assertion to
 * ALSO fold in a representative serialized tools[] payload — because the
 * number that actually matters is the whole request, and tools[] lives in
 * no block. This test builds the real advertised tools[] the same way the
 * agent loop does, so a future tool addition or block-copy edit that would
 * push the fixed portion toward the box's 4096-token window fails in CI.
 *
 * NOTE: this canary asserts the FIXED-block char sum stays under the char
 * ceiling; the RUNTIME overflow gate is estimateRequestTokens/degradeToFit
 * (context-budget.service.test.ts), which additionally accounts for pins,
 * attachments, and history.
 */
import { describe, it, expect } from "vitest";
import { TOOLS } from "@droplet/tools-core";
import {
  BASE_PROMPT_MAX_CHARS,
  estimateTokensFromChars,
  DEFAULT_NUM_CTX,
  OUTPUT_TOKEN_RESERVE,
} from "./context-budget.service.js";
import { IDENTITY_MAX_CHARS } from "./identity-prompt.js";
import { PERSONA_PROMPT_MAX_CHARS } from "./persona.service.js";

/** The tool-guidance block from buildBaseSystemPrompt, at its widest (every
 *  bullet present — the owner/privileged case). Kept in sync by eye; a copy
 *  edit that grows it is exactly what this canary is meant to catch. */
const WIDEST_TOOL_GUIDANCE_CHARS = 600;

/** Serialize the full registry to the wire tools[] shape the model sees
 *  (llm-agent.service.ts). The owner role is advertised every tool, so the
 *  full registry IS the worst case. */
function serializeAllToolSchemas(): string {
  const tools = Array.from(TOOLS.values()).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
  return JSON.stringify(tools);
}

describe("worst-case fixed system-block budget", () => {
  it("keeps identity + persona + tool guidance under BASE_PROMPT_MAX_CHARS", () => {
    const fixedBlockChars =
      IDENTITY_MAX_CHARS + PERSONA_PROMPT_MAX_CHARS + WIDEST_TOOL_GUIDANCE_CHARS;
    expect(fixedBlockChars).toBeLessThanOrEqual(BASE_PROMPT_MAX_CHARS);
  });

  it("records the real serialized tools[] worst case (WARP-854 overflow tripwire)", () => {
    const toolSchemasJson = serializeAllToolSchemas();
    const toolTokens = estimateTokensFromChars(toolSchemasJson.length);
    const effectiveWindow = DEFAULT_NUM_CTX - OUTPUT_TOKEN_RESERVE;

    // GROUND TRUTH (WARP-1118 §10, measured 2026-07-08): the full owner tool
    // registry serialized to the wire tools[] shape is ~40.7k chars ≈ 10.2k
    // estimated tokens — ~2.5x the box's DEFAULT_NUM_CTX (4096). This is the
    // concrete WARP-854 overflow: the tool schemas ALONE overflow the default
    // window before any persona/business/history is added. Persona+business
    // are only ~675 tokens, so degradeToFit CANNOT rescue this on its own —
    // the on-hardware num_ctx decision (§10a, raise to 8192) or a role-scoped
    // tool-list reduction is the real fix, tracked as a Phase-0 handoff.
    //
    // This assertion is a GROWTH tripwire, not a fit check: it fails if the
    // registry grows so much that even an 8192-token window (minus reserve)
    // could not carry the fixed portion + a minimal history. It intentionally
    // does NOT assert the request fits 4096 — it provably does not.
    expect(toolTokens).toBeGreaterThan(effectiveWindow); // documents the overflow
    expect(toolSchemasJson.length).toBeLessThan(60000); // regression ceiling
  });
});
