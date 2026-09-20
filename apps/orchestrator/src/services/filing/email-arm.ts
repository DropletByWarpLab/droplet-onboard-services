/**
 * WARP-2735 (ADR-048 slice 5) — a mail from a known customer lands on their
 * timeline by itself.
 *
 * ── There is no LLM on this path, and that is the design ───────────────────
 *
 * The file arm reads a document and asks a model what is in it. This arm does
 * not. Sender → contact → company is a JOIN, and a join has a right answer:
 * `ContactEmail.addressLower` is documented in the schema as *"the join key to
 * `EmailMessage.fromAddr`"* and this is its first consumer. Asking a model to
 * guess at something the database already knows would be slower, worse, and
 * would put mail bodies through an extractor for no gain.
 *
 * The consequence is that this arm is CHEAP and DETERMINISTIC: no claim can
 * outlive a transaction, no model can be unreachable, and the same mail
 * resolves the same way every time.
 *
 * ── There is no push trigger either ────────────────────────────────────────
 *
 * 🔴 The mosquitto ACL grants `orchestrator` read on `email/#`, and the
 * indexer publishes `email/<accountId>/new` — but **nothing subscribes**. The
 * only `.subscribe(` calls in this codebase are camera topics. The MQTT signal
 * is also QoS 0 and carries the RFC Message-ID rather than the row id, so it
 * could not address a row even if something listened.
 *
 * So this arm POLLS, on the filing tick that already exists. That is not a
 * workaround: the durable claim is the same mechanism the file arm uses, it
 * survives a restart, and a missed MQTT packet cannot lose a mail.
 *
 * ── There is no re-arm ─────────────────────────────────────────────────────
 *
 * `EmailMessage` has no `updatedAt` and is immutable after create, so unlike
 * `FileIndexStatus` there is no touch to re-read. The schema says so at the
 * claim columns. A redelivery cannot re-arm either — the ingest route's P2002
 * branch returns before any create.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { createLogger } from "../../lib/logger.js";
import { domainFromEmail, isPublicEmailDomain } from "./match.js";
import { screenPersistedString } from "./phi-screen.js";
import { classify } from "./policy.js";
import { persistDrafts, type ProposalDraft } from "./propose.js";
import type { ResolvedFilingSettings } from "./settings.js";

const logger = createLogger("filing-email");

/** How many mails one tick claims. Small: each is a handful of indexed
 *  queries, and a burst of them should not starve the file arm sharing the
 *  same tick. */
export const EMAIL_CLAIM_BATCH = 10;

export interface EmailClaim {
  id: string;
  accountId: string;
  fromAddr: string;
  subject: string;
  receivedAt: Date;
}

/**
 * Claim un-read mail, atomically.
 *
 * The same `FOR UPDATE SKIP LOCKED` + guarded `updateMany` shape the file arm
 * uses, for the same reason: it is atomic across replicas AND survives a
 * restart, where an advisory lock would vanish with the process and leave the
 * row `running` forever with nothing saying so.
 *
 * 🔴 Bounded by `enabledAt`. Connecting a mailbox imports its history, and a
 * box that filed three years of mail the moment somebody switched filing on
 * would bury the review queue on day one. Mail older than the consent stamp is
 * left alone, exactly as the file arm leaves an old corpus alone.
 */
export async function claimEmails(
  prisma: PrismaClient,
  accountIds: readonly string[],
  enabledAt: Date | null,
  limit: number = EMAIL_CLAIM_BATCH,
): Promise<EmailClaim[]> {
  if (accountIds.length === 0 || !enabledAt) return [];

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "EmailMessage"
      WHERE "extractStatus" = 'pending'
        AND "accountId" = ANY(${[...accountIds]}::text[])
        AND "receivedAt" >= ${enabledAt}
      ORDER BY "receivedAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const claimed = await tx.emailMessage.updateMany({
      // The `extractStatus: "pending"` predicate is the guard. A row another
      // replica took between the SELECT and here simply is not updated, and
      // the count tells us so.
      where: { id: { in: ids }, extractStatus: "pending" },
      data: { extractStatus: "running", extractClaimedAt: new Date() },
    });
    if (claimed.count === 0) return [];

    return tx.emailMessage.findMany({
      where: { id: { in: ids }, extractStatus: "running" },
      select: { id: true, accountId: true, fromAddr: true, subject: true, receivedAt: true },
    });
  });
}

export type SenderMatch =
  | { kind: "EMAIL"; companyId: string; companyName: string; contactId: string }
  | { kind: "DOMAIN"; companyId: string; companyName: string }
  | { kind: "NONE"; reason: "unknown_sender" | "free_mail" };

/**
 * Sender → company, deterministically.
 *
 * Two hops, in order of how much they prove:
 *
 *   1. The exact address, through `ContactEmail.addressLower` to a `Contact`
 *      and on to the company they belong to. This is an identity, not a guess.
 *   2. The domain, against `CrmCompany.domain`. Weaker — anyone at a company
 *      shares its domain — but still a fact about who they work for.
 *
 * 🔴 Free-mail domains are excluded from hop 2 and there is no hop 3.
 * `gmail.com` is not a company, and matching on it would file every personal
 * mail from every customer's staff onto whichever customer happened to have
 * been created with that domain. There is deliberately no NAME fallback here:
 * a display name in a `From` header is attacker-controlled, and the file arm's
 * name matching at least has a document to corroborate it.
 */
export async function resolveSender(
  prisma: PrismaClient,
  fromAddr: string,
): Promise<SenderMatch> {
  const address = fromAddr.trim().toLowerCase();

  const contactEmail = await prisma.contactEmail.findFirst({
    where: { addressLower: address },
    select: {
      contactId: true,
      contact: {
        select: {
          // `companyLinks` is the Contact side of CrmCompanyContact. The
          // company's NAME travels with its id so a review card can say "file
          // this under Northgate Dental" without a second query.
          companyLinks: {
            where: { company: { isArchived: false } },
            select: { companyId: true, company: { select: { name: true } } },
            take: 1,
          },
        },
      },
    },
  });
  const link = contactEmail?.contact?.companyLinks?.[0];
  if (contactEmail && link?.company) {
    return {
      kind: "EMAIL",
      companyId: link.companyId,
      companyName: link.company.name,
      contactId: contactEmail.contactId,
    };
  }

  const domain = domainFromEmail(address);
  if (!domain) return { kind: "NONE", reason: "unknown_sender" };
  if (isPublicEmailDomain(domain)) return { kind: "NONE", reason: "free_mail" };

  const company = await prisma.crmCompany.findFirst({
    where: { domain, isArchived: false },
    select: { id: true, name: true },
  });
  if (company) return { kind: "DOMAIN", companyId: company.id, companyName: company.name };

  return { kind: "NONE", reason: "unknown_sender" };
}

export interface EmailOutcome {
  claimId: string;
  /** A proposal draft, or null when the mail resolved to nobody. */
  draft: {
    kind: "LOG_EMAIL_ACTIVITY";
    dedupeKey: string;
    confidence: number;
    matchKind: "EMAIL" | "DOMAIN";
    payload: Record<string, unknown>;
  } | null;
  /** Set when nothing was proposed, so the mail lands in "Left alone" with a
   *  reason rather than vanishing. */
  skipReason: "not_business" | null;
}

/**
 * Decide what one mail becomes.
 *
 * 🔴 A miss produces a SKIP, never silence. An email from somebody the box
 * does not recognise is the ordinary case, and producing nothing at all would
 * give this feature the silent mode the Skipped tab exists to prevent — an
 * owner would have no way to tell "Droplet looked and decided not to" from
 * "Droplet never looked".
 *
 * 🔴 And a miss NEVER creates a customer or a contact. The ticket allows a
 * `CREATE_CUSTOMER` when a body names an organisation, but that needs the body
 * through an extractor, and a mail body is the weakest evidence on the box:
 * a signature block naming a company proves the sender typed it. This slice
 * files mail onto customers that already exist and does nothing else.
 */
export function decideEmail(claim: EmailClaim, match: SenderMatch): EmailOutcome {
  if (match.kind === "NONE") {
    return { claimId: claim.id, draft: null, skipReason: "not_business" };
  }

  // The subject becomes a CAPTION on a customer's timeline, so it goes through
  // the same persisted-string screen every other stored string does. The body
  // is never copied — the schema comment says the CRM stores a caption and not
  // a copy, and this keeps that true.
  //
  // 🔴 `null` back means the subject tripped the screen, and the mail is still
  // FILED — with no caption. A subject line reading "Mrs Patel's referral" is
  // exactly the shape that must not be copied onto a CRM timeline, and
  // dropping the caption while keeping the link is strictly better than
  // dropping the whole thing: the owner still sees that this customer wrote,
  // and the mail itself is one click away in the mailbox.
  const caption = screenPersistedString(claim.subject);

  return {
    claimId: claim.id,
    draft: {
      kind: "LOG_EMAIL_ACTIVITY",
      // Keyed on the MESSAGE, so the same mail cannot produce two proposals.
      dedupeKey: `email:${claim.id}`,
      // An exact-address match is an identity; a domain match is an
      // affiliation. The gap is what keeps a domain hit below the auto floor
      // for anything but the narrowest action.
      confidence: match.kind === "EMAIL" ? 95 : 80,
      matchKind: match.kind,
      payload: {
        companyId: match.companyId,
        emailMessageId: claim.id,
        occurredAt: claim.receivedAt.toISOString(),
        ...(caption ? { subject: caption } : {}),
        companyName: match.companyName,
        matchedKeyKind: match.kind === "EMAIL" ? "EMAIL_ADDRESS" : "EMAIL_DOMAIN",
        matchedKeyValue:
          match.kind === "EMAIL" ? claim.fromAddr.toLowerCase() : domainFromEmail(claim.fromAddr),
      },
    },
    skipReason: null,
  };
}

/** Write the terminal state for one claimed mail. */
export async function finishEmail(
  tx: Prisma.TransactionClient,
  claimId: string,
  outcome: { skipped: boolean; reason: "not_business" | null },
): Promise<void> {
  await tx.emailMessage.updateMany({
    // Guarded on `running`: a row the reconcile re-armed under us must not be
    // stamped terminal by the loser of that race.
    where: { id: claimId, extractStatus: "running" },
    data: {
      extractStatus: outcome.skipped ? "skipped" : "done",
      extractReason: outcome.reason,
      extractedAt: new Date(),
      extractClaimedAt: null,
    },
  });
}

export function logEmailTick(counts: { claimed: number; proposed: number; skipped: number }): void {
  if (counts.claimed === 0) return;
  logger.info(counts, "filing: email arm");
}


export interface EmailArmResult {
  claimed: number;
  proposed: number;
  skipped: number;
}

/**
 * One pass of the email arm.
 *
 * 🔴 Called BEFORE the model pre-flight in `runFilingTick`, deliberately.
 *
 * This arm uses no model at all — it is a join. A box whose local model is
 * unreachable has nothing wrong with its MAIL, and blocking mail filing behind
 * `resolveFilingModel` would mean a gateway blip stops a customer's email
 * reaching their timeline for reasons that have nothing to do with either. The
 * file arm returns `blocked` in that situation; this one keeps working, which
 * is the honest behaviour rather than the convenient one.
 */
export async function runEmailArm(
  prisma: PrismaClient,
  settings: ResolvedFilingSettings,
): Promise<EmailArmResult> {
  if (!settings.enabledById) return { claimed: 0, proposed: 0, skipped: 0 };

  // Only mailboxes the ENABLING OWNER connected. Filing was switched on by one
  // person, on their own authority, and their consent does not reach another
  // user's mailbox — the same scoping the file arm applies to a corpus.
  const accounts = await prisma.emailAccount.findMany({
    where: { userId: settings.enabledById },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return { claimed: 0, proposed: 0, skipped: 0 };

  const claims = await claimEmails(prisma, accountIds, settings.enabledAt);
  let proposed = 0;
  let skipped = 0;

  for (const claim of claims) {
    const match = await resolveSender(prisma, claim.fromAddr);
    const outcome = decideEmail(claim, match);

    if (outcome.draft) {
      const draft: ProposalDraft = {
        ...outcome.draft,
        evidence: [],
        ...classify({
          kind: "LOG_EMAIL_ACTIVITY",
          mode: settings.mode,
          level: settings.level,
          vertical: settings.vertical,
          // A mail that reached here was never sent to a classifier — there is
          // no body pass on this arm — so the verdict is the only honest one:
          // nothing has been read that could carry PHI beyond the subject,
          // and the subject has already been through the persisted screen.
          phiVerdict: "CLEAN",
          confidence: outcome.draft.confidence,
          matchKind: outcome.draft.matchKind,
        }),
      };
      await persistDrafts(
        prisma,
        {
          sourceKind: "EMAIL",
          sourceRef: `email:${claim.id}`,
          emailMessageId: claim.id,
          occurredAt: claim.receivedAt.toISOString(),
        },
        [draft],
        { requestedById: settings.enabledById, phiVerdict: "CLEAN" },
      );
      proposed += 1;
    } else {
      skipped += 1;
    }

    await prisma.$transaction((tx) =>
      finishEmail(tx, claim.id, {
        skipped: outcome.draft === null,
        reason: outcome.skipReason,
      }),
    );
  }

  const result = { claimed: claims.length, proposed, skipped };
  logEmailTick(result);
  return result;
}
