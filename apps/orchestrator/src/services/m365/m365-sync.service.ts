/**
 * WARP-2118 / ADR-041 — the Microsoft 365 delta sync engine.
 *
 * ## What this is
 *
 * The loop that finally joins the five modules WARP-2115 shipped without a
 * caller: {@link getAccessToken} resolves the grant, {@link GraphClient} makes
 * the request, {@link classifySyncFailure} reads the failure,
 * {@link computeBackoffMs} times the retry, and `delta-cursor.service.ts`
 * moves the cursor. Every decision in that list already had a home and a test;
 * none of them had anything that called them in sequence. This module is that
 * sequence and deliberately adds no new decisions of its own.
 *
 * ## The page loop, and the one rule that makes it correct
 *
 * A delta run is a sequence of pages. Mid-run, Graph returns
 * `@odata.nextLink`; on the LAST page it returns `@odata.deltaLink`, which is
 * the token for the *next* run. The rule that matters:
 *
 *   **The cursor advances only when a run reaches its `deltaLink`.**
 *
 * A run that fails on page 4 of 9 must NOT persist page 4's `nextLink` as the
 * cursor. `nextLink` is a position inside one enumeration, not a resumable
 * watermark — storing it would make the next tick continue an enumeration
 * whose earlier pages were never processed, and the skipped records would never
 * be seen again by any incremental pass. The failure path therefore leaves
 * `deltaLink` exactly as it was and lets the whole run repeat, which is why
 * page handling must tolerate seeing the same item twice (it is an upsert
 * keyed on the vendor id, never an append).
 *
 * ## What it does with what it reads — nothing, on purpose
 *
 * `handlePage` is injected and the shipped caller counts. This is not an
 * unfinished edge; it is ADR-041 §4 as amended by WARP-2549. That section
 * forbids becoming the first writer of `ErpEntityCache`, whose docstring
 * promises an at-rest encryption that **is not implemented** (WARP-2028) —
 * writing mail there would ship a lie about how the data is protected. The
 * narrow reading WARP-2549 settled permits landing into tables that make no
 * such claim, which is how HubSpot's companies and contacts land today.
 *
 * So the engine is complete and the landing target is a separate decision per
 * workload, taken where the schema for it exists. Until then this runs the
 * cursors, proves the transport, and advances `lastSyncedAt` — which is the
 * column the hub renders as "last synced" and which, before WARP-2218, was
 * only ever written by `connect()`.
 *
 * ## Concurrency
 *
 * One cursor at a time per call, and `claimDueCursors` excludes `SYNCING`, so
 * two ticks cannot overlap on one cursor and double-write. The tick itself is
 * registered on `cron-runtime` by the caller — never a `while (true)`, which is
 * a hard rule for scheduling in this repo.
 */
import type { PrismaClient } from "@prisma/client";

import {
  getAccessToken,
  M365NotConnectedError,
  type EntraClient,
} from "./m365-auth.service.js";
import {
  GRAPH_API_BASE_URL,
  GraphClient,
  GraphRequestError,
  type GraphPage,
} from "./graph-client.js";
import {
  claimDueCursors,
  recordFailure,
  recordSuccess,
  upsertCursor,
  type DueCursor,
} from "./delta-cursor.service.js";
import {
  GRAPH_RESOURCES,
  M365_WORKLOADS,
  SINGLETON_RESOURCE,
  discoveryUrlFor,
} from "./graph-resources.js";

/**
 * How many pages one cursor may walk in a single tick.
 *
 * A first enumeration of a large mailbox is thousands of pages; walking them
 * all in one tick would hold the tick open for minutes and starve every other
 * cursor behind it. Stopping early is safe **only** because of the rule above:
 * an unfinished run persists nothing, so the next tick repeats it from the last
 * `deltaLink`. That makes this a fairness bound, not a correctness one — but it
 * does mean a very large first sync makes progress only when it can finish
 * within the bound, which is why the number is generous rather than small.
 *
 * 🔴 If this is ever lowered to a value a first enumeration cannot complete
 * within, that mailbox never syncs at all and nothing reports a fault. Any
 * change here needs the resumable-run design that does not exist yet.
 */
export const MAX_PAGES_PER_TICK = 200;

/** Outcome of one cursor's run, for logging and for the tick's summary. */
export interface CursorSyncResult {
  cursorId: string;
  workload: string;
  /** Items seen across every page of this run. */
  items: number;
  pages: number;
  /** True when the run reached its `deltaLink` and the cursor advanced. */
  completed: boolean;
  /** Set when the run failed; already redacted by `recordFailure`. */
  error?: string;
}

/** What a caller does with a page of changes. Injected — see the module header. */
export type PageHandler = (
  cursor: DueCursor,
  page: GraphPage,
) => Promise<void> | void;

export interface M365SyncDeps {
  prisma: PrismaClient;
  client: GraphClient;
  /**
   * The Entra port. Required because `getAccessToken` refreshes THROUGH it —
   * an access token lives about an hour and a sync tick runs indefinitely, so
   * a client that could not refresh would work for one hour after every
   * reconnect and then stop.
   */
  entra: EntraClient;
  /**
   * The URL a run starts from when the cursor has no `deltaLink` — i.e. a first
   * sync or a resync. Injected rather than looked up here so the endpoint table
   * (which is vendor fact, verified against Microsoft's reference) stays in one
   * module and this one stays pure control flow.
   *
   * Returning `null` means "this build does not know how to enumerate that
   * workload", which is refused loudly rather than skipped silently.
   */
  initialUrlFor: (workload: string, resourceId: string) => string | null;
  handlePage?: PageHandler;
  now?: () => Date;
}

/**
 * Run one cursor to completion, or to the page bound, or to its first failure.
 *
 * Never throws for an expected failure: a dead grant, a dead delta token and a
 * throttle are all recorded on the cursor and returned as a result. The caller
 * is a scheduler tick, and one person's revoked mailbox must not abort every
 * other person's sync.
 */
export async function syncCursor(
  deps: M365SyncDeps,
  cursor: DueCursor,
): Promise<CursorSyncResult> {
  const now = deps.now ?? (() => new Date());
  const base: CursorSyncResult = {
    cursorId: cursor.id,
    workload: cursor.workload,
    items: 0,
    pages: 0,
    completed: false,
  };

  let url: string | null = cursor.deltaLink;
  if (!url) {
    url = deps.initialUrlFor(cursor.workload, cursor.resourceId);
    if (!url) {
      // Absence is never a silent success. A cursor naming a workload this
      // build cannot enumerate is a real fault — most likely a row written by
      // a newer build — and it must be visible rather than quietly idle.
      await recordFailure(
        deps.prisma,
        cursor.id,
        { statusCode: 0, code: "UNSUPPORTED_WORKLOAD", message: cursor.workload },
        null,
        now(),
      );
      return { ...base, error: `no enumeration is defined for workload "${cursor.workload}"` };
    }
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(deps.prisma, deps.entra, cursor.userId, now());
  } catch (err) {
    // A dead or missing grant. `classifySyncFailure` maps this to AUTH, which
    // `recordFailure` treats as a CONNECTION-level problem — the cursor is not
    // marked broken, because every other cursor for this person shares the
    // same dead grant and marking each one would turn a single reconnect into
    // a storm of pointless calls.
    const shaped =
      err instanceof M365NotConnectedError
        ? { statusCode: 401, code: "InvalidAuthenticationToken", message: "not connected" }
        : { statusCode: 401, code: "InvalidAuthenticationToken", message: "token unavailable" };
    await recordFailure(deps.prisma, cursor.id, shaped, null, now());
    return { ...base, error: "the Microsoft 365 connection needs to be reconnected" };
  }

  let items = 0;
  let pages = 0;

  while (url && pages < MAX_PAGES_PER_TICK) {
    let page: GraphPage;
    try {
      page = await deps.client.getPage(url, accessToken);
    } catch (err) {
      const shaped =
        err instanceof GraphRequestError
          ? { statusCode: err.statusCode, code: err.code, message: err.message }
          : { statusCode: 0, code: "ECONNRESET", message: "the sync request failed" };
      // The RAW header travels through: `recordFailure` parses it against its
      // own clock, and Microsoft's Retry-After is obeyed exactly because a
      // throttled request still spends the tenant's budget.
      const retryAfter = err instanceof GraphRequestError ? err.retryAfterHeader : null;
      await recordFailure(deps.prisma, cursor.id, shaped, retryAfter, now());
      return {
        ...base,
        items,
        pages,
        error: err instanceof Error ? err.message : "the sync request failed",
      };
    }

    pages += 1;
    items += page.items.length;

    if (deps.handlePage) {
      // A handler that throws must not advance the cursor: the page was read
      // but not stored, and advancing would drop it permanently. Treated as a
      // run failure so the whole run repeats from the last good deltaLink.
      try {
        await deps.handlePage(cursor, page);
      } catch (err) {
        await recordFailure(
          deps.prisma,
          cursor.id,
          { statusCode: 0, code: "HANDLER_FAILED", message: "page handling failed" },
          null,
          now(),
        );
        return {
          ...base,
          items,
          pages,
          error: err instanceof Error ? err.message : "page handling failed",
        };
      }
    }

    if (page.links.deltaLink) {
      // The run finished. THIS is the only place a cursor advances.
      await recordSuccess(deps.prisma, cursor.id, page.links.deltaLink, now());
      return { ...base, items, pages, completed: true };
    }

    url = page.links.nextLink;
  }

  // Ran out of page budget mid-enumeration, or Graph returned neither link.
  // Nothing is persisted: the next tick repeats this run from the same starting
  // point. See the module header for why persisting `nextLink` here would be a
  // silent data-loss bug rather than an optimisation.
  return { ...base, items, pages, completed: false };
}

/** Summary of one scheduler tick. */
export interface SyncTickResult {
  cursorsClaimed: number;
  cursorsCompleted: number;
  itemsSeen: number;
  results: CursorSyncResult[];
}

/**
 * One scheduler tick: claim what is due and run each cursor in turn.
 *
 * Sequential rather than concurrent, deliberately. Graph's throttling is
 * per-mailbox AND per-tenant, and a box syncing several connected people in one
 * organisation shares that tenant budget — firing every cursor at once is the
 * fastest way to earn a 429 that then applies to all of them. The budget is
 * generous for a paced reader (Outlook allows thousands of requests per
 * mailbox per ten minutes) and hostile to a burst.
 */
export async function runSyncTick(
  deps: M365SyncDeps,
  limit = 25,
): Promise<SyncTickResult> {
  const now = deps.now ?? (() => new Date());
  const due = await claimDueCursors(deps.prisma, limit, now());

  const results: CursorSyncResult[] = [];
  for (const cursor of due) {
    results.push(await syncCursor(deps, cursor));
  }

  return {
    cursorsClaimed: due.length,
    cursorsCompleted: results.filter((r) => r.completed).length,
    itemsSeen: results.reduce((sum, r) => sum + r.items, 0),
    results,
  };
}

// ---------------------------------------------------------------------------
// Resource discovery
// ---------------------------------------------------------------------------

/**
 * How deep the folder walk descends.
 *
 * Mail and contact folders nest arbitrarily, and a cycle in the graph — or a
 * pathological tree — must not turn discovery into an unbounded crawl of the
 * customer's mailbox on every tick. Ten is far past any real filing habit; a
 * tree deeper than this loses only the deepest folders, and `skipped` says so
 * rather than the walk silently appearing complete.
 */
export const MAX_FOLDER_DEPTH = 10;

/** One folder found by the walk. */
interface FoundFolder {
  id: string;
  hasChildren: boolean;
}

/**
 * Read one page-set of folders, following `@odata.nextLink`.
 *
 * Returns the ids plus whether each has children, which is what decides
 * recursion. `childFolderCount` is the documented field; a folder that does not
 * publish it is treated as HAVING children, because descending needlessly costs
 * one request and not descending loses every folder beneath it.
 */
async function listFolders(
  deps: M365SyncDeps,
  url: string,
  accessToken: string,
): Promise<FoundFolder[]> {
  const found: FoundFolder[] = [];
  let next: string | null = url;
  let pages = 0;

  while (next && pages < MAX_PAGES_PER_TICK) {
    const page: GraphPage = await deps.client.getPage(next, accessToken);
    pages += 1;
    for (const item of page.items) {
      const id = item.id;
      // A removed folder arrives as an `@removed` entry. Registering a cursor
      // for it would create a row that fails forever; an EXISTING cursor is
      // left alone rather than deleted, because its delta link is still the
      // cheapest way to learn the folder came back.
      if (typeof id !== "string" || id === "" || "@removed" in item) continue;
      const count = item.childFolderCount;
      found.push({ id, hasChildren: typeof count === "number" ? count > 0 : true });
    }
    next = page.links.nextLink;
  }

  return found;
}

/**
 * Register a cursor for every resource this person has, in every workload.
 *
 * Runs on every tick, not once at connect, and that is load-bearing: mail delta
 * is per-folder, so a folder created after the connection was made has no
 * cursor and its mail is invisible to the sync until discovery notices it.
 * `upsertCursor` is written to touch nothing on an existing row precisely so
 * this can run repeatedly — re-discovery is not new information, and clobbering
 * a delta link here would re-download the whole mailbox every tick.
 *
 * 🔴 **The walk is RECURSIVE, and that is a correction rather than a
 * refinement.** Microsoft documents that listing `/me/mailFolders` returns
 * *"only the child folders of the root folder"* and, by default, no hidden
 * folders. A flat discovery registers the top level only, so mail filed in any
 * nested folder is never enumerated — and nothing reports a fault, because
 * every cursor that does exist keeps succeeding. The failure is invisible by
 * construction, which is why the recursion is not an optimisation.
 *
 * Failure is per-workload and non-fatal. A tenant with no Exchange Online
 * licence has no mailbox to enumerate, and that must not stop OneDrive from
 * syncing — so a workload that refuses is skipped, not propagated.
 */
export async function discoverResources(
  deps: M365SyncDeps,
  userId: string,
): Promise<{ registered: number; skipped: string[] }> {
  const now = deps.now ?? (() => new Date());

  let accessToken: string;
  try {
    accessToken = await getAccessToken(deps.prisma, deps.entra, userId, now());
  } catch {
    return { registered: 0, skipped: [...M365_WORKLOADS] };
  }

  let registered = 0;
  const skipped: string[] = [];

  for (const workload of M365_WORKLOADS) {
    const spec = GRAPH_RESOURCES[workload];
    const discovery = discoveryUrlFor(workload);

    // A workload with one implicit resource — the drive root, the calendar
    // view. One cursor, no enumeration.
    if (!discovery) {
      await upsertCursor(deps.prisma, userId, workload, SINGLETON_RESOURCE);
      registered += 1;
      continue;
    }

    try {
      // Breadth-first, depth-bounded. Each level's children are fetched from
      // the child collection, which is the only documented way to see past the
      // root's immediate children.
      let frontier = await listFolders(deps, discovery, accessToken);
      let depth = 0;

      while (frontier.length > 0 && depth < MAX_FOLDER_DEPTH) {
        const nextFrontier: FoundFolder[] = [];

        for (const folder of frontier) {
          await upsertCursor(deps.prisma, userId, workload, folder.id);
          registered += 1;

          if (folder.hasChildren && spec.childCollectionPath) {
            const childUrl = `${GRAPH_API_BASE_URL}${spec.childCollectionPath(folder.id)}`;
            nextFrontier.push(...(await listFolders(deps, childUrl, accessToken)));
          }
        }

        frontier = nextFrontier;
        depth += 1;
      }

      // The bound was hit with folders still unvisited. Reported rather than
      // passed over — a truncated walk that looks complete is the same class of
      // silent gap the recursion exists to close.
      if (frontier.length > 0) skipped.push(`${workload} (deeper than ${MAX_FOLDER_DEPTH})`);
    } catch {
      // Most often a licence gap (no mailbox) or a scope the owner declined.
      // Named in the result so a caller can report it, never thrown.
      skipped.push(workload);
    }
  }

  return { registered, skipped };
}
