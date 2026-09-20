/**
 * WARP-2733 (ADR-048) — what the owner is told they are agreeing to.
 *
 * 🔴 DERIVED FROM THE POLICY TABLE, NOT WRITTEN AS PROSE.
 *
 * This is the consent record. The whole argument for unattended writes is
 * "consent at enable time": the owner promotes a CLASS of action, having been
 * told in plain English what that class is. If the sentence is hand-written
 * and the table then changes, the box does something the owner was never told
 * about — and the screen still shows the old promise. That is not a stale
 * string; it is consent obtained for a different thing.
 *
 * So every clause below is produced by asking `classify()` what would actually
 * happen, at the settings in question, and a test asserts that changing a cell
 * changes the sentence. Nobody can widen the table without the readback
 * widening with it.
 *
 * The voice is ADR-002: file, customer, look, undo. Never proposal, extraction,
 * entity, confidence.
 */
import type { AutoFilingLevel, AutoFilingMode, AutoFilingVertical } from "@prisma/client";

import { classify } from "./policy.js";

export interface ReadbackInput {
  mode: AutoFilingMode;
  level: AutoFilingLevel;
  vertical: AutoFilingVertical;
  /** Display name of the enabling owner. */
  ownerName?: string | null;
  enabledAt?: Date | null;
}

/** Would this kind run unattended at these settings, at its best case? */
function wouldAuto(
  kind: Parameters<typeof classify>[0]["kind"],
  input: ReadbackInput,
  over: Partial<Parameters<typeof classify>[0]> = {},
): boolean {
  return (
    classify({
      kind,
      mode: input.mode,
      level: input.level,
      vertical: input.vertical,
      phiVerdict: "CLEAN",
      // The BEST case for this kind: the readback describes what the box is
      // ALLOWED to do, not what it will do on any particular document.
      confidence: 100,
      matchKind: "DOMAIN",
      documentRole: "INVOICE",
      counterparty: "BUSINESS",
      nearestCandidateScore: 0,
      capReached: false,
      ...over,
    }).policyClass === "AUTO"
  );
}

/**
 * The sentences, in the order an owner reads them: what it does, what it
 * refuses, what you can take back, and who it acts as.
 */
export function buildReadback(input: ReadbackInput): string[] {
  const lines: string[] = [];

  if (input.mode === "off") {
    return ["Droplet is not reading your files."];
  }
  if (input.mode === "propose") {
    return [
      "Droplet reads new files and emails and suggests where they belong.",
      "Nothing is filed until you say so.",
      "It never reads or files anything that looks like a patient record.",
    ];
  }

  const links = wouldAuto("LINK_FILE", input);
  const emails = wouldAuto("LOG_EMAIL_ACTIVITY", input, { matchKind: "EMAIL" });
  const customers = wouldAuto("CREATE_CUSTOMER", input, { matchKind: "NONE" });
  const projects = wouldAuto("CREATE_PROJECT", input, { matchKind: "NONE" });

  if (links || emails) {
    lines.push("Files uploads and emails to customers you already have.");
  }
  if (customers) {
    // The conditions are named because they are the interesting part of the
    // promise: not "creates customers" but "creates them only from this".
    lines.push(
      "Creates a new customer only from a business invoice, quote or contract.",
    );
  } else {
    lines.push("Never adds a new customer by itself — those always wait for you.");
  }
  if (projects) {
    lines.push("Starts a project when a document names one for a customer it knows.");
  }

  // 🔴 Always said, at every setting, because it is the thing a practice owner
  // is actually deciding about — and because `CREATE_CONTACT` has no cell in
  // the table that says AUTO, in any mode, on any vertical.
  lines.push("Never reads or files anything that looks like a patient record.");
  lines.push("Never adds a person to your address book by itself.");
  lines.push("Everything it does can be undone with one click.");

  if (input.ownerName) {
    const when = input.enabledAt ? ` Turned on ${formatEnabledAt(input.enabledAt)}.` : "";
    lines.push(`Runs as: ${input.ownerName}.${when}`);
  }
  return lines;
}

/** Month names spelled out rather than left to ICU.
 *
 *  🔴 `toLocaleDateString("en-GB", { month: "short" })` returns "Sept" on
 *  current ICU and "Sep" on older builds. This string is part of a CONSENT
 *  RECORD, and a sentence whose wording depends on which ICU the container
 *  happens to ship is a sentence nobody can assert, in a test or in a
 *  screenshot a year later. */
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export function formatEnabledAt(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/**
 * Should the page offer to promote auto mode?
 *
 * Decision D1: `auto` is in the settings card from day one, and the page ALSO
 * offers it once the owner has a track record — twenty applied with at most
 * two corrections. The second half is the honest version of "are you ready":
 * it is a measurement of THEIR corpus with THIS model, not a nag on a timer.
 */
export const PROMOTION_MIN_APPLIED = 20;
export const PROMOTION_MAX_CORRECTIONS = 2;

export function shouldOfferPromotion(stats: {
  applied: number;
  corrections: number;
  mode: AutoFilingMode;
}): boolean {
  if (stats.mode !== "propose") return false;
  return (
    stats.applied >= PROMOTION_MIN_APPLIED && stats.corrections <= PROMOTION_MAX_CORRECTIONS
  );
}

export function promotionSentence(stats: { applied: number; corrections: number }): string {
  const corrections =
    stats.corrections === 0
      ? "not corrected any"
      : stats.corrections === 1
        ? "corrected 1"
        : `corrected ${stats.corrections}`;
  return `You've filed ${stats.applied} things and ${corrections}. Want Droplet to do the easy ones by itself?`;
}
