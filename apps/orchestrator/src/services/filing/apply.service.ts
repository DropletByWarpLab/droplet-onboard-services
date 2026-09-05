/**
 * WARP-2730 (ADR-048) — applying a proposal, and undoing the decision to.
 *
 * ── In-process seams, never HTTP ───────────────────────────────────────────
 *
 * This calls `createCompany` / `linkFileToRecord` / `createProject` directly,
 * inside one transaction. It does NOT call its own REST API and it never
 * presents as `_service:mcp`. A background job dispatching to its own routes
 * would be a second, unauthenticated caller of every write endpoint on the box,
 * and the confirmation gate those endpoints inherit exists for a human — which
 * this is not.
 *
 * ── The four guards, in the order they run ─────────────────────────────────
 *
 *   1. NEVER is unappliable, even for a human clicking the button. A CHECK on
 *      `IngestProposal` says so too; this is the readable half of the same rule.
 *   2. The SOURCE is re-checked. A proposal can sit thirty days. The stored
 *      `ncFileId`/`filePath` pair bypasses the PROPFIND every route-level
 *      linker does, so without this, applying could mint an `EntityLink` to a
 *      deleted fileid under a path that now holds somebody else's document.
 *   3. The PAYLOAD is re-parsed through its own `.strict()` allow-list. The row
 *      may have been written by an older extractor version, or by hand.
 *   4. The STATUS transition is a guarded `updateMany` with `count === 1`. Two
 *      tabs clicking Apply race here, and exactly one wins; the loser gets 409
 *      rather than a second customer.
 *
 * ── Attribution ────────────────────────────────────────────────────────────
 *
 * `createdById` is the deciding owner's real `User.id`, never null. The
 * "Created by Droplet" chip reads `origin === "EXTRACTED"`, never
 * `createdById IS NULL` — a NULL is an absence, and deriving a product
 * behaviour from an absence is how the chip starts appearing on rows a human
 * typed before the column existed.
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient, IngestProposal, IngestKeyKind } from "@prisma/client";

import * as crm from "../crm/crm.service.js";
import * as links from "../crm/entity-link.service.js";
import * as contacts from "../contacts/contacts.service.js";
import * as pm from "../pm/pm.service.js";

import { normalizeCompanyName } from "./match.js";
import { parsePayload, type AnyPayload, type PayloadFor } from "./payloads.js";

export const FILING_ERRORS = {
  PROPOSAL_NOT_FOUND: "proposal_not_found",
  /** Already decided — applied, rejected, expired, or undone. */
  NOT_PENDING: "proposal_not_pending",
  /** `policyClass = NEVER`. Not a permission problem; the box does not do this
   *  yet, for anyone. */
  NEVER_APPLIABLE: "proposal_never_appliable",
  /** The payload no longer satisfies its kind's allow-list. */
  PAYLOAD_UNREADABLE: "proposal_payload_unreadable",
  /** The file is gone, or the path now holds a different file. */
  SOURCE_CHANGED: "proposal_source_changed",
  /** `MATCH_REVIEW` applied without saying which candidate. */
  CHOICE_REQUIRED: "proposal_choice_required",
  /** The chosen id is not one of the candidates the proposal offered. */
  CHOICE_NOT_OFFERED: "proposal_choice_not_offered",
} as const;

export interface ApplyOptions {
  /** For `MATCH_REVIEW`: which of the offered candidates the owner picked. */
  chooseCompanyId?: string;
}

export interface ApplyContext {
  /** The deciding owner's real `User.id`. */
  actorId: string;
  /**
   * Resolve the CURRENT Nextcloud fileid for a stored path, as the deciding
   * caller. Returns null when the file is gone or they cannot see it.
   *
   * Injected rather than called here so the service does no HTTP and the route
   * keeps ownership of the caller's Nextcloud token — the same split
   * `crm-entity-links.ts` uses.
   */
  resolveFileId: (filePath: string) => Promise<number | null>;
}

export interface ApplyResult {
  proposalId: string;
  createdCompanyId?: string;
  createdContactId?: string;
  createdProjectId?: string;
  createdEntityLinkId?: string;
}

/**
 * Apply one proposal.
 *
 * Throws `Error(code)` from `FILING_ERRORS`; the route maps codes to statuses,
 * mirroring `routes/crm.ts` and `routes/pm/native.ts`.
 */
export async function applyProposal(
  prisma: PrismaClient,
  proposalId: string,
  ctx: ApplyContext,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const proposal = await prisma.ingestProposal.findUnique({ where: { id: proposalId } });
  if (!proposal) throw new Error(FILING_ERRORS.PROPOSAL_NOT_FOUND);
  if (proposal.status !== "PENDING") throw new Error(FILING_ERRORS.NOT_PENDING);
  if (proposal.policyClass === "NEVER") throw new Error(FILING_ERRORS.NEVER_APPLIABLE);

  const payload = parsePayload(proposal.kind, proposal.payload);
  if (payload === null) throw new Error(FILING_ERRORS.PAYLOAD_UNREADABLE);

  // 🔴 Guard 2, and it runs OUTSIDE the transaction on purpose: it is a
  // network round-trip to Nextcloud, and holding a Postgres transaction open
  // across one is how a slow PROPFIND becomes a lock nobody can explain.
  const file = "file" in payload ? payload.file : undefined;
  if (file) {
    const current = await ctx.resolveFileId(file.filePath);
    if (current === null || current !== file.ncFileId) {
      throw new Error(FILING_ERRORS.SOURCE_CHANGED);
    }
  }

  return prisma.$transaction(async (tx) => {
    // Guard 4. Re-read and re-guard INSIDE the transaction: everything above
    // was a pre-flight, and a pre-flight that is not re-checked under the lock
    // is a race with a comment on it.
    const claimed = await tx.ingestProposal.updateMany({
      where: { id: proposalId, status: "PENDING" },
      data: {
        status: "APPLIED",
        decidedById: ctx.actorId,
        decidedAt: new Date(),
        appliedAt: new Date(),
        autoApplied: false,
      },
    });
    if (claimed.count !== 1) throw new Error(FILING_ERRORS.NOT_PENDING);

    const result = await performApply(tx, proposal, payload, ctx, opts);

    await tx.ingestProposal.update({
      where: { id: proposalId },
      data: {
        createdCompanyId: result.createdCompanyId ?? null,
        createdContactId: result.createdContactId ?? null,
        createdProjectId: result.createdProjectId ?? null,
        createdEntityLinkId: result.createdEntityLinkId ?? null,
      },
    });

    return { proposalId, ...result };
  });
}

type Tx = Prisma.TransactionClient;

async function performApply(
  tx: Tx,
  proposal: IngestProposal,
  payload: AnyPayload,
  ctx: ApplyContext,
  opts: ApplyOptions,
): Promise<Omit<ApplyResult, "proposalId">> {
  const prisma = tx as unknown as PrismaClient;
  const confidence = proposal.confidence;

  switch (proposal.kind) {
    case "LINK_FILE": {
      const p = payload as PayloadFor<"LINK_FILE">;
      const link = await links.linkFileToRecord(
        prisma,
        {
          ncFileId: p.file.ncFileId,
          filePath: p.file.filePath,
          fileSpace: p.file.fileSpace,
          subjectType: "COMPANY",
          subjectId: p.companyId,
          linkedBy: "EXTRACTED",
          confidence,
        },
        ctx.actorId,
      );
      return { createdEntityLinkId: link.id };
    }

    case "CREATE_CUSTOMER": {
      const p = payload as PayloadFor<"CREATE_CUSTOMER">;
      const company = await crm.createCompany(
        prisma,
        {
          name: p.name,
          domain: p.domain ?? null,
          phone: p.phone ?? null,
          website: p.website ?? null,
          addressLine1: p.address ?? null,
        },
        ctx.actorId,
        { proposalId: proposal.id },
      );
      // The document that named them, attached in the same transaction. This
      // is why `CREATE_CUSTOMER` is one proposal and not a parent/child pair:
      // a customer created without the paper that created them is a record
      // nobody can check.
      let linkId: string | undefined;
      if (p.file) {
        const link = await links.linkFileToRecord(
          prisma,
          {
            ncFileId: p.file.ncFileId,
            filePath: p.file.filePath,
            fileSpace: p.file.fileSpace,
            subjectType: "COMPANY",
            subjectId: company.id,
            linkedBy: "EXTRACTED",
            confidence,
          },
          ctx.actorId,
        );
        linkId = link.id;
      }
      return { createdCompanyId: company.id, createdEntityLinkId: linkId };
    }

    case "MATCH_REVIEW": {
      const p = payload as PayloadFor<"MATCH_REVIEW">;
      const chosen = opts.chooseCompanyId;
      if (!chosen) throw new Error(FILING_ERRORS.CHOICE_REQUIRED);
      // The choice must be one this proposal actually offered. Without this,
      // "apply proposal X onto company Y" is an arbitrary link-anything
      // endpoint wearing a review card's clothes.
      if (!p.candidates.some((c) => c.companyId === chosen)) {
        throw new Error(FILING_ERRORS.CHOICE_NOT_OFFERED);
      }
      if (!p.file) return {};
      const link = await links.linkFileToRecord(
        prisma,
        {
          ncFileId: p.file.ncFileId,
          filePath: p.file.filePath,
          fileSpace: p.file.fileSpace,
          subjectType: "COMPANY",
          subjectId: chosen,
          linkedBy: "EXTRACTED",
          confidence,
        },
        ctx.actorId,
      );
      return { createdEntityLinkId: link.id };
    }

    case "CREATE_PROJECT": {
      const p = payload as PayloadFor<"CREATE_PROJECT">;
      const project = await pm.createProject(prisma, ctx.actorId, {
        name: p.name,
        ...(p.summary ? { description: p.summary } : {}),
        ...(p.companyId ? { companyId: p.companyId } : {}),
      });
      return { createdProjectId: project.id };
    }

    case "SET_PROJECT_CUSTOMER": {
      const p = payload as PayloadFor<"SET_PROJECT_CUSTOMER">;
      await pm.updateProject(prisma, p.projectId, { companyId: p.companyId });
      return { createdProjectId: p.projectId };
    }

    case "CREATE_CONTACT": {
      const p = payload as PayloadFor<"CREATE_CONTACT">;
      const contact = await contacts.createContact(
        prisma,
        ctx.actorId,
        {
          displayName: p.displayName,
          organization: p.organization ?? null,
          jobTitle: p.roleTitle ?? null,
          emails: p.email ? [{ address: p.email, isPrimary: true }] : [],
          phones: p.phone ? [{ number: p.phone, isPrimary: true }] : [],
          // No `birthday`, and `createContact` refuses one alongside `filing`.
        },
        { proposalId: proposal.id },
      );
      if (p.companyId) {
        await crm.linkContactToCompany(prisma, p.companyId, contact.id);
      }
      return { createdContactId: contact.id };
    }

    case "LOG_EMAIL_ACTIVITY": {
      const p = payload as PayloadFor<"LOG_EMAIL_ACTIVITY">;
      await crm.logActivity(
        prisma,
        {
          subjectType: "COMPANY",
          companyId: p.companyId,
          kind: "EMAIL",
          emailMessageId: p.emailMessageId,
          ...(p.occurredAt ? { occurredAt: p.occurredAt } : {}),
          // The subject line, already run through the persisted-string screen
          // when the proposal was built. Never the mailbox path, never a
          // filename.
          summary: p.subject ?? "Email logged",
        },
        ctx.actorId,
      );
      return {};
    }

    case "CREATE_MONEY_DOC":
      // Unreachable: `policyClass` is NEVER for this kind and the caller
      // refused above. Written as a throw rather than omitted so adding a
      // money path later is a deliberate edit here and not an accident of a
      // policy-table change somewhere else.
      throw new Error(FILING_ERRORS.NEVER_APPLIABLE);

    default: {
      const exhaustive: never = proposal.kind;
      throw new Error(`unhandled proposal kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Reject a proposal, and forget what it said.
 *
 * `evidence` is NULLED in the same statement, not in a follow-up: the quotes
 * are the most sensitive thing on the row, the owner has just said this filing
 * was wrong, and a rejected proposal that keeps its quotes is a copy of a
 * document nobody agreed to keep.
 */
export async function rejectProposal(
  prisma: PrismaClient,
  proposalId: string,
  actorId: string,
): Promise<void> {
  const n = await prisma.ingestProposal.updateMany({
    where: { id: proposalId, status: "PENDING" },
    data: {
      status: "REJECTED",
      decidedById: actorId,
      decidedAt: new Date(),
      evidence: Prisma.DbNull,
    },
  });
  if (n.count !== 1) throw new Error(FILING_ERRORS.NOT_PENDING);
}

/**
 * The key a "not this customer" rule is written against.
 *
 * 🔴 NOT the dedupe key. For a `LINK_FILE` the dedupe key is the matched
 * COMPANY'S UUID, and a `FilingDecision` keyed on a UUID matches nothing the
 * matcher ever looks up — the owner's correction would silently never take
 * effect and the same wrong suggestion would come back tomorrow. That is worse
 * than having no correction memory: it teaches the owner the feature does not
 * listen.
 *
 * So the key comes from the payload, which carries the key that FOUND the
 * match (`matchedKeyKind` / `matchedKeyValue`, set in `propose.ts`). A payload
 * without one — a `CREATE_CUSTOMER`, which matched nothing by definition —
 * falls back to the name the document used, which is exactly what the matcher's
 * NAME key looks up.
 */
export function notSameKey(
  kind: IngestProposal["kind"],
  payload: AnyPayload,
): { keyKind: IngestKeyKind; keyValue: string } | null {
  const p = payload as Record<string, unknown>;
  const carried = p.matchedKeyValue;
  const carriedKind = p.matchedKeyKind;
  if (typeof carried === "string" && carried.length > 0 && typeof carriedKind === "string") {
    return { keyKind: carriedKind as IngestKeyKind, keyValue: carried.toLowerCase() };
  }
  if (kind === "CREATE_CUSTOMER" && typeof p.name === "string") {
    return { keyKind: "NAME", keyValue: normalizeCompanyName(p.name) || p.name.toLowerCase() };
  }
  return null;
}

/**
 * "Not this customer" — reject, and remember.
 *
 * Writes a `FilingDecision` in the same transaction as the rejection, because
 * a correction the owner made that did not stick is worse than no correction:
 * they see the same wrong suggestion tomorrow and stop trusting the feature.
 *
 * A proposal whose payload carries no usable key is still REJECTED — the owner
 * said no and that must hold — but no rule is written, because a rule that
 * matches nothing is a rule the owner will later find on the Rules page and be
 * unable to explain.
 */
export async function markNotSame(
  prisma: PrismaClient,
  proposalId: string,
  companyId: string,
  actorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const proposal = await tx.ingestProposal.findUnique({
      where: { id: proposalId },
      select: { kind: true, payload: true, status: true },
    });
    if (!proposal) throw new Error(FILING_ERRORS.PROPOSAL_NOT_FOUND);

    const n = await tx.ingestProposal.updateMany({
      where: { id: proposalId, status: "PENDING" },
      data: {
        status: "NOT_SAME",
        decidedById: actorId,
        decidedAt: new Date(),
        evidence: Prisma.DbNull,
      },
    });
    if (n.count !== 1) throw new Error(FILING_ERRORS.NOT_PENDING);

    const parsed = parsePayload(proposal.kind, proposal.payload);
    const key = parsed === null ? null : notSameKey(proposal.kind, parsed);
    if (!key) return;

    await tx.filingDecision.create({
      data: {
        keyKind: key.keyKind,
        keyValue: key.keyValue,
        verdict: "NOT_SAME",
        companyId,
        createdById: actorId,
      },
    });
  });
}
