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

/**
 * WARP-3962 — what a tool DOES (the `grade` column), and the permission a
 * person gives it. The product contract is the validator: "reads run
 * automatically, writes ask for a thumbs-up, destructive actions are blocked."
 *
 *   read        → always | ask | block
 *   write       → ask | block            (never always)
 *   destructive → block                  (immutable)
 *
 * The default for a tool nobody has reviewed is the contract itself:
 * read → always, write → ask, destructive → block. An unknown grade is a
 * write.
 */
export type RemoteToolGradeValue = "read" | "write" | "destructive";
export type RemoteToolPermission = "always" | "ask" | "block";

const LEGAL_PERMISSIONS: Readonly<Record<RemoteToolGradeValue, readonly RemoteToolPermission[]>> = Object.freeze({
  read: ["always", "ask", "block"],
  write: ["ask", "block"],
  destructive: ["block"],
});

/** The default permission per grade — the contract. */
export const DEFAULT_PERMISSION: Readonly<Record<RemoteToolGradeValue, RemoteToolPermission>> = Object.freeze({
  read: "always",
  write: "ask",
  destructive: "block",
});

/** Tightness order, for the admin tighten-only rule. */
const PERMISSION_RANK: Readonly<Record<RemoteToolPermission, number>> = { always: 0, ask: 1, block: 2 };

const GRADE_DB = { read: "READ", write: "WRITE", destructive: "DESTRUCTIVE" } as const;

export function gradeFromDb(g: string | undefined | null): RemoteToolGradeValue {
  // Fail closed: anything unrecognised (or a pre-column row) is a write.
  return g === "READ" ? "read" : g === "DESTRUCTIVE" ? "destructive" : "write";
}

/** The classification columns a permission means for a grade. */
export function permissionColumns(grade: RemoteToolGradeValue, permission: RemoteToolPermission) {
  const isWrite = grade !== "read";
  if (permission === "always") {
    return { requiresWrite: false, requiresConfirmation: false, denied: false, allowlisted: true };
  }
  if (permission === "ask") {
    return { requiresWrite: isWrite, requiresConfirmation: true, denied: false, allowlisted: true };
  }
  return { requiresWrite: isWrite, requiresConfirmation: isWrite, denied: true, allowlisted: false };
}

/** What the reviewed compiled table says about a tool (absent = it does not know it). */
export type TableClassOf = (
  serverId: string,
  wireName: string,
) => { grade: RemoteToolGradeValue; excluded: boolean } | undefined;

/** A write nobody has reviewed: blocked until an owner chooses Ask. */
const UNREVIEWED_WRITE = Object.freeze({
  requiresWrite: true,
  requiresConfirmation: true,
  denied: false,
  allowlisted: false,
});

/** What a row currently says, as a permission. Pure. */
export function permissionOf(
  row: Pick<RemoteToolClassificationRow, "denied" | "requiresConfirmation" | "allowlisted">,
): RemoteToolPermission {
  if (row.denied || row.allowlisted !== true) return "block";
  return row.requiresConfirmation ? "ask" : "always";
}

/** Refusal codes. Machine-readable; callers switch on these, never on prose. */
export const RECORD_DENY_CODES = {
  notClassified: "REMOTE_TOOL_NOT_CLASSIFIED",
  denied: "REMOTE_TOOL_DENIED",
  writeBlocked: "REMOTE_WRITE_NOT_PERMITTED",
  notAllowlisted: "REMOTE_TOOL_NOT_ALLOWLISTED",
  definitionChanged: "REMOTE_TOOL_DEFINITION_CHANGED",
} as const;

export interface RemoteToolClassificationRow {
  serverId: string;
  toolName: string;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
  denied: boolean;
  /**
   * WARP-2434 — the per-server positive allowlist. Optional on the type so a
   * row from before the column reads as NOT admitted: only `=== true` admits
   * ({@link remoteToolAllowlisted}).
   */
  allowlisted?: boolean;
  /**
   * WARP-3962 — what the tool does; bounds the permission a person may set.
   * Absent (a fixture from before the column) reads as a write.
   */
  grade?: "READ" | "WRITE" | "DESTRUCTIVE";
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
  opts: {
    baselineUnpinned?: boolean;
    /**
     * WARP-3962 — the grade of a tool, from the reviewed compiled table for the
     * server (undefined = no table speaks for it = a write). When given, a NEW
     * row starts at the contract's default permission for its grade (read →
     * always, write → ask, destructive → block) and a changed definition
     * resets to that default. When absent (extensions) the import default
     * stands.
     */
    gradeOf?: TableClassOf;
  } = {},
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
    const known = opts.gradeOf?.(serverId, tool.wireName);
    // A tool the reviewed table does not know is a write that starts BLOCKED.
    const grade = opts.gradeOf ? (known?.grade ?? "write") : undefined;
    // The default a row starts at (and a changed definition resets to): the
    // contract for a tool the table grades; blocked for an excluded one;
    // not allowlisted for one nobody has reviewed (an owner choosing Ask is
    // the review).
    const defaults = grade
      ? !known
        ? UNREVIEWED_WRITE
        : permissionColumns(grade, known.excluded ? "block" : DEFAULT_PERMISSION[grade])
      : undefined;
    await prisma.remoteToolClassification.upsert({
      where: { serverId_toolName: { serverId, toolName: tool.wireName } },
      create: {
        serverId,
        toolName: tool.wireName,
        ...(grade && defaults ? { grade: GRADE_DB[grade], ...defaults } : IMPORT_DEFAULT_CLASSIFICATION),
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
                  // WARP-2434 — changed arguments leave the allowlist too.
                  allowlisted: false,
                  // WARP-3962 — back to the contract's default for the grade.
                  requiresWrite: defaults?.requiresWrite ?? IMPORT_DEFAULT_CLASSIFICATION.requiresWrite,
                  requiresConfirmation:
                    defaults?.requiresConfirmation ?? IMPORT_DEFAULT_CLASSIFICATION.requiresConfirmation,
                  ...(grade ? { grade: GRADE_DB[grade] } : {}),
                  reviewedBy: null,
                  reviewedAt: null,
                }),
          }
        : baselined
          ? { lastSeenAt: now, wireDescription, inputSchemaHash: hash }
          : { lastSeenAt: now, wireDescription },
    });
    // A destructive or table-excluded tool is stored blocked whatever its row
    // said (this only tightens), so the row always matches what dispatch does.
    if (before && !before.denied && known && (known.excluded || known.grade === "destructive")) {
      await prisma.remoteToolClassification.updateMany({
        where: { serverId, toolName: tool.wireName },
        data: { ...permissionColumns(known.grade, "block"), grade: GRADE_DB[known.grade] },
      });
    }
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
  /**
   * WARP-3962 — hold this classification to the product contract: the
   * resulting permission must be legal for the tool's grade (the table's when
   * `known`, else the row's), a destructive or excluded tool can never be
   * un-blocked, and the stored columns are the canonical ones for that
   * permission. Set for every server except extensions (`ext-*`), which keep
   * their own review lifecycle.
   */
  enforceContract?: { known?: { grade: RemoteToolGradeValue; excluded: boolean } };
}

export type ClassifyRemoteToolResult =
  | { ok: true; row: RemoteToolClassificationRow }
  | {
      ok: false;
      code: "NOT_FOUND" | "NO_REVIEWER" | "UNCONFIRMED_WRITE" | "STALE_REVIEW" | "PERMISSION_NOT_ALLOWED_FOR_GRADE";
      message: string;
    };

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
    select: { id: true, grade: true },
  });
  if (!existing) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `${input.serverId} has never advertised a tool named ${input.toolName}.`,
    };
  }
  let columns: { requiresWrite: boolean; requiresConfirmation: boolean; denied: boolean; allowlisted?: boolean } = {
    requiresWrite: input.requiresWrite,
    requiresConfirmation: input.requiresConfirmation,
    denied: input.denied,
  };
  if (input.enforceContract) {
    const known = input.enforceContract.known;
    const grade = known?.grade ?? gradeFromDb((existing as { grade?: string }).grade);
    const permission: RemoteToolPermission = input.denied ? "block" : input.requiresConfirmation ? "ask" : "always";
    const legal: readonly RemoteToolPermission[] = known?.excluded ? ["block"] : LEGAL_PERMISSIONS[grade];
    // An unblocked tool must say what it is: a write is requiresWrite, a read is not.
    const flagsHonest = input.denied || input.requiresWrite === (grade !== "read");
    if (!legal.includes(permission) || !flagsHonest) {
      return {
        ok: false,
        code: "PERMISSION_NOT_ALLOWED_FOR_GRADE",
        message:
          `${input.toolName} is ${known?.excluded ? "excluded and blocked" : `a ${grade} tool`}; ` +
          `its permission can be ${legal.join(", ")}, and requiresWrite must match its grade.`,
      };
    }
    columns = permissionColumns(grade, permission);
  }
  const data = {
    ...columns,
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

export type SetPermissionFailure =
  | "NOT_FOUND"
  | "NO_REVIEWER"
  | "PERMISSION_NOT_ALLOWED_FOR_GRADE"
  | "ADMIN_CAN_ONLY_TIGHTEN"
  | "STALE_REVIEW";

export type SetRemoteToolPermissionResult =
  | { ok: true; row: RemoteToolClassificationRow; before: RemoteToolPermission; grade: RemoteToolGradeValue }
  | { ok: false; code: SetPermissionFailure; message: string };

/** The contract check shared by the single and the group writer. */
function checkPermission(
  row: Pick<RemoteToolClassificationRow, "toolName" | "grade" | "denied" | "requiresConfirmation" | "allowlisted">,
  permission: RemoteToolPermission,
  role: string,
  known?: { grade: RemoteToolGradeValue; excluded: boolean },
): { ok: true; grade: RemoteToolGradeValue; before: RemoteToolPermission } | { ok: false; code: SetPermissionFailure; message: string } {
  // The reviewed table is the authority on the grade when it knows the tool.
  const grade = known?.grade ?? gradeFromDb(row.grade);
  const legal: readonly RemoteToolPermission[] = known?.excluded ? ["block"] : LEGAL_PERMISSIONS[grade];
  if (!legal.includes(permission)) {
    return {
      ok: false,
      code: "PERMISSION_NOT_ALLOWED_FOR_GRADE",
      message: `${row.toolName} is ${known?.excluded ? "excluded and blocked" : `a ${grade} tool`}; its permission can be ${legal.join(", ")}, not ${permission}.`,
    };
  }
  const before = permissionOf(row);
  // Owner sets any legal value. Anything else (admin) may only tighten.
  if (role !== "owner" && PERMISSION_RANK[permission] < PERMISSION_RANK[before]) {
    return {
      ok: false,
      code: "ADMIN_CAN_ONLY_TIGHTEN",
      message: `${row.toolName} is "${before}"; only an owner can loosen it.`,
    };
  }
  return { ok: true, grade, before };
}

const reviewReset = {
  // WARP-3918 — a person setting the permission is the re-review.
  definitionStatus: "CURRENT" as const,
  definitionChangedAt: null,
  previousReviewHash: null,
  previousWireDescription: null,
};

/**
 * WARP-3962 — a person gives one tool a permission. Validated against the
 * tool's grade (the product contract, see {@link LEGAL_PERMISSIONS}); an owner
 * may set any legal value, an admin may only tighten (always → ask → block).
 * Stamps the reviewer, re-reviews a CHANGED definition, and — with
 * `inputSchemaHash` — lands only while the row still has the hash the person
 * was shown (STALE_REVIEW otherwise).
 */
export async function setRemoteToolPermission(
  prisma: ClassificationPrisma,
  input: {
    serverId: string;
    toolName: string;
    permission: RemoteToolPermission;
    actor: { id: string; role: string };
    inputSchemaHash?: string;
    /** The reviewed table's view of the tool (grade authority; `excluded` is block-only). */
    classOf?: TableClassOf;
  },
  now: Date = new Date(),
): Promise<SetRemoteToolPermissionResult> {
  const reviewedBy = input.actor.id.trim();
  if (!reviewedBy) return { ok: false, code: "NO_REVIEWER", message: "A permission change needs a reviewer." };
  const where = { serverId: input.serverId, toolName: input.toolName };
  const existing = (await prisma.remoteToolClassification.findUnique({
    where: { serverId_toolName: where },
  })) as RemoteToolClassificationRow | null;
  if (!existing) {
    return { ok: false, code: "NOT_FOUND", message: `${input.serverId} has never advertised a tool named ${input.toolName}.` };
  }
  const check = checkPermission(existing, input.permission, input.actor.role, input.classOf?.(input.serverId, input.toolName));
  if (!check.ok) return check;
  const data = {
    ...permissionColumns(check.grade, input.permission),
    grade: GRADE_DB[check.grade],
    reviewedBy,
    reviewedAt: now,
    ...reviewReset,
  };
  // The hash in the WHERE (as classifyRemoteTool does): one statement, so a
  // reset that lands after the read above still wins.
  const u = await prisma.remoteToolClassification.updateMany({
    where: { ...where, ...(input.inputSchemaHash !== undefined ? { inputSchemaHash: input.inputSchemaHash } : {}) },
    data,
  });
  if (u.count === 0) {
    return {
      ok: false,
      code: "STALE_REVIEW",
      message:
        `${input.serverId}'s ${input.toolName} has changed since it was shown to you; ` +
        "reload it and review the new definition.",
    };
  }
  const row = (await prisma.remoteToolClassification.findUnique({
    where: { serverId_toolName: where },
  })) as RemoteToolClassificationRow;
  logger.info(
    { serverId: input.serverId, toolName: input.toolName, grade: check.grade, permission: input.permission, reviewedBy },
    "remote_tool_permission_set",
  );
  return { ok: true, row, before: check.before, grade: check.grade };
}

/**
 * WARP-3962 — the group dropdown: one permission for every tool of a grade on a
 * server. All-or-nothing: every tool is validated first and the write is ONE
 * `updateMany`, so a refusal for any tool refuses the group and nothing lands.
 * A tool whose definition CHANGED is left for its own review (its hash must be
 * shown to a person); the result lists it as skipped.
 */
export async function setRemoteToolGroupPermission(
  prisma: ClassificationPrisma,
  input: {
    serverId: string;
    group: "read" | "write";
    permission: RemoteToolPermission;
    actor: { id: string; role: string };
    classOf?: TableClassOf;
  },
  now: Date = new Date(),
): Promise<
  | { ok: true; changed: string[]; skipped: string[] }
  | { ok: false; code: SetPermissionFailure; message: string }
> {
  const reviewedBy = input.actor.id.trim();
  if (!reviewedBy) return { ok: false, code: "NO_REVIEWER", message: "A permission change needs a reviewer." };
  const rows = (await prisma.remoteToolClassification.findMany({
    where: { serverId: input.serverId, grade: GRADE_DB[input.group] },
  })) as RemoteToolClassificationRow[];
  if (rows.length === 0) {
    return { ok: false, code: "NOT_FOUND", message: `${input.serverId} has no ${input.group} tools.` };
  }
  // Left for their own review: a CHANGED definition, and (when the table is
  // known) any tool the reviewed table does not grade as this group, or excludes.
  const individually = (r: RemoteToolClassificationRow): boolean => {
    if (r.definitionStatus === "CHANGED") return true;
    if (!input.classOf) return false;
    const k = input.classOf(input.serverId, r.toolName);
    return !k || k.excluded || k.grade !== input.group;
  };
  const skipped = rows.filter(individually).map((r) => r.toolName);
  const todo = rows.filter((r) => !individually(r));
  for (const r of todo) {
    const check = checkPermission(r, input.permission, input.actor.role);
    if (!check.ok) return check;
  }
  if (todo.length > 0) {
    await prisma.remoteToolClassification.updateMany({
      where: {
        serverId: input.serverId,
        grade: GRADE_DB[input.group],
        definitionStatus: "CURRENT",
        toolName: { in: todo.map((r) => r.toolName) },
      },
      data: {
        ...permissionColumns(input.group, input.permission),
        reviewedBy,
        reviewedAt: now,
        ...reviewReset,
      },
    });
  }
  logger.info(
    { serverId: input.serverId, group: input.group, permission: input.permission, changed: todo.length, reviewedBy },
    "remote_tool_group_permission_set",
  );
  return { ok: true, changed: todo.map((r) => r.toolName), skipped };
}

/**
 * WARP-2434 — admit or withdraw one DISCOVERED tool. A tool the server has
 * never advertised has no row and cannot be allowlisted (`NOT_FOUND`): the
 * allowlist names tools the box has seen, never invents them.
 */
export async function setRemoteToolAllowlisted(
  prisma: ClassificationPrisma,
  input: { serverId: string; toolName: string; allowlisted: boolean },
): Promise<{ ok: true; row: RemoteToolClassificationRow } | { ok: false; code: "NOT_FOUND" }> {
  const where = { serverId: input.serverId, toolName: input.toolName };
  const u = await prisma.remoteToolClassification.updateMany({
    where,
    data: { allowlisted: input.allowlisted },
  });
  if (u.count === 0) return { ok: false, code: "NOT_FOUND" };
  const row = (await prisma.remoteToolClassification.findUnique({
    where: { serverId_toolName: where },
  })) as RemoteToolClassificationRow | null;
  return row ? { ok: true, row } : { ok: false, code: "NOT_FOUND" };
}

/**
 * WARP-2434 — THE allowlist predicate. Positive and fail-closed: a tool is
 * admitted only when its record row exists, says `allowlisted === true` and is
 * not blocked. An unknown server, an unknown tool, an unreadable row and a
 * pre-column row all answer false. Every surface that offers or dispatches a
 * remote tool asks this one function (the multiplexer's listing and policy, and
 * the role-scope facts in tool-layers.service.ts), so they cannot skew.
 */
export function remoteToolAllowlisted(
  lookup: ClassificationLookup,
  serverId: string,
  wireName: string,
): boolean {
  const row = lookup(serverId, wireName);
  return row?.allowlisted === true && row.denied !== true;
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

function destructiveDecision(namespacedName: string): RemoteCallDecision {
  return {
    kind: "deny",
    code: RECORD_DENY_CODES.writeBlocked,
    message: `'${namespacedName}' is destructive, and destructive actions are blocked on this box. Do not retry; tell the user it was not done.`,
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

/**
 * WARP-2434 — the allowlist in front of any policy: a call whose tool is not
 * {@link remoteToolAllowlisted} is refused BEFORE the inner policy is asked, so
 * nothing the inner policy would allow can widen the allowlist.
 */
export function withRemoteAllowlist(
  lookup: ClassificationLookup,
  inner: RemoteCallPolicy,
): RemoteCallPolicy {
  return (input) => {
    // WARP-3962 — a block is "blocked", not "not on the list": the honest code.
    const blocked = lookup(input.serverId, input.wireName);
    if (blocked?.denied === true) return decideFromRecord(blocked, input.namespacedName);
    return remoteToolAllowlisted(lookup, input.serverId, input.wireName)
      ? inner(input)
      : {
          kind: "deny",
          code: RECORD_DENY_CODES.notAllowlisted,
          message:
            `'${input.namespacedName}' is not on this server's tool allowlist. ` +
            "Do not retry; answer without it.",
        };
  };
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
 *   3. the record's reviewed read fills a table HOLE (`REMOTE_TOOL_NOT_CLASSIFIED`);
 *   4. otherwise the table's own refusal, with its own honest code.
 *
 * WARP-3962 — the permission (always | ask | block) lives on the record and the
 * grade is the floor: a destructive tool never runs; a table WRITE block
 * (`REMOTE_WRITE_NOT_PERMITTED`) is released only by an `ask` row (the
 * thumbs-up, `requiresConfirmation`) and never to a plain allow; a table read
 * with an explicit read-`ask` row asks; a server NO table speaks for follows its
 * record alone (ask → thumbs-up). A tool a server's table does not list stays
 * denied. The table's `excluded` rows keep their own code.
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
  /**
   * WARP-3962 — does a reviewed compiled table speak for this server? Defaults
   * to "yes" whenever a `table` is given and "no" without one.
   */
  tableSpeaksFor?: (serverId: string) => boolean;
}): RemoteCallPolicy {
  const table = opts.table ?? DENY_ALL_REMOTE_TOOLS;
  const tableSpeaksFor = (serverId: string): boolean =>
    opts.table !== undefined && (opts.tableSpeaksFor?.(serverId) ?? true);
  const decide: RemoteCallPolicy = (input) => {
    const row = opts.lookup(input.serverId, input.wireName);
    // WARP-3918 — a CHANGED definition beats the table's allow too: the table
    // vouched for the tool as it was reviewed, not for what it says now.
    if (row?.denied || row?.definitionStatus === "CHANGED") return decideFromRecord(row, input.namespacedName);
    const base = table(input);
    // WARP-3962 — a destructive tool is blocked whatever the row says.
    if (row && gradeFromDb(row.grade) === "destructive") return destructiveDecision(input.namespacedName);
    if (base.kind === "allow") {
      // The table vouches for a read; the record may only add the thumbs-up
      // (an explicit read-ask row: not a write, confirming).
      return row && !row.requiresWrite && row.requiresConfirmation
        ? { ...base, requiresConfirmation: true, grade: "read" }
        : base;
    }
    if (!row) return base;
    // WARP-3962 — the table's write-block (and its hole) is the GRADE; the
    // record carries the permission. "ask" lifts the block through the existing
    // thumbs-up path; "always" on a write is not a state, and the table's
    // `excluded` refusal (its own code) stands.
    if (base.code === RECORD_DENY_CODES.writeBlocked) {
      return row.requiresWrite && row.requiresConfirmation ? { kind: "allow", requiresConfirmation: true, grade: "write" } : base;
    }
    if (base.code === RECORD_DENY_CODES.notClassified) {
      // No table speaks for this server (an owner-added one): the record is
      // the authority, by its permission. A server WITH a table keeps its hole
      // closed: a tool the reviewed table does not list is never offered a
      // thumbs-up (ADR-043 §2).
      if (row.requiresConfirmation && !tableSpeaksFor(input.serverId)) {
        return { kind: "allow", requiresConfirmation: true, grade: row.requiresWrite ? "write" : "read" };
      }
      // A read with no thumbs-up needs a person's review behind it.
      if (!row.requiresWrite && row.reviewedAt) return { kind: "allow" };
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
