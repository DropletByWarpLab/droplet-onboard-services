/**
 * WARP-2339 — the pagination guard for a server that lies about having
 * finished.
 *
 * ## Upstream #221, stated exactly
 *
 * `searchJiraIssuesUsingJql` hard-caps its result at **5 nodes** regardless of
 * the requested page size, and then reports the page as complete:
 * `hasNextPage: false`, `endCursor: null` — while `remainingCount` is
 * non-zero. So the three fields a paginating caller would read all say "that
 * was everything", and one field that a caller would not think to read says it
 * was not.
 *
 * ## Why this is a typed error rather than a warning
 *
 * ADR-041's rule, inherited unchanged by ADR-043 §1: *"None of the three may
 * ever render as an empty result"* — a degraded read must not be presented as
 * a complete one. Here the degradation is worse than empty, because 5 issues
 * of 240 look exactly like "there are 5 issues", and an agent asked "how many
 * open bugs are there" would answer five with total confidence.
 *
 * So the call FAILS, with the partial payload attached. A caller that wants
 * the five rows can take them off {@link TruncatedResultError.partial} and say
 * so; a caller that does nothing gets an error instead of a wrong answer. The
 * default has to be the safe one.
 *
 * ## Why the detection is `remainingCount`-first
 *
 * `hasNextPage` and `endCursor` are the fields the defect corrupts, so they
 * cannot be the evidence. `remainingCount > 0` is the one field that stays
 * honest, and a node count at exactly the documented cap is corroboration
 * rather than the trigger — a genuine 5-result search must not be refused.
 */
import type { RemoteToolCallOutcome } from "./remote-session.js";

/**
 * The node cap upstream #221 reports for `searchJiraIssuesUsingJql`.
 * Documented for the error message; the guard does not key on it (see the
 * module header).
 */
export const ATLASSIAN_SEARCH_NODE_CAP = 5;

/** Thrown when a paginated result claimed to be complete and was not. */
export class TruncatedResultError extends Error {
  readonly code = "REMOTE_RESULT_TRUNCATED";
  constructor(
    readonly toolName: string,
    readonly returned: number,
    readonly remaining: number,
    /** The partial payload, so a caller can render "5 of 245" rather than
     *  losing the rows it did get. */
    readonly partial: RemoteToolCallOutcome,
  ) {
    super(
      `'${toolName}' returned ${returned} result(s) and reported the page complete, ` +
        `but ${remaining} more remain. Upstream atlassian/atlassian-mcp-server#221: ` +
        `the server caps at ${ATLASSIAN_SEARCH_NODE_CAP} nodes and still sends ` +
        "hasNextPage:false with endCursor:null. This result is NOT the whole answer — " +
        "narrow the query rather than reporting a total from it.",
    );
    this.name = "TruncatedResultError";
  }
}

/** The page shape the guard reads. Every field optional: a tool that paginates
 *  differently, or not at all, simply supplies none of them. */
interface PageInfoLike {
  hasNextPage?: unknown;
  endCursor?: unknown;
  remainingCount?: unknown;
  nodes?: unknown;
}

/**
 * Throw {@link TruncatedResultError} when `outcome` is a page that under-reports.
 *
 * Reads `structuredContent` first and falls back to parsing the first text
 * block as JSON, because #213 means `structuredContent` may be withheld
 * entirely — and a guard that only worked on the enriched response would be
 * off exactly when the response is already degraded.
 *
 * An `isError` outcome is exempt: a failed call has no page to be honest about.
 */
export function assertNotTruncated(
  toolName: string,
  outcome: RemoteToolCallOutcome,
): void {
  if (outcome.isError) return;
  const page = pageInfoOf(outcome);
  if (!page) return;

  const remaining = asNonNegativeInteger(page.remainingCount);
  if (remaining === null || remaining === 0) return;

  // `remainingCount > 0` alone is not the defect — a server that also said
  // `hasNextPage: true` is paginating honestly and the caller can follow it.
  // The defect is the contradiction.
  if (page.hasNextPage === true) return;

  const returned = Array.isArray(page.nodes) ? page.nodes.length : 0;
  throw new TruncatedResultError(toolName, returned, remaining, outcome);
}

function pageInfoOf(outcome: RemoteToolCallOutcome): PageInfoLike | null {
  const fromStructured = asPageInfo(outcome.structuredContent);
  if (fromStructured) return fromStructured;
  for (const block of outcome.content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(block.text);
      const page = asPageInfo(parsed);
      if (page) return page;
    } catch {
      // Not JSON. Prose is the common case and is not a failure.
    }
  }
  return null;
}

/**
 * Recognise a page object, whether its fields sit at the top level or one
 * level down under `pageInfo` — or, as #221's own payload does, SPLIT across
 * both (`remainingCount` beside `pageInfo`, `hasNextPage` inside it).
 *
 * The split case is why this merges rather than picking a level: reading only
 * the level where `remainingCount` happened to be would have made an honestly
 * paginating page (`hasNextPage: true` nested) look like the defect.
 *
 * Deliberately ONE level deep. An unbounded walk would start finding
 * `remainingCount` on nested objects that are not the page being returned.
 */
function asPageInfo(value: unknown): PageInfoLike | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  const nestedRaw = rec.pageInfo;
  const nested: Record<string, unknown> =
    typeof nestedRaw === "object" && nestedRaw !== null
      ? (nestedRaw as Record<string, unknown>)
      : {};
  // `pageInfo` wins for the fields it declares: it is the page's own record of
  // itself, and the outer object may be carrying an unrelated same-named key.
  const merged = { ...rec, ...nested };
  if (!hasPageFields(merged)) return null;
  return {
    hasNextPage: merged.hasNextPage,
    endCursor: merged.endCursor,
    remainingCount: merged.remainingCount,
    // `nodes` sits BESIDE `pageInfo`, not inside it, in the connection shape
    // Atlassian's GraphQL-derived tools return.
    nodes: rec.nodes ?? nested.nodes,
  };
}

function hasPageFields(rec: Record<string, unknown>): boolean {
  return "remainingCount" in rec || "hasNextPage" in rec;
}

function asNonNegativeInteger(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}
