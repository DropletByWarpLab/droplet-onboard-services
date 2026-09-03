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
 *                    `/delta(token='<opaque>')`. NOT `$deltatoken`.
 *
 * Writing `$deltatoken` against a drive, or `token=` against a mailbox, is the
 * exact silent-full-scan failure described above — and OneDrive is the workload
 * where a full scan is largest. Nothing in the type system prevents it, so the
 * parameter name lives on the descriptor below and
 * {@link deltaTokenParamFor} is the only place that decides it.
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
 */
export const M365_WORKLOADS = ["mail", "calendar", "contacts", "files", "todo"] as const;
export type M365Workload = (typeof M365_WORKLOADS)[number];

/**
 * Which delta-token parameter a workload uses. See the module header — this is
 * the fact most likely to be got wrong and the one with no runtime symptom.
 */
export function deltaTokenParamFor(workload: M365Workload): "$deltatoken" | "token" {
  return workload === "files" ? "token" : "$deltatoken";
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

/**
 * Page size requested via `Prefer: odata.maxpagesize`.
 *
 * Outlook and To Do resources honour the Prefer header; driveItem takes `$top`
 * instead. Modest on purpose: a large page is a larger unit of work to lose
 * when a run fails partway, and the run restarts from the beginning.
 */
export const PREFERRED_PAGE_SIZE = 100;

/** A workload's enumeration, as data. */
export interface GraphResourceSpec {
  readonly workload: M365Workload;
  /**
   * Builds the FIRST url of a run, given the cursor's `resourceId`. Later pages
   * come from `@odata.nextLink` and are replayed verbatim — never rebuilt from
   * this template, which is the whole point of storing links opaquely.
   */
  readonly initialPath: (resourceId: string, now: Date) => string;
  /**
   * The collection that DISCOVERS the resources this workload has cursors for,
   * or null when the workload has exactly one fixed resource.
   */
  readonly discoveryPath: string | null;
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
   * not the scope the shipped `M365_SCOPES` asks for, which is broader than any
   * read-through connector needs.
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
    discoveryPath: "/me/mailFolders?includeHiddenFolders=true",
    // The child collection the walk descends through.
    childCollectionPath: (folderId) =>
      `/me/mailFolders/${encodeURIComponent(folderId)}/childFolders`,
    leastPrivilegeScope: "Mail.ReadBasic",
  },
  calendar: {
    workload: "calendar",
    // The window is REQUIRED and is a trap — see the header. It is also encoded
    // into the cursor's resourceId by the discovery step, so a rolled window
    // produces a visibly different cursor rather than silently invalidating one.
    initialPath: (_resourceId, now) => {
      const start = new Date(now.getTime() - CALENDAR_WINDOW.backMs);
      const end = new Date(now.getTime() + CALENDAR_WINDOW.forwardMs);
      return (
        `/me/calendarView/delta` +
        `?startDateTime=${encodeURIComponent(iso(start))}` +
        `&endDateTime=${encodeURIComponent(iso(end))}`
      );
    },
    discoveryPath: null,
    leastPrivilegeScope: "Calendars.Read",
  },
  contacts: {
    workload: "contacts",
    initialPath: (folderId) =>
      `/me/contactFolders/${encodeURIComponent(folderId)}/contacts/delta`,
    // Contact folders nest too, and the same root-only limit applies to the
    // list operation. Walked with the same recursion as mail.
    discoveryPath: "/me/contactFolders",
    childCollectionPath: (folderId) =>
      `/me/contactFolders/${encodeURIComponent(folderId)}/childFolders`,
    leastPrivilegeScope: "Contacts.Read",
  },
  files: {
    workload: "files",
    // 🔴 `token`, not `$deltatoken`, on continuation. This first URL carries no
    // token at all, but the parameter name matters the moment a caller builds
    // one — which is why it is declared on `deltaTokenParamFor` rather than
    // left to whoever writes the next resync path.
    initialPath: () => `/me/drive/root/delta`,
    discoveryPath: null,
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
    discoveryPath: "/me/todo/lists/delta",
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
};

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

/** The absolute discovery URL for a workload, or `null` when it needs none. */
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
 * mail. `delta-cursor.service.ts` already redacts the Outlook forms; this adds
 * the driveItem `token=` form, which the existing pattern does not match — a
 * gap that would have leaked exactly the workload with the largest blast radius.
 */
export function redactDeltaTokens(text: string): string {
  return text.replace(
    /([?&](?:\$deltatoken|\$skiptoken|token)=)[^&\s'"]+/gi,
    "$1[redacted]",
  );
}
