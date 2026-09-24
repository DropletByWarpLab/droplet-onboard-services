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
 * `/api/m365/callback`, which redirects here with `?m365=<outcome>`. The ids
 * typed below are the app registration's, which are not secrets.
 *
 * 🔴 No hostname literals in this file — the `egress-gate` CI check reads
 * string literals in source and denies anything host-shaped. Microsoft's URL
 * always comes from the server.
 */

import { useCallback, useEffect, useState, type JSX } from "react";

import { authFetch, useAuth } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";

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
}

/** The outcomes `/api/m365/callback` can land here with. A closed set: the
 *  callback never reflects the query, and neither does this card. */
const OUTCOMES = {
  connected: { tone: "ok", text: "Microsoft 365 is connected." },
  cancelled: { tone: "info", text: "Sign-in was cancelled. Nothing was connected." },
  expired: { tone: "error", text: "That sign-in took too long and expired. Start it again below." },
  failed: { tone: "error", text: "Microsoft 365 could not be connected." },
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
    return "The redirect URI below is not on your app registration yet. Add it exactly as shown.";
  }
  if (lastError.includes("AADSTS7000218") || lastError.includes("AADSTS9002327")) {
    return "The redirect URI is registered under the wrong platform. Register it under “Mobile and desktop applications”.";
  }
  if (lastError.includes("AADSTS700016")) {
    return "Microsoft cannot find that Application (client) ID in your organisation. Check it against the app registration's Overview page.";
  }
  if (lastError.includes("AADSTS50194") || lastError.includes("AADSTS90002") || lastError.includes("AADSTS900023")) {
    return "Check the Directory (tenant) ID against the app registration's Overview page.";
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

/** Read and strip `?m365=` once. Reads `window.location` rather than
 *  `useSearchParams`, which would force a Suspense boundary onto Settings. */
function takeOutcome(): Outcome | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get(M365_OUTCOME_PARAM);
  if (raw === null) return null;
  url.searchParams.delete(M365_OUTCOME_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return raw in OUTCOMES ? (raw as Outcome) : null;
}

export function Microsoft365Card({
  navigate = (url: string) => window.location.assign(url),
}: {
  /** Where the browser goes to sign in. Injected so tests can observe it. */
  navigate?: (url: string) => void;
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
  const [copied, setCopied] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authFetch("/api/m365/connection");
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const next = (await res.json()) as M365ConnectionView;
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
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    setOutcome(takeOutcome());
    void load();
  }, [allowed, load]);

  if (!allowed) return null;

  const signIn = async () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await authFetch("/api/m365/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: clientId.trim(), tenantId: tenantId.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { authorizeUrl?: string; message?: string };
      if (res.ok && body.authorizeUrl) {
        navigate(body.authorizeUrl);
        return; // leaving the page; keep the button busy
      }
      setError(body.message ?? "Droplet could not start the Microsoft sign-in. Try again.");
    } catch {
      setError("Droplet could not reach itself to start the sign-in. Check your connection and try again.");
    }
    setBusy(false);
  };

  const disconnect = async () => {
    const res = await authFetch("/api/m365/connection", { method: "DELETE" });
    if (!res.ok) {
      setError("Droplet could not disconnect Microsoft 365. Try again.");
      throw new Error("disconnect failed"); // keeps the dialog open
    }
    setOutcome(null);
    await load();
  };

  const copyRedirect = async () => {
    if (!view) return;
    try {
      await navigator.clipboard.writeText(view.redirectUri);
      setCopied(true);
    } catch {
      // The field is selectable; copying by hand still works.
    }
  };

  const connected = view?.state === "CONNECTED";
  const hint = hintForError(view?.lastError ?? null);
  const since = formatDate(view?.connectedAt ?? null);
  const note = outcome ? OUTCOMES[outcome] : null;

  return (
    <section className="card space-y-4" id="microsoft-365" aria-labelledby="microsoft-365-title">
      <h2 className="type-title-3" id="microsoft-365-title">
        Microsoft 365
      </h2>
      <p className="type-caption-1">
        Connect your own Microsoft 365 account and Droplet reads your mail, calendar, contacts and
        the list of your OneDrive files as you, and never more than you can see. This is the one
        connection that goes over the internet to Microsoft, and only after you sign in.{" "}
        <a href={SETUP_GUIDE_HREF} className="underline">
          How your Microsoft admin sets it up
        </a>
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

      {loadFailed && !view && (
        <p className="type-caption-1" data-testid="m365-load-failed">
          Droplet could not read your Microsoft 365 connection. Reload the page to try again.
        </p>
      )}

      {view && (
        <div className="space-y-1" data-testid="m365-state">
          <p className="type-subheadline" role="status">
            {stateLabel(view)}
            {connected && since ? ` · since ${since}` : ""}
          </p>
          {(view.state === "NEEDS_RECONNECT" || view.state === "ERROR") && view.lastError && (
            <p className="type-caption-1">{view.lastError}</p>
          )}
          {(view.state === "NEEDS_RECONNECT" || view.state === "ERROR") && hint && (
            <p className="type-caption-1" data-testid="m365-hint">
              {hint}
            </p>
          )}
        </div>
      )}

      {view && connected && (
        <button className="btn" disabled={busy} onClick={() => setConfirmingDisconnect(true)}>
          Disconnect
        </button>
      )}

      {view && !connected && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            Application (client) ID
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            Directory (tenant) ID
            <input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            Redirect URI for your app registration
            <span className="flex items-center gap-2">
              <input value={view.redirectUri} readOnly className="flex-1" onFocus={(e) => e.target.select()} />
              <button className="btn" type="button" onClick={() => void copyRedirect()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </span>
          </label>
          <p className="type-caption-1 px-0.5 sm:col-span-2">
            Register it under “Mobile and desktop applications” on a single-tenant app. Both IDs are
            on the app registration&apos;s Overview page. Neither is a secret.
          </p>
          <div className="flex items-center gap-2 pt-1 sm:col-span-2">
            <button className="btn primary type-subheadline" disabled={busy} onClick={() => void signIn()}>
              {busy
                ? "Opening Microsoft…"
                : view.state === "NEEDS_RECONNECT" || view.state === "ERROR"
                  ? "Sign in again"
                  : "Sign in with Microsoft"}
            </button>
          </div>
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
          "calendar, contacts and files. Nothing in your Microsoft 365 account changes. To revoke it " +
          "on Microsoft's side too, ask your Microsoft admin to remove Droplet's permissions."
        }
        confirmedIdentifier={view?.accountUpn ?? undefined}
        confirmLabel="Disconnect"
        variant="destructive"
        onCancel={() => setConfirmingDisconnect(false)}
        onConfirm={disconnect}
      />
    </section>
  );
}
