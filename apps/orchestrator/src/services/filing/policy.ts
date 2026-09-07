/**
 * WARP-2730 (ADR-048) — the policy table. What may apply itself, and what
 * always waits for a person.
 *
 * 🔴 THIS IS EVALUATED IN CODE AND NEVER BY THE MODEL. The model's job ends at
 * "here is what I read"; whether that becomes a row without anyone looking is a
 * decision about consequences, and consequences are not something to prompt for.
 *
 * The table is enumerated rather than computed. Every (kind × mode × level ×
 * vertical) cell has a written answer and a reason string that is rendered on
 * the card in the owner's own words — "Not applied automatically because it
 * would create a new customer, and this box is set to links only." A rule
 * nobody can read is a rule nobody can revoke.
 *
 * Slice 2 ships PROPOSE mode only: `mode: "auto"` is refused by a CHECK on
 * `AutoFilingSetting` until an extraction-eval canary has passed on this box's
 * own model (WARP-2732), so every cell below that says AUTO is unreachable
 * until WARP-2733. It is written now because writing it later, under pressure
 * to ship auto mode, is how the floors get chosen to fit the demo.
 */
import type {
  AutoFilingLevel,
  AutoFilingMode,
  AutoFilingVertical,
  FilingPolicyClass,
  IngestMatchKind,
  IngestProposalKind,
  PhiVerdict,
} from "@prisma/client";

/**
 * Confidence floors for unattended application.
 *
 * Two, not one, and the gap is the point: attaching a file to a customer that
 * already exists is reversible with one click and touches nothing else, while
 * creating a customer puts a new row in front of every user of the CRM. A
 * MENTIONS document is capped at 79 before it reaches here, so it can never
 * clear either floor.
 */
export const AUTO_FLOOR_LINK = 85;
export const AUTO_FLOOR_CREATE = 92;

/** The cap applied to a MENTIONS document's confidence, wherever it came
 *  from. Exported so the test can assert it is below both floors rather than
 *  restating the number. */
export const MENTIONS_CONFIDENCE_CAP = 79;

export interface PolicyInput {
  kind: IngestProposalKind;
  mode: AutoFilingMode;
  level: AutoFilingLevel;
  vertical: AutoFilingVertical;
  phiVerdict: PhiVerdict;
  confidence: number;
  matchKind: IngestMatchKind;
}

export interface PolicyVerdict {
  policyClass: FilingPolicyClass;
  /** Rendered verbatim on the review card. Null only for a plain AUTO. */
  policyReason: string | null;
}

/** Kinds that are structurally additive: they attach or annotate something
 *  that already exists, and undoing one leaves nothing behind. */
const LINK_KINDS: ReadonlySet<IngestProposalKind> = new Set([
  "LINK_FILE",
  "LOG_EMAIL_ACTIVITY",
  "SET_PROJECT_CUSTOMER",
]);

/** Kinds that mint a new record. */
const CREATE_KINDS: ReadonlySet<IngestProposalKind> = new Set([
  "CREATE_CUSTOMER",
  "CREATE_PROJECT",
]);

/**
 * Decide one proposal's class.
 *
 * Ordered most-restrictive first, and every `NEVER` returns before anything
 * else is consulted — a NEVER is not a low score, it is a different kind of
 * answer, and a CHECK on `IngestProposal` refuses to apply one even for a
 * human who clicks the button.
 */
export function classify(input: PolicyInput): PolicyVerdict {
  // ── NEVER ────────────────────────────────────────────────────────────────
  //
  // Money documents wait for the `ErpDocument` widening (WARP-2739). Until
  // that lands there is no column to put a proposed invoice in that would not
  // silently coerce a NUMERIC(20,6) through a JS number, so the proposal is
  // recorded and shown, and applying it is refused rather than approximated.
  if (input.kind === "CREATE_MONEY_DOC") {
    return {
      policyClass: "NEVER",
      policyReason:
        "Invoices and quotes are read and shown here, but Droplet does not file " +
        "them into your books yet.",
    };
  }

  // ── REVIEW, unconditionally ──────────────────────────────────────────────
  //
  // A person is where PHI lives on a practice box. `CREATE_CONTACT` never
  // auto-applies in any mode, at any confidence, on any vertical — this is the
  // one row of the table with no cell that says AUTO.
  if (input.kind === "CREATE_CONTACT") {
    return {
      policyClass: "REVIEW",
      policyReason: "New people are always added by you, never automatically.",
    };
  }

  // Several candidates matched. There is nothing to be confident ABOUT — the
  // question is which one, and only a person knows.
  if (input.kind === "MATCH_REVIEW") {
    return {
      policyClass: "REVIEW",
      policyReason: "More than one customer could be the right one.",
    };
  }

  if (input.mode !== "auto") {
    return {
      policyClass: "REVIEW",
      policyReason: "Droplet is set to ask you first.",
    };
  }

  // A document that names patients still gets filed for its company and its
  // money — that is the whole reason MENTIONS exists as a class — but never
  // without someone looking at it.
  if (input.phiVerdict === "MENTIONS") {
    return {
      policyClass: "REVIEW",
      policyReason: "This document mentions patients, so it always gets a look.",
    };
  }

  // A name that merely looks alike is not a match. `Northgate Dental` and
  // `Northgate Dental Lab` are two businesses, and the cost of learning that
  // after the fact is a customer's file on the wrong record.
  if (input.matchKind === "NAME") {
    return {
      policyClass: "REVIEW",
      policyReason: "The name is close, but nothing else confirms it is the same customer.",
    };
  }

  if (LINK_KINDS.has(input.kind)) {
    if (input.confidence < AUTO_FLOOR_LINK) {
      return {
        policyClass: "REVIEW",
        policyReason: "Droplet is not sure enough about this one.",
      };
    }
    return { policyClass: "AUTO", policyReason: null };
  }

  if (CREATE_KINDS.has(input.kind)) {
    if (input.level !== "also_create") {
      return {
        policyClass: "REVIEW",
        policyReason:
          "Droplet is set to attach files to customers you already have, not to add new ones.",
      };
    }
    // On a practice box, creating records unattended is off. A dental
    // vertical was ASKED for at enable time, never inferred, and the answer it
    // buys is a smaller blast radius — not a different PHI screen.
    if (input.vertical === "healthcare") {
      return {
        policyClass: "REVIEW",
        policyReason: "On a practice box, new customers and projects are always added by you.",
      };
    }
    if (input.confidence < AUTO_FLOOR_CREATE) {
      return {
        policyClass: "REVIEW",
        policyReason: "Droplet is not sure enough to add something new on its own.",
      };
    }
    return { policyClass: "AUTO", policyReason: null };
  }

  // Unreachable while `IngestProposalKind` and the sets above agree. If a new
  // kind is added and this line is hit, the answer is REVIEW: an unenumerated
  // kind must not inherit permission from the last branch that happened to run.
  return {
    policyClass: "REVIEW",
    policyReason: "Droplet is set to ask you first.",
  };
}
