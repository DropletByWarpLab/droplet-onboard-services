/**
 * WARP-2360 / WARP-2346 — the local, operator-owned classification table for
 * the Atlassian remote MCP server, and the {@link RemoteCallPolicy} built from
 * it.
 *
 * ## Why the table lives HERE and not in `services/mcp-bridge`
 *
 * ADR-043 §2 is unambiguous: *"The only authority on whether a remote MCP tool
 * is a read, a write, or blocked is a local classification table this repo
 * owns and an operator maintains."* The bridge is the component that talks to
 * the vendor; putting the privilege table beside the socket would put the
 * authority one refactor away from the wire. It belongs in the process that
 * decides, which is the orchestrator.
 *
 * That also keeps the ADR-043 §5 tripwire intact — this module imports nothing
 * from `@droplet/mcp-bridge`, so no MCP transport is reachable from orchestrator
 * product code through it.
 *
 * ## The wire's `annotations` are not read, here or anywhere
 *
 * ADR-043 §2: `readOnlyHint` / `destructiveHint` are advisory by spec and are
 * asserted by the party they describe — a server can declare `deleteIssue` with
 * `readOnlyHint: true` and thereby choose its own privilege level. The
 * multiplexer already discards them at the copy; this table is what fills the
 * gap that leaves.
 *
 * ## Fail-closed by absence, which is what makes the table's HOLES safe
 *
 * A tool absent from {@link ATLASSIAN_TOOL_CLASSIFICATIONS} is not callable —
 * {@link createAtlassianRemoteCallPolicy} denies it with
 * `REMOTE_TOOL_NOT_CLASSIFIED`. That matters because this table has a KNOWN,
 * DELIBERATE hole: the Jira Service Management and Bitbucket tools are
 * API-token-only, we have no live API-token credential to enumerate them with,
 * and inventing their names would put fiction in a security artefact. They are
 * therefore absent, and absent means denied. The cost is capability, never
 * safety.
 *
 * ## Provenance of the 40 rows below
 *
 * Recorded 2026-09-02 from the tool surface an **OAuth-connected** Atlassian
 * Rovo MCP client advertises. That surface is itself evidence for the auth-mode
 * matrix rather than a contradiction of it: Compass tools are present and JSM /
 * Bitbucket tools are absent, which is exactly what
 * {@link ATLASSIAN_PRODUCT_AUTH_MODES} says. It is a FIXTURE, not a live probe
 * of the API-token path; `atlassian-tool-snapshot.test.ts` gates it against the
 * committed snapshot, and the runtime gate for the server changing under us is
 * the session's `catalog_changed` state, which no CI job can stand in for.
 */
import type { RemoteCallDecision, RemoteCallPolicy } from "./mcp-multiplexer.service.js";

/**
 * The server id Atlassian's tools are namespaced under.
 *
 * Deliberately re-declared rather than imported from `@droplet/mcp-bridge`:
 * that package's barrel pulls in `streamable-http.ts`, and an import chain from
 * orchestrator product code to `StreamableHTTPClientTransport` is the exact
 * breach ADR-043 §5 tells a reviewer to look for. `@droplet/mcp-bridge` is not
 * even an orchestrator dependency, and it should not become one for a
 * nine-character string.
 *
 * The two spellings must agree, so both sides assert the same literal:
 * `services/mcp-bridge/__tests__/atlassian.test.ts` and
 * `atlassian-tool-policy.test.ts` each pin it to `"atlassian"`.
 */
export const ATLASSIAN_SERVER_ID = "atlassian";

/**
 * Which credential can reach a product's tools.
 *
 * NOT a capability we choose — it is Atlassian's, and it is asymmetric: a
 * connection cannot see every tool at once under any single credential.
 */
export type AtlassianAuthMode = "api-token" | "oauth";

/** The Atlassian products whose tools this server exposes. */
export type AtlassianProduct =
  | "jira"
  | "confluence"
  | "compass"
  | "jsm"
  | "bitbucket"
  | "teamwork-graph"
  | "platform";

/**
 * The privilege grade. Assigned by reading what the tool DOES, never by its
 * name and never by anything the server said about it (ADR-043 §2).
 */
export type AtlassianToolGrade = "read" | "write" | "destructive";

/** What v1 does with a tool, stated per row rather than derived from the grade
 *  — `updateConfluencePage` is excluded for a reason its grade does not carry. */
export type AtlassianV1Disposition =
  /** Callable on an operator-enabled connection. */
  | "allowed"
  /** Classified, but refused until ADR-043 §3's remote-write conditions are
   *  met (WARP-2321's deny tier and the `remote_mcp` channel). */
  | "blocked-write"
  /** Refused in v1 for a reason specific to this tool. Never callable, even
   *  once writes are permitted, until the reason is addressed. */
  | "excluded";

export interface AtlassianToolClassification {
  /** The WIRE name, exactly as the server advertises it. */
  readonly name: string;
  readonly product: AtlassianProduct;
  readonly grade: AtlassianToolGrade;
  readonly v1: AtlassianV1Disposition;
  /** Required for anything not plainly `allowed` — the reason a reader needs
   *  and a future maintainer would otherwise have to reconstruct. */
  readonly note?: string;
}

/**
 * The auth-mode availability matrix.
 *
 * Requesting a tool that this connection's credential cannot reach must return
 * a TYPED "unavailable in this auth mode" refusal — never an empty result.
 * The distinction is load-bearing: "Compass has no components" and "this
 * connection cannot see Compass at all" send an operator to opposite remedies,
 * and only one of them is fixable.
 */
export const ATLASSIAN_PRODUCT_AUTH_MODES: Readonly<
  Record<AtlassianProduct, readonly AtlassianAuthMode[]>
> = {
  jira: ["api-token", "oauth"],
  confluence: ["api-token", "oauth"],
  /** OAuth ONLY. An API-token connection cannot reach Compass. */
  compass: ["oauth"],
  /** API-token ONLY. Not enumerated below — see the module header. */
  jsm: ["api-token"],
  /** API-token ONLY. Not enumerated below — see the module header. */
  bitbucket: ["api-token"],
  "teamwork-graph": ["api-token", "oauth"],
  platform: ["api-token", "oauth"],
};

/**
 * `updateConfluencePage` is WHOLE-BODY REPLACEMENT, and that is why it is out.
 *
 * Upstream #210 / #217 / #60: the tool replaces the page body with whatever is
 * supplied. A partial payload — an agent "adding a paragraph" — destroys
 * everything else on the page, and the destruction is a legitimate,
 * successfully-applied edit as far as Confluence is concerned, so nothing
 * upstream or downstream flags it.
 *
 * WARP-2346 offered two ways to ship it: (a) exclude it from v1, policed by an
 * absence test, or (b) gate it at destructive grade with a fetched base
 * revision, a diff and a hard confirmation. **(a) is what this PR does.** (b)
 * is not half-buildable: it needs a fetched base revision to diff against, a
 * confirmation surface that can show a destructive diff to an owner, and the
 * `remote_mcp` off-LAN channel to have shipped — and ADR-043 §3 forbids any
 * remote write before WARP-2321's deny tier exists anyway, so (b) would be
 * unreachable code guarded by a confirmation nobody can answer.
 *
 * The exclusion is enforced by ABSENCE FROM THE ALLOWED SET, in the same shape
 * `packages/tools-core/__tests__/storage-pool-tools.test.ts` uses for the local
 * registry's destructive operations, and `atlassian-tool-policy.test.ts`
 * asserts it the same way.
 */
export const CONFLUENCE_UPDATE_TOOL = "updateConfluencePage";

/**
 * The table. Ordered by product then name so a diff is readable.
 *
 * Adding a row is a privilege decision. The default for a newly discovered
 * tool is NOT "add it as a read" — ADR-043 §2 says a new tool enters as a
 * write requiring confirmation and is demoted only by explicit human review of
 * what it actually does.
 */
export const ATLASSIAN_TOOL_CLASSIFICATIONS: readonly AtlassianToolClassification[] = [
  // --- Jira: reads -------------------------------------------------------
  { name: "getIssueLinkTypes", product: "jira", grade: "read", v1: "allowed" },
  { name: "getJiraIssue", product: "jira", grade: "read", v1: "allowed" },
  { name: "getJiraIssueRemoteIssueLinks", product: "jira", grade: "read", v1: "allowed" },
  { name: "getJiraIssueTypeMetaWithFields", product: "jira", grade: "read", v1: "allowed" },
  { name: "getJiraProjectIssueTypesMetadata", product: "jira", grade: "read", v1: "allowed" },
  { name: "getTransitionsForJiraIssue", product: "jira", grade: "read", v1: "allowed" },
  { name: "getVisibleJiraProjects", product: "jira", grade: "read", v1: "allowed" },
  { name: "lookupJiraAccountId", product: "jira", grade: "read", v1: "allowed" },
  {
    name: "searchJiraIssuesUsingJql",
    product: "jira",
    grade: "read",
    v1: "allowed",
    note:
      "Upstream #221: caps at 5 nodes and reports the page complete. The bridge's " +
      "TruncatedResultError guard is what stops that rendering as a total.",
  },
  // --- Jira: writes ------------------------------------------------------
  {
    name: "addCommentToJiraIssue",
    product: "jira",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3 — no remote write before WARP-2321's deny tier.",
  },
  {
    name: "addWorklogToJiraIssue",
    product: "jira",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3.",
  },
  {
    name: "createIssueLink",
    product: "jira",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3.",
  },
  {
    name: "createJiraIssue",
    product: "jira",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3.",
  },
  {
    name: "editJiraIssue",
    product: "jira",
    grade: "write",
    v1: "blocked-write",
    note:
      "Field-level update, not whole-issue replacement, so it is a write and " +
      "not destructive — unlike its Confluence counterpart.",
  },
  {
    name: "transitionJiraIssue",
    product: "jira",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3. A transition can fire automation the box cannot see.",
  },
  // --- Confluence: reads -------------------------------------------------
  { name: "getConfluenceCommentChildren", product: "confluence", grade: "read", v1: "allowed" },
  { name: "getConfluencePage", product: "confluence", grade: "read", v1: "allowed" },
  { name: "getConfluencePageDescendants", product: "confluence", grade: "read", v1: "allowed" },
  { name: "getConfluencePageFooterComments", product: "confluence", grade: "read", v1: "allowed" },
  { name: "getConfluencePageInlineComments", product: "confluence", grade: "read", v1: "allowed" },
  { name: "getConfluenceSpaces", product: "confluence", grade: "read", v1: "allowed" },
  { name: "getPagesInConfluenceSpace", product: "confluence", grade: "read", v1: "allowed" },
  { name: "searchConfluenceUsingCql", product: "confluence", grade: "read", v1: "allowed" },
  // --- Confluence: writes ------------------------------------------------
  {
    name: "createConfluenceFooterComment",
    product: "confluence",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3.",
  },
  {
    name: "createConfluenceInlineComment",
    product: "confluence",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3.",
  },
  {
    name: "createConfluencePage",
    product: "confluence",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3. Creates, never replaces — not destructive.",
  },
  // --- Confluence: destructive ------------------------------------------
  {
    name: CONFLUENCE_UPDATE_TOOL,
    product: "confluence",
    grade: "destructive",
    v1: "excluded",
    note:
      "WHOLE-BODY REPLACEMENT (upstream #210/#217/#60): a partial payload " +
      "destroys the rest of the page, and Confluence records it as a normal " +
      "successful edit. Excluded from v1 — see CONFLUENCE_UPDATE_TOOL.",
  },
  // --- Compass (OAuth only) ---------------------------------------------
  { name: "getCompassComponent", product: "compass", grade: "read", v1: "allowed" },
  { name: "getCompassComponents", product: "compass", grade: "read", v1: "allowed" },
  { name: "getCompassCustomFieldDefinitions", product: "compass", grade: "read", v1: "allowed" },
  {
    name: "createCompassComponent",
    product: "compass",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3.",
  },
  {
    name: "createCompassComponentRelationship",
    product: "compass",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3.",
  },
  {
    name: "createCompassCustomFieldDefinition",
    product: "compass",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3. Changes a site-wide schema.",
  },
  // --- Teamwork graph ----------------------------------------------------
  { name: "getTeamworkGraphContext", product: "teamwork-graph", grade: "read", v1: "allowed" },
  { name: "getTeamworkGraphObject", product: "teamwork-graph", grade: "read", v1: "allowed" },
  {
    name: "addTeamworkGraphContext",
    product: "teamwork-graph",
    grade: "write",
    v1: "blocked-write",
    note: "ADR-043 §3.",
  },
  // --- Platform / cross-product -----------------------------------------
  { name: "atlassianUserInfo", product: "platform", grade: "read", v1: "allowed" },
  {
    name: "fetch",
    product: "platform",
    grade: "read",
    v1: "allowed",
    note:
      "Resolves an Atlassian URL to the object behind it. A read of the " +
      "customer's own tenant — it is not a general web fetch, and cannot " +
      "reach a host outside Atlassian.",
  },
  { name: "getAccessibleAtlassianResources", product: "platform", grade: "read", v1: "allowed" },
  { name: "search", product: "platform", grade: "read", v1: "allowed" },
];

/** Every classified tool, by wire name. */
export const ATLASSIAN_TOOL_INDEX: ReadonlyMap<string, AtlassianToolClassification> =
  new Map(ATLASSIAN_TOOL_CLASSIFICATIONS.map((t) => [t.name, t]));

/**
 * The explicit v1 read list — the ONLY names {@link createAtlassianRemoteCallPolicy}
 * will allow.
 *
 * Derived from the table rather than hand-written, so the table stays the one
 * place a privilege decision is recorded. ADR-043 §3 permits exactly this:
 * *"Read-only invocation of tools an operator has explicitly demoted to read
 * status under §2 may ship before those land. Writes may not."*
 */
export const ATLASSIAN_V1_READ_TOOLS: ReadonlySet<string> = v1ReadToolsOf(
  ATLASSIAN_TOOL_CLASSIFICATIONS,
);

/**
 * Derive the v1 read list from a set of rows.
 *
 * Exported as a FUNCTION, not only as the const above, because the two
 * conditions it ANDs are indistinguishable on today's table — no shipped row
 * is `v1: "allowed"` with a non-read grade, so a mutation dropping either
 * condition produces the identical set and stays green. (It did: mutation N5
 * survived the first pass of `atlassian-tool-policy.test.ts` for exactly that
 * reason.) A test can feed this a mis-marked write row and prove the grade
 * check is load-bearing; it cannot do that to a frozen const.
 *
 * Both conditions are required, and they mean different things: `v1` is the
 * disposition an operator recorded, `grade` is what the tool DOES. A row
 * marked `allowed` by mistake must still not become callable because someone
 * edited one field.
 */
export function v1ReadToolsOf(
  rows: readonly AtlassianToolClassification[],
): ReadonlySet<string> {
  return new Set(
    rows.filter((t) => t.v1 === "allowed" && t.grade === "read").map((t) => t.name),
  );
}

/** Refusal codes. Machine-readable; callers switch on these, never on prose. */
export const ATLASSIAN_DENY_CODES = {
  /** Not in the table at all — the fail-closed default. */
  notClassified: "REMOTE_TOOL_NOT_CLASSIFIED",
  /** Classified as a write or destructive; ADR-043 §3 blocks it. */
  writeBlocked: "REMOTE_WRITE_NOT_PERMITTED",
  /** Classified and deliberately kept out of v1 for its own reason. */
  excluded: "REMOTE_TOOL_EXCLUDED_FROM_V1",
  /** Real tool, wrong credential type. NEVER an empty result. */
  authMode: "ATLASSIAN_TOOL_UNAVAILABLE_IN_AUTH_MODE",
} as const;

export interface AtlassianPolicyOptions {
  /** Which credential this connection holds. WARP-2316 ships the API-token
   *  path; `oauth` exists so the matrix is expressible, not because a v1 box
   *  can produce one. */
  authMode: AtlassianAuthMode;
  /** Server id to police. Defaults to {@link ATLASSIAN_SERVER_ID}; overridable
   *  only so a test can prove the policy ignores other servers. */
  serverId?: string;
  /** What to do with a call to any OTHER remote server. Defaults to denying it
   *  as unclassified — this policy speaks for Atlassian and must not
   *  accidentally become a blanket allow for a second server somebody attaches
   *  later. */
  fallback?: RemoteCallPolicy;
}

/**
 * Build the Atlassian {@link RemoteCallPolicy}.
 *
 * Refusal order, and each step answers a different operator question:
 *
 *   1. **not this server** → the fallback (deny-all by default).
 *   2. **not in the table** → `REMOTE_TOOL_NOT_CLASSIFIED`. Covers the JSM and
 *      Bitbucket hole, every tool Atlassian adds after this table was
 *      recorded, and every name a model invents.
 *   3. **wrong auth mode** → `ATLASSIAN_TOOL_UNAVAILABLE_IN_AUTH_MODE`,
 *      checked BEFORE the grade so an operator asking "why can't I read
 *      Compass" gets the true reason rather than a write refusal.
 *   4. **excluded** → its own code, carrying the row's note.
 *   5. **write or destructive** → `REMOTE_WRITE_NOT_PERMITTED`.
 *   6. otherwise allow.
 */
export function createAtlassianRemoteCallPolicy(
  opts: AtlassianPolicyOptions,
): RemoteCallPolicy {
  const serverId = opts.serverId ?? ATLASSIAN_SERVER_ID;
  const fallback = opts.fallback;

  return (input) => {
    if (input.serverId !== serverId) {
      return (
        fallback?.(input) ?? {
          kind: "deny",
          code: ATLASSIAN_DENY_CODES.notClassified,
          message:
            `'${input.namespacedName}' belongs to remote server '${input.serverId}', ` +
            "which has no classification table on this box. Do not retry.",
        }
      );
    }
    return classifyAtlassianCall(input.wireName, input.namespacedName, opts.authMode);
  };
}

/** The decision, separated from the policy plumbing so it is directly
 *  testable and so a future operator surface can render it. */
export function classifyAtlassianCall(
  wireName: string,
  namespacedName: string,
  authMode: AtlassianAuthMode,
): RemoteCallDecision {
  return classifyAtlassianRow(ATLASSIAN_TOOL_INDEX.get(wireName), namespacedName, authMode);
}

/**
 * The decision for ONE row (or for no row at all).
 *
 * Split out from {@link classifyAtlassianCall} so a test can hand it a row the
 * shipped table does not contain — specifically a write row mis-marked
 * `v1: "allowed"`. That case cannot occur on today's table, which is precisely
 * why it needs asserting: it is the one a future edit would introduce, and the
 * grade check below is the second of two independent layers that refuse it
 * (the first being {@link v1ReadToolsOf}).
 */
export function classifyAtlassianRow(
  row: AtlassianToolClassification | undefined,
  namespacedName: string,
  authMode: AtlassianAuthMode,
): RemoteCallDecision {
  if (!row) {
    return {
      kind: "deny",
      code: ATLASSIAN_DENY_CODES.notClassified,
      message:
        `'${namespacedName}' is not in this box's Atlassian classification table, ` +
        "so no operator has reviewed what it does (ADR-043 §2). Do not retry; " +
        "answer without it.",
    };
  }

  if (!ATLASSIAN_PRODUCT_AUTH_MODES[row.product].includes(authMode)) {
    return {
      kind: "deny",
      code: ATLASSIAN_DENY_CODES.authMode,
      message:
        `'${namespacedName}' is an Atlassian ${row.product} tool, and ${row.product} ` +
        `tools are not reachable on a ${authMode} connection. This is a property of ` +
        "the credential, not of the data: the tool exists and this connection " +
        "cannot use it. Do not retry, and do not report the result as empty.",
    };
  }

  if (row.v1 === "excluded") {
    return {
      kind: "deny",
      code: ATLASSIAN_DENY_CODES.excluded,
      message:
        `'${namespacedName}' is deliberately excluded from this release. ` +
        (row.note ?? "") +
        " Do not retry.",
    };
  }

  if (row.grade !== "read") {
    return {
      kind: "deny",
      code: ATLASSIAN_DENY_CODES.writeBlocked,
      message:
        `'${namespacedName}' is classified as a ${row.grade}. Remote writes are ` +
        "blocked on this box until the runtime deny tier ships (ADR-043 §3). " +
        "Do not retry; tell the user the change was not made.",
    };
  }

  return { kind: "allow" };
}
