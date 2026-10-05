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
 * ## Runs longer than one tick (WARP-3059)
 *
 * A run that exhausts its page budget is different from one that FAILED: every
 * page it read was handled. So it stores the `nextLink` of its last handled
 * page as `resumeLink` — a checkpoint in its own column, never in `deltaLink`,
 * so the rule above still holds — and the next tick continues from there. A
 * failure keeps the last checkpoint (the pages before it were handled); a
 * resync clears it with the delta link. Without this, a folder over the budget
 * re-read the same pages every tick and never produced a deltaLink.
 *
 * ## What it does with what it reads — a decision per workload
 *
 * `handlePage` is injected, and the landing target is a separate decision per
 * workload, taken where the schema for it exists. This is ADR-041 §4 as amended
 * by WARP-2549: the engine must not become the first writer of
 * `ErpEntityCache`, whose docstring promises an at-rest encryption that **is
 * not implemented** (WARP-2028) — writing mail there would ship a lie about how
 * the data is protected.
 *
 * The shipped caller lands `files` (OneDrive) and `sharepoint` (one cursor per
 * document library) as METADATA into the
 * provider-agnostic cloud-file store with its names encrypted
 * (`drive-landing.service.ts`, WARP-3538), and explicitly enabled `calendar`
 * events into the person's external calendar source, and explicitly enabled
 * `mail` bodies into their local email archive. Every other workload is still
 * counted and discarded: this runs its cursors, proves the transport, and
 * advances `lastSyncedAt` — the column the hub renders as "last synced" and
 * which, before WARP-2218, was only ever written by `connect()`.
 *
 * What the engine owes a handler that LANDS is the one fact it alone knows: where
 * in an enumeration a page sits. A run that starts from scratch returns the
 * current state and says nothing about what was deleted, so the handler sweeps —
 * and it can only do that if it is told when a full enumeration starts and ends
 * (`PageContext`).
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
  markNeedsReconnect,
  type EntraClient,
  type M365GrantGeneration,
} from "./m365-auth.service.js";
import {
  classifySyncFailure,
  HANDLER_FAILED_CODE,
  TOKEN_UNAVAILABLE_CODE,
} from "./sync-policy.js";
import {
  GRAPH_API_BASE_URL,
  GraphClient,
  GraphRequestError,
  type GraphPage,
} from "./graph-client.js";
import {
  claimDueCursors,
  recordCheckpoint,
  recordFailure,
  recordSuccess,
  upsertCursor,
  type DueCursor,
} from "./delta-cursor.service.js";
import {
  FOLLOWED_SITES_PATH,
  GRAPH_RESOURCES,
  M365_WORKLOADS,
  ONEDRIVE_DRIVE_PATH,
  SHAREPOINT_SITE_SEARCH_PATH,
  SINGLETON_RESOURCE,
  discoveryUrlFor,
  grantCovers,
  parseOneDrive,
  parseSharePointLibrary,
  parseSharePointSite,
  siteDrivesPath,
  type SharePointLibrary,
  type SharePointSite,
} from "./graph-resources.js";
import { ensureSource, findSourceId, upsertSource } from "../cloud-files/cloud-file-store.service.js";
import { pruneSharePointLibraries, purgeSharePointDataForUser } from "./drive-data.service.js";
import { ensureMicrosoftCalendarCursor, recordMicrosoftCalendarFailure } from "./calendar-landing.service.js";
import { ensureMicrosoftMailFolder, recordMicrosoftMailFailure, setMicrosoftMailEnabled } from "./mail-settings.service.js";

/**
 * How many pages one cursor may walk in a single tick.
 *
 * A first enumeration of a large mailbox is thousands of pages; walking them
 * all in one tick would hold the tick open for minutes and starve every other
 * cursor behind it. A run that reaches the bound checkpoints its position
 * (`resumeLink`, WARP-3059) and the next tick continues it, so this is a
 * fairness bound only: an enumeration of any size completes, over as many
 * ticks as it needs.
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
  /** WARP-3059 — true when the run hit the page budget and stored where the
   *  next tick resumes. */
  checkpointed?: boolean;
  /** Set when the run failed; already redacted by `recordFailure`. */
  error?: string;
}

/**
 * Where a page sits in the enumeration it belongs to — the one fact only the
 * engine knows, and the one a handler that LANDS needs to remove what is gone.
 *
 * A run that starts from scratch (a first sync, or a resync after Microsoft
 * dropped the token) returns the CURRENT state and says nothing about what was
 * deleted in between, so a handler must delete what such a run did not return.
 * It can only do that if it is told when a full enumeration starts and when it
 * ends — and "ends" is not "this tick ends": a big source takes many ticks, each
 * resuming from a checkpoint (WARP-3059).
 *
 *   - `fullEnumeration` — the enumeration this page belongs to began from
 *     scratch: the cursor had no delta link when it was claimed. True for a first
 *     sync, a resync, and every tick that RESUMES one; false for an incremental
 *     run (and for resuming one), which must never delete anything the feed did
 *     not say was deleted.
 *   - `isFirstPage` — the first page of the enumeration, read in THIS tick: a
 *     tick that resumes from a checkpoint never sees it, because the first page
 *     was read by an earlier tick.
 *   - `isLastPage` — the page that carries the delta link, wherever in the
 *     enumeration's ticks it falls. It may carry no items at all.
 *
 * Computed from the cursor as it was CLAIMED, never from what the run has done
 * since: a page that fails and is retried is told the same thing it was told
 * the first time, which is what makes a handler's mark and sweep idempotent.
 */
export interface PageContext {
  readonly fullEnumeration: boolean;
  readonly isFirstPage: boolean;
  readonly isLastPage: boolean;
  /** Ephemeral handler credentials, never stored or logged. */
  readonly accessToken?: string;
  readonly grantGeneration?: M365GrantGeneration;
}

/** What a caller does with a page of changes. Injected — see the module header. */
export type PageHandler = (
  cursor: DueCursor,
  page: GraphPage,
  run: PageContext,
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
  /** Workspace module choices stop the corresponding provider reads. */
  calendarModuleEnabled?: boolean;
  mailModuleEnabled?: boolean;
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

  if (cursor.workload === "mail") {
    if (deps.mailModuleEnabled === false) return { ...base, error: "Email capability is disabled." };
    const connection = await deps.prisma.m365Connection.findUnique({ where: { userId: cursor.userId },
      select: { state: true, mailEnabled: true, emailAccountId: true, grantedScopes: true } });
    if (connection?.state !== "CONNECTED" || connection.mailEnabled !== true || !connection.emailAccountId) return { ...base, error: "Outlook email import is off." };
    if (!grantCovers((connection.grantedScopes ?? "").split(/\s+/).filter(Boolean), GRAPH_RESOURCES.mail.leastPrivilegeScope)) return { ...base, error: "Outlook email permission needs reconnecting." };
  }

  if (cursor.workload === "calendar") {
    if (deps.calendarModuleEnabled === false) return { ...base, error: "Calendar capability is disabled." };
    const connection = await deps.prisma.m365Connection.findUnique({ where: { userId: cursor.userId },
      select: { state: true, calendarEnabled: true, calendarSourceId: true, grantedScopes: true } });
    if (connection?.state !== "CONNECTED" || connection.calendarEnabled !== true || !connection.calendarSourceId) return { ...base, error: "Outlook calendar import is off." };
    if (!grantCovers((connection.grantedScopes ?? "").split(/\s+/).filter(Boolean), GRAPH_RESOURCES.calendar.leastPrivilegeScope)) return { ...base, error: "Outlook calendar permission needs reconnecting." };
  }
  if (cursor.cursorLinkHash !== undefined) {
    const connection = await deps.prisma.m365Connection.findUnique({ where: { userId: cursor.userId }, select: { state: true, cursorLinkHash: true } });
    if (connection?.state !== "CONNECTED" || connection.cursorLinkHash !== cursor.cursorLinkHash) return { ...base, error: "The Microsoft connection changed." };
  }

  // A checkpoint from a run the page budget cut short takes precedence: the
  // pages before it were handled, and starting over would re-read them.
  let url: string | null = cursor.resumeLink ?? cursor.deltaLink;
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
  let generation: M365GrantGeneration | undefined;
  try {
    accessToken = await getAccessToken(deps.prisma, deps.entra, cursor.userId, now(), (current) => { generation = current; });
  } catch (err) {
    if (err instanceof M365NotConnectedError) {
      // A dead or missing grant. `classifySyncFailure` maps this to AUTH,
      // which `recordFailure` treats as a CONNECTION-level problem — the
      // cursor is not marked broken, because every other cursor for this
      // person shares the same dead grant and marking each one would turn a
      // single reconnect into a storm of pointless calls. The auth service
      // has already moved the connection row itself before throwing.
      await recordFailure(
        deps.prisma,
        cursor.id,
        { statusCode: 401, code: "InvalidAuthenticationToken", message: "not connected" },
        null,
        now(),
      );
      return { ...base, error: "the Microsoft 365 connection needs to be reconnected" };
    }
    // Anything else is NOT an auth verdict — a database read that failed, a
    // cache the box could not open this second — and must not be dressed up
    // as one: a synthetic 401 would tell the responder to reconnect a grant
    // that is fine, and hide the real error. Park the cursor, keep the real
    // message for the log, retry on the backoff.
    await recordFailure(
      deps.prisma,
      cursor.id,
      { statusCode: 0, code: TOKEN_UNAVAILABLE_CODE, message: "token unavailable" },
      null,
      now(),
    );
    return {
      ...base,
      error: err instanceof Error ? err.message : "the access token could not be produced",
    };
  }

  if (generation && cursor.cursorLinkHash !== undefined && generation.cursorLinkHash !== cursor.cursorLinkHash) return { ...base, error: "The Microsoft connection changed." };
  if (cursor.workload === "mail") {
    const current = await deps.prisma.m365Connection.findUnique({ where: { userId: cursor.userId }, select: { state: true, mailEnabled: true, emailAccountId: true, grantedScopes: true } });
    if (current?.state !== "CONNECTED" || !current.mailEnabled || !current.emailAccountId || !grantCovers((current.grantedScopes ?? "").split(/\s+/).filter(Boolean), GRAPH_RESOURCES.mail.leastPrivilegeScope)) return { ...base, error: "Outlook email import needs a connected mailbox and permission." };
  }
  let items = 0;
  let pages = 0;

  // Read off the cursor as CLAIMED (see `PageContext`): a full enumeration is
  // one that began with no delta link, and its first page is only ever read by a
  // tick that did not start from a checkpoint.
  const fullEnumeration = cursor.deltaLink === null;
  const resuming = cursor.resumeLink !== null;

  while (url && pages < MAX_PAGES_PER_TICK) {
    let page: GraphPage;
    try {
      page = await deps.client.getPage(url, accessToken, cursor.workload === "mail" ? { mail: true } : {});
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
      if (cursor.workload === "calendar") await recordMicrosoftCalendarFailure(deps.prisma, cursor.userId, classifySyncFailure(shaped) === "AUTH", generation);
      if (cursor.workload === "mail") await recordMicrosoftMailFailure(deps.prisma, cursor.userId, classifySyncFailure(shaped) === "AUTH", generation);
      // 🔴 A 403 on a SHAREPOINT cursor is not a dead grant. Losing access to one
      // library — a site's permissions changed, the library was locked or
      // deleted, a policy applies to that one site — answers 403 for that
      // library's drive while every other call with the same token succeeds.
      // `markNeedsReconnect` would move the WHOLE connection (mail, calendar,
      // OneDrive) to NEEDS_RECONNECT and stop its sync because one person lost
      // one library. The cursor still records its own failure above and backs
      // off; a COMPLETE discovery prunes the library once Microsoft stops listing
      // it. A 401 is different: the token itself was refused, which no single
      // library can cause, so it still reconnects.
      const lostOneLibrary = cursor.workload === "sharepoint" && shaped.statusCode === 403;
      if (classifySyncFailure(shaped) === "AUTH" && !lostOneLibrary) {
        // The token refreshed fine and Graph still refused it — resource
        // access revoked, a conditional-access policy, a tenant change. The
        // refresh path never sees this, so nothing else would ever move the
        // connection off CONNECTED: the cursor would back off forever while
        // the dashboard kept saying the link was healthy. Say so on the row
        // the dashboard reads, and audit it as the box's discovery.
        await markNeedsReconnect(
          deps.prisma,
          cursor.userId,
          "Microsoft rejected the sync's access to this account.",
          ...(generation ? [generation] as const : [] as const),
        );
      }
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
        await deps.handlePage(cursor, page, {
          fullEnumeration,
          isFirstPage: pages === 1 && !resuming,
          isLastPage: page.links.deltaLink !== null,
          ...(cursor.workload === "mail" ? { accessToken, grantGeneration: generation } : {}),
        });
      } catch (err) {
        const shaped = err instanceof GraphRequestError
          ? { statusCode: err.statusCode, code: err.code, message: err.message }
          : { statusCode: 0, code: HANDLER_FAILED_CODE, message: "page handling failed" };
        await recordFailure(
          deps.prisma,
          cursor.id,
          shaped,
          err instanceof GraphRequestError ? err.retryAfterHeader : null,
          now(),
        );
        if (cursor.workload === "calendar") await recordMicrosoftCalendarFailure(deps.prisma, cursor.userId, false, generation);
        if (cursor.workload === "mail") {
          const reconnect = classifySyncFailure(shaped) === "AUTH";
          await recordMicrosoftMailFailure(deps.prisma, cursor.userId, reconnect, generation);
          if (reconnect) await markNeedsReconnect(deps.prisma, cursor.userId, "Microsoft rejected access while importing email.", generation);
        }
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

  // Out of page budget with more to read: every page so far was handled, so
  // the next page's link is a correct place to resume (WARP-3059). This is NOT
  // the failure path — a failed run returned above and kept its last
  // checkpoint — and `deltaLink` is untouched.
  if (url) {
    await recordCheckpoint(deps.prisma, cursor.id, url);
    return { ...base, items, pages, completed: false, checkpointed: true };
  }

  // Graph returned neither link. Nothing to resume from; the next tick repeats
  // the run from its last good position.
  return { ...base, items, pages, completed: false, checkpointed: false };
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
 * fastest way to earn a 429 that then applies to all of them. A paced reader
 * that obeys `Retry-After` stays inside whatever the budget is; a burst finds
 * its edge (WARP-2706 — Microsoft publishes no per-mailbox figure to plan by).
 */
export async function runSyncTick(
  deps: M365SyncDeps,
  limit = 25,
): Promise<SyncTickResult> {
  const now = deps.now ?? (() => new Date());
  const due = (await claimDueCursors(deps.prisma, limit, now(), deps.calendarModuleEnabled === false, deps.mailModuleEnabled === false))
    .filter((cursor) => (deps.calendarModuleEnabled !== false || cursor.workload !== "calendar") && (deps.mailModuleEnabled !== false || cursor.workload !== "mail"));

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
  mailOwner?: { userId: string; generation?: M365GrantGeneration },
): Promise<FoundFolder[]> {
  const found: FoundFolder[] = [];
  let next: string | null = url;
  let pages = 0;

  while (next && pages < MAX_PAGES_PER_TICK) {
    if (mailOwner) {
      const row = await deps.prisma.m365Connection.findUnique({ where: { userId: mailOwner.userId } });
      if (row?.state !== "CONNECTED" || !row.mailEnabled || !row.emailAccountId ||
          !grantCovers((row.grantedScopes ?? "").split(/\s+/).filter(Boolean), GRAPH_RESOURCES.mail.leastPrivilegeScope) ||
          (mailOwner.generation && (row.tokenCacheEnc !== mailOwner.generation.tokenCacheEnc || row.cursorLinkHash !== mailOwner.generation.cursorLinkHash || row.emailAccountId !== mailOwner.generation.emailAccountId))) throw new Error("Outlook email import changed during folder discovery.");
    }
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
 *
 * A workload the person's grant does not cover is not attempted at all
 * (WARP-3059) and is reported as `notGranted`, not `skipped`: it is the
 * expected consequence of what was consented to, not a fault. Before this, To
 * Do — whose only delegated permission the connector does not request — was
 * attempted, refused and logged as skipped on every tick for every person.
 *
 * SharePoint (WARP-3538) is the first workload that is the PERSON'S choice and
 * not only a consequence of the grant. One the person has not opted in to is
 * reported as `disabled` — a third word, because it is neither a refusal
 * (`notGranted`) nor a break (`skipped`) — and is not even checked against the
 * grant: a tenant may have approved `Sites.Read.All` for everyone, and a person
 * who said no must still not be read. Its discovery is a walk over sites, not a
 * folder tree; see {@link discoverSharePointLibraries}.
 */
export async function discoverResources(
  deps: M365SyncDeps,
  userId: string,
): Promise<DiscoveryResult> {
  const now = deps.now ?? (() => new Date());

  let accessToken: string;
  let generation: M365GrantGeneration | undefined;
  try {
    accessToken = await getAccessToken(deps.prisma, deps.entra, userId, now(), (value) => { generation = value; });
  } catch {
    return { registered: 0, skipped: [...M365_WORKLOADS], notGranted: [], disabled: [], sharePoint: null };
  }

  // Read AFTER the token: a refresh rewrites `grantedScopes` with what
  // Microsoft granted this time, which may be narrower than last time.
  const connection = (await deps.prisma.m365Connection.findUnique({
    where: { userId },
    select: { grantedScopes: true, sharePointEnabled: true, calendarEnabled: true, mailEnabled: true, emailAccountId: true },
  })) as { grantedScopes: string | null; sharePointEnabled?: boolean; calendarEnabled?: boolean; mailEnabled?: boolean; emailAccountId?: string | null } | null;
  const granted = (connection?.grantedScopes ?? "").split(" ").filter(Boolean);
  // `=== true`, not truthiness: an absent or malformed flag is OFF. Explicit
  // state, never inferred (WARP-3538).
  const sharePointEnabled = connection?.sharePointEnabled === true;

  let registered = 0;
  const skipped: string[] = [];
  const notGranted: string[] = [];
  const disabled: string[] = [];
  let sharePoint: SharePointDiscoveryOutcome | null = null;

  for (const workload of M365_WORKLOADS) {
    const spec = GRAPH_RESOURCES[workload];

    if (workload === "mail") {
      if (deps.mailModuleEnabled === false || connection?.mailEnabled !== true) { disabled.push(workload); continue; }
      if (!grantCovers(granted, spec.leastPrivilegeScope)) { notGranted.push(workload); continue; }
      // A successful additive consent may still need its first local mailbox.
      if (!connection.emailAccountId) {
        try { if (!await setMicrosoftMailEnabled(deps.prisma, userId, true, deps.entra, deps.client)) { disabled.push(workload); continue; }
          // Refresh above rotated the cache; folder registration must use that new generation.
          accessToken = await getAccessToken(deps.prisma, deps.entra, userId, now(), (value) => { generation = value; });
        } catch { skipped.push(workload); continue; }
      }
    }

    if (workload === "calendar") {
      if (deps.calendarModuleEnabled === false || connection?.calendarEnabled !== true) { disabled.push(workload); continue; }
      if (!grantCovers(granted, spec.leastPrivilegeScope)) { notGranted.push(workload); continue; }
      try {
        if (await ensureMicrosoftCalendarCursor(deps.prisma, userId, now())) registered += 1;
        else disabled.push(workload);
      } catch { skipped.push(workload); }
      continue;
    }

    // SharePoint: the person's choice first, then the grant, then a walk of its
    // own. `continue` after every arm, so it can never fall into the folder
    // walk below and be treated as a singleton with one bogus cursor.
    if (spec.discovery === "sites") {
      if (!sharePointEnabled) {
        disabled.push(workload);
        // "Off" converges: whatever a discovery that was in flight when the
        // switch was thrown re-created after its purge is removed here, one
        // tick later at the worst. Three indexed deletes that find nothing.
        await purgeSharePointDataForUser(deps.prisma, userId);
        continue;
      }
      if (!grantCovers(granted, spec.leastPrivilegeScope)) {
        notGranted.push(workload);
        continue;
      }
      try {
        const walk = await discoverSharePointLibraries(deps, userId, accessToken);
        if (walk.status === "failed") {
          skipped.push(workload);
        } else if (walk.status === "switched_off") {
          disabled.push(workload);
          await purgeSharePointDataForUser(deps.prisma, userId);
        } else {
          sharePoint = walk.outcome;
          registered += walk.outcome.registered;
          // Reported rather than passed over — a partial walk that looks
          // complete is the silent gap `skipped` exists to close.
          if (!walk.outcome.complete) skipped.push(`${workload} (partial)`);
        }
      } catch {
        // Per-workload and non-fatal, like every other: a tenant whose SharePoint
        // is unreachable must still sync its mail and OneDrive.
        skipped.push(workload);
      }
      continue;
    }

    if (!grantCovers(granted, spec.leastPrivilegeScope)) {
      notGranted.push(workload);
      continue;
    }

    // A workload with one implicit resource — the drive root, the calendar
    // view. One cursor, no enumeration.
    if (spec.discovery === "singleton") {
      await upsertCursor(deps.prisma, userId, workload, SINGLETON_RESOURCE);
      registered += 1;
      // OneDrive's files land under a SOURCE that names the drive (the cursor's
      // own resource is the singleton `-`), so it is registered beside the
      // cursor. A failure is named, not hidden: until the source exists the
      // landing handler refuses `files` pages, and "synced" would otherwise
      // look the same as "nothing to sync".
      if (workload === "files" && (await ensureOneDriveSource(deps, userId, accessToken)) === "failed") {
        skipped.push(`${workload} (drive details)`);
      }
      continue;
    }

    const discovery = discoveryUrlFor(workload);
    if (!discovery) {
      // A `folders` workload with no collection to list is a hole in the table
      // (graph-resources.test.ts pins that it cannot happen). Said, not guessed.
      skipped.push(workload);
      continue;
    }

    try {
      // Breadth-first, depth-bounded. Each level's children are fetched from
      // the child collection, which is the only documented way to see past the
      // root's immediate children.
      const mailOwner = workload === "mail" ? { userId, generation } : undefined;
      let frontier = await listFolders(deps, discovery, accessToken, mailOwner);
      let depth = 0;

      while (frontier.length > 0 && depth < MAX_FOLDER_DEPTH) {
        // NOT named `nextFrontier`/`nextLevel`: the WARP-2203 canary greps the
        // producer surface for cursor-shaped keys and requires each to be
        // classified as a cursor or a reviewed non-cursor. A BFS frontier is
        // neither, and adding a local variable to that security-relevant
        // exemption list to keep a nicer name would blunt the canary for a
        // cosmetic reason.
        const deeperFolders: FoundFolder[] = [];

        for (const folder of frontier) {
          if (workload === "mail") {
            if (await ensureMicrosoftMailFolder(deps.prisma, userId, folder.id, generation)) registered += 1;
            else throw new Error("Outlook email import changed during folder discovery.");
          } else { await upsertCursor(deps.prisma, userId, workload, folder.id); registered += 1; }

          if (folder.hasChildren && spec.childCollectionPath) {
            const childUrl = `${GRAPH_API_BASE_URL}${spec.childCollectionPath(folder.id)}`;
            deeperFolders.push(...(await listFolders(deps, childUrl, accessToken, mailOwner)));
          }
        }

        frontier = deeperFolders;
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

  return { registered, skipped, notGranted, disabled, sharePoint };
}

/** What one discovery pass found and did, for the scheduler's log and the tests. */
export interface DiscoveryResult {
  /** Cursors the pass registered (singletons, folders and SharePoint libraries). */
  registered: number;
  /** Workloads that FAILED, or whose walk was only partial — named, never silent. */
  skipped: string[];
  /** Workloads the person's grant does not cover: expected, not a fault. */
  notGranted: string[];
  /**
   * WARP-3538 — workloads the PERSON has switched off. Not `notGranted` (a
   * refusal) and not `skipped` (a break): a choice, reported as one.
   */
  disabled: string[];
  /** What the SharePoint walk did, or null when it did not run. */
  sharePoint: SharePointDiscoveryOutcome | null;
}

// ---------------------------------------------------------------------------
// The OneDrive source (WARP-3538)
// ---------------------------------------------------------------------------

/**
 * Make sure this person's OneDrive is registered as a cloud-file SOURCE.
 *
 * Every landed file sits in a source, and the OneDrive cursor cannot name its
 * own: its resource is the singleton `-`. `GET /me/drive` returns the drive
 * resource — the id the landing handler files OneDrive's items under, its name
 * and its browser URL — and `Files.Read`, which the `files` workload already
 * requires, covers it.
 *
 * Read ONCE: when the source already exists the call is not made at all, so a
 * connected person's ticks pay one indexed lookup for this, not one request to
 * Microsoft. And it creates and never rewrites (`ensureSource`): a drive's id is
 * as permanent as the drive, and a refresh that could fail halfway is a way to
 * replace a good name with a worse one.
 *
 * Failure is a RESULT, never a throw — one person's unreachable OneDrive must not
 * abort discovery for the rest. The caller names it in `skipped`.
 */
async function ensureOneDriveSource(
  deps: M365SyncDeps,
  userId: string,
  accessToken: string,
): Promise<"present" | "registered" | "failed"> {
  if (await findSourceId(deps.prisma, { userId, provider: "M365", kind: "ONEDRIVE" })) return "present";
  try {
    const page = await deps.client.getPage(`${GRAPH_API_BASE_URL}${ONEDRIVE_DRIVE_PATH}`, accessToken);
    const drive = parseOneDrive(page.raw);
    if (!drive) return "failed";
    await ensureSource(deps.prisma, {
      userId,
      provider: "M365",
      sourceId: drive.driveId,
      kind: "ONEDRIVE",
      siteId: null,
      siteName: null,
      name: drive.name,
      webUrl: drive.webUrl,
      followed: false,
    });
    return "registered";
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// SharePoint library discovery (WARP-3538)
// ---------------------------------------------------------------------------

/**
 * How many document libraries one person may have registered.
 *
 * Each library is a cursor, and each cursor is a stream of Graph calls against
 * a SharePoint budget that is per APP per TENANT per minute (1,250 resource
 * units a minute up to 1,000 licences; delta with a token costs 1, delta without
 * one costs 2 — SharePoint throttling, 2026-08-10). A person who can open
 * hundreds of libraries is a tenant-wide read of everything the practice owns,
 * which is not what "my SharePoint" means and not what a box this size can
 * afford. A hundred is far past any real working set.
 *
 * It is a bound on what is READ, not on what is hidden: the libraries past it
 * are counted, the count is kept (`M365Connection.sharePointLibrariesCapped`)
 * and the card says "N more libraries not read" — a silent cap would look
 * exactly like a library with no files.
 */
export const MAX_SHAREPOINT_LIBRARIES_PER_PERSON = 100;

/** What one SharePoint walk registered, dropped and pruned. */
export interface SharePointDiscoveryOutcome {
  /** Libraries registered (a cursor and a source row each) — at most the cap. */
  registered: number;
  /** Libraries found beyond the cap and NOT registered. */
  dropped: number;
  /**
   * True only when every listing the walk needed ran to its end: no page bound
   * hit, no listing failed, and the answer is believable. Pruning happens only
   * then.
   */
  complete: boolean;
  /** Why it was not complete, or null when it was. */
  incompleteBecause: "listing_failed" | "page_bound" | "empty_answer" | null;
  /** Libraries removed — cursor, source row and landed items — because a complete walk no longer saw them. */
  pruned: number;
}

type SharePointWalk =
  | { status: "done"; outcome: SharePointDiscoveryOutcome }
  /** Neither site source answered — nothing is known, nothing is changed. */
  | { status: "failed" }
  /** The person switched SharePoint off while the walk was in flight. */
  | { status: "switched_off" };

/** One shared allowance of page reads, spent by every listing in a walk. */
interface PageBudget {
  remaining: number;
}

interface Listing {
  items: Record<string, unknown>[];
  /** The listing was read to its end — or as far as it got before failing: see `ok`. */
  ok: boolean;
  /** The budget ran out with pages still to read. */
  exhausted: boolean;
}

/**
 * Read one collection, following `@odata.nextLink`, out of a shared page budget.
 *
 * Never throws: a failed listing is a RESULT (`ok: false`) because the walk's
 * whole policy is built on telling a failed listing from a finished one — the
 * items read before a failure are kept (registering is additive and idempotent),
 * but a failure forbids pruning.
 */
async function listCollection(
  deps: M365SyncDeps,
  url: string,
  accessToken: string,
  budget: PageBudget,
): Promise<Listing> {
  const items: Record<string, unknown>[] = [];
  let next: string | null = url;
  try {
    while (next) {
      if (budget.remaining <= 0) return { items, ok: true, exhausted: true };
      budget.remaining -= 1;
      const page: GraphPage = await deps.client.getPage(next, accessToken);
      items.push(...page.items);
      next = page.links.nextLink;
    }
  } catch {
    return { items, ok: false, exhausted: false };
  }
  return { items, ok: true, exhausted: false };
}

/**
 * Register a cursor for every SharePoint document library the person can open —
 * up to the cap — and prune the ones that are gone.
 *
 *  1. SITES are the union, by id, of site search (`/sites?search=*`) and the
 *     sites the person follows (`/me/followedSites`), each paged. Personal sites
 *     — somebody's OneDrive — are excluded by `parseSharePointSite`. Two sources
 *     because Microsoft warns the followed list "might" be incomplete and the
 *     search spelling is undocumented (see `SHAREPOINT_SITE_SEARCH_PATH`): each
 *     covers for the other.
 *  2. LIBRARIES are each site's `/sites/{id}/drives`, document libraries only,
 *     in a DETERMINISTIC order — followed sites first, then by web URL — because
 *     the cap keeps the first hundred and the order decides which survive it.
 *  3. REGISTER: a cursor (`upsertCursor` touches nothing on an existing one, so
 *     re-discovery never resets a delta link) and then an encrypted source row
 *     (`CloudFileSource`, kind SHAREPOINT_LIBRARY). Cursor first: a crash between
 *     the two leaves a cursor that syncs and lacks only a display name, never a
 *     row that claims a library nothing reads.
 *  4. PRUNE — and this is the dangerous half — ONLY after a COMPLETE walk.
 *     Pruning on a partial listing would delete a library, its cursor and the
 *     person's landed file list because Microsoft hiccuped, a page bound was
 *     hit, or one site's listing failed: "I did not see it" must never be read
 *     as "it is gone". A walk that finds NOTHING while libraries are registered
 *     is not trusted either — the search spelling is undocumented, and an empty
 *     answer to a question that had answers yesterday would otherwise erase the
 *     whole list in one tick.
 *
 * ONE page budget (`MAX_PAGES_PER_TICK`) is shared by every listing, so a tenant
 * with thousands of sites cannot turn a tick into thousands of requests per
 * person; hitting it marks the walk incomplete and says so.
 *
 * Throws nothing for an expected failure: the caller turns `failed` into
 * `skipped: ["sharepoint"]`.
 */
async function discoverSharePointLibraries(
  deps: M365SyncDeps,
  userId: string,
  accessToken: string,
): Promise<SharePointWalk> {
  const budget: PageBudget = { remaining: MAX_PAGES_PER_TICK };
  // A holder, not a captured `let`: TypeScript does not see assignments made
  // inside a closure and would narrow the reason to `null` for the rest of the
  // function. The FIRST reason wins — a failure is the more serious thing to say.
  const why: { reason: SharePointDiscoveryOutcome["incompleteBecause"] } = { reason: null };
  const note = (reason: NonNullable<SharePointDiscoveryOutcome["incompleteBecause"]>) => {
    why.reason ??= reason;
  };

  const search = await listCollection(deps, `${GRAPH_API_BASE_URL}${SHAREPOINT_SITE_SEARCH_PATH}`, accessToken, budget);
  const followed = await listCollection(deps, `${GRAPH_API_BASE_URL}${FOLLOWED_SITES_PATH}`, accessToken, budget);
  if (!search.ok && !followed.ok) return { status: "failed" };
  if (!search.ok || !followed.ok) note("listing_failed");
  if (search.exhausted || followed.exhausted) note("page_bound");

  // 1. Sites: the union by id, remembering which ones the person follows.
  const sites = new Map<string, { site: SharePointSite; followed: boolean }>();
  for (const item of search.items) {
    const site = parseSharePointSite(item);
    if (site && !sites.has(site.id)) sites.set(site.id, { site, followed: false });
  }
  for (const item of followed.items) {
    const site = parseSharePointSite(item);
    if (site) sites.set(site.id, { site: sites.get(site.id)?.site ?? site, followed: true });
  }
  const ordered = [...sites.values()].sort(
    (a, b) =>
      Number(b.followed) - Number(a.followed) ||
      compareText(a.site.webUrl, b.site.webUrl) ||
      compareText(a.site.id, b.site.id),
  );

  // 2. Libraries, site by site, in that order.
  const libraries: Array<SharePointLibrary & { site: SharePointSite; followed: boolean }> = [];
  const seen = new Set<string>();
  for (const entry of ordered) {
    if (budget.remaining <= 0) {
      note("page_bound");
      break;
    }
    const drives = await listCollection(
      deps,
      `${GRAPH_API_BASE_URL}${siteDrivesPath(entry.site.id)}`,
      accessToken,
      budget,
    );
    if (!drives.ok) note("listing_failed");
    if (drives.exhausted) note("page_bound");
    const found = drives.items
      .map((item) => parseSharePointLibrary(item, entry.site))
      .filter((lib): lib is SharePointLibrary => lib !== null)
      .sort((a, b) => compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.driveId, b.driveId));
    for (const lib of found) {
      if (seen.has(lib.driveId)) continue;
      seen.add(lib.driveId);
      libraries.push({ ...lib, site: entry.site, followed: entry.followed });
    }
  }

  // The person may have switched SharePoint off while the walk was in flight —
  // it takes seconds, the click takes a moment. Re-read the flag right before
  // writing, so the race shrinks from "the whole walk" to a few milliseconds
  // (and the next tick, finding the switch off, cleans up what is left).
  const still = (await deps.prisma.m365Connection.findUnique({
    where: { userId },
    select: { sharePointEnabled: true },
  })) as { sharePointEnabled?: boolean } | null;
  if (still?.sharePointEnabled !== true) return { status: "switched_off" };

  // 3. Register the first hundred; count the rest.
  const kept = libraries.slice(0, MAX_SHAREPOINT_LIBRARIES_PER_PERSON);
  const dropped = libraries.length - kept.length;
  for (const lib of kept) {
    await upsertCursor(deps.prisma, userId, "sharepoint", lib.driveId);
    await upsertSource(deps.prisma, {
      userId,
      provider: "M365",
      sourceId: lib.driveId,
      kind: "SHAREPOINT_LIBRARY",
      siteId: lib.site.id,
      siteName: lib.site.displayName,
      name: lib.name,
      webUrl: lib.webUrl,
      followed: lib.followed,
    });
  }

  // 4. Prune — only on an answer worth acting on.
  if (why.reason === null && kept.length === 0) {
    // "Registered" means CURSORS — what is actually being read — not source rows,
    // which a crash between the two writes above can leave one short.
    const registeredBefore = await deps.prisma.m365DeltaCursor.count({
      where: { userId, workload: "sharepoint" },
    });
    if (registeredBefore > 0) note("empty_answer");
  }
  const complete = why.reason === null;
  let pruned = 0;
  if (complete) {
    pruned = (await pruneSharePointLibraries(deps.prisma, userId, kept.map((lib) => lib.driveId))).libraries;
  }

  // Remember the cap's count where the card can read it — written only by a walk
  // that read enough to know: a complete one, or one that already saw libraries
  // past the cap. A walk that failed or stopped short and saw nothing past it
  // does not know, and must not overwrite what an earlier one did. Skipped when
  // unchanged (the row carries @updatedAt).
  if (complete || dropped > 0) {
    await deps.prisma.m365Connection.updateMany({
      where: { userId, sharePointLibrariesCapped: { not: dropped } },
      data: { sharePointLibrariesCapped: dropped },
    });
  }

  return {
    status: "done",
    outcome: { registered: kept.length, dropped, complete, incompleteBecause: why.reason, pruned },
  };
}

/** Plain code-unit order: the same on every machine, unlike `localeCompare`. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * #2347 review — true when a person's grant covers no workload at all.
 *
 * `notGranted` is not a fault and is not logged: for To Do it is the expected
 * outcome of what the connector requests. But when EVERY workload is in it (an
 * empty or unreadable `grantedScopes`, or a consent that named no workload),
 * the box syncs nothing for that person, and without a line saying so that
 * looks exactly like a mailbox with no mail. The scheduler logs it.
 *
 * A workload the person switched OFF (`disabled`, WARP-3538) is not judged: it
 * is not in `notGranted`, so counting it would make "every other workload is
 * not granted" read as "some workload is covered", and a person whose grant
 * covers nothing — who simply never opted in to SharePoint — would never be
 * warned that nothing syncs for them. `disabled` is optional so a caller that
 * predates it keeps its meaning.
 */
export function grantCoversNoWorkload(found: {
  registered: number;
  notGranted: readonly string[];
  disabled?: readonly string[];
}): boolean {
  const judged = M365_WORKLOADS.length - (found.disabled?.length ?? 0);
  return found.registered === 0 && found.notGranted.length === judged;
}
