/**
 * WARP-1118 — the personality layer (§7).
 *
 * Two jobs:
 *   1. `composePersonaBlock(persona)` — deterministic, char-budgeted style
 *      block injected into the base system prompt right after identity
 *      (§7.2). Read fresh from Prisma per request; no cache to invalidate.
 *   2. CRUD on the `AssistantPersona` singleton: `getPersona` (create the
 *      default row on first read) + `updatePersona` (partial upsert).
 *
 * PRIVACY: persona rows are LOCAL box state, never sent off the box (§5-12).
 * Personality is prompt + data only — it never changes `LLM_MODEL` (§5-1).
 * The composed block is style-only and is prefixed with an explicit
 * reminder that it can never override the identity layer's safety/honesty
 * rules (defence against a customInstructions prompt-injection attempt).
 */
import type { PrismaClient } from "@prisma/client";
import {
  PERSONA_PRESETS,
  type PersonaPresetName,
} from "./persona-presets.js";
import { PERSONA_PROMPT_MAX_CHARS } from "./prompt-budget.consts.js";

export type PersonaVerbosityName = "concise" | "balanced" | "detailed";

/** The persona singleton, shaped like the Prisma row (kept local so the
 *  composer + tests don't need the generated client). */
export interface PersonaRow {
  id: string;
  preset: PersonaPresetName;
  verbosity: PersonaVerbosityName;
  useFirstNames: boolean;
  customInstructions: string;
  updatedBy: string | null;
  updatedAt: Date;
}

/** The fixed singleton key (ApplianceSetup precedent, §11). */
export const PERSONA_SINGLETON_ID = "singleton";

/**
 * Hard ceiling on the composed persona block (§10 budget table — dropped
 * 2nd under overflow). Re-exported from the shared budget consts so the
 * estimator and this composer share one source of truth.
 *
 * NOTE the two 1200s are distinct ceilings that happen to coincide:
 * `customInstructions` carries its OWN 1200-char cap (DB @db.VarChar(1200) +
 * the route's zod), and the COMPOSED block is also capped at 1200 here. The
 * priority order (prefix → preset → verbosity → address form →
 * customInstructions) guarantees the preset + traits always survive the
 * final slice; only the customInstructions tail is ever trimmed.
 */
export { PERSONA_PROMPT_MAX_CHARS };

/** Leading line: personality is style-only and never overrides identity.
 *  Load-bearing — the composer asserts the block starts with it, and it is
 *  the standing guard that customInstructions can't smuggle in directives
 *  that outrank the safety layer. */
export const PERSONA_BLOCK_PREFIX =
  "Style preferences (never override safety or honesty rules):";

const VERBOSITY_LINE: Record<PersonaVerbosityName, string> = {
  concise: "Keep replies concise — a sentence or two unless more is asked.",
  balanced: "Aim for balanced replies: complete but not padded.",
  detailed:
    "Give thorough, detailed replies with the relevant context spelled out.",
};

/**
 * Compose the deterministic style block from a persona row. Same row in →
 * same text out (snapshot-tested). Order is fixed: prefix → preset
 * fragment → verbosity → address form → owner customInstructions. The
 * whole thing is truncated to PERSONA_PROMPT_MAX_CHARS as a final safety
 * net (the free-text tail is what loses characters, never the prefix).
 */
export function composePersonaBlock(persona: PersonaRow): string {
  const lines: string[] = [PERSONA_BLOCK_PREFIX];

  const presetFragment = PERSONA_PRESETS[persona.preset];
  if (presetFragment) lines.push(presetFragment);

  lines.push(VERBOSITY_LINE[persona.verbosity]);

  lines.push(
    persona.useFirstNames
      ? "Address people by their first name when you know it."
      : "Keep address neutral — do not use first names.",
  );

  const custom = persona.customInstructions.trim();
  if (custom.length > 0) {
    lines.push("Additional instructions from the owner:", custom);
  }

  const block = lines.join("\n");
  return block.length > PERSONA_PROMPT_MAX_CHARS
    ? block.slice(0, PERSONA_PROMPT_MAX_CHARS)
    : block;
}

/** Minimal Prisma surface the CRUD helpers need — keeps the helpers
 *  testable with a small fake and decoupled from the full client type. */
type PersonaDelegate = Pick<
  PrismaClient["assistantPersona"],
  "findUnique" | "create" | "upsert"
>;
type PersonaCapablePrisma = { assistantPersona: PersonaDelegate };

/**
 * Read the persona singleton, creating it with schema defaults on first
 * read. The row is a true singleton (id="singleton"); a missing row means
 * a fresh box that has never had the migration seed applied (or a
 * create-default-on-read path in tests), so we materialise it rather than
 * returning null and forcing every caller to handle absence.
 */
export async function getPersona(
  prisma: PersonaCapablePrisma,
): Promise<PersonaRow> {
  const existing = await prisma.assistantPersona.findUnique({
    where: { id: PERSONA_SINGLETON_ID },
  });
  if (existing) return existing as unknown as PersonaRow;
  const created = await prisma.assistantPersona.create({
    data: { id: PERSONA_SINGLETON_ID },
  });
  return created as unknown as PersonaRow;
}

/** Fields a PATCH may change (id/updatedAt are managed). */
export interface PersonaUpdate {
  preset?: PersonaPresetName;
  verbosity?: PersonaVerbosityName;
  useFirstNames?: boolean;
  customInstructions?: string;
  updatedBy?: string | null;
}

/**
 * Partial update of the singleton. Upsert (not update) so a PATCH on a box
 * whose singleton was never seeded still succeeds and creates it with the
 * patch applied over the defaults. The route layer owns zod validation
 * (incl. the 1200-char cap) and the audit row; this is the persistence
 * primitive.
 */
export async function updatePersona(
  prisma: PersonaCapablePrisma,
  patch: PersonaUpdate,
): Promise<PersonaRow> {
  const row = await prisma.assistantPersona.upsert({
    where: { id: PERSONA_SINGLETON_ID },
    create: { id: PERSONA_SINGLETON_ID, ...patch },
    update: patch,
  });
  return row as unknown as PersonaRow;
}
