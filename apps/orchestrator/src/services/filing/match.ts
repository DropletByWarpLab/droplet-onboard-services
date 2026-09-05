/**
 * WARP-2730 (ADR-048) — is this a customer we already have?
 *
 * 🔴 DETERMINISTIC. No model is consulted here and no embedding is compared.
 * The matcher answers with a key it can name — this email address, this
 * domain, this exact name — because the failure mode of a fuzzy match is
 * putting one customer's contract on another customer's record, and the owner
 * finds that out months later.
 *
 * The correction memory (`FilingDecision`) is consulted BEFORE the search, not
 * after it. That ordering is the difference between a system that learns and
 * one that argues: if the owner has already said "mail from this domain is
 * Northgate", the matcher does not get to have an opinion, and if they have
 * said "not the same", the candidate is not offered a second time.
 *
 * The three key kinds, strongest first:
 *
 *   EMAIL   an address on a `ContactEmail` row (`addressLower`), or on a
 *           company. Two businesses do not share a mailbox.
 *   DOMAIN  `normalizeDomain`, the same function `crm.service` dedupes on, so
 *           `https://Example.com/pricing` and `example.com` are one key and
 *           not two customers.
 *   NAME    exact, case- and whitespace-normalised. Still REVIEW-ONLY in the
 *           policy table: `Northgate Dental` and `Northgate Dental Lab` are two
 *           businesses and no amount of confidence changes that.
 *
 * Anything weaker is `NONE`, which is not a failure — it is how a new customer
 * gets proposed.
 */
import type { PrismaClient } from "@prisma/client";
import type { IngestMatchKind } from "@prisma/client";

import { normalizeDomain } from "../crm/crm.service.js";

/** Free mail providers. A shared domain is not a shared employer, and
 *  matching on one would file every private customer onto whichever record
 *  happened to be created first. */
const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
]);

export function isPublicEmailDomain(domain: string | null): boolean {
  return domain !== null && PUBLIC_EMAIL_DOMAINS.has(domain.toLowerCase());
}

/** The domain half of an address, normalised the same way a website is. */
export function domainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return normalizeDomain(email.slice(at + 1));
}

/** Case- and whitespace-normalised, and stripped of the legal suffixes a
 *  document writes inconsistently. Used ONLY for the NAME key, which is
 *  review-only — this is a lookup normalisation, not an identity claim. */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(?:ltd|limited|llc|l\.l\.c|inc|incorporated|corp|corporation|plc|gmbh|pty|co)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface MatchCandidate {
  companyId: string;
  name: string;
  /** Which key found it. */
  via: IngestMatchKind;
}

export type MatchOutcome =
  /** The owner has told us to ignore this source entirely. */
  | { kind: "IGNORED"; reason: string }
  /** Exactly one record, found by a key we can name. */
  | { kind: "MATCH"; matchKind: IngestMatchKind; companyId: string; companyName: string; taught: boolean }
  /** More than one plausible record. A person picks; never auto-applied. */
  | { kind: "AMBIGUOUS"; candidates: MatchCandidate[] }
  /** Nothing matched. This is how a new customer gets proposed. */
  | { kind: "NONE" };

export interface MatchInput {
  name?: string;
  domain?: string | null;
  emails?: string[];
  /** Nextcloud folder the file sits in, for `NC_FOLDER` decisions. */
  folder?: string | null;
}

/**
 * Consult the memory, then search.
 *
 * Ordered: IGNORE_SOURCE first (the owner said stop), then ALWAYS_HERE (the
 * owner said where), then the deterministic keys, then NOT_SAME as a filter on
 * whatever those found.
 */
export async function matchCompany(
  prisma: PrismaClient,
  input: MatchInput,
): Promise<MatchOutcome> {
  const emails = (input.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const emailDomains = emails
    .map(domainFromEmail)
    .filter((d): d is string => d !== null && !isPublicEmailDomain(d));
  const domain = normalizeDomain(input.domain ?? null);
  const domains = [...new Set([domain, ...emailDomains].filter((d): d is string => d !== null))];
  const nameKey = input.name ? normalizeCompanyName(input.name) : null;

  const keyValues = [
    ...emails.map((v) => ({ keyKind: "EMAIL_ADDRESS" as const, keyValue: v })),
    ...domains.map((v) => ({ keyKind: "EMAIL_DOMAIN" as const, keyValue: v })),
    ...(nameKey ? [{ keyKind: "NAME" as const, keyValue: nameKey }] : []),
    ...(input.folder ? [{ keyKind: "NC_FOLDER" as const, keyValue: input.folder.toLowerCase() }] : []),
  ];

  const decisions = keyValues.length
    ? await prisma.filingDecision.findMany({ where: { OR: keyValues } })
    : [];

  const ignored = decisions.find((d) => d.verdict === "IGNORE_SOURCE");
  if (ignored) {
    return { kind: "IGNORED", reason: `${ignored.keyKind.toLowerCase()}:${ignored.keyValue}` };
  }

  // "Mail from @northgatedental.com always files under Northgate Dental."
  // A taught answer beats a searched one, and is reported as such so the card
  // can say WHY it was sure.
  const taught = decisions.find((d) => d.verdict === "ALWAYS_HERE" && d.companyId);
  if (taught?.companyId) {
    const company = await prisma.crmCompany.findUnique({
      where: { id: taught.companyId },
      select: { id: true, name: true },
    });
    if (company) {
      return {
        kind: "MATCH",
        matchKind: taught.keyKind === "EMAIL_ADDRESS" ? "EMAIL" : taught.keyKind === "EMAIL_DOMAIN" ? "DOMAIN" : "NAME",
        companyId: company.id,
        companyName: company.name,
        taught: true,
      };
    }
    // The taught company was deleted. Fall through to the search rather than
    // returning a match to a row that is gone — and do NOT delete the rule
    // here: a background matcher quietly forgetting what a human taught it is
    // the behaviour this table exists to prevent. WARP-2731 surfaces stale
    // rules on the Rules page for the owner to remove.
  }

  const notSame = new Set(
    decisions.filter((d) => d.verdict === "NOT_SAME" && d.companyId).map((d) => d.companyId!),
  );

  const found: MatchCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: MatchCandidate) => {
    if (notSame.has(c.companyId) || seen.has(c.companyId)) return;
    seen.add(c.companyId);
    found.push(c);
  };

  // ── EMAIL ────────────────────────────────────────────────────────────────
  if (emails.length > 0) {
    const contacts = await prisma.contactEmail.findMany({
      where: { addressLower: { in: emails } },
      select: {
        contact: {
          select: {
            companyLinks: { select: { company: { select: { id: true, name: true, isArchived: true } } } },
          },
        },
      },
      take: 25,
    });
    for (const row of contacts) {
      for (const link of row.contact.companyLinks) {
        if (link.company.isArchived) continue;
        push({ companyId: link.company.id, name: link.company.name, via: "EMAIL" });
      }
    }
  }
  if (found.length === 1) return single(found[0]);

  // ── DOMAIN ───────────────────────────────────────────────────────────────
  if (domains.length > 0) {
    const byDomain = await prisma.crmCompany.findMany({
      where: { domain: { in: domains }, isArchived: false },
      select: { id: true, name: true },
      take: 25,
    });
    for (const c of byDomain) push({ companyId: c.id, name: c.name, via: "DOMAIN" });
  }
  if (found.length === 1) return single(found[0]);

  // ── NAME ─────────────────────────────────────────────────────────────────
  //
  // `mode: "insensitive"` rather than a normalised column, because there is no
  // normalised column: adding one would be a migration on a table this slice
  // does not otherwise touch, and the NAME key is review-only regardless. The
  // suffix-stripped form is compared in memory below.
  if (input.name && nameKey) {
    const byName = await prisma.crmCompany.findMany({
      where: {
        name: { contains: input.name.trim().split(/\s+/)[0], mode: "insensitive" },
        isArchived: false,
      },
      select: { id: true, name: true },
      take: 50,
    });
    for (const c of byName) {
      if (normalizeCompanyName(c.name) === nameKey) {
        push({ companyId: c.id, name: c.name, via: "NAME" });
      }
    }
  }

  if (found.length === 1) return single(found[0]);
  if (found.length > 1) return { kind: "AMBIGUOUS", candidates: found.slice(0, 5) };
  return { kind: "NONE" };
}

function single(c: MatchCandidate): MatchOutcome {
  return {
    kind: "MATCH",
    matchKind: c.via,
    companyId: c.companyId,
    companyName: c.name,
    taught: false,
  };
}
