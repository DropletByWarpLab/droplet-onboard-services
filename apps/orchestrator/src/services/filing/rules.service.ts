/**
 * WARP-2731 (ADR-048) — the Rules memory, in the owner's words.
 *
 * `FilingDecision` is the table the matcher consults BEFORE it searches
 * (WARP-2730), so it is the most powerful thing in this feature: one row can
 * silently stop a whole domain being filed, or force it onto one customer
 * forever. A capability like that is only acceptable if the person who has it
 * can SEE it and TAKE IT BACK.
 *
 * So this module exists to render each row as a sentence and to delete one.
 * That is the whole surface. There is deliberately no edit: a rule is a thing
 * the owner said once, and changing it in place would make the audit read as
 * though they had always said the new thing.
 *
 * ── Why the sentence is built here and not in the dashboard ────────────────
 *
 * Because it needs the company's NAME, which the row stores only as an id, and
 * because the phrasing is the product. "Mail from @northgatedental.example
 * always files under Northgate Dental" is a rule an owner can judge;
 * `ALWAYS_HERE / EMAIL_DOMAIN / 4f2a…` is not. Sending the raw row and letting
 * three clients each invent their own phrasing is how the same rule ends up
 * described three different ways.
 */
import type { PrismaClient, IngestKeyKind, FilingDecisionKind } from "@prisma/client";

export interface FilingRule {
  id: string;
  keyKind: IngestKeyKind;
  keyValue: string;
  verdict: FilingDecisionKind;
  companyId: string | null;
  companyName: string | null;
  /** The rule as one sentence, ready to render. */
  sentence: string;
  createdAt: string;
}

/** How many rules one page carries. The Rules tab is meant to be readable, and
 *  a box with more than this has a different problem. */
export const RULES_PAGE_SIZE = 200;

/**
 * Render one rule.
 *
 * 🔴 The key value is shown VERBATIM, and that is deliberate even though it is
 * usually an email address or a domain: a rule the owner cannot identify is a
 * rule they cannot revoke, and this surface is owner/admin only for exactly
 * this reason. What is never shown is anything the rule did not come from —
 * no filename, no document text, no quote.
 */
export function sentenceFor(rule: {
  keyKind: IngestKeyKind;
  keyValue: string;
  verdict: FilingDecisionKind;
  companyName: string | null;
}): string {
  const subject =
    rule.keyKind === "EMAIL_ADDRESS"
      ? `Mail from ${rule.keyValue}`
      : rule.keyKind === "EMAIL_DOMAIN"
        ? `Mail from @${rule.keyValue}`
        : rule.keyKind === "NC_FOLDER"
          ? `Files in ${rule.keyValue}`
          : `Documents naming “${rule.keyValue}”`;

  switch (rule.verdict) {
    case "ALWAYS_HERE":
      return `${subject} always files under ${rule.companyName ?? "a customer that no longer exists"}.`;
    case "NOT_SAME":
      return `${subject} is never ${rule.companyName ?? "that customer"}.`;
    case "IGNORE_SOURCE":
      return `${subject} is ignored.`;
    default:
      return subject;
  }
}

export async function listRules(prisma: PrismaClient): Promise<FilingRule[]> {
  const rows = await prisma.filingDecision.findMany({
    orderBy: { createdAt: "desc" },
    take: RULES_PAGE_SIZE,
  });

  // One query for every named company rather than one per rule.
  const ids = [...new Set(rows.map((r) => r.companyId).filter((v): v is string => v !== null))];
  const companies =
    ids.length > 0
      ? await prisma.crmCompany.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : [];
  const nameById = new Map(companies.map((c) => [c.id, c.name]));

  return rows.map((r) => {
    // 🔴 A rule whose company was DELETED still renders, with the absence said
    // out loud. The matcher already falls through such a rule rather than
    // matching to a row that is gone (WARP-2730) — and deleting it here, in a
    // read, would be a background job quietly forgetting what a human taught
    // it. Surfacing it lets the owner remove it themselves.
    const companyName = r.companyId ? (nameById.get(r.companyId) ?? null) : null;
    return {
      id: r.id,
      keyKind: r.keyKind,
      keyValue: r.keyValue,
      verdict: r.verdict,
      companyId: r.companyId,
      companyName,
      sentence: sentenceFor({ ...r, companyName }),
      createdAt: r.createdAt.toISOString(),
    };
  });
}

export const RULE_ERRORS = { NOT_FOUND: "filing_rule_not_found" } as const;

/**
 * Forget a rule.
 *
 * A hard delete, not an archive. The row's only purpose is to change what the
 * matcher does next time; a revoked rule that lingered would either still
 * apply (wrong) or sit in the table doing nothing (confusing). The `ActivityRow`
 * written by the route is where the fact that it once existed survives.
 */
export async function revokeRule(prisma: PrismaClient, id: string): Promise<void> {
  const n = await prisma.filingDecision.deleteMany({ where: { id } });
  if (n.count !== 1) throw new Error(RULE_ERRORS.NOT_FOUND);
}

/**
 * "Stop filing @domain here" — the rule offered from a record's own chip.
 *
 * Upserted on the natural key rather than blindly created, so an owner
 * clicking twice does not grow two identical rules that then both have to be
 * revoked.
 */
export async function teachNotSame(
  prisma: PrismaClient,
  input: { keyKind: IngestKeyKind; keyValue: string; companyId: string },
  actorId: string,
): Promise<FilingRule> {
  const keyValue = input.keyValue.trim().toLowerCase();
  const existing = await prisma.filingDecision.findFirst({
    where: {
      keyKind: input.keyKind,
      keyValue,
      verdict: "NOT_SAME",
      companyId: input.companyId,
    },
  });
  const row =
    existing ??
    (await prisma.filingDecision.create({
      data: {
        keyKind: input.keyKind,
        keyValue,
        verdict: "NOT_SAME",
        companyId: input.companyId,
        createdById: actorId,
      },
    }));

  const company = await prisma.crmCompany.findUnique({
    where: { id: input.companyId },
    select: { name: true },
  });
  const companyName = company?.name ?? null;
  return {
    id: row.id,
    keyKind: row.keyKind,
    keyValue: row.keyValue,
    verdict: row.verdict,
    companyId: row.companyId,
    companyName,
    sentence: sentenceFor({ ...row, companyName }),
    createdAt: row.createdAt.toISOString(),
  };
}
