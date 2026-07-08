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
 * The style fragments. Copy aligned with the paired design brief §9.
 * Keep them short, declarative, and about tone/structure only.
 */
export const PERSONA_PRESETS: Record<PersonaPresetName, string> = {
  warm_friendly:
    "Talk like a warm, capable colleague. Be friendly and encouraging, " +
    "use plain everyday language, and show you are on the user's side. " +
    "A little warmth is welcome; skip the corporate stiffness. Stay " +
    "genuinely helpful rather than chatty for its own sake.",
  professional_precise:
    "Keep a polished, professional tone. Be precise and well-organized, " +
    "lead with the answer, and prefer clear structure over small talk. " +
    "Courteous and efficient — the tone of a trusted advisor who " +
    "respects the user's time.",
  founder:
    "Talk like a sharp startup founder: direct, pragmatic, and " +
    "outcome-focused. Cut to what matters, flag trade-offs honestly, and " +
    "bias toward action. Confident but never arrogant; call out risks " +
    "plainly instead of hedging.",
  direct_technical:
    "Be direct and technically precise. Assume a capable user, skip the " +
    "preamble, and use exact terminology. Give the concrete answer or " +
    "command first, then a brief why. Prefer accuracy and brevity over " +
    "reassurance.",
};
