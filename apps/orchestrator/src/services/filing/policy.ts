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
export const AUTO_FLOOR_CREATE = 90;

/**
 * How close a rejected candidate may be before a CREATE is refused.
 *
 * Above this, the matcher saw something similar and declined to trust it —
 * which is a reason to ask a person, not a licence to make a second record.
 */
export const NEAREST_CANDIDATE_CEILING = 0.6;

/** Document roles that may mint a customer unattended. Paper that IS a
 *  transaction; not a letter that mentions a company. */
export const CREATE_ROLES: ReadonlySet<string> = new Set(["INVOICE", "QUOTE", "CONTRACT"]);

/**
 * The substring every cap-deferred reason contains.
 *
 * 🔴 Defined HERE, beside the sentences, and imported by `caps.ts` — not the
 * other way round. `policyReason` is already the durable record of why a
 * proposal is in review; adding a second column to say "and it was the cap"
 * would give two answers to one question, and they would disagree the first
 * time somebody edited a sentence. A test asserts every cap reason contains
 * this, so an edit that breaks the sweep breaks a test first.
 */
export const BOUNDED_MARKER = "so this one waits";

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

  // ── WARP-2733 — the conditions a CREATE must additionally satisfy ────────

  /** The classifier's `role`. Only paper that IS a transaction may mint a
   *  customer unattended: an invoice, a quote or a contract. A letter that
   *  mentions a company is not a business relationship. */
  documentRole?: string | null;
  /** `BUSINESS` | `INDIVIDUAL` | `UNKNOWN`. A private individual becoming a
   *  customer row without anyone looking is how a personal document ends up
   *  in the CRM. */
  counterparty?: string | null;
  /**
   * How close the NEAREST rejected candidate was, 0–1.
   *
   * 🔴 A create is only safe when nothing else came close. `matchKind: NONE`
   * says the matcher found no key it trusts — it does NOT say the record is
   * absent. A near miss at 0.6 is precisely the case where creating produces
   * the duplicate the whole matcher exists to prevent, and the owner finds it
   * weeks later.
   */
  nearestCandidateScore?: number | null;
  /** True when the hourly/daily cap for this class is already spent. */
  capReached?: boolean;
  /** WARP-2733: a project whose name already exists must not be minted again. */
  sameNameProjectExists?: boolean;
  /** The record this would write to was landed by a connector. */
  targetIsExternal?: boolean;
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
  // 🔴 A row a CONNECTOR landed is not ours to touch, in any mode, by anyone.
  // `origin = EXTERNAL` means a vendor is the system of record: whatever we
  // wrote would be reverted by the next sync tick, so the write is not merely
  // risky but pointless — and it would look, for the hours in between, as
  // though Droplet had made a change the owner then saw disappear.
  if (input.targetIsExternal) {
    return {
      policyClass: "NEVER",
      policyReason:
        "This customer comes from a connected account, so Droplet leaves it to that service.",
    };
  }

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
    if (input.capReached) {
      return {
        policyClass: "REVIEW",
        policyReason: `Droplet has filed a lot in the last hour, ${BOUNDED_MARKER} for you.`,
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

    // 🔴 Only paper that IS a transaction may mint a customer unattended. A
    // letter that mentions a company is not a business relationship, and a
    // scan whose role the classifier could not tell is not either.
    if (input.kind === "CREATE_CUSTOMER") {
      if (!CREATE_ROLES.has(String(input.documentRole ?? ""))) {
        return {
          policyClass: "REVIEW",
          policyReason:
            "Droplet only adds customers by itself from an invoice, a quote or a contract.",
        };
      }
      if (input.counterparty !== "BUSINESS") {
        return {
          policyClass: "REVIEW",
          policyReason: "This looks like a private individual rather than a business.",
        };
      }
    }

    // 🔴 Nothing else may have come close. `matchKind: NONE` says the matcher
    // found no key it TRUSTS — not that the record is absent. A near miss is
    // exactly where creating produces the duplicate the matcher exists to
    // prevent, and the owner finds it weeks later.
    if ((input.nearestCandidateScore ?? 0) >= NEAREST_CANDIDATE_CEILING) {
      return {
        policyClass: "REVIEW",
        policyReason: "This looks a lot like a customer you already have.",
      };
    }

    if (input.kind === "CREATE_PROJECT" && input.sameNameProjectExists) {
      return {
        policyClass: "REVIEW",
        policyReason: "There is already a project with this name.",
      };
    }

    // 🔴 Over the cap is REVIEW, never DROPPED. The proposal stays visible and
    // is reconsidered when the window rolls: a bound that silently discarded
    // work would make a busy morning indistinguishable from a broken worker.
    if (input.capReached) {
      return {
        policyClass: "REVIEW",
        policyReason: `Droplet has already added several customers today, ${BOUNDED_MARKER}.`,
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
