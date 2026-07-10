/**
 * WARP-1119 — greeting preview model for the Settings "AI personality" card.
 *
 * All chrome strings are VERBATIM from the design brief §9 copy block.
 * `[FirstName]` is a runtime substitution (the signed-in owner's first
 * name); when no name is known the no-name variant drops the comma clause
 * (§9 substitution rules). Sample content (invoice #1042, composite
 * refills, Eastgate) is the brief's canonical sample data — context for the
 * preview capsule only, never rendered outside it.
 *
 * The live preview is LOCAL ONLY (design brief §6.4): it illustrates how
 * the selected style would sound; it never calls the model.
 */
import type { PersonaPreset, PersonaVerbosity } from "./api";

export interface PresetTile {
  id: PersonaPreset;
  name: string;
  desc: string;
  /** §9 tile preview with `[FirstName]` resolved (null → no-name variant). */
  preview: (firstName: string | null) => string;
}

/** The four §6.1 preset tiles, in the brief's order. */
export const PRESET_TILES: PresetTile[] = [
  {
    id: "warm_friendly",
    name: "Warm & friendly",
    desc: "Approachable and encouraging, plain words.",
    preview: (n) =>
      n
        ? `Good morning, ${n}. Three things could use a look today — want the quick version?`
        : "Good morning. Three things could use a look today — want the quick version?",
  },
  {
    id: "professional_precise",
    name: "Professional & precise",
    desc: "Structured, formal, straight to the point.",
    preview: () =>
      "Good morning. Two items require your attention: an unpaid invoice and a low-stock alert.",
  },
  {
    id: "founder",
    name: "Founder-y",
    desc: "Short, friendly, first names only.",
    preview: (n) =>
      n
        ? `Morning, ${n} — quiet night. One invoice worth a look.`
        : "Morning — quiet night. One invoice worth a look.",
  },
  {
    id: "direct_technical",
    name: "Direct & technical",
    desc: "Terse, numbers first, no small talk.",
    preview: () => "3 alerts. Backup finished 02:14. Invoice #1042 is 6 days overdue.",
  },
];

/** Per-preset greeting matrix (ported from the design prototype). The
 *  opener carries the name; each verbosity level completes the sentence. */
const GREETINGS: Record<
  PersonaPreset,
  {
    opener: (n: string | null) => string;
    lines: Record<PersonaVerbosity, (g: string) => string>;
  }
> = {
  warm_friendly: {
    opener: (n) => (n ? `Good morning, ${n}.` : "Good morning."),
    lines: {
      concise: (g) => `${g} Three things could use a look today.`,
      balanced: (g) => `${g} Three things could use a look today — want the quick version?`,
      detailed: (g) =>
        `${g} Three things could use a look today — an unpaid invoice, a low-stock item, and last night’s backup. Want the quick version, or all the detail?`,
    },
  },
  professional_precise: {
    opener: (n) => (n ? `Good morning, ${n}.` : "Good morning."),
    lines: {
      concise: (g) => `${g} Two items need attention.`,
      balanced: (g) =>
        `${g} Two items require your attention: an unpaid invoice and a low-stock alert.`,
      detailed: (g) =>
        `${g} Two items require your attention: invoice #1042 (6 days overdue) and a low-stock alert on composite refills. Full list below.`,
    },
  },
  founder: {
    opener: (n) => (n ? `Morning, ${n} —` : "Morning —"),
    lines: {
      concise: (g) => `${g} one invoice worth a look.`,
      balanced: (g) => `${g} quiet night. One invoice worth a look.`,
      detailed: (g) =>
        `${g} quiet night, backups clean. One invoice worth a look, and Eastgate’s schedule is light Thursday.`,
    },
  },
  direct_technical: {
    // Terse, numbers first, no small talk — and never a name.
    opener: () => "",
    lines: {
      concise: () => "3 alerts. Invoice #1042 overdue.",
      balanced: () => "3 alerts. Backup finished 02:14. Invoice #1042 is 6 days overdue.",
      detailed: () =>
        "3 alerts. Backup 02:14 OK. Invoice #1042 +6d. Stock: composite refills < 10. Eastgate Thu: 4 open slots.",
    },
  },
};

/**
 * The live-preview greeting for the current control state. The name is
 * used only when the first-names toggle is on AND a name is known —
 * otherwise the no-name variant applies (drop the comma clause, §9).
 */
export function buildGreeting(
  preset: PersonaPreset,
  verbosity: PersonaVerbosity,
  useFirstNames: boolean,
  firstName: string | null,
): string {
  const n = useFirstNames && firstName ? firstName : null;
  const m = GREETINGS[preset];
  return m.lines[verbosity](m.opener(n));
}
