/**
 * The system prompt a chat turn actually assembles.
 *
 * ── Why this is a service and not a route-local helper ─────────────────────
 *
 * 🔴 WARP-2823. These two functions were private to `routes/llm.ts`, which
 * made them unreachable from anywhere an admin could be shown what the model
 * is told. The only way to render a person's prompt was to re-implement the
 * assembly beside it — and a second implementation of a composed value is the
 * drift this repo has already paid for three times (WARP-1621, WARP-2552,
 * WARP-2556): the copy is right on the day it is written and wrong on the
 * first day somebody changes the original.
 *
 * So the inspector calls THIS function, the same one the turn calls. If the
 * page is wrong, the turn is wrong, and that is the only relationship between
 * them worth having.
 *
 * Nothing else changed. The bodies below are the shipped ones, moved verbatim;
 * `llm-chat.base-prompt.test.ts` and `helpers/prompt-block-fixtures.ts` are
 * untouched and still green over the route, which is what makes the move
 * believable rather than merely plausible.
 */
import type { PrismaClient } from "@prisma/client";

import { visibleAudiences } from "./memory-audience.js";
import { loadIdentityPrompt } from "./identity-prompt.js";
import { composeToolGuidance } from "./tool-guidance.service.js";
// The budget lives in `tool-budget.service.ts` because the fixed-block sum is
// composed there. One source, imported — not a fourth copy of a literal that
// already exists three times in this repo.
import { MEMORY_FACTS_CHAR_BUDGET } from "./tool-budget.service.js";

// ── Base system prompt (RAG + durable-memory steering) ──
//
// Without a server-side base prompt the model receives ZERO guidance
// about this appliance's retrieval and memory surfaces — RAG invocation
// rode entirely on the search_content tool description, which already
// failed in practice (the WARP-642 hallucinated-tool guard exists
// because gpt-oss:20b invented `knowledge_base_search`), and WARP-461
// memory facts only surfaced if the model spontaneously called
// memory_recall. The base prompt names the tools and inlines the active
// facts (bounded below) so both work by default.
/**
 * Build the base prompt from the caller's EFFECTIVE tool set. Mentioning
 * a tool the role can't call is worse than silence: non-privileged roles
 * (family/guest/service) have write tools like memory_extract_fact
 * stripped by narrowAllowedToolsForRole, and a system prompt instructing
 * a stripped tool sends small local models straight into the WARP-642
 * hallucinated-tool guard (and, after 3 guard-only iterations, a failed
 * turn). `allowed` undefined = privileged caller = every tool.
 */
export function buildBaseSystemPrompt(
  allowed: string[] | undefined,
  /**
   * WARP-1118 — the composed personality block (persona.service.ts). Spliced
   * in RIGHT AFTER identity and BEFORE tool guidance (§7.2): personality
   * refines HOW Droplet talks without outranking the identity layer's
   * safety/honesty rules (the block itself carries that reminder as its
   * prefix). Read fresh from Prisma each request by the caller; passed in
   * here so this stays a pure string builder. "" (or undefined) = no persona
   * block this turn — e.g. the estimator degraded it away under overflow, or
   * the fresh read failed (fail-open, same posture as the memory block).
   */
  personaBlock?: string,
  /**
   * WARP-1120 (§8/§10/§15) — the role-filtered business-context block
   * (business-profile.service.ts). Spliced in RIGHT AFTER the persona block
   * and BEFORE tool guidance (§10 composition order), rendered inside its own
   * §15 data-framing delimiter so the model treats it as reference data, not
   * directives. Already role-filtered by the composer (owner/admin → summary +
   * fields, family → summary only, guest/service → ""), and empty entirely on
   * a non-BUSINESS box. "" (or undefined) = no business block this turn — the
   * estimator degraded it away (dropped 1st), the box is HOME-typed, or the
   * fresh read failed (fail-open).
   */
  businessBlock?: string,
): string {
  // Identity leads: the full "who you are / what this box does" block
  // from data/droplet-identity.md (fail-open to the legacy one-liner),
  // shared by every surface — dashboard, voice, external MCP clients.
  const lines = [loadIdentityPrompt()];
  // Personality is appended immediately after identity, before tool
  // guidance — one injection owner for the persona block on this path.
  if (personaBlock && personaBlock.length > 0) {
    lines.push("", personaBlock);
  }
  // Business context follows persona, still before tool guidance. Summary-
  // first + delimiter-framed by the composer; a truncation loses detail, not
  // meaning.
  if (businessBlock && businessBlock.length > 0) {
    lines.push("", businessBlock);
  }
  // Tool guidance is composed per-category from the caller's EFFECTIVE
  // set (tool-guidance.service.ts) — the WARP-642 never-name-a-stripped-
  // tool invariant lives there, with its own unit tests.
  const guidanceBlock = composeToolGuidance(allowed);
  if (guidanceBlock.length > 0) {
    lines.push("", guidanceBlock);
  }
  return lines.join("\n");
}

/** Bounds for the durable-memory block appended to the base prompt.
 *  MemoryFact rows are short one-liners; 20 facts / 2k chars keeps the
 *  block well under the attachment/pin budgets while covering every
 *  realistic household fact list. Older facts beyond the cap stay
 *  reachable via the memory_recall tool. */
export const MEMORY_FACTS_LIMIT = 20;

/** Render the active WARP-461 memory facts as a bounded bullet list,
 *  or "" when none exist. Newest first — when the budget bites, recent
 *  facts win. */
export async function buildMemoryFactsBlock(
  prisma: PrismaClient,
  /** Caller's role — facts are filtered to the audiences this role may
   *  read (WARP-845 role-scoped distribution). */
  role: string | undefined,
): Promise<string> {
  const facts = await prisma.memoryFact.findMany({
    where: { active: true, audience: { in: visibleAudiences(role) } },
    orderBy: { addedAt: "desc" },
    take: MEMORY_FACTS_LIMIT,
  });
  const lines: string[] = [];
  let used = 0;
  for (const f of facts) {
    const line = `- [${f.category}] ${f.fact}`;
    if (used + line.length > MEMORY_FACTS_CHAR_BUDGET) break;
    used += line.length;
    lines.push(line);
  }
  if (lines.length === 0) return "";
  return (
    "\n\nDurable memory — facts previously saved for this business:\n" +
    lines.join("\n")
  );
}
