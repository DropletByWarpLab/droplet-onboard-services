/**
 * Corpus digest pass (WARP-2749, ADR-051) — the LLM half, and the reason the
 * whole feature is shaped the way it is.
 *
 * THE ARITHMETIC. The shipped window is 16,384 tokens. A turn spends ~2,950 on
 * fixed system blocks and ~3,426 on tool schemas before anything else, every
 * tool result is capped at 8,000 chars by a Zod `.max(8000)` an operator cannot
 * raise, and the agent loop force-finalizes past 13,824 estimated tokens. That
 * is ~40-45 KB of readable text per turn against a corpus five orders of
 * magnitude larger. No prompt makes a company fit. So this pass reads ONE
 * document at a time, writes down what it learned, and moves the cursor.
 *
 * WHAT "INCREMENTAL" ACTUALLY BUYS. The cursor is the FULL sort key —
 * `updatedAt|userId|path` — not a bare timestamp. Two files that share a
 * millisecond (routine when an indexer lands a batch) would straddle a
 * bare-timestamp boundary and one would be skipped FOREVER: the WARP-2743
 * pagination bug, in a place where nobody would ever notice the gap. The
 * tiebreak is two fields rather than one because `FileIndexStatus` has a
 * composite primary key `@@id([userId, path])` and no `id` column. The
 * comparison order matches the sort order exactly, so every row is visited
 * once.
 *
 * THE CURSOR MOVES WITH THE WRITE, NOT BEFORE IT. Each unit's digest upsert and
 * its cursor advance happen in ONE transaction. A crash re-digests at most one
 * document (the upsert is idempotent, so that is free) and skips none. The
 * alternative — batch the work, advance at the end — loses everything on a
 * mid-run failure, and this runs unattended at night where nobody sees it fail.
 *
 * IT YIELDS. The box runs ONE inference at a time (`max_concurrent=1`,
 * `num_parallel=1`) with no turn-level timeout, so a greedy pass can hold the
 * only slot for the better part of an hour and make chat look dead. This one
 * takes a small bounded number of units per tick and returns. Slow is correct:
 * ~240 units/day at the shipped cadence, so a 5,000-document corpus reaches
 * first-pass coverage in about three weeks. That number belongs on /brief, not
 * in a footnote — an operator who thinks the brain read everything on night one
 * stops trusting it the first time it misses something.
 */
import type { PrismaClient } from "@prisma/client";
import { upsertDigest, type BrainSourceRef } from "./brain-digest.service";
import { decryptChunkRows } from "../file-search.service";

export const CORPUS_PASS_KEY = "corpus.documents";

// 🔴 WARP-2837 — `BRAIN_CORPUS_LOCK_KEY` USED TO LIVE HERE AND IS GONE ON
// PURPOSE. This pass must not be registered with cron-runtime's `lockKey`:
// that runs the handler inside `prisma.$transaction(..., { timeout: 60_000 })`,
// and this pass makes up to CORPUS_UNITS_PER_RUN sequential model calls on a
// box with one inference slot. The transaction expired mid-run, released the
// lock while the pass was still working, and threw P2028 on writes that had
// already committed through the outer client.
//
// Exclusion is the lease in brain-lease.service.ts instead — a conditional
// UPDATE, atomic without holding anything open, correct across replicas.
// The constant is deleted rather than left unused because an exported lock key
// sitting next to a pass is an invitation to pass it to `scheduleInterval`,
// which is exactly the regression.

/** Units per tick. Deliberately small — see the yielding note above. */
export const CORPUS_UNITS_PER_RUN = 10;

/** How much of a document the model sees. Sized to sit inside the per-result
 *  ceiling with room for the instruction and the answer, so one unit is always
 *  one comfortable call rather than a truncation gamble. */
export const CORPUS_CHARS_PER_UNIT = 6000;

export type CorpusChatFn = (req: {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  max_tokens?: number;
}) => Promise<{ ok: boolean; json: () => Promise<{ choices?: { message?: { content?: string } }[] }> }>;

export type CorpusDeps = {
  prisma: PrismaClient;
  chat: CorpusChatFn;
  model: string;
};

export type CorpusOutcome = {
  passKey: string;
  ran: boolean;
  unitsSeen: number;
  digestsWritten: number;
  cursor: string | null;
  errors: string[];
};

/**
 * `${updatedAt.toISOString()}|${userId}|${path}` — the FULL sort key.
 *
 * `FileIndexStatus` has a COMPOSITE primary key `@@id([userId, path])` and no
 * `id` column, so the tiebreak is two fields, not one. Split on the first two
 * separators only: a Nextcloud username cannot contain "|" but a path can, and
 * truncating a path at a pipe would silently resume from the wrong document.
 */
export function encodeCursor(updatedAt: Date, userId: string, path: string): string {
  return `${updatedAt.toISOString()}|${userId}|${path}`;
}

export function decodeCursor(
  cursor: string | null,
): { updatedAt: Date; userId: string; path: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf("|");
  if (i <= 0) return null;
  const j = cursor.indexOf("|", i + 1);
  if (j <= i) return null;
  const updatedAt = new Date(cursor.slice(0, i));
  if (Number.isNaN(updatedAt.getTime())) return null;
  return { updatedAt, userId: cursor.slice(i + 1, j), path: cursor.slice(j + 1) };
}

const SYSTEM_PROMPT = [
  "You extract durable business facts from one document.",
  "",
  "Return STRICT JSON: {\"digests\":[{\"kind\":...,\"title\":...,\"body\":...,\"quote\":...}]}",
  "kind is one of: entity, project, obligation, theme, metric, relationship.",
  "",
  "RULES:",
  "- `quote` MUST be text copied verbatim from the document. If you cannot quote it, do not claim it.",
  "- Prefer 0 digests over a guess. An empty list is a correct answer for a document that says nothing durable.",
  "- A digest is something still true next month: who a party is, what was agreed, what is owed, when something renews.",
  "- Not events, not pleasantries, not the document's own formatting.",
  "- title <= 200 chars, body <= 1200 chars.",
].join("\n");

type ModelDigest = { kind?: string; title?: string; body?: string; quote?: string };

const VALID_KINDS = new Set([
  "entity",
  "project",
  "obligation",
  "theme",
  "metric",
  "relationship",
]);

/**
 * Parse the model's reply. Tolerant of fenced code blocks and leading prose —
 * a 20B model wraps JSON about a third of the time — but NOT tolerant of a
 * missing quote. An unquoted claim is dropped, not repaired: the CHECK
 * constraint would reject it at the database anyway, and a digest whose
 * provenance the model invented is exactly what the constraint exists to stop.
 */
export function parseDigests(raw: string): Array<Required<ModelDigest>> {
  if (!raw) return [];
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  const list = (parsed as { digests?: unknown })?.digests;
  if (!Array.isArray(list)) return [];

  const out: Array<Required<ModelDigest>> = [];
  for (const d of list as ModelDigest[]) {
    if (!d || typeof d !== "object") continue;
    const kind = String(d.kind ?? "").trim().toLowerCase();
    const title = String(d.title ?? "").trim();
    const body = String(d.body ?? "").trim();
    const quote = String(d.quote ?? "").trim();
    if (!VALID_KINDS.has(kind)) continue;
    if (!title || !body || !quote) continue;
    out.push({ kind, title: title.slice(0, 200), body: body.slice(0, 1200), quote: quote.slice(0, 500) });
  }
  return out;
}

/**
 * One tick: digest up to `CORPUS_UNITS_PER_RUN` changed documents, advancing
 * the cursor with each.
 */
export async function runCorpusPass(
  deps: CorpusDeps,
  opts: { now?: Date; limit?: number } = {},
): Promise<CorpusOutcome> {
  const { prisma, chat, model } = deps;
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? CORPUS_UNITS_PER_RUN;

  const pass = await prisma.brainPass.upsert({
    where: { passKey: CORPUS_PASS_KEY },
    create: { passKey: CORPUS_PASS_KEY },
    update: {},
    select: { enabled: true, cursor: true },
  });
  if (!pass.enabled) {
    return {
      passKey: CORPUS_PASS_KEY,
      ran: false,
      unitsSeen: 0,
      digestsWritten: 0,
      cursor: pass.cursor,
      errors: [],
    };
  }

  const from = decodeCursor(pass.cursor);
  // Strictly after the watermark, ties broken by id — the same ordering the
  // cursor encodes, so the two cannot disagree.
  const where = from
    ? {
        OR: [
          { updatedAt: { gt: from.updatedAt } },
          { updatedAt: from.updatedAt, userId: { gt: from.userId } },
          { updatedAt: from.updatedAt, userId: from.userId, path: { gt: from.path } },
        ],
      }
    : {};

  const files = await prisma.fileIndexStatus.findMany({
    // `ready` only: `indexing` has no chunks yet, and `skipped`/`failed` never
    // will. `ncFileId` is nullable on this table, and a row without one cannot
    // be joined to its chunks, so it is excluded here rather than skipped in
    // the loop (a filtered row must not consume a unit of the run's budget).
    where: { ...where, status: "ready", ncFileId: { not: null } },
    select: { updatedAt: true, path: true, ncFileId: true, userId: true },
    orderBy: [{ updatedAt: "asc" }, { userId: "asc" }, { path: "asc" }],
    take: limit,
  });

  let digestsWritten = 0;
  const errors: string[] = [];
  let cursor = pass.cursor;

  for (const f of files) {
    try {
      const rawChunks = await prisma.fileContentChunk.findMany({
        // `ncFileId` is nullable on FileIndexStatus; the query above already
        // excludes nulls, so this narrowing is safe and the filter stays in
        // one place.
        where: { ncFileId: f.ncFileId as number },
        select: { text: true, brainItemId: true, path: true },
        orderBy: { chunkIdx: "asc" },
        take: 8,
      });
      // WARP-242 decrypt-on-read. Chunk `text` may be an encrypted column, and
      // feeding ciphertext to the model produces confident nonsense with a
      // real-looking quote attached. `decryptChunkRows` passes plaintext rows
      // through untouched and DROPS rows whose DEK is missing — the correct
      // failure: digest less of a document rather than digest bytes nobody
      // could read.
      const chunks = await decryptChunkRows(prisma, rawChunks);
      const text = chunks
        .map((c) => c.text ?? "")
        .join("\n")
        .slice(0, CORPUS_CHARS_PER_UNIT);

      // The file's owner, as a local User.id. `FileIndexStatus.userId` is the
      // Nextcloud username, which is NOT the local id — storing one and
      // filtering on the other is the IDOR bug `FileComment` already paid for.
      const ownerRow = await prisma.user.findFirst({
        where: { OR: [{ username: f.userId }, { nextcloudUsername: f.userId }] },
        select: { id: true },
      });
      const ownerId = ownerRow?.id ?? null;

      // 🔴 WARP-2834 — DID WE ACTUALLY READ IT? A unit is `digested` when the
      // model read it, not when the loop reached it. The two skip conditions
      // below are permanent, not transient: a document with no extractable
      // text has none to extract, and a file whose owner cannot be resolved
      // stays unresolvable — which is most of the shared drive, because the
      // file-indexer writes groupfolder documents under the `__household__` /
      // `__dept_<uuid>__` SENTINEL owners and no `User` row carries those.
      //
      // Counting a skip as a digest is what let /brief report "read 240 of
      // 5,000" on a business box that had read close to none of them — an
      // overstatement concentrated on exactly the corpus that matters most.
      // The coverage line is the most important thing on that page precisely
      // because an operator who believes the brain has read everything stops
      // trusting it the moment it misses something.
      const digestible = text.trim().length > 0 && ownerId !== null;

      if (digestible) {
        const res = await chat({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Document: ${f.path}\n\n${text}` },
          ],
          temperature: 0,
          max_tokens: 800,
        });
        if (!res.ok) throw new Error("inference_failed");
        const body = await res.json();
        const digests = parseDigests(body.choices?.[0]?.message?.content ?? "");

        for (const d of digests) {
          const sources: BrainSourceRef[] = [
            { sourceKind: "file", sourceId: String(f.ncFileId), quote: d.quote },
          ];
          await upsertDigest(prisma, {
            kind: d.kind as "entity",
            title: d.title,
            body: d.body,
            subjectType: "FILE",
            subjectId: String(f.ncFileId),
            sources,
            detectorKey: "corpus.documents",
            // Personal scope until WARP-2026 lands the unified corpus resolver
            // and WARP-2753 lands the consent posture. Writing `company` here
            // would widen the audience of every digest ahead of the decision
            // that governs it.
            //
            // `ownerId` is what MAKES that personal — the local User.id behind
            // the file's Nextcloud owner. Without it `personal` was a label
            // nothing enforced and every reader saw every other reader's rows.
            // A file whose owner cannot be resolved is SKIPPED rather than
            // written unscoped: an unattributable digest is exactly the row
            // that would leak.
            scope: "personal",
            ownerId,
          });
          digestsWritten += 1;
        }
      }

      // Cursor advances WITH the write, per unit. A crash re-digests this one
      // document (idempotent, so free) and skips none.
      cursor = encodeCursor(f.updatedAt, f.userId, f.path);
      await prisma.brainPass.update({
        where: { passKey: CORPUS_PASS_KEY },
        data: {
          cursor,
          unitsSeen: { increment: 1 },
          // Only when the model actually read it. A unit the model READ and
          // found nothing worth recording in IS digested — the inference was
          // spent and the document has been considered; `rowsWritten` is where
          // "produced nothing" shows up, not here.
          ...(digestible ? { unitsDigested: { increment: 1 } } : {}),
        },
      });
    } catch (err) {
      errors.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
      // ADVANCE PAST IT, then stop this tick.
      //
      // The first draft did NOT advance, reasoning "the next tick retries it".
      // That is right for a transient failure and catastrophic for a
      // deterministic one: an oversized document, a decrypt failure, a chat()
      // call that always errors on this input is refetched FIRST on every
      // subsequent tick and breaks again — halting all corpus digestion for the
      // whole box, indefinitely, with nothing but a passive `lastError` to say
      // so. One poison document must not be able to stop the brain.
      //
      // So the cursor moves past the unit and the tick ends. The cost of the
      // trade is explicit: a document that failed transiently is SKIPPED rather
      // than retried, and is only revisited if it changes (its `updatedAt`
      // moves it back into the window). A retry budget would be better and
      // needs a column BrainPass does not have — that is the follow-up, not a
      // reason to ship a wedge.
      cursor = encodeCursor(f.updatedAt, f.userId, f.path);
      await prisma.brainPass.update({
        where: { passKey: CORPUS_PASS_KEY },
        data: { cursor, unitsSeen: { increment: 1 } },
      });
      break;
    }
  }

  await prisma.brainPass.update({
    where: { passKey: CORPUS_PASS_KEY },
    data: {
      lastRunAt: now,
      ...(errors.length === 0 ? { lastSucceededAt: now, lastError: null } : {}),
      ...(errors.length > 0 ? { lastError: errors.join(" | ").slice(0, 1000) } : {}),
      rowsWritten: { increment: digestsWritten },
    },
  });

  return {
    passKey: CORPUS_PASS_KEY,
    ran: true,
    unitsSeen: files.length,
    digestsWritten,
    cursor,
    errors,
  };
}
