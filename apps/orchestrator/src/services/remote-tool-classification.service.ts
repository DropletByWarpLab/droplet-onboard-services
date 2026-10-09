/**
 * WARP-2426 (ADR-043 §2, ADR-056 I4) — the operator-owned classification
 * record for tools this box did not author, and the call policy that reads it.
 *
 * ## The one rule
 *
 * Every tool a remote server advertises lands in `RemoteToolClassification`
 * as a CONFIRMING WRITE — `requiresWrite: true, requiresConfirmation: true,
 * denied: false` — through {@link recordDiscoveredRemoteTools}, which is the
 * ONLY code path that creates a row (`remote-tool-classification.import-paths`
 * test enumerates the tree and says so). It does not read the wire's
 * `readOnlyHint`, its name, or its description: a server can call a tool
 * `search_issues` and thereby choose its own privilege level, and this record
 * is what refuses to let it. The default costs a click; the other direction
 * costs data.
 *
 * ## Who may change a row
 *
 * A person, through {@link classifyRemoteTool} — the owner route's service —
 * which stamps `reviewedBy` / `reviewedAt`. Re-discovery on a later attach
 * touches `lastSeenAt` and the recorded wire description and NOTHING else, so
 * a demotion survives every reconnect.
 *
 * WARP-2900 — with ONE exception, for a caller that knows the tool's input
 * schema (a promoted extension; the Atlassian attach sends none). What a
 * person reviewed is the tool's description AND its arguments, so the row
 * keeps {@link remoteToolReviewHash} of the two (in the `inputSchemaHash`
 * column). A tool whose description or schema CHANGED is a different tool
 * under an old name: a person reviewed what it used to say and take, not
 * what it says and takes now (review #2325: a description change reset
 * nothing). So it goes back to {@link IMPORT_DEFAULT_CLASSIFICATION} with
 * the review cleared, and a review sent with the hash it was shown is a
 * STALE_REVIEW. The same name, description and schema keep their review
 * across a version bump. An operator's BLOCK is never lifted by a reset:
 * `denied` stays, with the reviewer who set it. An unconfirmed write
 * (`requiresWrite: true, requiresConfirmation: false`) is not expressible
 * through any writer: the service refuses it.
 *
 * WARP-3918 extends that pin to EVERY server. The bridge (the only component
 * that sees the wire object, `annotations` included) sends a sha256 of each
 * tool's canonical name, description, input schema and annotations; the
 * attach path passes it as `inputSchemaHash`, so this same mechanism applies.
 * Because a curated server's compiled table ALLOWS a tool regardless of the
 * record, a reset also sets the explicit `definitionStatus: CHANGED`, which
 * dispatch refuses ahead of the table, until a person classifies the tool
 * again. Rows recorded before the pin (no stored hash) are baselined once
 * (`baselineUnpinned`) instead of reset, so an upgrade does not take every
 * reviewed Atlassian read offline.
 *
 * ## What the record decides at dispatch
 *
 * {@link createRecordBackedRemoteCallPolicy} is a {@link RemoteCallPolicy}:
 *
 *   - no row            → `REMOTE_TOOL_NOT_CLASSIFIED` (never seen; deny)
 *   - `denied`          → `REMOTE_TOOL_DENIED` (an operator blocked it; deny)
 *   - definition CHANGED → `REMOTE_TOOL_DEFINITION_CHANGED` (WARP-3918: the
 *                          pinned wire definition moved since a person
 *                          reviewed it; deny, for curated and owner-added
 *                          servers alike, until classified again)
 *   - `requiresWrite`   → `REMOTE_WRITE_NOT_PERMITTED` — ADR-043 §3 still
 *                          holds: a remote write may not run until the
 *                          interceptor can confirm a RUNTIME tool, which is
 *                          WARP-2321's remaining half. The confirming-write
 *                          default therefore DENIES today, by design.
 *   - reviewed read     → allow.
 *
 * {@link composeRemoteCallPolicy} layers it over a compiled table (today the
 * Atlassian one): the record's DENY always wins; the record's read-ALLOW fills
 * only the table's holes (`REMOTE_TOOL_NOT_CLASSIFIED`) and never overrides a
 * table's write-block — the reviewed JSON is a floor, not a suggestion.
 *
 * Policies are synchronous and the record is in Postgres, so the policy reads
 * a {@link RemoteToolClassificationCache} the attach path and the owner route
 * refresh. A stale cache errs closed: a row that does not exist in the cache
 * is "not classified", never "allowed".
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../lib/logger.js";
import {
  DENY_ALL_REMOTE_TOOLS,
  namespacedToolName,
  parseNamespacedToolName,
  type RemoteCallDecision,
  type RemoteCallPolicy,
} from "./mcp-multiplexer.service.js";

const logger = createLogger("remote-tool-classification");

/**
 * What a newly discovered remote tool IS, before any person has looked at it.
 * Frozen: the mutation the ticket names as its most valuable is flipping
 * `requiresWrite` here, and the import test goes red when it happens.
 */
export const IMPORT_DEFAULT_CLASSIFICATION = Object.freeze({
  requiresWrite: true,
  requiresConfirmation: true,
  denied: false,
});

/** Refusal codes. Machine-readable; callers switch on these, never on prose. */
export const RECORD_DENY_CODES = {
  notClassified: "REMOTE_TOOL_NOT_CLASSIFIED",
  denied: "REMOTE_TOOL_DENIED",
  writeBlocked: "REMOTE_WRITE_NOT_PERMITTED",
  definitionChanged: "REMOTE_TOOL_DEFINITION_CHANGED",
} as const;

export interface RemoteToolClassificationRow {
  serverId: string;
  toolName: string;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
  denied: boolean;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  wireDescription: string | null;
  /**
   * WARP-2900 — {@link remoteToolReviewHash} of the description and the
   * input-schema hash last discovered: what a review covers. Null when the
   * caller sent no schema hash.
   */
  inputSchemaHash?: string | null;
  /**
   * WARP-3918 — CHANGED when the pinned definition no longer matches the one a
   * person reviewed; refused at dispatch (every server) until re-classified.
   * Absent is CURRENT (fixtures built before the column).
   */
  definitionStatus?: "CURRENT" | "CHANGED";
  definitionChangedAt?: Date | null;
  /** What the review screen (WARP-2430) diffs against; set at the first change. */
  previousReviewHash?: string | null;
  previousWireDescription?: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface DiscoveredRemoteTool {
  /** The WIRE name — what the server calls it, before namespacing. */
  wireName: string;
  /**
   * Recorded for the operator; never read as a privilege claim. With an
   * `inputSchemaHash` it is also part of what a review covers (the header).
   */
  description?: string;
  /**
   * WARP-2900 — sha256 of the tool's canonical inputSchema. When present,
   * the row keeps {@link remoteToolReviewHash} of it and the description,
   * and a row whose stored hash differs is reset to the import default (see
   * the header). Absent → the row's classification is never touched.
   */
  inputSchemaHash?: string;
}

/**
 * sha256 hex over what a person reviews of a tool: its description (absent
 * is not the empty string) and its input-schema hash. Stored in the row's
 * `inputSchemaHash` column, and what a review sends back as the hash it was
 * shown.
 */
export function remoteToolReviewHash(description: string | undefined, inputSchemaHash: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ description: description ?? null, inputSchemaHash }), "utf8")
    .digest("hex");
}

/** The one Prisma surface this module needs; typed narrowly so tests can hand
 *  in a map-backed fake without faking the whole client. */
export type ClassificationPrisma = Pick<PrismaClient, "remoteToolClassification">;

/**
 * THE import path. Upserts one row per discovered tool: a row that does not
 * exist is created as {@link IMPORT_DEFAULT_CLASSIFICATION}; a row that does
 * gets `lastSeenAt` and the wire description refreshed and nothing else —
 * unless the caller sent an input-schema hash that differs from the stored
 * one, which resets the classification (WARP-2900, see the header).
 *
 * Returns the names it created and the names it reset, so the attach path
 * can log "N new tools, all confirming writes" — an operator surface's
 * honest first line.
 */
export async function recordDiscoveredRemoteTools(
  prisma: ClassificationPrisma,
  serverId: string,
  tools: readonly DiscoveredRemoteTool[],
  now: Date = new Date(),
  /**
   * WARP-3918 — `baselineUnpinned`: a row with NO stored hash (recorded before
   * the definition pin existed) adopts the hash it is first seen with instead
   * of being reset. The vendor attach sets it so the first boot after the
   * upgrade does not take every reviewed Atlassian read offline; the `ext-*`
   * attach does not (its rows have always carried a hash).
   */
  opts: { baselineUnpinned?: boolean } = {},
): Promise<{
  created: string[];
  seen: number;
  reset: string[];
  /** WARP-3918 — per reset tool, whether its description is what changed
   *  (otherwise its schema or annotations), for the owners' notice. */
  changes: { toolName: string; descriptionChanged: boolean }[];
}> {
  const created: string[] = [];
  const reset: string[] = [];
  const changes: { toolName: string; descriptionChanged: boolean }[] = [];
  for (const tool of tools) {
    const wireDescription = tool.description?.slice(0, 2000) ?? null;
    const before = (await prisma.remoteToolClassification.findUnique({
      where: { serverId_toolName: { serverId, toolName: tool.wireName } },
      select: {
        id: true,
        denied: true,
        inputSchemaHash: true,
        wireDescription: true,
        definitionStatus: true,
      },
    })) as {
      id: string;
      denied: boolean;
      inputSchemaHash: string | null;
      wireDescription: string | null;
      definitionStatus?: "CURRENT" | "CHANGED";
    } | null;
    // The description and the arguments together: a person reviewed both.
    const hash = tool.inputSchemaHash === undefined ? undefined : remoteToolReviewHash(tool.description, tool.inputSchemaHash);
    const baselined =
      opts.baselineUnpinned === true && before !== null && hash !== undefined && (before.inputSchemaHash ?? null) === null;
    const schemaChanged = before !== null && hash !== undefined && before.inputSchemaHash !== hash && !baselined;
    await prisma.remoteToolClassification.upsert({
      where: { serverId_toolName: { serverId, toolName: tool.wireName } },
      create: {
        serverId,
        toolName: tool.wireName,
        ...IMPORT_DEFAULT_CLASSIFICATION,
        wireDescription,
        ...(hash !== undefined ? { inputSchemaHash: hash } : {}),
        firstSeenAt: now,
        lastSeenAt: now,
      },
      // Only the "seen" facts — a reconnect must not undo a person's
      // decision — unless the arguments the person reviewed are gone.
      update: schemaChanged
        ? {
            lastSeenAt: now,
            wireDescription,
            inputSchemaHash: hash,
            // WARP-3918 — the explicit flag dispatch refuses on (a curated
            // table's allow cannot see a reset), and what a review screen
            // diffs against. A second change before re-review keeps the
            // FIRST previous: that is what a person last reviewed.
            definitionStatus: "CHANGED",
            definitionChangedAt: now,
            ...(before.definitionStatus === "CHANGED"
              ? {}
              : { previousReviewHash: before.inputSchemaHash, previousWireDescription: before.wireDescription }),
            // A block is final: the reset re-opens a review, it never
            // unblocks a tool (nor forgets who blocked it).
            ...(before.denied
              ? {}
              : {
                  requiresWrite: IMPORT_DEFAULT_CLASSIFICATION.requiresWrite,
                  requiresConfirmation: IMPORT_DEFAULT_CLASSIFICATION.requiresConfirmation,
                  reviewedBy: null,
                  reviewedAt: null,
                }),
          }
        : baselined
          ? { lastSeenAt: now, wireDescription, inputSchemaHash: hash }
          : { lastSeenAt: now, wireDescription },
    });
    if (!before) created.push(tool.wireName);
    else if (schemaChanged) {
      reset.push(tool.wireName);
      changes.push({ toolName: tool.wireName, descriptionChanged: before.wireDescription !== wireDescription });
    }
  }
  logger.info(
    { serverId, seen: tools.length, created: created.length, reset: reset.length },
    "remote_tools_recorded_as_confirming_writes",
  );
  return { created, seen: tools.length, reset, changes };
}

export interface ClassifyRemoteToolInput {
  serverId: string;
  toolName: string;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
  denied: boolean;
  /** The person deciding. Required — an anonymous demotion is not a review. */
  reviewedBy: string;
  /**
   * WARP-2900 — the input-schema hash of the tool the person was SHOWN. When
   * sent, the review lands only while the row still has that hash: a
   * re-discovery that changed the schema (and so reset the review) between
   * the person reading the tool and deciding is a STALE_REVIEW, never a
   * review of arguments they did not see. Omitted: today's behaviour.
   */
  expectedInputSchemaHash?: string;
}

export type ClassifyRemoteToolResult =
  | { ok: true; row: RemoteToolClassificationRow }
  | { ok: false; code: "NOT_FOUND" | "NO_REVIEWER" | "UNCONFIRMED_WRITE" | "STALE_REVIEW"; message: string };

/**
 * A person's classification of one tool. Refuses:
 *   - a tool never discovered (there is nothing to classify; a row invented
 *     here would be a tool the box has never seen advertised);
 *   - an empty reviewer;
 *   - `requiresWrite: true` with `requiresConfirmation: false` — the one
 *     combination no writer may produce (ADR-043 §3).
 */
export async function classifyRemoteTool(
  prisma: ClassificationPrisma,
  input: ClassifyRemoteToolInput,
  now: Date = new Date(),
): Promise<ClassifyRemoteToolResult> {
  const reviewedBy = input.reviewedBy.trim();
  if (!reviewedBy) {
    return { ok: false, code: "NO_REVIEWER", message: "A classification needs a reviewer." };
  }
  if (input.requiresWrite && !input.requiresConfirmation) {
    return {
      ok: false,
      code: "UNCONFIRMED_WRITE",
      message: "A remote write always asks first; requiresWrite without requiresConfirmation is not a state.",
    };
  }
  const existing = await prisma.remoteToolClassification.findUnique({
    where: { serverId_toolName: { serverId: input.serverId, toolName: input.toolName } },
    select: { id: true },
  });
  if (!existing) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `${input.serverId} has never advertised a tool named ${input.toolName}.`,
    };
  }
  const data = {
    requiresWrite: input.requiresWrite,
    requiresConfirmation: input.requiresConfirmation,
    denied: input.denied,
    reviewedBy,
    reviewedAt: now,
    // WARP-3918 — a person classifying the tool is the re-review: the pinned
    // definition is now the one they saw (the optional expected hash above is
    // what makes that true under a race).
    definitionStatus: "CURRENT" as const,
    definitionChangedAt: null,
    previousReviewHash: null,
    previousWireDescription: null,
  };
  let row: RemoteToolClassificationRow;
  if (input.expectedInputSchemaHash !== undefined) {
    // The hash in the WHERE: one statement, so a reset that lands between
    // the read above and this write still wins.
    const u = await prisma.remoteToolClassification.updateMany({
      where: { serverId: input.serverId, toolName: input.toolName, inputSchemaHash: input.expectedInputSchemaHash },
      data,
    });
    if (u.count === 0) {
      return {
        ok: false,
        code: "STALE_REVIEW",
        message:
          `${input.serverId}'s ${input.toolName} has changed its arguments since it was shown to you; ` +
          "its review was reset. Reload it and review the new arguments.",
      };
    }
    row = (await prisma.remoteToolClassification.findUnique({
      where: { serverId_toolName: { serverId: input.serverId, toolName: input.toolName } },
    })) as RemoteToolClassificationRow;
  } else {
    row = (await prisma.remoteToolClassification.update({
      where: { serverId_toolName: { serverId: input.serverId, toolName: input.toolName } },
      data,
    })) as RemoteToolClassificationRow;
  }
  logger.info(
    {
      serverId: row.serverId,
      toolName: row.toolName,
      requiresWrite: row.requiresWrite,
      requiresConfirmation: row.requiresConfirmation,
      denied: row.denied,
      reviewedBy,
    },
    "remote_tool_classified",
  );
  return { ok: true, row };
}

export async function listRemoteToolClassifications(
  prisma: ClassificationPrisma,
  serverId?: string,
): Promise<RemoteToolClassificationRow[]> {
  return (await prisma.remoteToolClassification.findMany({
    ...(serverId ? { where: { serverId } } : {}),
    orderBy: [{ serverId: "asc" }, { toolName: "asc" }],
  })) as RemoteToolClassificationRow[];
}

/** `(serverId, toolName)` → row, for the synchronous policy. */
export type ClassificationLookup = (serverId: string, toolName: string) => RemoteToolClassificationRow | undefined;

/**
 * WARP-3918 — the live definition of a tool. `tracked: false`: this server
 * reports no definition hashes (an `ext-*` extension), nothing to compare.
 * Tracked with no `hash`: the latest listing carried none for this tool.
 */
export type LiveDefinitionLookup = (
  serverId: string,
  toolName: string,
) => { tracked: false } | { tracked: true; hash: string | undefined };

function key(serverId: string, toolName: string): string {
  return `${serverId} ${toolName}`;
}

/**
 * The in-memory snapshot the policy reads. Refreshed by the attach path (the
 * rows just recorded) and by the owner route (the row just changed). Errs
 * closed: anything not in the snapshot is "not classified".
 */
export class RemoteToolClassificationCache {
  #rows = new Map<string, RemoteToolClassificationRow>();

  async refresh(prisma: ClassificationPrisma): Promise<number> {
    const rows = await listRemoteToolClassifications(prisma);
    this.#rows = new Map(rows.map((r) => [key(r.serverId, r.toolName), r]));
    return rows.length;
  }

  /** Test hook — seed without a database. */
  seed(rows: readonly RemoteToolClassificationRow[]): void {
    this.#live = new Map(); // a seeded snapshot starts with no live listing
    this.#rows = new Map(rows.map((r) => [key(r.serverId, r.toolName), r]));
  }

  lookup: ClassificationLookup = (serverId, toolName) => this.#rows.get(key(serverId, toolName));

  /**
   * WARP-3918 — the review hash of each tool as the server's LATEST listing
   * defined it (wire name → {@link remoteToolReviewHash}), held in memory.
   * This, not the database write that records a change, is what dispatch
   * compares against the reviewed hash: a write that failed cannot leave a
   * changed tool callable. Replaced wholesale on every listing.
   */
  #live = new Map<string, ReadonlyMap<string, string>>();

  setLiveDefinitions(serverId: string, hashes: ReadonlyMap<string, string>): void {
    this.#live.set(serverId, hashes);
  }

  liveDefinition: LiveDefinitionLookup = (serverId, toolName) => {
    const m = this.#live.get(serverId);
    return m ? { tracked: true, hash: m.get(toolName) } : { tracked: false };
  };

  /**
   * WARP-2436 — is this NAMESPACED remote tool name classified a write right
   * now? Read straight off the snapshot: no copy of the answer is kept, so a
   * demotion the owner route just refreshed is the very next answer.
   */
  isWrite(namespacedName: string): boolean {
    const parsed = parseNamespacedToolName(namespacedName);
    return parsed !== null && this.#rows.get(key(parsed.serverId, parsed.wireName))?.requiresWrite === true;
  }

  /** The namespaced names of every row currently classified a write. */
  writeNames(): string[] {
    return [...this.#rows.values()]
      .filter((r) => r.requiresWrite)
      .map((r) => namespacedToolName(r.serverId, r.toolName));
  }

  get size(): number {
    return this.#rows.size;
  }
}

/** The process-wide snapshot the singleton's policy reads. */
export const remoteToolClassificationCache = new RemoteToolClassificationCache();

function definitionChangedDecision(namespacedName: string): RemoteCallDecision {
  return {
    kind: "deny",
    code: RECORD_DENY_CODES.definitionChanged,
    message:
      `'${namespacedName}' changed its description, arguments or hints since it was last reviewed, ` +
      "so it is switched off until an owner reviews it again. Do not retry; answer without it.",
  };
}

/** The decision for one row (or none) — separated so a surface can render it. */
export function decideFromRecord(
  row: RemoteToolClassificationRow | undefined,
  namespacedName: string,
): RemoteCallDecision {
  if (!row) {
    return {
      kind: "deny",
      code: RECORD_DENY_CODES.notClassified,
      message:
        `'${namespacedName}' has never been advertised to this box, so no operator has classified it. ` +
        "Do not retry; answer without it.",
    };
  }
  if (row.denied) {
    return {
      kind: "deny",
      code: RECORD_DENY_CODES.denied,
      message: `'${namespacedName}' is blocked on this box by its operator. Do not retry; answer without it.`,
    };
  }
  if (row.definitionStatus === "CHANGED") return definitionChangedDecision(namespacedName);
  if (row.requiresWrite) {
    return {
      kind: "deny",
      code: RECORD_DENY_CODES.writeBlocked,
      message:
        `'${namespacedName}' is classified as a write, and remote writes are not permitted from this box (ADR-043 §3). ` +
        "Do not retry; answer without it.",
    };
  }
  return { kind: "allow" };
}

/** A policy that reads ONLY the record. The whole authority for a server no
 *  compiled table speaks for. */
export function createRecordBackedRemoteCallPolicy(lookup: ClassificationLookup): RemoteCallPolicy {
  return (input) => decideFromRecord(lookup(input.serverId, input.wireName), input.namespacedName);
}

/**
 * The record layered over a compiled table:
 *   1. the record's `denied` wins over everything — an operator's block is
 *      final whatever a JSON reviewed months ago says;
 *   2. the table's allow stands;
 *   3. the record's reviewed read fills a table HOLE (`REMOTE_TOOL_NOT_CLASSIFIED`)
 *      and nothing else — a table's write-block cannot be demoted around;
 *   4. otherwise the table's own refusal, with its own honest code.
 */
export function composeRemoteCallPolicy(opts: {
  lookup: ClassificationLookup;
  table?: RemoteCallPolicy;
  /**
   * WARP-3918 — the FAIL-CLOSED pin. For a server that reports definition
   * hashes, an ALLOW stands only while the tool's live hash (latest listing,
   * in memory) equals the hash stored on its reviewed row. Mismatch, no live
   * hash, no stored hash, or no row: refused. Independent of whether the
   * database write that records a change succeeded.
   */
  live?: LiveDefinitionLookup;
}): RemoteCallPolicy {
  const table = opts.table ?? DENY_ALL_REMOTE_TOOLS;
  const decide: RemoteCallPolicy = (input) => {
    const row = opts.lookup(input.serverId, input.wireName);
    // WARP-3918 — a CHANGED definition beats the table's allow too: the table
    // vouched for the tool as it was reviewed, not for what it says now.
    if (row?.denied || row?.definitionStatus === "CHANGED") return decideFromRecord(row, input.namespacedName);
    const base = table(input);
    if (base.kind === "allow") return base;
    if (base.code === RECORD_DENY_CODES.notClassified && row) {
      const fromRecord = decideFromRecord(row, input.namespacedName);
      // The record may only ALLOW a reviewed read here; its own write-block is
      // the same refusal as the table's hole, so the table's code stands.
      if (fromRecord.kind === "allow" && row.reviewedAt) return fromRecord;
    }
    return base;
  };
  const live = opts.live;
  if (!live) return decide;
  return (input) => {
    const d = decide(input);
    if (d.kind !== "allow") return d;
    const l = live(input.serverId, input.wireName);
    if (!l.tracked) return d;
    const stored = opts.lookup(input.serverId, input.wireName)?.inputSchemaHash;
    return l.hash && stored && l.hash === stored ? d : definitionChangedDecision(input.namespacedName);
  };
}
