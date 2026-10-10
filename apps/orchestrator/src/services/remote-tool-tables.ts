/**
 * WARP-3703 (ADR-043 TC-1.3) — the compiled classification table, per server.
 *
 * ## What this is, and what it is not
 *
 * ADR-043 §2: *"The only authority on whether a remote MCP tool is a read, a
 * write, or blocked is a local classification table this repo owns and an
 * operator maintains."* `atlassian-tool-policy.ts` is that table for the first
 * server, and it is Atlassian-shaped in exactly two ways a second server does not
 * share: a `product` column and an auth-mode matrix (Compass is OAuth only, JSM
 * is API-token only). Everything else it does — grade × disposition, deny by
 * absence, a note for every refusal, two independent layers (`v1` says what an
 * operator decided, `grade` says what the tool DOES) — is the shape of ANY
 * server's table. This module is that remainder, and nothing in it names a
 * vendor.
 *
 * It is NOT a replacement. Atlassian's own table and policy are registered here
 * under `atlassian`, built exactly as the singleton used to build them, and
 * `atlassian-tool-policy.test.ts` and `atlassian-tool-snapshot.test.ts` are the
 * regression net for that.
 *
 * ## A vendor's data PR
 *
 * A server whose tools can run on this track ships ONE table, as data:
 *
 *   1. a `RemoteToolTableDef` (`remote-tool-tables/<vendor>.ts`): the server id,
 *      every tool the vendor documents with its grade, disposition and — for
 *      anything not plainly `allowed` — the note a future maintainer needs, and
 *      the PROVENANCE of the names;
 *   2. appended to {@link REMOTE_TOOL_TABLE_DEFS};
 *   3. its snapshot, `docs/security/<serverId>-mcp-tool-surface.json`
 *      (`remote-tool-snapshot.ts`), generated and committed.
 *
 * Nothing here is wired by a vendor PR beyond that line: the registry below is
 * DERIVED from the list, the singleton reads the registry, and
 * `remote-tool-tables.test.ts` runs the invariants over whatever the list holds.
 *
 * ## Fail-closed, three ways
 *
 * A tool the table has never heard of is not callable — and so is every tool of
 * a server with NO table at all, which falls to {@link DENY_ALL_REMOTE_TOOLS}.
 * That is what makes a vendor safe to register before anyone has reviewed its
 * tools: the table's silence is a refusal, and the owner's classification record
 * can fill a hole one reviewed read at a time (`composeRemoteCallPolicy`). And a
 * name the table lists TWICE is ambiguous, so it is refused as unclassified
 * rather than resolved in whichever direction iteration order happened to prefer.
 *
 * ## The wire's `annotations` are not read, here or anywhere
 *
 * ADR-043 §2: `readOnlyHint` / `destructiveHint` are advisory by spec and are
 * asserted by the party they describe. A row's grade is assigned by reading what
 * the tool DOES, from the vendor's own description of its behaviour.
 */
import {
  ATLASSIAN_SERVER_ID,
  ATLASSIAN_TOOL_INDEX,
  createAtlassianRemoteCallPolicy,
} from "./atlassian-tool-policy.js";
import {
  DENY_ALL_REMOTE_TOOLS,
  REMOTE_TOOL_NAME_SEPARATOR,
  SERVER_ID_PATTERN,
  WIRE_TOOL_NAME_PATTERN,
  namespacedToolName,
  type RemoteCallDecision,
  type RemoteCallPolicy,
} from "./mcp-multiplexer.service.js";
import { RECORD_DENY_CODES } from "./remote-tool-classification.service.js";

/**
 * The privilege grade. Assigned by reading what the tool DOES, never by its name
 * and never by anything the server said about it (ADR-043 §2).
 */
export type RemoteToolGrade = "read" | "write" | "destructive";

/**
 * What v1 does with a tool, stated per row rather than derived from the grade —
 * a read can be held back for a reason its grade does not carry.
 */
export type RemoteToolDisposition =
  /** Callable on an operator-enabled connection. */
  | "allowed"
  /** Classified, but refused until ADR-043 §3's remote-write conditions are met
   *  (WARP-2321's deny tier and the `remote_mcp` channel). */
  | "blocked-write"
  /** Refused in v1 for a reason specific to this tool — a read held back for the
   *  context budget, say. Promotable one row at a time, with a snapshot diff. */
  | "excluded";

const GRADES: ReadonlySet<string> = new Set<RemoteToolGrade>(["read", "write", "destructive"]);
const DISPOSITIONS: ReadonlySet<string> = new Set<RemoteToolDisposition>([
  "allowed",
  "blocked-write",
  "excluded",
]);

export interface RemoteToolRow {
  /** The WIRE name, exactly as the server advertises it. */
  readonly name: string;
  readonly grade: RemoteToolGrade;
  readonly v1: RemoteToolDisposition;
  /** Required for anything not plainly `allowed` — the reason a reader needs and
   *  a future maintainer would otherwise have to reconstruct. */
  readonly note?: string;
}

/** One server's table, as data. */
export interface RemoteToolTableDef {
  /** The server id its tools are namespaced under. Must equal the provider
   *  descriptor's `mcpServerId` — gated in `adr-043-boundary.test.ts`. */
  readonly serverId: string;
  /** Every tool the vendor documents. Sorted by name, strictly ascending. */
  readonly rows: readonly RemoteToolRow[];
  /**
   * Where the names came from, carried IN the generated snapshot. A snapshot
   * whose provenance lives only in a PR description is one nobody can date, and
   * Warp Lab holds no vendor credential to probe a live `tools/list` with — so
   * this says what it is NOT as plainly as what it is.
   */
  readonly provenance: string;
}

/**
 * The longest `<serverId>__<wireName>` a model will be given.
 *
 * The multiplexer says the namespaced name is serialised into an OpenAI-style
 * `function.name`, and bounds the WIRE name at 64 — but the name the model sees is
 * the namespaced one, which can reach 98. A compiled table asserts the bound on
 * the whole thing, because the table is where every name is enumerated.
 */
export const MAX_NAMESPACED_TOOL_NAME_LENGTH = 64;

/**
 * Refusal codes. Machine-readable; callers switch on these, never on prose.
 *
 * The same three strings Atlassian's table uses, and the first two are the
 * RECORD's own: `composeRemoteCallPolicy` lets an owner's reviewed read fill a
 * table hole only when the table's refusal carries `notClassified`, so a generic
 * table that spelled it differently would silently stop every owner review from
 * applying. `remote-tool-tables.test.ts` pins all three against both homes.
 */
export const REMOTE_TABLE_DENY_CODES = {
  /** Not in the table at all — the fail-closed default. */
  notClassified: RECORD_DENY_CODES.notClassified,
  /** Classified as a write or destructive, or held out by its disposition;
   *  ADR-043 §3 blocks it. */
  writeBlocked: RECORD_DENY_CODES.writeBlocked,
  /** Classified and deliberately kept out of v1 for its own reason. */
  excluded: "REMOTE_TOOL_EXCLUDED_FROM_V1",
} as const;

/**
 * The names a table admits: `allowed` AND a read.
 *
 * Exported as a FUNCTION for the reason `atlassian-tool-policy.ts`'s
 * `v1ReadToolsOf` is: the two conditions are indistinguishable on a table that
 * has no mis-marked row, so a test must be able to feed it one — a write marked
 * `allowed`, a read held back — and prove each condition is load-bearing. Both
 * are required, and they mean different things: `v1` is the disposition an
 * operator recorded, `grade` is what the tool does, and one field edited by
 * mistake must not make a tool callable in either direction.
 */
export function remoteReadToolsOf(rows: readonly RemoteToolRow[]): ReadonlySet<string> {
  return new Set(rows.filter((r) => r.v1 === "allowed" && r.grade === "read").map((r) => r.name));
}

/**
 * The decision for ONE row (or for no row at all) — `classifyAtlassianRow` minus
 * the auth-mode matrix.
 *
 * Split out from the policy so a test can hand it a row the shipped tables do not
 * contain, and so a future operator surface can render it. Both conditions
 * {@link remoteReadToolsOf} ANDs are checked here as two independent layers.
 */
export function classifyTableRow(
  row: RemoteToolRow | undefined,
  namespacedName: string,
): RemoteCallDecision {
  if (!row) {
    return {
      kind: "deny",
      code: REMOTE_TABLE_DENY_CODES.notClassified,
      message:
        `'${namespacedName}' is not in this box's classification table for its server, ` +
        "so no operator has reviewed what it does (ADR-043 §2). Do not retry; " +
        "answer without it.",
    };
  }

  // The v1 DISPOSITION — the decision an operator recorded — is checked for
  // EVERY row, and as `!== "allowed"` rather than a list of refused values, so a
  // fourth disposition added later is denied by DEFAULT and its author has to
  // come here to make it callable.
  if (row.v1 !== "allowed") {
    return denyByDisposition(row, namespacedName);
  }

  // The second, independent layer: `v1` is what an operator decided, `grade` is
  // what the tool DOES. A row marked `allowed` by mistake must still not become
  // callable because one field was edited.
  if (row.grade !== "read") {
    return {
      kind: "deny",
      code: REMOTE_TABLE_DENY_CODES.writeBlocked,
      message:
        `'${namespacedName}' is classified as a ${row.grade}. Remote writes are ` +
        "blocked on this box until the runtime deny tier ships (ADR-043 §3). " +
        "Do not retry; tell the user the change was not made.",
    };
  }

  return { kind: "allow" };
}

/**
 * Turn a non-`allowed` disposition into its refusal. `excluded` and
 * `blocked-write` keep DIFFERENT codes because they send an operator to different
 * places: `excluded` is a decision about this tool that outlives ADR-043 §3 and
 * needs the row's own note, `blocked-write` is lifted when WARP-2321's deny tier
 * ships.
 */
function denyByDisposition(row: RemoteToolRow, namespacedName: string): RemoteCallDecision {
  switch (row.v1) {
    case "excluded":
      return {
        kind: "deny",
        code: REMOTE_TABLE_DENY_CODES.excluded,
        message:
          `'${namespacedName}' is deliberately excluded from this release. ` +
          (row.note ?? "") +
          " Do not retry.",
      };
    case "blocked-write":
      return {
        kind: "deny",
        code: REMOTE_TABLE_DENY_CODES.writeBlocked,
        message:
          `'${namespacedName}' is classified as a ${row.grade} and is held out of ` +
          "this release by its recorded v1 disposition. Remote calls this box has " +
          "not admitted to its read set are refused until the runtime deny tier " +
          "ships (ADR-043 §3). Do not retry; tell the user the call was not made.",
      };
    default:
      // Fail closed. A disposition added to `RemoteToolDisposition` without a
      // case here denies rather than falling through to allow.
      return {
        kind: "deny",
        code: REMOTE_TABLE_DENY_CODES.excluded,
        message:
          `'${namespacedName}' carries a v1 disposition this box does not ` +
          "recognise, so it is refused. Do not retry.",
      };
  }
}

export interface TablePolicyOptions {
  /** What to do with a call to any OTHER server. Defaults to the shipping
   *  deny-all — this policy speaks for ONE server and must not accidentally
   *  become a blanket allow for another. */
  fallback?: RemoteCallPolicy;
}

/**
 * Build one server's {@link RemoteCallPolicy} from its rows.
 *
 * Refusal order, and each step answers a different operator question:
 *
 *   1. **not this server** → the fallback (deny-all by default). A table speaks
 *      for its own server and for no other: a name that is a read HERE must not
 *      let a second vendor's tool of the same name inherit the clearance.
 *   2. **not in the table** → `REMOTE_TOOL_NOT_CLASSIFIED`.
 *   3. **any v1 disposition other than `allowed`** → its own refusal.
 *   4. **write or destructive** → `REMOTE_WRITE_NOT_PERMITTED`, independently of
 *      what step 3 read.
 *   5. otherwise allow — and steps 3 and 4 are exactly the two conditions
 *      {@link remoteReadToolsOf} ANDs, so what is allowed here IS that set.
 *
 * A name listed twice is refused at step 2: an ambiguous privilege is not
 * resolved in whichever direction iteration order happened to prefer. The
 * validator rejects such a table; this keeps one that slipped past it closed.
 */
export function createTablePolicy(
  serverId: string,
  rows: readonly RemoteToolRow[],
  opts: TablePolicyOptions = {},
): RemoteCallPolicy {
  const fallback = opts.fallback ?? DENY_ALL_REMOTE_TOOLS;
  const index = new Map<string, RemoteToolRow | null>();
  for (const row of rows) index.set(row.name, index.has(row.name) ? null : row);

  return (input) => {
    if (input.serverId !== serverId) return fallback(input);
    return classifyTableRow(index.get(input.wireName) ?? undefined, input.namespacedName);
  };
}

// --- The invariants a table must keep -----------------------------------------

/**
 * Every way one table breaks the rules a vendor's data PR must keep, as
 * sentences. Empty means clean.
 *
 * A function that RETURNS the problems rather than asserting, so the test that
 * runs it over every shipped table and the tests that feed it a table built to
 * break each rule are the same code: an invariant nobody has seen fail is an
 * invariant nobody knows is checked.
 */
export function remoteToolTableViolations(def: RemoteToolTableDef): string[] {
  const out: string[] = [];
  if (!SERVER_ID_PATTERN.test(def.serverId)) {
    out.push(
      `serverId "${def.serverId}" is not a legal server id (lowercase letters, digits and ` +
        "hyphens, 1-32 characters, no underscore)",
    );
  }
  if (def.provenance.trim().length === 0) {
    out.push("provenance is empty — the snapshot must say where the names came from");
  }

  const seen = new Set<string>();
  let previous: string | undefined;
  for (const row of def.rows) {
    const at = `row "${row.name}"`;
    if (!WIRE_TOOL_NAME_PATTERN.test(row.name) || row.name.includes(REMOTE_TOOL_NAME_SEPARATOR)) {
      out.push(
        `${at}: not a legal wire name (1-64 characters of [A-Za-z0-9_.-] starting ` +
          `alphanumeric, and no '${REMOTE_TOOL_NAME_SEPARATOR}')`,
      );
    }
    const namespaced = namespacedToolName(def.serverId, row.name);
    if (namespaced.length > MAX_NAMESPACED_TOOL_NAME_LENGTH) {
      out.push(
        `${at}: "${namespaced}" is ${namespaced.length} characters; the model's function.name ` +
          `bound is ${MAX_NAMESPACED_TOOL_NAME_LENGTH}`,
      );
    }
    if (seen.has(row.name)) out.push(`${at}: duplicate name`);
    seen.add(row.name);
    if (previous !== undefined && row.name < previous) {
      out.push(`${at}: names must be sorted ascending (it follows "${previous}")`);
    }
    previous = row.name;

    if (!GRADES.has(row.grade)) out.push(`${at}: unknown grade "${row.grade}"`);
    if (!DISPOSITIONS.has(row.v1)) out.push(`${at}: unknown disposition "${row.v1}"`);
    if (row.v1 !== "allowed" && (row.note ?? "").trim().length === 0) {
      out.push(`${at}: a row that is not "allowed" needs a note saying WHY`);
    }
    if (row.v1 === "allowed" && row.grade !== "read") {
      out.push(
        `${at}: an "allowed" row must be a read — a write or destructive tool is never ` +
          "callable in v1",
      );
    }
  }
  return out;
}

/**
 * {@link remoteToolTableViolations} over a whole set of tables, plus the two
 * rules that are about the set: one table per server, and nobody's table may
 * claim Atlassian's id.
 */
export function remoteToolTableSetViolations(defs: readonly RemoteToolTableDef[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const def of defs) {
    if (def.serverId === ATLASSIAN_SERVER_ID) {
      out.push(
        `${def.serverId}: already has the reviewed table in atlassian-tool-policy.ts, which ` +
          "a generic table cannot replace",
      );
    }
    if (seen.has(def.serverId)) {
      out.push(`${def.serverId}: more than one table speaks for this server`);
    }
    seen.add(def.serverId);
    for (const violation of remoteToolTableViolations(def)) out.push(`${def.serverId}: ${violation}`);
  }
  return out;
}

// --- The registry --------------------------------------------------------------

/**
 * The vendor tables that ship — NONE today. A vendor's data PR appends its
 * {@link RemoteToolTableDef} here and nowhere else (see the module header); the
 * registry, the snapshot gate and every invariant are derived from this list.
 * Frozen, because it is a security artefact's source.
 */
export const REMOTE_TOOL_TABLE_DEFS: readonly RemoteToolTableDef[] = Object.freeze<
  RemoteToolTableDef[]
>([]);

/**
 * Which policy speaks for which server, built from a list of vendor tables.
 *
 * Atlassian's own policy is registered under `atlassian` — LAST, so a def that
 * claimed its id would lose to the reviewed table rather than replace it (and
 * {@link remoteToolTableSetViolations} refuses such a def anyway). It is built
 * exactly as the singleton used to build it: `api-token`, because that is the
 * only credential a v1 box can hold — ADR-043 §7 classifies Atlassian as the
 * customer-created-credential model and its OAuth endpoint is an explicit
 * non-goal. The mode is a parameter rather than an assumption so the Compass half
 * of the auth-mode matrix is expressible and testable.
 *
 * Exported as a builder so a test can build a registry from a table that exists
 * nowhere else.
 */
export function buildRemoteToolTables(
  defs: readonly RemoteToolTableDef[],
): Readonly<Record<string, RemoteCallPolicy>> {
  const vendors = Object.fromEntries(
    defs.map((def) => [def.serverId, createTablePolicy(def.serverId, def.rows)] as const),
  );
  return Object.freeze({
    ...vendors,
    [ATLASSIAN_SERVER_ID]: createAtlassianRemoteCallPolicy({
      authMode: "api-token",
      fallback: DENY_ALL_REMOTE_TOOLS,
    }),
  });
}

/** The shipped registry: `atlassian`, plus whatever {@link REMOTE_TOOL_TABLE_DEFS} holds. */
export const REMOTE_TOOL_TABLES: Readonly<Record<string, RemoteCallPolicy>> =
  buildRemoteToolTables(REMOTE_TOOL_TABLE_DEFS);

/**
 * The compiled-table half of the call policy: the table that speaks for the
 * server a call names, or — for every server none speaks for — the shipping
 * {@link DENY_ALL_REMOTE_TOOLS}.
 *
 * An OWN-property read, never a bare index. A server id is `[a-z0-9-]`, which
 * admits `constructor`, and `REMOTE_TOOL_TABLES["constructor"]` is `Object`: a
 * "policy" that returns its input, which has no `kind` and so is neither `allow`
 * nor `deny` — and a dispatcher that only checks for a refusal would call it
 * through.
 */
export const remoteToolTablePolicy: RemoteCallPolicy = (input) => {
  const table = Object.prototype.hasOwnProperty.call(REMOTE_TOOL_TABLES, input.serverId)
    ? REMOTE_TOOL_TABLES[input.serverId]
    : undefined;
  return (table ?? DENY_ALL_REMOTE_TOOLS)(input);
};

/**
 * WARP-3962 — what a tool DOES, read off the compiled table that speaks for its
 * server (Atlassian's reviewed table, or a vendor def). `undefined` when no
 * table lists it — the caller treats that as a write (fail closed). The table
 * supplies the grade; the permission lives on the classification record.
 */
export function remoteToolGradeOf(serverId: string, wireName: string): RemoteToolGrade | undefined {
  if (serverId === ATLASSIAN_SERVER_ID) return ATLASSIAN_TOOL_INDEX.get(wireName)?.grade;
  return REMOTE_TOOL_TABLE_DEFS.find((d) => d.serverId === serverId)?.rows.find((r) => r.name === wireName)?.grade;
}

/** WARP-3962 — does a compiled table speak for this server? (Own-property read, as {@link remoteToolTablePolicy}.) */
export const remoteToolTableExists = (serverId: string): boolean =>
  Object.prototype.hasOwnProperty.call(REMOTE_TOOL_TABLES, serverId);
