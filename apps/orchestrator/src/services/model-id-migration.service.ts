/**
 * WARP-1749 (ADR-036 Phase 2) — rewrite persisted model ids between the Ollama
 * and DMR vocabularies.
 *
 * NOT WIRED TO ANYTHING THAT RUNS BY ITSELF. Nothing here is imported by
 * `app.ts`, `index.ts`, or any route; the only callers are the
 * `model-id-migrate` CLI and this file's colocated test. The Prisma migration
 * that creates the journal tables adds no rows and no behaviour — so on a box
 * where the operator never runs the command, this entire module is inert.
 *
 * THE THREE SITES, AND WHY ONLY THREE
 * -----------------------------------
 * A model id is persisted in exactly three places (verified by reading every
 * write path, not by grepping for the word "model"):
 *
 *   1. `WorkspaceSetting` where key = `ai.model.chat` — the box's active local
 *      chat model (`active-model.service.ts:27`). One row.
 *   2. `ChatSession.model` (`schema.prisma:154`) — the model a conversation was
 *      started in. Written at `chat-persistence.service.ts:433`.
 *   3. `ChatMessage.model` (`schema.prisma:462`) — WARP-904, the model that
 *      actually served one turn. Written at `chat-persistence.service.ts:505`
 *      and `:521`.
 *
 * Deliberately NOT touched:
 *
 *   - `Camera.model` (:788), `ApDevice.model` (:1592), `FabricMember.model`
 *     (:1739) — hardware model names. Same column name, unrelated vocabulary.
 *   - `ActivityRow` audit rows, including the `previousModel`/`nextModel` refs
 *     that `routes/models.ts:177-182` writes. An audit log records what
 *     happened; rewriting history to match a later decision is the one thing an
 *     audit trail must never do.
 *   - Redis benchmark cache (`benchCacheKey`,
 *     `model-benchmark.service.ts:46`). It is a TTL'd cache, not state: after a
 *     flip the key simply misses and the card shows "—" until the operator
 *     re-measures. Documented in the runbook, not migrated.
 *   - `LLM_MODEL` / `VISION_MODEL` in `.env`. Operator-owned configuration, and
 *     the flip is meant to be an `.env` edit the operator makes deliberately.
 *     `planEnvAdvisories` below REPORTS what those values would become; it
 *     never writes the file.
 *   - Embeddings. `EMBEDDING_MODEL` defaults to `all-MiniLM-L6-v2`
 *     (`services/file-indexer/config.py:47`) and is served by ai-gateway's own
 *     sentence-transformers, not by Ollama (`providers/embeddings.py:18`). DMR
 *     never serves it, so no pgvector row needs re-embedding. This is the
 *     single largest thing that is NOT in the blast radius, and it is worth
 *     stating explicitly.
 */
import type { PrismaClient } from "@prisma/client";
import { ACTIVE_CHAT_MODEL_KEY } from "./active-model.service.js";
import { classifyModelId, type ModelIdClassification } from "./model-id-map.js";

/** Which table a stored id came from. */
export type MigrationSite = "workspace_setting" | "chat_session" | "chat_message";

/** One persisted model id, located precisely enough to write back. */
export interface StoredModelId {
  readonly site: MigrationSite;
  /** Row primary key, or the WorkspaceSetting `key`. */
  readonly rowKey: string;
  /** `valueJson` (workspace_setting) or `model` (the two chat tables). */
  readonly column: "valueJson" | "model";
  readonly value: string;
}

/** A row the forward migration would rewrite. */
export interface PlannedChange {
  readonly site: MigrationSite;
  readonly rowKey: string;
  readonly column: "valueJson" | "model";
  readonly before: string;
  readonly after: string;
  readonly evidence: string;
}

/** A value left alone, with the reason, so the report can be honest. */
export interface UntouchedValue {
  readonly site: MigrationSite;
  readonly rowKey: string;
  readonly value: string;
  readonly reason: string;
}

export interface MigrationPlan {
  readonly changes: readonly PlannedChange[];
  /** Already an OCI target id — proof that a second run is a no-op. */
  readonly alreadyMigrated: readonly UntouchedValue[];
  /** Configured models DMR has no equivalent for. Loud, never rewritten. */
  readonly blocked: readonly UntouchedValue[];
  /** Everything else, incl. customer-pulled models. Left ALONE. */
  readonly unknown: readonly UntouchedValue[];
  /** Blank values (the `ai.model.chat` seed `""`). Counted, not listed. */
  readonly skipped: number;
}

// ── collection ───────────────────────────────────────────────────────────

/**
 * Page size for the two chat tables. `ChatMessage` is the only table here that
 * can plausibly reach six figures on a long-lived box.
 */
const PAGE_SIZE = 1000;

/**
 * Hard cap on pages, so a pathological cursor can never spin forever. At
 * PAGE_SIZE=1000 this is 10M rows — orders of magnitude beyond any real
 * appliance, and it fails LOUDLY rather than looping (no `while (true)`
 * anywhere: the loop is a bounded `for` and every exit is explicit).
 */
const MAX_PAGES = 10_000;

interface ModelRow {
  id: string;
  model: string | null;
}

/** Cursor-paged read of one chat table. Explicitly bounded. */
async function collectChatTable(
  site: "chat_session" | "chat_message",
  findMany: (args: {
    where: { model: { not: null } };
    select: { id: true; model: true };
    orderBy: { id: "asc" };
    take: number;
    cursor?: { id: string };
    skip?: number;
  }) => Promise<ModelRow[]>,
): Promise<StoredModelId[]> {
  const out: StoredModelId[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await findMany({
      where: { model: { not: null } },
      select: { id: true, model: true },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const row of rows) {
      if (row.model == null) continue;
      out.push({ site, rowKey: row.id, column: "model", value: row.model });
    }
    // Explicit terminal condition — a short page is the last page.
    if (rows.length < PAGE_SIZE) return out;
    cursor = rows[rows.length - 1]!.id;
  }

  throw new Error(
    `model-id-migration: ${site} exceeded ${MAX_PAGES} pages of ${PAGE_SIZE} — refusing to continue rather than loop`,
  );
}

/** Read every persisted model id from the three sites. Read-only. */
export async function collectStoredModelIds(prisma: PrismaClient): Promise<StoredModelId[]> {
  const out: StoredModelId[] = [];

  const setting = await prisma.workspaceSetting.findUnique({
    where: { key: ACTIVE_CHAT_MODEL_KEY },
    select: { valueJson: true },
  });
  // `valueJson` is a Json column holding a bare string (routes/models.ts:160).
  // Anything else (an object someone hand-wrote) is not a model id and is left
  // for the `unknown` bucket rather than coerced.
  if (typeof setting?.valueJson === "string") {
    out.push({
      site: "workspace_setting",
      rowKey: ACTIVE_CHAT_MODEL_KEY,
      column: "valueJson",
      value: setting.valueJson,
    });
  }

  out.push(
    ...(await collectChatTable("chat_session", (args) =>
      prisma.chatSession.findMany(args as never) as Promise<ModelRow[]>,
    )),
  );
  out.push(
    ...(await collectChatTable("chat_message", (args) =>
      prisma.chatMessage.findMany(args as never) as Promise<ModelRow[]>,
    )),
  );

  return out;
}

// ── planning (pure) ──────────────────────────────────────────────────────

function reasonFor(c: ModelIdClassification): string {
  switch (c.kind) {
    case "already":
      return `already an OCI id (${c.oci})`;
    case "blocked":
      return c.reason;
    case "unknown":
      return "not a model this appliance configures — left exactly as-is";
    default:
      return "";
  }
}

/**
 * Pure: stored values in, plan out. No Prisma, no clock, no env.
 *
 * This is the whole decision, and it is the thing the tests drive. `--report`
 * prints exactly this and stops.
 */
export function planForwardMigration(stored: readonly StoredModelId[]): MigrationPlan {
  const changes: PlannedChange[] = [];
  const alreadyMigrated: UntouchedValue[] = [];
  const blocked: UntouchedValue[] = [];
  const unknown: UntouchedValue[] = [];
  let skipped = 0;

  for (const row of stored) {
    const c = classifyModelId(row.value);
    switch (c.kind) {
      case "skip":
        skipped++;
        break;
      case "rewrite":
        changes.push({
          site: row.site,
          rowKey: row.rowKey,
          column: row.column,
          before: row.value,
          after: c.oci,
          evidence: c.evidence,
        });
        break;
      case "already":
        alreadyMigrated.push({
          site: row.site,
          rowKey: row.rowKey,
          value: row.value,
          reason: reasonFor(c),
        });
        break;
      case "blocked":
        blocked.push({
          site: row.site,
          rowKey: row.rowKey,
          value: row.value,
          reason: reasonFor(c),
        });
        break;
      case "unknown":
        unknown.push({
          site: row.site,
          rowKey: row.rowKey,
          value: row.value,
          reason: reasonFor(c),
        });
        break;
    }
  }

  return { changes, alreadyMigrated, blocked, unknown, skipped };
}

/**
 * Advisory only: what the operator's `.env` model vars would have to become.
 * Reads `process.env`, writes nothing, and is never part of apply.
 */
export interface EnvAdvisory {
  readonly variable: string;
  readonly current: string;
  readonly classification: ModelIdClassification;
}

export function planEnvAdvisories(
  env: NodeJS.ProcessEnv = process.env,
): readonly EnvAdvisory[] {
  const out: EnvAdvisory[] = [];
  for (const variable of ["LLM_MODEL", "VISION_MODEL", "DEFAULT_MODEL"] as const) {
    const current = (env[variable] ?? "").trim();
    if (!current) continue;
    out.push({ variable, current, classification: classifyModelId(current) });
  }
  return out;
}

// ── apply (forward) ──────────────────────────────────────────────────────

export interface ApplyResult {
  /** Null when the plan had nothing to do — no empty batch is recorded. */
  readonly batchId: string | null;
  readonly changed: number;
}

/**
 * Apply a forward plan inside ONE transaction, journaling every rewrite.
 *
 * IDEMPOTENT BY CONSTRUCTION, not by a guard flag: the plan is computed from
 * the values the rows hold RIGHT NOW, so a second run classifies them as
 * `already` and produces zero changes — at which point this returns without
 * creating a batch at all. There is no "has it run?" boolean to get out of sync
 * with reality.
 */
export async function applyForwardMigration(
  prisma: PrismaClient,
  plan: MigrationPlan,
  note?: string,
): Promise<ApplyResult> {
  if (plan.changes.length === 0) return { batchId: null, changed: 0 };

  return prisma.$transaction(async (tx) => {
    const batch = await tx.modelIdMigrationBatch.create({
      data: { direction: "forward", state: "applied", note: note ?? null },
      select: { id: true },
    });

    for (const change of plan.changes) {
      await writeValue(tx, change.site, change.rowKey, change.after);
      await tx.modelIdMigrationEntry.create({
        data: {
          batchId: batch.id,
          site: change.site,
          rowKey: change.rowKey,
          column: change.column,
          beforeValue: change.before,
          afterValue: change.after,
        },
      });
    }

    return { batchId: batch.id, changed: plan.changes.length };
  });
}

// ── rollback (backward) ──────────────────────────────────────────────────

export interface RollbackEntry {
  readonly site: MigrationSite;
  readonly rowKey: string;
  readonly column: "valueJson" | "model";
  readonly restoreTo: string;
  readonly expectCurrent: string;
}

export interface RollbackPlan {
  /** Null when there is no applied forward batch — rollback is then a no-op. */
  readonly forwardBatchId: string | null;
  readonly entries: readonly RollbackEntry[];
}

/**
 * The most recent forward batch still in state `applied`, and what undoing it
 * would restore. Reads only.
 *
 * State comes off the explicit `state` column — never from "no later backward
 * row exists", which would be exactly the derived-state pattern CLAUDE.md
 * rule 10 forbids.
 */
export async function planRollback(prisma: PrismaClient): Promise<RollbackPlan> {
  const batch = await prisma.modelIdMigrationBatch.findFirst({
    where: { direction: "forward", state: "applied" },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (!batch) return { forwardBatchId: null, entries: [] };

  const entries = await prisma.modelIdMigrationEntry.findMany({
    where: { batchId: batch.id },
    select: { site: true, rowKey: true, column: true, beforeValue: true, afterValue: true },
  });

  return {
    forwardBatchId: batch.id,
    entries: entries.map((e) => ({
      site: e.site as MigrationSite,
      rowKey: e.rowKey,
      column: e.column as "valueJson" | "model",
      restoreTo: e.beforeValue,
      expectCurrent: e.afterValue,
    })),
  };
}

export interface RollbackResult {
  readonly batchId: string | null;
  readonly restored: number;
  /**
   * Entries whose row no longer holds the value the forward run wrote —
   * somebody changed it in between. SKIPPED, never overwritten, and returned so
   * the operator sees them.
   */
  readonly skippedDrifted: readonly RollbackEntry[];
}

/**
 * Undo a forward batch. Safe to run twice: the first run flips the forward
 * batch's `state` to `reverted`, so the second finds no applied forward batch
 * and returns `{ batchId: null, restored: 0 }`.
 *
 * The revert is itself journaled as a `backward` batch (born `applied`, never
 * reverted) so the box can answer "what happened here, and in what order".
 */
export async function applyRollback(
  prisma: PrismaClient,
  plan: RollbackPlan,
  note?: string,
): Promise<RollbackResult> {
  // Bound to a const so the narrowing survives into the transaction closure —
  // TypeScript re-widens a property read across a callback boundary.
  const forwardBatchId = plan.forwardBatchId;
  if (!forwardBatchId) return { batchId: null, restored: 0, skippedDrifted: [] };

  return prisma.$transaction(async (tx) => {
    const batch = await tx.modelIdMigrationBatch.create({
      data: {
        direction: "backward",
        state: "applied",
        revertsBatchId: forwardBatchId,
        note: note ?? null,
      },
      select: { id: true },
    });

    const skippedDrifted: RollbackEntry[] = [];
    let restored = 0;

    for (const entry of plan.entries) {
      const current = await readValue(tx, entry.site, entry.rowKey);
      // Verify before restoring. A row somebody re-pointed by hand after the
      // migration must not be silently dragged back to a value they replaced.
      if (current !== entry.expectCurrent) {
        skippedDrifted.push(entry);
        continue;
      }
      await writeValue(tx, entry.site, entry.rowKey, entry.restoreTo);
      await tx.modelIdMigrationEntry.create({
        data: {
          batchId: batch.id,
          site: entry.site,
          rowKey: entry.rowKey,
          column: entry.column,
          beforeValue: entry.expectCurrent,
          afterValue: entry.restoreTo,
        },
      });
      restored++;
    }

    await tx.modelIdMigrationBatch.update({
      where: { id: forwardBatchId },
      data: { state: "reverted" },
    });

    return { batchId: batch.id, restored, skippedDrifted };
  });
}

// ── row access ───────────────────────────────────────────────────────────
//
// One reader and one writer, so the three sites cannot drift into three
// different notions of "the model column".
//
// Neither takes a `column` argument: the site DETERMINES the column
// (`workspace_setting` → `valueJson`, both chat tables → `model`). Passing it
// as well would let a caller ask for a combination that does not exist. The
// journal still records the column, because a journal describes what happened
// rather than deciding it.

/** Minimal transactional surface — keeps the helpers testable with a stub. */
type Tx = Pick<PrismaClient, "workspaceSetting" | "chatSession" | "chatMessage">;

async function readValue(
  tx: Tx,
  site: MigrationSite,
  rowKey: string,
): Promise<string | null> {
  if (site === "workspace_setting") {
    const row = await tx.workspaceSetting.findUnique({
      where: { key: rowKey },
      select: { valueJson: true },
    });
    return typeof row?.valueJson === "string" ? row.valueJson : null;
  }
  if (site === "chat_session") {
    const row = await tx.chatSession.findUnique({ where: { id: rowKey }, select: { model: true } });
    return row?.model ?? null;
  }
  const row = await tx.chatMessage.findUnique({ where: { id: rowKey }, select: { model: true } });
  return row?.model ?? null;
}

async function writeValue(
  tx: Tx,
  site: MigrationSite,
  rowKey: string,
  value: string,
): Promise<void> {
  if (site === "workspace_setting") {
    // `update`, never `upsert`: this command only ever rewrites a row that the
    // collection pass already saw. Creating one would invent an active-model
    // choice for a box that never made one.
    await tx.workspaceSetting.update({
      where: { key: rowKey },
      data: { valueJson: value as never },
    });
    return;
  }
  if (site === "chat_session") {
    await tx.chatSession.update({ where: { id: rowKey }, data: { model: value } });
    return;
  }
  await tx.chatMessage.update({ where: { id: rowKey }, data: { model: value } });
}
