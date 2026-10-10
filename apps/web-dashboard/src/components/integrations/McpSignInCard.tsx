"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  disconnectMcpOAuth,
  fetchMcpOAuthConnections,
  pasteMcpRedirect,
  startMcpSignIn,
  type McpOAuthSide,
  type McpSignInView,
} from "@/lib/api";

/**
 * WARP-3951 — "Sign in with <provider>" for a remote MCP server.
 *
 * The box is the OAuth client; this card only opens the `authorizeUrl` the box
 * returns (the `GoogleAccountCard` pattern) and shows a status. It renders
 * NOTHING when the box has no sign-in view for the provider, so it is safe
 * against a box that predates the routes: no dead button.
 *
 * `admin` mode (Integrations › Connector credentials) adds the Workspace
 * connection, behind a verbatim acknowledgement. Guests see nothing and cause
 * no request.
 */

export const WORKSPACE_ACK_TEXT =
  "Everyone allowed to use this server acts as this account and sees what it sees.";

const OUTCOMES = {
  connected: { error: false, text: "You are signed in." },
  cancelled: { error: false, text: "Sign-in was cancelled. Try again when you’re ready." },
  expired: { error: true, text: "That sign-in expired. Start again when you’re ready." },
  failed: { error: true, text: "Sign-in could not be completed. Try again, or paste the address you landed on." },
  blocked: { error: true, text: "Sign-in was blocked because remote MCP was switched off. Nothing was sent to Atlassian." },
} as const;

/** `?mcp=<provider>:<outcome>`: consumed only by the card whose provider matches. */
function takeOutcome(provider: string): keyof typeof OUTCOMES | null {
  const url = new URL(window.location.href);
  const raw = url.searchParams.get("mcp");
  if (raw === null) return null;
  const [p, outcome] = raw.split(":");
  if (p !== provider) return null;
  url.searchParams.delete("mcp");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return Object.hasOwn(OUTCOMES, outcome ?? "") ? (outcome as keyof typeof OUTCOMES) : "failed";
}

/** Fixed sentences for the box's 409 codes; the box's own message is never shown. */
const START_BLOCKED: Record<string, (name: string) => string> = {
  remote_mcp_off: () => "Remote MCP is switched off for this Workspace. An owner or admin can turn it on in Integrations › Connector credentials.",
  server_not_allowed: (name) => `This Droplet isn't set up to reach ${name}.`,
  connection_disabled: (name) => `An owner or admin turned ${name} off for this Workspace.`,
};

function statusText(side: McpOAuthSide | null): string {
  switch (side?.state) {
    case "CONNECTED": return "Signed in · refreshes automatically";
    case "NEEDS_RECONNECT":
    case "ERROR": return "Needs sign-in again";
    case "PENDING_CONSENT": return "Waiting for approval…";
    default: return "Not signed in";
  }
}

const field =
  "w-full px-3 py-2 type-footnote focus:outline-none focus:ring-2 focus:ring-[var(--brand)]";
const fieldStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-input)",
  color: "var(--text)",
};

export function McpSignInCard({
  provider,
  displayName,
  admin = false,
  navigate = (url: string) => window.location.assign(url),
}: {
  provider: string;
  displayName: string;
  admin?: boolean;
  navigate?: (url: string) => void;
}) {
  const { user } = useAuth();
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const allowed = isAdmin || user?.role === "family";
  const [view, setView] = useState<McpSignInView | null>(null);
  const [outcome, setOutcome] = useState<keyof typeof OUTCOMES | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [ack, setAck] = useState(false);
  const [blockedCode, setBlockedCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await fetchMcpOAuthConnections();
      setView(all.find((v) => v.provider === provider) ?? null);
    } catch {
      setView(null); // no view means no card: a box without the routes shows nothing
    }
  }, [provider]);

  useEffect(() => {
    if (!allowed) return;
    setOutcome(takeOutcome(provider));
    void load();
  }, [allowed, provider, load]);

  if (!allowed || !view) return null;

  const start = async (scope: "MEMBER" | "WORKSPACE") => {
    if (busy || (scope === "WORKSPACE" && !ack)) return;
    setBusy(true);
    setBlockedCode(null);
    setError(null);
    setBlockedCode(null);
    setOutcome(null);
    try {
      const body = await startMcpSignIn({
        provider,
        scope,
        ...(scope === "WORKSPACE" ? { acknowledge: true as const } : {}),
        ...(view.callbackSupported ? {} : { redirectMode: "loopback" as const }),
      });
      // Only ever an http(s) address the box returned; never built from page state.
      const target = new URL(body.authorizeUrl);
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("bad_url");
      navigate(body.authorizeUrl);
      return;
    } catch (err) {
      const blocked = err instanceof Error && Object.hasOwn(START_BLOCKED, err.message) ? START_BLOCKED[err.message] : undefined;
      if (blocked) {
        setBlockedCode(err instanceof Error ? err.message : null);
        setError(blocked(displayName));
        setBusy(false);
        return;
      }
      setError(`Droplet could not start the ${displayName} sign-in. Try again, or ask your Droplet administrator.`);
    }
    setBusy(false);
  };

  const paste = async () => {
    const text = pasted.trim();
    if (busy || !text) return;
    setBusy(true);
    setError(null);
    try {
      await pasteMcpRedirect(text);
      setPasted("");
      setOutcome("connected");
      await load();
    } catch (err) {
      setError(
        err instanceof Error && err.message === "bare_code_rejected"
          ? "Paste the whole address from the browser’s address bar, not just the code."
          : "That address could not be used. Start the sign-in again and paste the full address.",
      );
    }
    setBusy(false);
  };

  const disconnect = async (side: McpOAuthSide | null) => {
    if (busy || !side?.id) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectMcpOAuth(side.id);
      setOutcome(null);
      await load();
    } catch {
      setError("Droplet could not disconnect. Nothing changed. Try again.");
    }
    setBusy(false);
  };

  const note = outcome ? OUTCOMES[outcome] : null;
  const pending = view.member?.state === "PENDING_CONSENT";
  const signedIn = view.member?.state === "CONNECTED";
  const wsConnected = view.workspace?.state === "CONNECTED";
  const showWorkspace = admin && isAdmin;

  return (
    <section
      className={admin ? "space-y-4" : "card space-y-4"}
      data-testid={`mcp-sign-in-${provider}`}
      aria-labelledby={`mcp-sign-in-${provider}-title`}
    >
      <h3 className="type-title-3" id={`mcp-sign-in-${provider}-title`}>
        {admin ? `Sign in with ${displayName}` : displayName}
      </h3>
      {!admin && (
        <p className="type-caption-1">
          Sign in so Droplet acts as you in {displayName}, with only what you can see there. Writes still ask for a thumbs-up.
        </p>
      )}
      {note && (
        <p className={note.error ? "type-footnote text-system-red" : "type-footnote"} role={note.error ? "alert" : "status"}>
          {note.text}
        </p>
      )}
      <p className="type-subheadline" role="status" data-testid="mcp-member-status">{statusText(view.member)}</p>
      {!view.callbackSupported && (
        <p className="type-caption-1">
          This Droplet has no registered HTTPS address, so after approving, copy the full address you land on and paste it below.
        </p>
      )}
      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start("MEMBER")}>
          {pending || signedIn || view.member?.state === "NEEDS_RECONNECT" ? `Sign in with ${displayName} again` : `Sign in with ${displayName}`}
        </button>
        {view.member?.id && view.member.state !== "DISCONNECTED" && (
          <button type="button" className="btn" disabled={busy} onClick={() => void disconnect(view.member)}>Disconnect</button>
        )}
      </div>
      {(pending || !view.callbackSupported) && (
        <div className="space-y-1">
          <label className="type-caption-1 block" htmlFor={`mcp-paste-${provider}`}>
            If the browser ended on a page that did not load, paste its full address here
          </label>
          <input
            id={`mcp-paste-${provider}`}
            type="text"
            className={field}
            style={fieldStyle}
            autoComplete="off"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <button type="button" className="btn" disabled={busy || !pasted.trim()} onClick={() => void paste()}>
            Finish sign-in
          </button>
        </div>
      )}

      {showWorkspace && (
        <div className="space-y-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
          <h4 className="type-headline">Workspace connection</h4>
          <p className="type-subheadline" role="status" data-testid="mcp-workspace-status">
            {statusText(view.workspace)}
            {wsConnected && view.workspace?.ackBy ? ` · acknowledged by ${view.workspace.ackBy}` : ""}
          </p>
          <label className="flex items-start gap-2 type-footnote">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>{WORKSPACE_ACK_TEXT}</span>
          </label>
          <div className="flex items-center gap-3">
            <button type="button" className="btn" disabled={busy || !ack} onClick={() => void start("WORKSPACE")}>
              Create a Workspace connection
            </button>
            {view.workspace?.id && view.workspace.state !== "DISCONNECTED" && (
              <button type="button" className="btn" disabled={busy} onClick={() => void disconnect(view.workspace)}>
                Disconnect Workspace connection
              </button>
            )}
          </div>
        </div>
      )}
      {error && <p role="alert" className="type-footnote text-system-red">{error}</p>}
      {blockedCode === "remote_mcp_off" && isAdmin && (
        <a className="type-caption-1 underline" style={{ color: "var(--brand)" }} href="/integrations/credentials">Open the remote MCP switch</a>
      )}
    </section>
  );
}
