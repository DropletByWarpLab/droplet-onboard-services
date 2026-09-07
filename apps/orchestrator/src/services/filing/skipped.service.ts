/**
 * WARP-2731 (ADR-048) — the Skipped tab: what Droplet decided not to file.
 *
 * ── Why this needs its own read at all ─────────────────────────────────────
 *
 * A skip produces NO `IngestProposal`, by construction: a `RECORD` verdict is
 * terminal before the extraction pass ever runs, and a path-denylist hit never
 * reaches a model. So there is nothing in the proposals table to list, and the
 * only record that a document was considered and refused lives on
 * `FileIndexStatus.extractStatus` — a Python-owned table.
 *
 * Without this list the feature has a silent mode: an owner drops a folder of
 * invoices into a directory whose name happens to contain "treatment", nothing
 * appears, and there is no surface anywhere that says why. That is the single
 * most likely way this feature loses trust.
 *
 * ── 🔴 The orchestrator as a SECOND WRITER ─────────────────────────────────
 *
 * There is no Prisma call site for `fileIndexStatus` anywhere in
 * `apps/orchestrator/src` other than filing's own: the table is read with
 * `$queryRaw` (`routes/files.ts`) and written only by `db.py set_index_status`.
 * Filing writes the `extract*` columns, and that is safe ONLY because Python's
 * `ON CONFLICT` arm names its columns explicitly and never touches them.
 *
 * That safety is an assumption about a file in another language, in another
 * image, on another release cadence — so it is PINNED by a test rather than
 * trusted (`filing-second-writer.guard.test.ts`). If `set_index_status` ever
 * grows an `extractStatus` write, the guard goes red here instead of a box
 * quietly re-extracting its whole corpus on every touch.
 *
 * ── Paging over two different key shapes ───────────────────────────────────
 *
 * `FileIndexStatus` is `@@id([userId, path])` with no surrogate id;
 * `EmailMessage` is a uuid. There is no shared cursor, so the page is keyed on
 * `extractedAt` — the one column both carry and both set at the same moment.
 *
 * ⚠ Two sources merged under one `extractedAt` cursor: "there is more" is true
 * when either query hit its own cap OR the merge of two under-cap queries
 * overflowed a page. Testing only the caps loses up to a page of rows in the
 * merge — the shape where each source returns thirty and the owner never sees
 * the last ten.
 *
 * ── The email half is deliberately quiet in this slice ─────────────────────
 *
 * Slice 1's backfill retired every existing `EmailMessage` as
 * `not_needed/backlog`, so an unfiltered read here would hand the owner their
 * entire mail history as a list of "skips" on the day they turned filing on —
 * a list nobody would ever finish, made of non-events. `backlog` is therefore
 * excluded from the EMAIL half specifically. The email arm proper is
 * WARP-2735; when it lands, its own genuine skips appear here with no change
 * to this function.
 *
 * Emails are scoped through `EmailAccount.userId`, since `EmailMessage` has no
 * owner column of its own — the same fail-closed rule as the file half: an
 * unresolvable owner reads nothing rather than everything.
 */
import type { PrismaClient, ExtractReason } from "@prisma/client";

export const SKIPPED_PAGE_SIZE = 50;

export interface SkippedItem {
  /** `file:<ncFileId>` or `email:<uuid>` — the same shape `sourceRef` uses. */
  sourceRef: string;
  sourceKind: "FILE" | "EMAIL";
  reason: ExtractReason | null;
  /** What the owner is told. Never a snippet, never a filename. */
  explanation: string;
  skippedAt: string;
  /** True when re-opening it is meaningful — see `isReopenable`. */
  reopenable: boolean;
}

/**
 * The owner-facing sentence for each reason.
 *
 * 🔴 NO SNIPPET, EVER, and no filename. The whole point of a skip is that the
 * document was judged unsafe or irrelevant to read further; quoting it on the
 * page that explains the skip would undo the skip. The reason code carries all
 * the information the owner needs to act — and if they want more, the file is
 * one click away in Files, where access is checked.
 */
export const EXPLANATIONS: Record<string, string> = {
  phi_path: "In a folder Droplet is told to leave alone — not filed.",
  phi_record: "Looked like a personal or patient document — not filed.",
  not_business: "Did not look like business paperwork — not filed.",
  out_of_scope: "Outside the folders you asked Droplet to watch.",
  ignored_by_you: "You told Droplet to ignore this source.",
  backlog: "Was already here before you turned filing on.",
  unchanged: "Nothing changed since Droplet last read it.",
  no_text: "Droplet could not find any readable text in this one.",
  encrypted_content: "This one is encrypted, so Droplet cannot read it.",
  too_large: "Too large for Droplet to read in one go.",
  bad_json: "Droplet could not make sense of what the model returned.",
  model_unreachable: "Droplet could not reach the AI service.",
  cloud_model_refused:
    "Droplet only reads your documents with a model running on this box, and the box is set to a cloud one.",
  stale_claim: "Droplet started reading this one and did not finish.",
  owner_unavailable: "There was no owner to file this under.",
};

export function explain(reason: ExtractReason | null): string {
  return reason ? (EXPLANATIONS[reason] ?? "Not filed.") : "Not filed.";
}

/**
 * Can the owner usefully ask Droplet to look again?
 *
 * 🔴 A PHI skip is NOT reopenable from this list, and that is a product
 * decision rather than a technical one. Re-opening `phi_record` would mean a
 * one-click override of the screen from a page anyone with admin can reach,
 * which turns a four-layer control into a button. The way to file a document
 * the screen refused is to move it out of the denylisted folder, or to change
 * the folder list — both deliberate acts with an owner behind them.
 */
export function isReopenable(reason: ExtractReason | null): boolean {
  return (
    reason === "not_business" ||
    reason === "out_of_scope" ||
    reason === "backlog" ||
    reason === "no_text" ||
    reason === "bad_json" ||
    reason === "model_unreachable" ||
    reason === "stale_claim"
  );
}

/** The statuses that mean "we looked and did not file it". `failed` is
 *  included: to an owner, a document that could not be read and one that was
 *  refused are the same question — "why isn't this filed?" */
const SKIPPED_STATUSES = ["skipped", "not_needed", "failed"] as const;

export interface SkippedPage {
  items: SkippedItem[];
  /** ISO timestamp to pass back as `before`. Null when the list is exhausted. */
  nextBefore: string | null;
}

/**
 * One page of skips, newest first, across both source kinds.
 *
 * Scoped to `permittedOwnerIds` for the same reason the chunk reader is: this
 * is a list of documents, and the fact that a document EXISTS at a path is
 * itself information the caller may not be entitled to.
 */
export async function listSkipped(
  prisma: PrismaClient,
  permittedOwnerIds: readonly string[],
  /** The enabling owner's `User.id`, for the email half. Null reads no mail. */
  ownerUserId: string | null,
  opts: { before?: Date } = {},
): Promise<SkippedPage> {
  if (permittedOwnerIds.length === 0) return { items: [], nextBefore: null };

  const timeFilter = opts.before ? { lt: opts.before } : undefined;

  const [files, emails] = await Promise.all([
    prisma.fileIndexStatus.findMany({
      where: {
        userId: { in: [...permittedOwnerIds] },
        extractStatus: { in: [...SKIPPED_STATUSES] },
        ...(timeFilter ? { extractedAt: timeFilter } : { extractedAt: { not: null } }),
        ncFileId: { not: null },
      },
      select: { ncFileId: true, extractReason: true, extractedAt: true },
      orderBy: { extractedAt: "desc" },
      take: SKIPPED_PAGE_SIZE + 1,
    }),
    ownerUserId === null
      ? Promise.resolve([])
      : prisma.emailMessage.findMany({
          where: {
            account: { userId: ownerUserId },
            extractStatus: { in: [...SKIPPED_STATUSES] },
            // See the header: slice 1 retired the whole mail history as
            // `backlog`, and those are non-events.
            extractReason: { not: "backlog" },
            ...(timeFilter ? { extractedAt: timeFilter } : { extractedAt: { not: null } }),
          },
          select: { id: true, extractReason: true, extractedAt: true },
          orderBy: { extractedAt: "desc" },
          take: SKIPPED_PAGE_SIZE + 1,
        }),
  ]);

  const merged: SkippedItem[] = [
    ...files.map((f) => ({
      sourceRef: `file:${f.ncFileId}`,
      sourceKind: "FILE" as const,
      reason: f.extractReason,
      explanation: explain(f.extractReason),
      skippedAt: (f.extractedAt as Date).toISOString(),
      reopenable: isReopenable(f.extractReason),
    })),
    ...emails.map((e) => ({
      sourceRef: `email:${e.id}`,
      sourceKind: "EMAIL" as const,
      reason: e.extractReason,
      explanation: explain(e.extractReason),
      skippedAt: (e.extractedAt as Date).toISOString(),
      reopenable: isReopenable(e.extractReason),
    })),
  ].sort((a, b) => (a.skippedAt < b.skippedAt ? 1 : a.skippedAt > b.skippedAt ? -1 : 0));

  const page = merged.slice(0, SKIPPED_PAGE_SIZE);

  // 🔴 There is more when EITHER query hit its own cap, OR the merge of two
  // under-cap queries overflowed one page. Testing only the caps loses up to
  // `SKIPPED_PAGE_SIZE - 1` rows in the merge — the shape where each source
  // returns thirty and the owner never sees the last ten.
  const hasMore =
    files.length > SKIPPED_PAGE_SIZE ||
    emails.length > SKIPPED_PAGE_SIZE ||
    merged.length > page.length;
  const nextBefore = hasMore && page.length > 0 ? page[page.length - 1].skippedAt : null;

  return { items: page, nextBefore };
}
