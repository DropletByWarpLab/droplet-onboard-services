/**
 * The brain block (WARP-2752, ADR-051) — the standing understanding, inlined
 * into the system prompt.
 *
 * TWO READ PATHS, AND THIS IS THE ONE THAT NEEDS NO TOOL CALL. `business_find`
 * with `entity: "finding"` lets the model ASK; this block means it already
 * knows, on turn one, without spending an iteration. That matters because the
 * agent loop gets ten of them and the in-loop guard force-finalizes past 13,824
 * estimated tokens — a fact worth ~200 chars in the prompt is much cheaper than
 * the same fact behind a tool round trip.
 *
 * BOUNDED AT BUILD TIME, exactly like `MemoryFact`'s 20-fact / 2,000-char
 * block. The budget is spent here rather than left to `degradeToFit`, because
 * a block that is sometimes 300 chars and sometimes 9,000 makes every
 * downstream estimate a guess. `degradeToFit` can still drop it whole — it is
 * ranked LAST of the three droppable blocks, so a busy turn loses the typed
 * business summary and the persona before it loses what the box actually read.
 *
 * OPEN FINDINGS ONLY, NEWEST UNDERSTANDING FIRST. A dismissed finding is a
 * decision a human already made and re-stating it to the model invites it to
 * argue. A superseded digest is history.
 *
 * ROLE-SCOPED, because the corpus was. This composes `visibleScopeFilter`, so a
 * `company`-scope row never reaches a `family` turn — the same filter /brief
 * and `business_find` run, and the reason it lives in the service rather than
 * at each call site.
 */
import type { PrismaClient } from "@prisma/client";
import { formatMinorUnits } from "@droplet/shared-types";
import { visibleScopeFilter } from "./brain-digest.service.js";
import type { Prisma } from "@prisma/client";

/** Mirrors MEMORY_FACTS_* — same shape of budget, same reason. */
export const BRAIN_BLOCK_FINDINGS_LIMIT = 5;
export const BRAIN_BLOCK_DIGESTS_LIMIT = 8;
export const BRAIN_BLOCK_CHAR_BUDGET = 1800;

function money(minor: bigint | null, currency: string | null): string {
  if (minor === null || currency === null) return "";
  // CURRENCY-AWARE via formatMinorUnits. Dividing by 100n was wrong by 100x
  // for JPY/KRW and 10x for KWD/BHD — and a wrong number read to the model is
  // worse than no number, because it will quote it.
  const shown = formatMinorUnits(minor, currency);
  return shown ? ` (${shown} ${currency})` : "";
}

export async function buildBrainBlock(
  prisma: PrismaClient,
  caller: { id: string; role: string },
): Promise<string> {
  let scopeFilter: Prisma.BrainDigestWhereInput;
  try {
    scopeFilter = await visibleScopeFilter(prisma, caller);
  } catch {
    // A brain block is an enhancement. If scope cannot be resolved the honest
    // move is to send NO block rather than an unscoped one — failing open here
    // would show a family member company-wide findings.
    return "";
  }

  const [findings, digests] = await Promise.all([
    prisma.brainFinding.findMany({
      where: { ...(scopeFilter as Prisma.BrainFindingWhereInput), status: "new" },
      orderBy: [{ impactMinor: { sort: "desc", nulls: "last" } }, { lastConfirmedAt: "desc" }],
      take: BRAIN_BLOCK_FINDINGS_LIMIT,
      select: { title: true, kind: true, impactMinor: true, currency: true },
    }),
    prisma.brainDigest.findMany({
      where: { ...scopeFilter, supersededById: null },
      orderBy: { lastConfirmedAt: "desc" },
      take: BRAIN_BLOCK_DIGESTS_LIMIT,
      select: { title: true, body: true },
    }),
  ]);

  if (findings.length === 0 && digests.length === 0) return "";

  const lines: string[] = ["", "What you have worked out about this business:"];

  for (const d of digests) {
    // Title plus a clipped body: the title alone is often a label, and the
    // whole body is a paragraph. One sentence is what makes it usable.
    lines.push(`- ${d.title}. ${d.body.slice(0, 160)}`);
  }

  if (findings.length > 0) {
    lines.push("", "Open items you have flagged:");
    for (const f of findings) {
      lines.push(`- [${f.kind}] ${f.title}${money(f.impactMinor, f.currency)}`);
    }
  }

  lines.push(
    "",
    // The model must not present this as a live read. It is a standing summary
    // written by a scheduled pass, and it is deliberately partial — the corpus
    // pass covers ~240 documents a day. A model that says "I have reviewed all
    // your documents" on the strength of eight digests is lying on the box's
    // behalf, and `business_find` is how it checks.
    "This is a standing summary from a background pass, not a live read, and it is partial. Use business_find (entity: finding or digest) for the current list.",
  );

  const block = lines.join("\n");
  // Hard clip. Truncated at a line boundary so the last entry is never half a
  // sentence the model might complete for itself.
  if (block.length <= BRAIN_BLOCK_CHAR_BUDGET) return block;
  const clipped = block.slice(0, BRAIN_BLOCK_CHAR_BUDGET);
  return clipped.slice(0, clipped.lastIndexOf("\n"));
}
