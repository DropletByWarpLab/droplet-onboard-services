"use client";

/**
 * WARP-3056 — "Your Microsoft 365": one person connects their own account.
 *
 * The orchestrator could connect Microsoft 365 (WARP-2704 authorization code +
 * PKCE, WARP-2705 the customer's own Entra app) but nothing in the dashboard
 * called `/api/m365/*`, so nobody could. This card is that surface.
 *
 * ── Why here, and why self-scoped ─────────────────────────────────────────
 *
 * The connection is PER PERSON (`M365Connection`, one row per user, every
 * route scoped to the requester), unlike the integrations hub, which is
 * box-level and guest-readable. It sits on Settings beside "Mailboxes Droplet
 * reads" because that is where a person looks for "my mail", and because
 * `family` can reach Settings but not the owner/admin integrations hub. It
 * renders for owner, admin and family — the roles the routes accept — and
 * for nobody else.
 *
 * ── What it never holds ───────────────────────────────────────────────────
 *
 * No token, code or state. The browser goes to the `authorizeUrl` the box
 * returns (built server-side with PKCE); Microsoft sends it back to
 * `/api/m365/callback`, which redirects here with `?m365=<outcome>`.
 * Shared administrator setup is resolved on the server. Previously saved
 * personal app registrations remain usable behind advanced settings.
 *
 * 🔴 No hostname literals in this file — the `egress-gate` CI check reads
 * string literals in source and denies anything host-shaped. Microsoft's URL
 * always comes from the server.
 *
 * ── Your files (WARP-3538) ────────────────────────────────────────────────
 *
 * Once connected, the card also shows what Droplet keeps a list of: OneDrive's
 * file count, and the person's own switch for SharePoint document libraries
 * with the libraries it finds. That block is `Microsoft365Files`; this card
 * only passes it the connection's `sharePoint` block, re-reads the connection
 * when the switch moves, and lends it its own sign-in for the case where
 * Microsoft has not approved SharePoint yet.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Mail } from "lucide-react";

import { authFetch, useAuth } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Microsoft365Files, SYNC_POLL_MS, type M365SharePointView } from "./Microsoft365Files";
import { Microsoft365Calendar, type MicrosoftCalendarView } from "./Microsoft365Calendar";
import type { AccountConnectionNavigation } from "./ConnectedAccounts";
import { Microsoft365Mail, type MicrosoftMailView } from "./Microsoft365Mail";

type M365State = "DISCONNECTED" | "PENDING_CONSENT" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR";

/** `GET /api/m365/connection` — the box's allow-listed view. */
export interface M365ConnectionView {
  state: M365State;
  accountUpn: string | null;
  tenantId: string | null;
  app: { clientId: string; tenantId: string } | null;
  grantedScopes: string[];
  connectedAt: string | null;
  lastRefreshOkAt: string | null;
  lastError: string | null;
  /** The exact URL the owner registers on their app. */
  redirectUri: string;
  /** Shared administrator setup or a previously saved personal registration. */
  configured?: boolean;
  /** The person's own SharePoint switch and whether Microsoft has approved it.
   *  Absent only from an orchestrator older than this card (a box mid-update). */
  sharePoint?: M365SharePointView;
  calendar?: MicrosoftCalendarView;
  mail?: MicrosoftMailView;
}

/** The outcomes `/api/m365/callback` can land here with. A closed set: the
 *  callback never reflects the query, and neither does this card. Looked up
 *  by own key only (`isOutcome`) — `"toString" in OUTCOMES` is true. */
const OUTCOMES = {
  connected: { tone: "ok", text: "Microsoft 365 is connected." },
  cancelled: { tone: "info", text: "Sign-in was cancelled. Nothing was connected." },
  expired: { tone: "error", text: "That sign-in took too long and expired. Start it again below." },
  failed: { tone: "error", text: "Microsoft 365 could not be connected." },
  different_account: { tone: "error", text: "To connect a different Microsoft account, disconnect the current one first. Your existing local copies were kept." },
  invalid: {
    tone: "error",
    text: "That sign-in did not start in this browser, so Droplet ignored it. Start it again below.",
  },
} as const;
type Outcome = keyof typeof OUTCOMES;

/** The query parameter the callback sets. */
export const M365_OUTCOME_PARAM = "m365";

/** The bundled customer guide. A literal rather than `integrationGuideHref()`:
 *  that module inlines every guide's markdown, and Settings should not carry
 *  them all. `Microsoft365Card.test.tsx` pins the two to each other. */
export const SETUP_GUIDE_HREF = "/help/integrations/microsoft-365";

/**
 * Plain-language hint for the Entra errors a mis-registered app produces.
 * Each one is a setting on the app registration, which signing in again
 * cannot fix — so the card says where to look instead of "try again".
 */
export function hintForError(lastError: string | null): string | null {
  if (!lastError) return null;
  if (lastError.includes("AADSTS50011")) {
    return "Ask your Droplet administrator to check the redirect URI in Account connection setup.";
  }
  if (lastError.includes("AADSTS7000218") || lastError.includes("AADSTS9002327")) {
    return "The redirect URI is registered under the wrong platform. Register it under “Mobile and desktop applications”.";
  }
  if (lastError.includes("AADSTS700016")) {
    return "Ask your Droplet administrator to check the Application (client) ID in Account connection setup.";
  }
  if (lastError.includes("AADSTS50194") || lastError.includes("AADSTS90002") || lastError.includes("AADSTS900023")) {
    return "Ask your Droplet administrator to check the Directory (tenant) ID in Account connection setup.";
  }
  if (lastError.includes("AADSTS90094")) {
    return "Your organisation needs an administrator to approve Droplet. Ask your Microsoft admin to grant admin consent on the app registration.";
  }
  return null;
}

function stateLabel(view: M365ConnectionView): string {
  switch (view.state) {
    case "CONNECTED":
      return view.accountUpn ? `Connected as ${view.accountUpn}` : "Connected";
    case "PENDING_CONSENT":
      return "Signing in…";
    case "NEEDS_RECONNECT":
      return "Needs reconnect";
    case "ERROR":
      return "Error";
    default:
      return "Not connected";
  }
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

function isOutcome(raw: string): raw is Outcome {
  return Object.hasOwn(OUTCOMES, raw);
}

/** Read and strip `?m365=` once. Reads `window.location` rather than
 *  `useSearchParams`, which would force a Suspense boundary onto Settings. */
function takeOutcome(): Outcome | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get(M365_OUTCOME_PARAM);
  if (raw === null) return null;
  url.searchParams.delete(M365_OUTCOME_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return isOutcome(raw) ? raw : null;
}

export function Microsoft365Card({
  navigate = (url: string) => window.location.assign(url),
  syncPollMs = SYNC_POLL_MS,
  calendarPollMs = 5_000,
  mailPollMs = 5_000,
  returnTo,
  beforeConnect,
}: AccountConnectionNavigation & {
  /** Where the browser goes to sign in. Injected so tests can observe it. */
  navigate?: (url: string) => void;
  /** How often the files block re-reads while something is still being read for
   *  the first time. Injected so tests need not wait half a minute. */
  syncPollMs?: number;
  calendarPollMs?: number;
  mailPollMs?: number;
} = {}): JSX.Element | null {
  const { user } = useAuth();
  const role = user?.role;
  const allowed = role === "owner" || role === "admin" || role === "family";

  const [view, setView] = useState<M365ConnectionView | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [clientId, setClientId] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A failed status read. Said plainly, not as an alert: like the mailbox
   *  card above it, a list that could not be read is not an emergency on a
   *  settings page, and the sign-in reports its own failures. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  /** A failed disconnect. Said inside the dialog, which stays open over the
   *  card so the person can retry; the card's own error line would be hidden
   *  behind it. */
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch("/api/m365/connection");
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const next = (await res.json()) as M365ConnectionView;
      if (!next || !["DISCONNECTED", "PENDING_CONSENT", "CONNECTED", "NEEDS_RECONNECT", "ERROR"].includes(next.state)) throw new Error("invalid connection view");
      setLoadFailed(false);
      setView(next);
      // Pre-fill from the stored app so reconnecting is one click; never
      // overwrite what the person is typing.
      if (next.app) {
        setClientId((cur) => cur || next.app!.clientId);
        setTenantId((cur) => cur || next.app!.tenantId);
      }
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    setOutcome(takeOutcome());
    void load();
  }, [allowed, load]);

  useEffect(() => {
    if (!allowed || view?.calendar?.state !== "WAITING") return;
    const timer = window.setInterval(() => void load(), calendarPollMs);
    return () => window.clearInterval(timer);
  }, [allowed, view?.calendar?.state, load, calendarPollMs]);

  useEffect(() => {
    // The calendar timer already reloads the entire connection while waiting.
    if (!allowed || view?.mail?.state !== "WAITING" || view?.calendar?.state === "WAITING") return;
    const timer = window.setInterval(() => void load(), mailPollMs);
    return () => window.clearInterval(timer);
  }, [allowed, view?.mail?.state, view?.calendar?.state, load, mailPollMs]);

  if (!allowed) return null;

  const signIn = async (usePersonalRegistration = false) => {
    if (busy || !view) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      if (beforeConnect) {
        try {
          await beforeConnect();
        } catch {
          if (mounted.current) {
            setError("Droplet could not save your setup progress. Try again before connecting Microsoft.");
            setBusy(false);
          }
          return;
        }
      }
      if (!mounted.current) return;
      if (new URL(view.redirectUri).origin !== window.location.origin) {
        navigate(new URL(returnTo ?? "/settings", view.redirectUri).toString());
        return;
      }
      const res = await authFetch("/api/m365/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(usePersonalRegistration ? { clientId: clientId.trim(), tenantId: tenantId.trim() } : {}), ...(returnTo ? { returnTo } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { authorizeUrl?: string; message?: string };
      if (!mounted.current) return;
      if (res.ok && body.authorizeUrl) {
        navigate(body.authorizeUrl);
        return; // leaving the page; keep the button busy
      }
      setError("Droplet could not start the Microsoft sign-in. Try again, or ask your Droplet administrator to check Account connection setup.");
    } catch {
      setError("Droplet could not reach itself to start the sign-in. Check your connection and try again.");
    }
    setBusy(false);
  };

  const disconnect = async () => {
    setDisconnectError(null);
    let ok = false;
    try {
      ok = (await authFetch("/api/m365/connection", { method: "DELETE" })).ok;
    } catch {
      // Unreachable is said the same way: nothing was disconnected.
    }
    if (!ok) {
      setDisconnectError("Droplet could not disconnect Microsoft 365. Nothing changed. Try again.");
      throw new Error("disconnect failed"); // keeps the dialog open
    }
    setOutcome(null);
    await load();
  };

  const closeDisconnect = () => {
    setConfirmingDisconnect(false);
    setDisconnectError(null);
  };

  const connected = view?.state === "CONNECTED";
  const configured = view?.configured ?? Boolean(view?.app);
  const hint = hintForError(view?.lastError ?? null);
  const since = formatDate(view?.connectedAt ?? null);
  const note = outcome ? OUTCOMES[outcome] : null;
  const opensRegisteredAddress = (() => {
    try { return Boolean(view && new URL(view.redirectUri).origin !== window.location.origin); }
    catch { return false; }
  })();

  return (
    <section className="card space-y-4" id="microsoft-365" aria-labelledby="microsoft-365-title">
      <div className="flex items-center gap-3">
        <span className="ri brand" aria-hidden="true"><Mail size={20} /></span>
        <h3 className="type-title-3" id="microsoft-365-title">Outlook / Microsoft 365</h3>
      </div>
      <p className="type-caption-1">
        Connect your work or school Microsoft account. Approve access on Microsoft&apos;s website,
        then return here. Choose whether to import your received and sent Outlook emails or calendar into Droplet after connecting.
        Imported emails can be read and searched locally; sending from Outlook in Droplet is not available.
        Droplet also checks contacts and keeps OneDrive file lists.
      </p>

      {note && (
        <p
          className={
            note.tone === "error"
              ? "type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
              : note.tone === "ok"
                ? "type-footnote text-system-green"
                : "type-footnote"
          }
          role={note.tone === "error" ? "alert" : "status"}
          data-testid="m365-outcome"
        >
          {note.text}
        </p>
      )}

      {loadFailed && (
        <div className="space-y-2" data-testid="m365-load-failed">
          <p className="type-caption-1">Droplet could not read your Microsoft 365 connection.</p>
          <button type="button" className="btn" disabled={loading} onClick={() => void load()}>{loading ? "Checking…" : "Retry"}</button>
        </div>
      )}
      {!view && !loadFailed && <p className="type-caption-1" role="status">Checking connection…</p>}
      {opensRegisteredAddress && <p className="type-caption-1">Account linking opens Droplet&apos;s registered address. You may need to sign in to Droplet there.</p>}

      {view && (
        <div className="space-y-1" data-testid="m365-state">
          <p className="type-subheadline" role="status">
            {stateLabel(view)}
            {connected && since ? ` · since ${since}` : ""}
          </p>
          {(view.state === "NEEDS_RECONNECT" || view.state === "ERROR") && (
            <p className="type-caption-1">Reconnect to let Droplet continue reading your account.</p>
          )}
          {(view.state === "NEEDS_RECONNECT" || view.state === "ERROR") && hint && (
            <p className="type-caption-1" data-testid="m365-hint">
              {hint}
            </p>
          )}
        </div>
      )}

      {view && (connected || view.accountUpn || view.calendar?.enabled || view.mail?.enabled) && (
        <button className="btn" disabled={busy} onClick={() => setConfirmingDisconnect(true)}>
          Disconnect
        </button>
      )}

      {view?.mail && (connected || view.mail.enabled) && <Microsoft365Mail view={view.mail} accountAddress={view.accountUpn} connected={connected} onChanged={load} onReconnect={() => void signIn()} signInBusy={busy} />}

      {view?.calendar && (connected || view.calendar.enabled) && <Microsoft365Calendar view={view.calendar} accountAddress={view.accountUpn} connected={connected} onChanged={load} onReconnect={() => void signIn()} signInBusy={busy} />}

      {view && connected && (
        <Microsoft365Files
          sharePoint={view.sharePoint}
          guideHref={SETUP_GUIDE_HREF}
          onSharePointChanged={load}
          onSignIn={() => void signIn()}
          signInBusy={busy}
          syncPollMs={syncPollMs}
        />
      )}

      {view && !connected && (
        <div className="space-y-3">
          {!configured && <p className="type-caption-1">Ask your Droplet administrator to enable Microsoft account connections.</p>}
          <button className="btn primary type-subheadline" disabled={busy || loading || !configured || loadFailed} onClick={() => void signIn()}>
            {busy ? "Opening Microsoft…" : view.state === "NEEDS_RECONNECT" || view.state === "ERROR" ? "Reconnect Outlook" : "Connect Outlook"}
          </button>
          {view.app && <details className="type-caption-1">
            <summary className="cursor-pointer py-2">Advanced personal app settings</summary>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3">
          <label className="flex flex-col gap-1.5">
            Application (client) ID
            <input
              className="input"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            Directory (tenant) ID
            <input
              className="input"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <p className="type-caption-1 px-0.5 sm:col-span-2">
            Your saved personal registration still works. Administrator setup lets everyone connect
            without entering these settings. <a href={SETUP_GUIDE_HREF} className="underline">Microsoft setup guide</a>
          </p>
          <div className="flex items-center gap-2 pt-1 sm:col-span-2">
            <button className="btn" disabled={busy || !clientId.trim() || !tenantId.trim()} onClick={() => void signIn(true)}>Connect using these settings</button>
          </div>
            </div>
          </details>}
        </div>
      )}

      {error && (
        <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2" role="alert">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirmingDisconnect}
        title="Disconnect Microsoft 365?"
        description={
          "Droplet will forget the key Microsoft gave it for this account and stop reading its mail, " +
          "calendar, contacts and files, and delete its local email archive, attachment metadata, Droplet drafts and imported calendar events. Nothing in your Microsoft 365 account changes. To revoke it " +
          "on Microsoft's side too, ask your Microsoft admin to remove Droplet's permissions."
        }
        confirmedIdentifier={view?.accountUpn ?? undefined}
        confirmLabel="Disconnect"
        variant="destructive"
        accessory={
          disconnectError ? (
            <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2" role="alert">
              {disconnectError}
            </p>
          ) : undefined
        }
        onCancel={closeDisconnect}
        onConfirm={disconnect}
      />
    </section>
  );
}
