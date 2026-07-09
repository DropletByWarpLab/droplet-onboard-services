/**
 * WARP-1118 — code-versioned personality preset fragments (§7.1).
 *
 * Presets are PRODUCT COPY, versioned with the app — not DB rows. The DB
 * only stores which preset is selected (`AssistantPersona.preset`); the
 * text lives here so it ships and reviews as prose alongside the code and
 * can never drift per-box.
 *
 * Each fragment is a short *style* instruction appended after the identity
 * core. It changes only HOW Droplet talks, never WHAT it is: presets never
 * rename the assistant, never mention a model, and never override the
 * safety/honesty rules the identity layer owns (the persona block is
 * prefixed with that reminder in persona.service.ts::composePersonaBlock).
 *
 * PRIVACY: these are static strings baked into the image — no box state,
 * no PII, no egress.
 */

/** The four canonical preset names — must match the Prisma `PersonaPreset`
 *  enum verbatim. */
export type PersonaPresetName =
  | "warm_friendly"
  | "professional_precise"
  | "founder"
  | "direct_technical";

/**
 * Hard per-fragment ceiling. The composed persona block is capped at
 * PERSONA_PROMPT_MAX_CHARS (1200); keeping each preset ≤400 leaves room
 * for the verbosity + address-form + customInstructions lines beneath it.
 * A CI test (persona-presets.test.ts) fails if any fragment exceeds this.
 */
export const PERSONA_PRESET_MAX_CHARS = 400;

/**
 * The style fragments. Production-tone drafts authored for Phase 0 and
 * carried verbatim from the WARP-1118 ticket; they are subject to design
 * reconciliation in Phase 1 (WARP-1123) but are kept as-is here so the
 * composed-prompt snapshots are stable and reviewable. Short, declarative,
 * and about tone/structure only.
 */
export const PERSONA_PRESETS: Record<PersonaPresetName, string> = {
  warm_friendly:
    "Speak warmly and personably, like a trusted colleague. Use plain " +
    "language, a little encouragement, and natural contractions. Favor " +
    "clarity over formality and keep things human.",
  professional_precise:
    "Speak with calm, professional precision. Be concise and " +
    "well-structured, use correct terminology, and avoid slang or filler. " +
    "Prioritize accuracy and clear next steps.",
  founder:
    "Speak like a pragmatic startup founder: direct, energetic, and " +
    "outcome-focused. Get to the point, name trade-offs plainly, and bias " +
    "toward action and momentum.",
  direct_technical:
    "Speak like a senior engineer: terse, technically precise, and free of " +
    "fluff. Lead with the answer, use exact terms, show commands or " +
    "specifics when useful, and skip pleasantries.",
};
