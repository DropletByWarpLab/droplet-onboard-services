/**
 * WARP-2118 / ADR-041 — which Graph resource each workload enumerates, and how.
 *
 * Separated from `m365-sync.service.ts` on purpose: that module is pure control
 * flow and this one is pure VENDOR FACT. Every string below was read off
 * Microsoft's own reference pages rather than inferred, because the failure
 * mode for getting one wrong is silent. Graph does not reject an unrecognised
 * delta parameter — it starts a fresh enumeration — so a plausible-looking
 * mistake here produces a connector that full-scans the customer's mailbox or
 * drive on every tick while reporting an incremental sync, with nothing
 * anywhere reporting a fault.
 *
 * ## 🔴 The delta parameter is NOT uniform across Graph
 *
 * This is the single most important fact in this file.
 *
 *   Outlook + To Do  `$deltatoken` (final page) / `$skiptoken` (mid-run)
 *                    — message, mailFolder, event/calendarView, contact,
 *                      contactFolder, todoTask, todoTaskList.
 *   driveItem        a BARE `token` — `?token=<opaque>`, or the function form
 *                    `/delta(token='<opaque>')`. NOT `$deltatoken`. This is
 *                    EVERY drive-shaped workload: OneDrive (`files`) and, since
 *                    WARP-3538, SharePoint document libraries (`sharepoint`),
 *                    which are the same driveItem delta addressed by drive id.
 *
 * Writing `$deltatoken` against a drive, or `token=` against a mailbox, is the
 * exact silent-full-scan failure described above — and a drive is the workload
 * where a full scan is largest. Nothing in the type system prevents it, so the
 * parameter name lives on the descriptor below (`deltaTokenParam`, a REQUIRED
 * field: a workload cannot be added without choosing one) and
 * {@link deltaTokenParamFor} is the only place that reads it. It used to be
 * `workload === "files" ? "token" : "$deltatoken"`, which is correct for exactly
 * as long as OneDrive is the only drive.
 *
 * ## Grain: why some workloads need discovery first
 *
 * **Mail delta has no whole-mailbox form.** Only
 * `/me/mailFolders/{id}/messages/delta` is documented; `/me/messages/delta`
 * does not exist. A mailbox with ten folders therefore needs ten cursors —
 * which is precisely the grain `M365DeltaCursor` was built for — and folder
 * discovery must run on every tick to notice a new folder.
 *
 * A consequence worth stating because it is a data-loss shape: a message MOVED
 * between folders appears as `@removed` in the source folder and as new only in
 * the destination folder. Miss a folder's cursor and that mail disappears from
 * the local copy without any error.
 *
 * **SharePoint is per-library, and its libraries are found through sites.** A
 * document library is a drive (`GET /sites/{site-id}/drives`), so one person
 * with access to ten libraries has ten cursors, each on
 * `/drives/{drive-id}/root/delta`. Finding them takes a walk of its own — the
 * sites the person can open, then each site's libraries — which is not a folder
 * tree and has no single collection to list, so it is declared as
 * `discovery: "sites"` rather than squeezed into `discoveryPath`.
 *
 * Microsoft documents the delegated side of this (2026-10-03):
 *   - `GET /sites?search={query}` (site-search, updated 2026-06-19) and
 *     `GET /me/followedSites` (sites-list-followed, 2026-03-07): delegated
 *     `Sites.Read.All`, work or school accounts only.
 *   - `GET /sites/{site-id}/drives` (drive-list, 2025-07-23): a site's document
 *     libraries; system drives are hidden unless `$select=system` is asked for.
 *   - `GET /sites` (site-list) and `getAllSites` are APPLICATION permissions
 *     only — a delegated token cannot call them, and ADR-041 rules application
 *     permissions out.
 *
 * ## 🔴 The calendar window trap
 *
 * `calendarView` delta REQUIRES `startDateTime` and `endDateTime`, and
 * Microsoft documents that events moving OUTSIDE that window come back under
 * `@removed` with reason `deleted` — indistinguishable from a real deletion
 * unless the caller knows which window it asked for. A consumer that treats
 * every `@removed` as a deletion will erase real, still-existing meetings from
 * the local store whenever somebody reschedules one past the window's edge.
 *
 * Rolling the window forward CHANGES the request, which invalidates the delta
 * token and forces a fresh full enumeration. That is a designed-for cost here,
 * not a surprise: {@link CALENDAR_WINDOW} is deliberately wide so the roll is
 * rare, and the window that produced a cursor is recorded in its `resourceId`
 * so a roll is visible rather than silent.
 *
 * ## What is deliberately NOT here
 *
 * No `/beta` endpoint. No `deltashowsharingchanges` Prefer value — it requires
 * `Sites.FullControl.All`, which is a wildly disproportionate scope for a
 * read-through connector. No national-cloud variants: `.env.example` is
 * explicit that US Gov and China endpoints are unnamed because an unregistered
 * host is denied by default, and several of these APIs do not exist on
 * 21Vianet anyway (message, mailFolder, contact, contactFolder, todoTask and
 * todoTaskList delta are all unsupported there).
 */
import { GRAPH_API_BASE_URL } from "./graph-client.js";

/**
 * The workloads this build can enumerate.
 *
 * `M365DeltaCursor.workload` is free-text in Prisma, so this union is the only
 * gate — the same construction as the provider registry, and for the same
 * reason: a value outside it must be refused by name rather than fall through
 * to a surprise transport. `todo` is new here; the schema comment naming four
 * workloads predates it and is updated in the same change.
 *
 * `sharepoint` (WARP-3538) is appended, not inserted: this order is the order
 * discovery visits workloads in and the order every `notGranted` / `disabled`
 * list reads in. Its resource is a DRIVE id (one cursor per document library).
 */
export const M365_WORKLOADS = [
  "mail",
  "calendar",
  "contacts",
  "files",
  "todo",
  "sharepoint",
] as const;
export type M365Workload = (typeof M365_WORKLOADS)[number];

/**
 * Which delta-token parameter a workload uses. See the module header — this is
 * the fact most likely to be got wrong and the one with no runtime symptom.
 *
 * A LOOKUP, on purpose: the answer is declared on each workload's descriptor
 * (`deltaTokenParam`, required), so this reader has no opinion of its own to
 * drift from it.
 */
export function deltaTokenParamFor(workload: M365Workload): "$deltatoken" | "token" {
  return GRAPH_RESOURCES[workload].deltaTokenParam;
}

/**
 * How far either side of "now" the calendar view reaches.
 *
 * A year back and a year forward. Wide because rolling the window forces a full
 * re-enumeration (see the header), and a small window would roll constantly;
 * bounded because `calendarView` requires bounds and an unbounded-looking
 * request is not on offer.
 */
export const CALENDAR_WINDOW = {
  backMs: 365 * 24 * 60 * 60 * 1000,
  forwardMs: 365 * 24 * 60 * 60 * 1000,
} as const;

/** The stable primary-calendar window that owns a delta cursor. Never a provider token. */
export function calendarWindowResourceId(start: Date, end: Date): string {
  return `${start.toISOString()}|${end.toISOString()}`;
}

function calendarWindowBounds(resourceId: string): [Date, Date] | null {
  const pieces = resourceId.split("|");
  if (pieces.length !== 2) return null;
  const start = new Date(pieces[0]!);
  const end = new Date(pieces[1]!);
  return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start ? [start, end] : null;
}

/**
 * Page size requested via `Prefer: odata.maxpagesize`.
 *
 * Outlook and To Do resources honour the Prefer header; driveItem takes `$top`
 * instead. Modest on purpose: a large page is a larger unit of work to lose
 * when a run fails partway, and the run restarts from the beginning.
 */
export { GRAPH_PREFERRED_PAGE_SIZE as PREFERRED_PAGE_SIZE } from "./graph-client.js";

/**
 * How a workload's cursors come to exist (WARP-3538).
 *
 *   - `singleton` — one implicit resource (the calendar view, the OneDrive
 *                   root): one cursor, no enumeration.
 *   - `folders`   — one collection to list, possibly nested: a cursor per mail
 *                   folder, contact folder or To Do list (`discoveryPath`).
 *   - `sites`     — a walk over SharePoint sites to their document libraries:
 *                   several collections and a policy of its own, so there is no
 *                   single `discoveryPath` (see `discoverSharePointLibraries`).
 *
 * A discriminant rather than "is `discoveryPath` null": `singleton` and `sites`
 * are BOTH null there, and an engine that read the null as "one implicit
 * resource" would register a single bogus cursor for SharePoint and report it
 * healthy.
 */
export type DiscoveryKind = "singleton" | "folders" | "sites";

/** A workload's enumeration, as data. */
export interface GraphResourceSpec {
  readonly workload: M365Workload;
  /**
   * Builds the FIRST url of a run, given the cursor's `resourceId`. Later pages
   * come from `@odata.nextLink` and are replayed verbatim — never rebuilt from
   * this template, which is the whole point of storing links opaquely.
   */
  readonly initialPath: (resourceId: string, now: Date) => string;
  /** How this workload's resources are found. See {@link DiscoveryKind}. */
  readonly discovery: DiscoveryKind;
  /**
   * The collection that DISCOVERS the resources this workload has cursors for.
   * Non-null exactly when `discovery` is `folders` (pinned by a test): a
   * singleton has nothing to list and a `sites` walk has no single collection.
   */
  readonly discoveryPath: string | null;
  /**
   * The continuation parameter this resource's delta uses — see the module
   * header. REQUIRED, so the next workload cannot be added without deciding it:
   * `token` for every driveItem resource, `$deltatoken` for Outlook and To Do.
   */
  readonly deltaTokenParam: "$deltatoken" | "token";
  /**
   * The child collection to descend into, for a workload whose folders NEST.
   *
   * Present exactly where a root-level listing is documented to be incomplete
   * (mail and contacts). Absent means the discovery listing is the whole set —
   * not "recursion was forgotten", which is the reading this comment exists to
   * prevent.
   */
  readonly childCollectionPath?: (resourceId: string) => string;
  /**
   * The least-privileged delegated scope Microsoft documents for this call —
   * not the scope the shipped base set (`M365_BASE_SCOPES`) asks for, which is
   * broader than any read-through connector needs.
   */
  readonly leastPrivilegeScope: string;
}

/** Sentinel `resourceId` for a workload whose resource is implicit. */
export const SINGLETON_RESOURCE = "-";

const iso = (d: Date): string => d.toISOString();

export const GRAPH_RESOURCES: Readonly<Record<M365Workload, GraphResourceSpec>> = {
  mail: {
    workload: "mail",
    // Folder-scoped ONLY — there is no /me/messages/delta. See the header.
    initialPath: (folderId) =>
      `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta`,
    // 🔴 NOT `/me/mailFolders/delta`, and this is a correction, not a
    // preference. Microsoft states it on the sibling list operation over the
    // identical collection: *"This operation doesn't return all mail folders in
    // a mailbox, only the child folders of the root folder"*, and *"By default,
    // this operation doesn't return hidden folders."*
    //
    // A flat discovery therefore registers cursors for the top level only. Mail
    // in any nested folder — which is how most people file anything — would
    // never be enumerated, and NOTHING would report a fault: the cursors that
    // do exist keep succeeding. Hence `includeHiddenFolders=true` here and the
    // recursive descent in `discoverMailFolders`.
    discovery: "folders",
    discoveryPath: "/me/mailFolders?includeHiddenFolders=true",
    // The child collection the walk descends through.
    childCollectionPath: (folderId) =>
      `/me/mailFolders/${encodeURIComponent(folderId)}/childFolders`,
    deltaTokenParam: "$deltatoken",
    leastPrivilegeScope: "Mail.ReadBasic",
  },
  calendar: {
    workload: "calendar",
    // The window is REQUIRED and is a trap — see the header. It is also encoded
    // into the cursor's resourceId by the discovery step, so a rolled window
    // produces a visibly different cursor rather than silently invalidating one.
    initialPath: (resourceId, now) => {
      const [start, end] = calendarWindowBounds(resourceId) ?? [
        new Date(now.getTime() - CALENDAR_WINDOW.backMs), new Date(now.getTime() + CALENDAR_WINDOW.forwardMs),
      ];
      return (
        `/me/calendarView/delta` +
        `?startDateTime=${encodeURIComponent(iso(start))}` +
        `&endDateTime=${encodeURIComponent(iso(end))}`
      );
    },
    discovery: "singleton",
    discoveryPath: null,
    deltaTokenParam: "$deltatoken",
    leastPrivilegeScope: "Calendars.Read",
  },
  contacts: {
    workload: "contacts",
    initialPath: (folderId) =>
      `/me/contactFolders/${encodeURIComponent(folderId)}/contacts/delta`,
    // Contact folders nest too, and the same root-only limit applies to the
    // list operation. Walked with the same recursion as mail.
    discovery: "folders",
    discoveryPath: "/me/contactFolders",
    childCollectionPath: (folderId) =>
      `/me/contactFolders/${encodeURIComponent(folderId)}/childFolders`,
    deltaTokenParam: "$deltatoken",
    leastPrivilegeScope: "Contacts.Read",
  },
  files: {
    workload: "files",
    // 🔴 `token`, not `$deltatoken`, on continuation. This first URL carries no
    // token at all, but the parameter name matters the moment a caller builds
    // one — which is why it is declared on `deltaTokenParamFor` rather than
    // left to whoever writes the next resync path.
    initialPath: () => `/me/drive/root/delta`,
    discovery: "singleton",
    discoveryPath: null,
    deltaTokenParam: "token",
    // 🔴 METADATA ONLY, and that bound is an EGRESS decision, not a feature
    // gap. `driveItem: get content` answers **302 Found** with a redirect to a
    // preauthenticated download URL on a per-tenant, per-request host — a host
    // no static `allowed-egress.yaml` entry can name. Fetching file bodies
    // would therefore either dial an unregistered destination or need a
    // `kind: dynamic` registration with a code-side host guard of its own.
    // Neither is in this slice, so nothing here follows `@microsoft.graph.
    // downloadUrl`, and the delta feed's metadata is the whole contract.
    leastPrivilegeScope: "Files.Read",
  },
  todo: {
    workload: "todo",
    initialPath: (listId) =>
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks/delta`,
    discovery: "folders",
    discoveryPath: "/me/todo/lists/delta",
    deltaTokenParam: "$deltatoken",
    // The ONE unavoidable write scope. Stated precisely, because the tempting
    // paraphrase is wrong: Microsoft publishes `Tasks.ReadWrite` as the ONLY
    // delegated permission for `todoTaskList: delta` — no read-only delegated
    // permission is offered for that call. (The "Not available." cell on that
    // page sits in the HIGHER-privileged column and means there is no higher
    // option; it does not say Tasks.Read was refused.)
    //
    // It is the only place this connector asks for more than it uses, so an
    // owner who will not grant a write-capable scope should leave To Do off
    // rather than have it smuggled in behind the other four workloads.
    leastPrivilegeScope: "Tasks.ReadWrite",
  },
  sharepoint: {
    workload: "sharepoint",
    // One cursor per DOCUMENT LIBRARY, and the resource id is the DRIVE id: a
    // library is a drive, and `/drives/{drive-id}/root/delta` is the same
    // driveItem delta OneDrive uses, addressed by id (driveitem-delta,
    // 2026-06-06). Never a site id and never a path — Graph is explicit that
    // drive items are tracked by id, since a rename would orphan a path-keyed
    // row. Escaped like every other id: drive ids carry `!` and are otherwise
    // opaque, and this one comes out of a response body.
    initialPath: (driveId) => `/drives/${encodeURIComponent(driveId)}/root/delta`,
    // Found by the custom walk over sites, not by one collection — see
    // `DiscoveryKind` and `discoverSharePointLibraries`.
    discovery: "sites",
    discoveryPath: null,
    // 🔴 `token`, NOT `$deltatoken` — the same driveItem fact as `files`, and the
    // reason this is a field on the spec rather than `workload === "files"`.
    // A drive with the wrong parameter does not fail: it re-enumerates the whole
    // library on every tick and reports an incremental sync.
    deltaTokenParam: "token",
    // 🔴 METADATA ONLY, for the same EGRESS reason as `files`: a file's content
    // is a 302 to a per-tenant SharePoint host that no static
    // `allowed-egress.yaml` entry can name. Nothing here follows
    // `@microsoft.graph.downloadUrl` and no `/content` is ever requested.
    //
    // Site discovery is what needs this scope: site-search and followedSites
    // list delegated `Sites.Read.All` as the least-privileged permission, and
    // the drive reads it unlocks are covered by the same grant. It is NOT in the
    // base scope set — `Files.ReadWrite.All` can read a drive but cannot find
    // one — so an existing connection reports SharePoint as needing permission
    // instead of attempting a discovery its token cannot make.
    leastPrivilegeScope: "Sites.Read.All",
  },
};

// ---------------------------------------------------------------------------
// SharePoint discovery — vendor facts (WARP-3538)
// ---------------------------------------------------------------------------

/**
 * 🔴 The query that asks site search for EVERY site the person can open.
 *
 * `*` is NOT in Microsoft's reference. Read 2026-10-03: site-search (updated
 * 2026-06-19) documents `GET /sites?search={query}` as "a free text search that
 * uses multiple properties" and names no wildcard; site-list (2026-06-06) lists
 * `GET /sites` and `getAllSites` as APPLICATION-permission only, which ADR-041
 * rules out. The documented form takes a keyword and has no spelling for "every
 * site", so `*` is an UNDOCUMENTED dependency — named here so nobody mistakes it
 * for a verified one.
 *
 * It is not relied on alone. Discovery unions it with the person's followed
 * sites (below), so if `*` ever stops matching, SharePoint degrades to the
 * followed set rather than to nothing — and that is a visible shrink on the
 * card, not a silent one. Confirm it on the live-tenant run WARP-3538 requires.
 */
export const SHAREPOINT_SITE_SEARCH_PATH = "/sites?search=*";

/**
 * The sites the person follows (sites-list-followed, 2026-03-07; delegated
 * `Sites.Read.All`). Microsoft warns the list "might" be incomplete, which is
 * why it is a SECOND source beside search rather than the only one.
 */
export const FOLLOWED_SITES_PATH = "/me/followedSites";

/**
 * A site's document libraries (drive-list, 2025-07-23). System drives are
 * hidden unless `$select=system` is requested, so the default listing is the
 * one wanted; {@link parseSharePointLibrary} still refuses a system drive.
 *
 * A site id is `hostname,siteCollectionId,webId` and Microsoft documents the
 * commas literally, so they are kept: percent-encoding them is not known to be
 * accepted on this router, and a 404 on every site would read as "this person
 * has no libraries". Everything else that could change the path or start a
 * query — `/`, `?`, `#` — is escaped, because the id comes out of a response
 * body and is the one value here a hostile or malformed tenant could shape.
 */
export function siteDrivesPath(siteId: string): string {
  return `/sites/${encodeURIComponent(siteId).replace(/%2C/gi, ",")}/drives`;
}

/** A SharePoint site a person's libraries may come from. */
export interface SharePointSite {
  /** Graph's composite site id (`hostname,siteCollectionId,webId`). */
  readonly id: string;
  readonly displayName: string;
  readonly webUrl: string;
}

/** One document library, as the walk reads it off `/sites/{id}/drives`. */
export interface SharePointLibrary {
  /** The DRIVE id — the cursor's `resourceId`. */
  readonly driveId: string;
  readonly name: string;
  readonly webUrl: string;
}

/**
 * Somebody's OneDrive for Business is a SharePoint site on a `-my` host
 * (`contoso-my.sharepoint…`). A regex on the HOSTNAME, so a path that merely
 * mentions the string cannot match; deliberately not tied to one top-level
 * domain, since excluding too much is the safe error here.
 */
const PERSONAL_SITE_HOST = /-my\.sharepoint\./i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The URL as given, but only when it is an https URL — null otherwise. */
function httpsUrl(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

function lastPathSegment(url: string): string | null {
  const segment = new URL(url).pathname.split("/").filter(Boolean).pop();
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Read one entry of a site listing — or `null` when it is not a site this
 * connector may read libraries from.
 *
 * Refused, each for a reason that is about WHOSE data it is:
 *   - a personal site, by `isPersonalSite === true` OR by its `-my` host. The
 *     flag is on the site resource, but search results are documented as
 *     shortened and the published example carries no `isPersonalSite` at all, so
 *     the host is the second witness. Other people's OneDrives are never read;
 *     the person's own arrives through the `files` workload.
 *   - a site with no usable https `webUrl`. The personal-site check cannot be
 *     made without one, and a person's OneDrive must not slip through on an
 *     ABSENCE.
 *   - a site with no id, a removed entry (`@removed`), or a non-object.
 */
export function parseSharePointSite(item: unknown): SharePointSite | null {
  if (!isRecord(item) || "@removed" in item) return null;
  const id = nonEmpty(item.id);
  const webUrl = httpsUrl(item.webUrl);
  if (!id || !webUrl) return null;
  if (item.isPersonalSite === true) return null;
  if (PERSONAL_SITE_HOST.test(new URL(webUrl).hostname)) return null;
  return {
    id,
    displayName:
      nonEmpty(item.displayName) ??
      nonEmpty(item.name) ??
      lastPathSegment(webUrl) ??
      new URL(webUrl).hostname,
    webUrl,
  };
}

/**
 * Read one entry of `/sites/{id}/drives` — or `null` when it is not a document
 * library.
 *
 * `driveType` must be exactly `documentLibrary`: it is the documented
 * discriminator, and a site's drive list can also carry other drive types. A
 * drive with a `system` facet is refused whatever its type says — the facet is
 * the DEFINITION of a system drive, and drive-list hides them by default only
 * as a convenience. A library with no `webUrl` of its own borrows its site's,
 * so the card still has somewhere to link.
 */
export function parseSharePointLibrary(
  item: unknown,
  site: Pick<SharePointSite, "webUrl">,
): SharePointLibrary | null {
  if (!isRecord(item)) return null;
  if (item.driveType !== "documentLibrary") return null;
  if (item.system !== undefined && item.system !== null) return null;
  const driveId = nonEmpty(item.id);
  if (!driveId) return null;
  return {
    driveId,
    name: nonEmpty(item.name) ?? driveId,
    webUrl: httpsUrl(item.webUrl) ?? site.webUrl,
  };
}

/**
 * The person's own OneDrive (WARP-3538).
 *
 * `GET /me/drive` returns the signed-in person's default drive as a `drive`
 * resource — its id, its name and its browser URL — and delegated `Files.Read`,
 * which the `files` workload already needs, covers it. It is read ONCE, to
 * register the OneDrive as a cloud-file source: the OneDrive cursor's own
 * resource is the singleton `-`, so nothing else says which drive its items
 * belong to.
 *
 * The response is ONE resource, not a collection, so it is read from the page's
 * `raw` body (`GraphPage.items` is the `value` array and is empty here).
 */
export const ONEDRIVE_DRIVE_PATH = "/me/drive";

/** A person's OneDrive, as `GET /me/drive` describes it. */
export interface OneDrive {
  /** The DRIVE id — the id the landed OneDrive items are filed under. */
  readonly driveId: string;
  readonly name: string;
  readonly webUrl: string | null;
}

/**
 * Read the body of `GET /me/drive` — or `null` when it names no drive.
 *
 * Only the id is required: without one there is nothing to file items under. The
 * name falls back to "OneDrive" (the drive resource is documented to carry one,
 * but a missing name must not stop the files landing), and a URL that is not
 * https is dropped rather than stored.
 */
export function parseOneDrive(raw: unknown): OneDrive | null {
  if (!isRecord(raw)) return null;
  const driveId = nonEmpty(raw.id);
  if (!driveId) return null;
  return { driveId, name: nonEmpty(raw.name) ?? "OneDrive", webUrl: httpsUrl(raw.webUrl) };
}

/** Delegated access levels, narrowest first. Lower-cased: Entra compares
 *  scope names case-insensitively, and so must this. */
const ACCESS_RANK: Readonly<Record<string, number>> = { readbasic: 0, read: 1, readwrite: 2 };

/**
 * WARP-3059 — does what Microsoft granted cover a workload's
 * `leastPrivilegeScope`?
 *
 * The schema promises the sync engine "reads grantedScopes to decide which
 * workloads it is allowed to attempt"; until this it did not, so To Do — whose
 * only delegated permission is `Tasks.ReadWrite`, which the connector does not
 * request — was attempted, refused and reported on every tick.
 *
 * A broader grant covers a narrower need (`Mail.ReadWrite` covers
 * `Mail.ReadBasic`; `Files.ReadWrite.All` covers `Files.Read`); a write need is
 * covered only by a write grant. Scopes arrive short (`Mail.Read`) or
 * resource-qualified (`<resource>/Mail.Read`), so only the segment after the
 * last `/` is compared. An unknown access level covers nothing.
 */
export function grantCovers(granted: readonly string[], needed: string): boolean {
  const [resource, access] = needed.split(".");
  const need = access === undefined ? undefined : ACCESS_RANK[access.toLowerCase()];
  if (!resource || need === undefined) return false;
  return granted.some((raw) => {
    const [r, a] = raw.slice(raw.lastIndexOf("/") + 1).split(".");
    const have = a === undefined ? undefined : ACCESS_RANK[a.toLowerCase()];
    return r?.toLowerCase() === resource.toLowerCase() && have !== undefined && have >= need;
  });
}

/** Narrow a stored workload string, or `null` if this build does not know it. */
export function asWorkload(raw: string): M365Workload | null {
  return (M365_WORKLOADS as readonly string[]).includes(raw)
    ? (raw as M365Workload)
    : null;
}

/**
 * The `initialUrlFor` the sync engine injects — absolute, ready to fetch.
 *
 * Returns `null` for an unknown workload rather than throwing or guessing: the
 * engine records that as a real fault on the cursor, which is the no-guessing
 * rule applied to a row a newer build may have written.
 */
export function initialUrlFor(
  workload: string,
  resourceId: string,
  now: Date = new Date(),
): string | null {
  const known = asWorkload(workload);
  if (!known) return null;
  return `${GRAPH_API_BASE_URL}${GRAPH_RESOURCES[known].initialPath(resourceId, now)}`;
}

/**
 * The absolute URL of the ONE collection that discovers a workload's resources,
 * or `null` when there is none: a singleton needs no listing, and SharePoint's
 * is a walk over several collections (`discovery: "sites"`), which this cannot
 * express. A caller deciding HOW a workload is discovered reads `discovery` on
 * the spec, never this null.
 */
export function discoveryUrlFor(workload: string): string | null {
  const known = asWorkload(workload);
  if (!known) return null;
  const path = GRAPH_RESOURCES[known].discoveryPath;
  return path ? `${GRAPH_API_BASE_URL}${path}` : null;
}

/**
 * Strip delta tokens out of a string before it is logged or persisted.
 *
 * A delta link is a CREDENTIAL-SHAPED URL: replaying one reads the customer's
 * mail. This adds the driveItem `token=` form, which the Outlook-only pattern
 * in `delta-cursor.service.ts` does not match — a gap that would have leaked
 * exactly the workload with the largest blast radius.
 *
 * WIRED, not just available: `redactSyncError()` in `delta-cursor.service.ts`
 * calls this before its own pass, so every persisted `lastError` goes through
 * it. The two are LAYERED on purpose — this one anchors on `?`/`&` and so
 * cannot see a bare `$deltatoken=` spliced into a message, which the other
 * pattern catches. Neither is a superset; see that function's note.
 */
export function redactDeltaTokens(text: string): string {
  return text.replace(
    /([?&](?:\$deltatoken|\$skiptoken|token)=)[^&\s'"]+/gi,
    "$1[redacted]",
  );
}
