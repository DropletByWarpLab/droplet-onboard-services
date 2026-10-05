"use client";

/**
 * WARP-3538 — "Your files": what the Microsoft 365 connection keeps a list of,
 * and the person's own switch for SharePoint.
 *
 * ── What it shows, and where each fact comes from ─────────────────────────
 *
 * - The switch and its three states come from `GET /api/m365/connection`'s
 *   `sharePoint` block (`{ enabled, granted, needsConsent }`) — the card's own
 *   read, passed in. This file does not re-derive `needsConsent` from the other
 *   two: the box says it, and a card that second-guessed it could disagree with
 *   the box about whether a person has to act.
 * - OneDrive's file count and the SharePoint libraries come from
 *   `GET /api/m365/sync-status`, read here, because only this block uses it.
 * - The switch writes through `PUT /api/m365/sharepoint { enabled }`, and the
 *   card then re-reads the connection (`onSharePointChanged`) rather than
 *   trusting the PUT's body: what the box now says is what the card shows.
 *
 * ── Metadata only, and the copy says so ───────────────────────────────────
 *
 * The connector lands file NAMES, folders, links and dates and never a file's
 * contents. A person deciding whether to let Droplet read a practice's
 * SharePoint is deciding on exactly that, so the block says it in the first
 * sentence and again at the switch, and the setup guide says it a third time
 * (`Microsoft365Guide.test.ts` keeps the three from drifting apart).
 *
 * ── Turning it OFF deletes something; turning it ON does not ──────────────
 *
 * Off removes the list of SharePoint files Droplet kept (the box does that in
 * one transaction), so it goes through `<ConfirmDialog>` with words that say
 * what is deleted and what is not. On reads nothing the person has not already
 * been told about in the sentence beside the switch, so it asks nothing.
 *
 * ── 🔴 A name from Microsoft is data ──────────────────────────────────────
 *
 * Site and library names are typed by whoever administers a tenant. They are
 * rendered as React text, never as markup, and the address the box also sends
 * for a library (`webUrl`) is deliberately NOT rendered as a link: an address
 * that came from outside never goes into an `href` here. Nothing in this file
 * is a hostname literal either (the `egress-gate` CI check reads string
 * literals); every address comes from the box.
 *
 * ── Keeping up while Droplet reads ────────────────────────────────────────
 *
 * The box reads Microsoft on a timer (every five minutes by default,
 * `DROPLET_M365_SYNC_TICK_MS`), and a library's first full read can take
 * several ticks. So a person who has just turned SharePoint on would watch a
 * list that never fills in. While anything is still waiting for its FIRST read,
 * the status is re-read every `SYNC_POLL_MS`; once everything has been read (or
 * has failed, which waiting does not fix) the polling stops. Same pattern as
 * `EmailAccountCard`'s first-sync poll.
 */

import { useCallback, useEffect, useState, type JSX } from "react";

import { authFetch } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ToggleSwitch } from "@/components/smart-home/ToggleSwitch";
import { formatRelativeTime } from "@/lib/relative-time";

/** The switch's label. The setup guide names the switch by exactly this text,
 *  and `Microsoft365Guide.test.ts` pins the two to each other. */
export const SHAREPOINT_SWITCH_LABEL = "Include SharePoint document libraries";

/** What the card says when Microsoft has not approved SharePoint yet. The setup
 *  guide quotes it, so a person who reads it on the card finds the same words
 *  there; `Microsoft365Guide.test.ts` pins the two to each other. */
export const SHAREPOINT_CONSENT_LINE = "Microsoft needs to approve SharePoint access";

/** How many SharePoint libraries Droplet reads for one person. A copy of the
 *  orchestrator's `MAX_SHAREPOINT_LIBRARIES_PER_PERSON` (the dashboard cannot
 *  import it): the card says "limit 100" and the guide says 100, and all three
 *  have to move together. */
export const SHAREPOINT_LIBRARY_LIMIT = 100;

/** How often to re-read the status while something has not had its first read.
 *  The box ticks every five minutes by default; half a minute keeps the card
 *  close behind a tick without asking the box every few seconds. */
export const SYNC_POLL_MS = 30_000;

/** A cursor's state, as the box names it (`M365SyncState`). The mapping below
 *  also takes any other string, so a state a newer box adds renders as a
 *  generic chip instead of nothing. */
export type M365SyncState = "IDLE" | "SYNCING" | "BACKOFF" | "RESYNC_REQUIRED" | "FAILED";

/** `GET /api/m365/connection` → `sharePoint`. */
export interface M365SharePointView {
  /** The person's own switch (`M365Connection.sharePointEnabled`). */
  enabled: boolean;
  /** The grant they hold covers what SharePoint needs. */
  granted: boolean;
  /** `enabled` and not `granted`: Microsoft has not approved it yet. */
  needsConsent: boolean;
}

/** What the box knows about one place it reads: OneDrive, or a library. */
export interface M365SourceStatus {
  files: number;
  lastSyncedAt: string | null;
  state: string;
  lastError: string | null;
}

export interface M365LibraryStatus extends M365SourceStatus {
  driveId: string;
  siteName: string;
  libraryName: string;
}

/** `GET /api/m365/sync-status`. */
export interface M365SyncStatus {
  /** OneDrive's own status. Null when the box has not registered it yet. */
  oneDrive: M365SourceStatus | null;
  sharePoint: {
    /** Libraries it could not register for want of room (the 100-library limit). */
    capped: number;
    libraries: M365LibraryStatus[];
  };
}

type Tone = "ok" | "info" | "warn" | "danger" | "muted";

/**
 * A state, in words and a colour. The colour is never the whole message: the
 * label says it, so it reads the same without telling green from amber.
 *
 * `IDLE` with no `lastSyncedAt` is "never run yet", not "up to date": the box
 * sets that time only when a full read completes.
 */
export function describeSyncState(state: string, lastSyncedAt: string | null): { label: string; tone: Tone } {
  switch (state) {
    case "IDLE":
      return lastSyncedAt ? { label: "Up to date", tone: "ok" } : { label: "Waiting", tone: "muted" };
    case "SYNCING":
      return { label: "Reading", tone: "info" };
    // The box's change marker went stale and it starts over. A normal step,
    // not a failure, so it is not amber.
    case "RESYNC_REQUIRED":
      return { label: "Reading again", tone: "info" };
    case "BACKOFF":
      return { label: "Retrying later", tone: "warn" };
    case "FAILED":
      return { label: "Needs attention", tone: "danger" };
    default:
      return { label: "Checking", tone: "muted" };
  }
}

function describeCounts(files: number, lastSyncedAt: string | null): string {
  const count = `${files.toLocaleString()} ${files === 1 ? "file" : "files"}`;
  return lastSyncedAt ? `${count} · last read ${formatRelativeTime(lastSyncedAt)}` : `${count} so far`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One place's status. `files` and `state` are required; the two nullable
 *  fields read as null when missing, because JSON drops a key whose value is
 *  `undefined` and a status is no less readable for it. */
function readSource(value: unknown): M365SourceStatus | null {
  if (!isRecord(value) || typeof value.files !== "number" || typeof value.state !== "string") return null;
  return {
    files: value.files,
    state: value.state,
    lastSyncedAt: typeof value.lastSyncedAt === "string" ? value.lastSyncedAt : null,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
  };
}

/**
 * The status, or null when the body is not one. Checked rather than cast: this
 * renders inside Settings, and a malformed library must read as "could not read
 * the status" and not take the page's other cards down with a thrown error.
 */
function readSyncStatus(body: unknown): M365SyncStatus | null {
  if (!isRecord(body) || !isRecord(body.sharePoint)) return null;
  const { capped, libraries } = body.sharePoint;
  if (typeof capped !== "number" || !Array.isArray(libraries)) return null;

  const read: M365LibraryStatus[] = [];
  for (const lib of libraries) {
    const source = readSource(lib);
    if (!source || !isRecord(lib) || typeof lib.driveId !== "string") return null;
    if (typeof lib.siteName !== "string" || typeof lib.libraryName !== "string") return null;
    read.push({ ...source, driveId: lib.driveId, siteName: lib.siteName, libraryName: lib.libraryName });
  }

  let oneDrive: M365SourceStatus | null = null;
  if (body.oneDrive !== undefined && body.oneDrive !== null) {
    oneDrive = readSource(body.oneDrive);
    if (!oneDrive) return null;
  }
  return { oneDrive, sharePoint: { capped, libraries: read } };
}

/** Has this place never completed a read, and not failed (which waiting does
 *  not fix)? */
const awaitingFirstRead = (s: M365SourceStatus): boolean => s.lastSyncedAt === null && s.state !== "FAILED";

/** Is anything still waiting for its first read — worth asking the box again
 *  soon? A SharePoint with no libraries yet counts, because the box has not
 *  finished looking for them; one that waits on Microsoft's approval does not,
 *  because no amount of waiting changes that. */
function stillReading(sync: M365SyncStatus, sharePoint: M365SharePointView): boolean {
  if (sync.oneDrive && awaitingFirstRead(sync.oneDrive)) return true;
  if (!sharePoint.enabled || sharePoint.needsConsent) return false;
  return sync.sharePoint.libraries.length === 0 || sync.sharePoint.libraries.some(awaitingFirstRead);
}

/** One place and its state. The reason is shown only for a failure, which is
 *  the one state that needs a person to look; a retry is not worth a sentence. */
function SourceRow({ name, source }: { name: string; source: M365SourceStatus }): JSX.Element {
  const state = describeSyncState(source.state, source.lastSyncedAt);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="min-w-0">
        <p className="type-subheadline">{name}</p>
        <p className="type-caption-1">{describeCounts(source.files, source.lastSyncedAt)}</p>
        {source.state === "FAILED" && source.lastError && <p className="type-caption-1">{source.lastError}</p>}
      </div>
      <span className={`badge ${state.tone}`}>{state.label}</span>
    </div>
  );
}

export function Microsoft365Files({
  sharePoint,
  guideHref,
  onSharePointChanged,
  onSignIn,
  signInBusy,
  syncPollMs = SYNC_POLL_MS,
}: {
  /** Absent only from an orchestrator older than this card (a box mid-update):
   *  the block is then not shown, rather than guessing a state. */
  sharePoint: M365SharePointView | undefined;
  /** The customer guide the consent line points an administrator to. */
  guideHref: string;
  /** Re-read the connection once the switch has moved. */
  onSharePointChanged: () => Promise<void>;
  /** The card's own sign-in: it holds the app ids and knows where the browser goes. */
  onSignIn: () => void;
  /** The card's sign-in is in flight. */
  signInBusy: boolean;
  /** Injected so tests need not wait half a minute. */
  syncPollMs?: number;
}): JSX.Element | null {
  const [sync, setSync] = useState<M365SyncStatus | null>(null);
  /** A failed read. Said plainly, not as an alert, like the connection's own. */
  const [syncFailed, setSyncFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingOff, setConfirmingOff] = useState(false);
  /** A failed turn-off. Said inside the dialog, which stays open over the card. */
  const [offError, setOffError] = useState<string | null>(null);

  const present = sharePoint !== undefined;
  const enabled = sharePoint?.enabled;
  const granted = sharePoint?.granted;

  const loadSync = useCallback(async () => {
    try {
      const res = await authFetch("/api/m365/sync-status");
      const next = res.ok ? readSyncStatus(await res.json()) : null;
      if (!next) {
        setSyncFailed(true);
        return;
      }
      setSyncFailed(false);
      setSync(next);
    } catch {
      setSyncFailed(true);
    }
  }, []);

  // Re-read when the switch or the grant moves, as well as on arrival: what the
  // list should say changes with both.
  useEffect(() => {
    if (present) void loadSync();
  }, [present, enabled, granted, loadSync]);

  const polling = sharePoint !== undefined && sync !== null && stillReading(sync, sharePoint);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void loadSync(), syncPollMs);
    return () => clearInterval(timer);
  }, [polling, loadSync, syncPollMs]);

  if (!sharePoint) return null;

  const put = (enable: boolean) =>
    authFetch("/api/m365/sharepoint", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: enable }),
    });

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    let ok = false;
    try {
      ok = (await put(true)).ok;
    } catch {
      // Unreachable is said the same way: nothing was turned on.
    }
    if (ok) await onSharePointChanged();
    else setError("Droplet could not turn on SharePoint. Nothing changed. Try again.");
    setBusy(false);
  };

  const turnOff = async () => {
    setOffError(null);
    let ok = false;
    try {
      ok = (await put(false)).ok;
    } catch {
      // Unreachable is said the same way: nothing was turned off.
    }
    if (!ok) {
      setOffError("Droplet could not turn off SharePoint. Nothing changed. Try again.");
      throw new Error("turn off failed"); // keeps the dialog open
    }
    await onSharePointChanged();
  };

  const closeOff = () => {
    setConfirmingOff(false);
    setOffError(null);
  };

  const libraries = sync?.sharePoint.libraries ?? [];
  const capped = sync?.sharePoint.capped ?? 0;
  const reading = sharePoint.enabled && !sharePoint.needsConsent;

  return (
    <div className="space-y-3" data-testid="m365-files" role="group" aria-labelledby="microsoft-365-files-title">
      <h3 className="type-headline" id="microsoft-365-files-title">
        Your files
      </h3>
      <p className="type-caption-1">
        Droplet keeps a list of file names, folders and dates so it can find a file for you. It never reads what is
        inside your files.
      </p>

      {syncFailed && sync === null && (
        <p className="type-caption-1" data-testid="m365-sync-failed">
          Droplet could not read the status of your files. Reload the page to try again.
        </p>
      )}

      {sync?.oneDrive && (
        <div data-testid="m365-onedrive">
          <SourceRow name="OneDrive" source={sync.oneDrive} />
        </div>
      )}

      <div className="space-y-2" data-testid="m365-sharepoint">
        <div className="flex items-center justify-between gap-3">
          <span className="type-subheadline">{SHAREPOINT_SWITCH_LABEL}</span>
          <ToggleSwitch
            on={sharePoint.enabled}
            // Off asks first: it deletes the list Droplet kept. On asks nothing.
            onToggle={() => (sharePoint.enabled ? setConfirmingOff(true) : void turnOn())}
            disabled={busy}
            ariaLabel={SHAREPOINT_SWITCH_LABEL}
          />
        </div>

        {!sharePoint.enabled && (
          <p className="type-caption-1">
            Droplet reads only your OneDrive. Turn this on and it also keeps a list of the names, folders and dates of
            the files in every SharePoint document library you can open, up to {SHAREPOINT_LIBRARY_LIMIT} libraries. It
            never reads what is inside them.
          </p>
        )}

        {sharePoint.enabled && sharePoint.needsConsent && (
          <div className="space-y-2" data-testid="m365-sharepoint-consent">
            <p className="type-subheadline">{SHAREPOINT_CONSENT_LINE}</p>
            <p className="type-caption-1">
              SharePoint is on, but Microsoft has not approved it for your Droplet yet. On most Microsoft 365 setups an
              administrator has to do that first: ask them to select <strong>Grant admin consent</strong> on your Droplet
              app, then sign in again.{" "}
              <a href={guideHref} className="underline">
                How your Microsoft admin approves it
              </a>
            </p>
            <button className="btn primary type-subheadline" disabled={signInBusy} onClick={onSignIn}>
              {signInBusy ? "Opening Microsoft…" : "Sign in again"}
            </button>
          </div>
        )}

        {reading && sync === null && !syncFailed && <p className="type-caption-1">Checking…</p>}

        {reading && sync !== null && libraries.length === 0 && (
          <p className="type-caption-1">
            No SharePoint document libraries yet. Droplet looks for the ones you can open every few minutes, and they
            appear here as soon as it finds them.
          </p>
        )}

        {reading && libraries.length > 0 && (
          <ul className="flex flex-col gap-2">
            {libraries.map((lib) => (
              <li key={lib.driveId} data-testid="m365-library">
                <SourceRow name={`${lib.siteName} › ${lib.libraryName}`} source={lib} />
              </li>
            ))}
          </ul>
        )}

        {reading && capped > 0 && (
          <p className="type-caption-1" data-testid="m365-sharepoint-capped">
            {capped} more {capped === 1 ? "library" : "libraries"} not read (limit {SHAREPOINT_LIBRARY_LIMIT})
          </p>
        )}

        {error && (
          <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2" role="alert">
            {error}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmingOff}
        title="Stop reading SharePoint?"
        // Says what is DELETED and what SURVIVES: "are you sure?" about an
        // unnamed thing is a speed bump, not a confirmation.
        description={
          "Droplet will delete the list of SharePoint files it kept and stop reading your SharePoint " +
          "document libraries. Your OneDrive is not affected and nothing in Microsoft 365 changes. " +
          "You can turn this on again later."
        }
        confirmLabel="Turn off"
        variant="destructive"
        accessory={
          offError ? (
            <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2" role="alert">
              {offError}
            </p>
          ) : undefined
        }
        onCancel={closeOff}
        onConfirm={turnOff}
      />
    </div>
  );
}
