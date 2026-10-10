"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { ArrowLeft, Copy, ExternalLink, MoreHorizontal } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { useIntegrations } from "@/lib/hooks/useIntegrations";
import {
  disconnectMcpOAuth,
  fetchMcpOAuthConnections,
  setMcpServerEnabled,
  startMcpSignIn,
  type ConnectorDirectoryEntry,
} from "@/lib/api";
import { DisconnectControl } from "./DisconnectControl";
import { IconTile, VerifiedMark } from "./DirectoryCards";
import { DropMenu } from "./DropMenu";
import { LanApiSetupDialog } from "./LanApiConnectionSetup";
import { ConnectWizard } from "./ConnectWizard";
import { McpSignInCard } from "./McpSignInCard";
import { PromptSuggestions } from "./PromptSuggestions";
import { RelatedConnectors } from "./RelatedConnectors";
import { ToolPermissions } from "./ToolPermissions";
import { isYours } from "./directory-model";

/** The Workspace-connection acknowledgement, verbatim (same words as the credentials page). */
const WORKSPACE_ACK =
  "Everyone allowed to use this server acts as this account and sees what it sees.";

const TRUST_NOTE =
  "Only use connectors from vendors your business already trusts. Droplet does not control which tools a vendor publishes or how they change.";

/** `?mcp=<provider>:<outcome>` is where the box's callback lands; the copy is ours. */
const OUTCOMES: Record<string, { error: boolean; text: (name: string) => string }> = {
  connected: { error: false, text: (n) => `You are connected to ${n}.` },
  cancelled: { error: false, text: () => "Sign-in was cancelled. Try again when you’re ready." },
  expired: { error: true, text: () => "That sign-in expired. Start again when you’re ready." },
  failed: { error: true, text: () => "Sign-in could not be completed. Try again." },
};

/** Fixed sentences for the box's refusals; the box's own message is never shown. */
function startRefusal(code: string, name: string): string {
  return code === "connection_disabled"
    ? `An owner or admin turned ${name} off for this Workspace.`
    : `Droplet could not start the ${name} sign-in. Try again, or ask your Droplet administrator.`;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="type-caption-1 text-[color:var(--text-faint)]" style={{ letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div className="type-footnote text-[color:var(--text)]">{children}</div>
    </div>
  );
}

function signInFact(e: ConnectorDirectoryEntry): string | null {
  if (e.kind === "mcp") return e.signInRequired ? "Required" : null;
  if (e.actions.connect === "wizard") return "API key";
  if (e.actions.connect === "lanApi" || e.actions.connect.startsWith("route:")) return "On your network";
  return null;
}

export function ConnectorDetail({
  entry,
  all,
  refresh,
  navigate = (url: string) => window.location.assign(url),
}: {
  entry: ConnectorDirectoryEntry;
  all: readonly ConnectorDirectoryEntry[];
  refresh: () => void | Promise<unknown>;
  navigate?: (url: string) => void;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const canManage = user?.role === "owner" || user?.role === "admin";
  const isMcp = entry.kind === "mcp";
  const yours = isYours(entry, canManage);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ error: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<"disconnect" | "turn-off" | "disconnect-workspace" | null>(null);
  const [workspacePanel, setWorkspacePanel] = useState(false);
  const [ack, setAck] = useState(false);
  const [wizardFor, setWizardFor] = useState<string | null>(null);
  const [lanApiOpen, setLanApiOpen] = useState(false);
  const [allTools, setAllTools] = useState(false);
  const [copied, setCopied] = useState(false);

  // A box without an https address cannot use the browser hand-off: the sign-in
  // card (with its paste field) takes over. Unreadable is treated as supported.
  const { data: signInViews } = useSWR(isMcp ? "/api/mcp/oauth/connections" : null, fetchMcpOAuthConnections, {
    shouldRetryOnError: false,
  });
  const pasteFallback = signInViews?.find((v) => v.provider === entry.id)?.callbackSupported === false;

  // The wizard / route dispatch for a business system is the descriptor's own.
  const { entries: hubEntries } = useIntegrations(!isMcp && canManage);
  const hub = hubEntries.find((h) => h.meta.id === entry.id || h.providerKeys.includes(entry.id));

  useEffect(() => {
    if (!isMcp || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("mcp");
    if (raw === null) return;
    const [p, o] = raw.split(":");
    if (p !== entry.id) return;
    url.searchParams.delete("mcp");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    const known = Object.hasOwn(OUTCOMES, o ?? "") ? OUTCOMES[o!]! : OUTCOMES.failed!;
    setOutcome({ error: known.error, text: known.text(entry.name) });
    void refresh();
    // Once per connector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  const act = async (fn: () => Promise<void>, fail: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch {
      setError(fail);
    }
    setBusy(false);
  };

  const signIn = async (scope: "MEMBER" | "WORKSPACE") => {
    if (busy || (scope === "WORKSPACE" && !ack)) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const body = await startMcpSignIn({
        provider: entry.id,
        scope,
        ...(scope === "WORKSPACE" ? { acknowledge: true as const } : {}),
      });
      // Only ever an http(s) address the box returned; never built from page state.
      const target = new URL(body.authorizeUrl);
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("bad_url");
      navigate(body.authorizeUrl);
      return;
    } catch (err) {
      setError(startRefusal(err instanceof Error ? err.message : "", entry.name));
    }
    setBusy(false);
  };

  const connectSystem = () => {
    const a = entry.actions.connect;
    if (a === "lanApi") return setLanApiOpen(true);
    if (a.startsWith("route:")) return router.push(a.slice("route:".length));
    if (a === "wizard") {
      if (hub?.connect.kind === "wizard") return setWizardFor(hub.connect.catalogId);
      if (hub?.connect.kind === "route") return router.push(hub.connect.href);
    }
    setError(`${entry.name} can’t be set up from the dashboard yet.`);
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(entry.connectorUrl ?? "");
      setCopied(true);
    } catch {
      setError("Couldn’t copy. Select the address and copy it by hand.");
    }
  };

  const conn = entry.connection;
  const mcp = conn.kind === "mcp" ? conn : null;
  const off = mcp?.workspaceState === "DISABLED";
  const memberConnected = mcp?.member?.state === "CONNECTED";
  const needsSignIn = mcp?.member?.state === "NEEDS_RECONNECT" || mcp?.member?.state === "ERROR";
  const tools = entry.tools ?? [];
  const shownTools = allTools ? tools : tools.slice(0, 12);
  const fact = signInFact(entry);
  const guide = entry.links.guide;

  const menuItems = [
    {
      id: "turn-off",
      label: off ? "Turn on for the Workspace" : "Turn off for the Workspace",
      hidden: !isMcp || !entry.actions.canDisableServer,
      onSelect: () => (off ? void act(() => setMcpServerEnabled(entry.id, true), "Droplet couldn’t turn this on. Nothing changed.") : setConfirm("turn-off")),
    },
    {
      id: "workspace",
      label: "Workspace connection…",
      hidden: !isMcp || !entry.actions.canAddWorkspaceConnection,
      onSelect: () => setWorkspacePanel((v) => !v),
    },
    {
      id: "guide",
      label: "Setup guide",
      hidden: !guide,
      onSelect: () => {
        if (guide) window.open(guide, "_blank", "noopener");
      },
    },
  ];

  return (
    <div className="space-y-8" data-testid={`connector-detail-${entry.id}`}>
      <Link href="/connectors" className="type-footnote text-[color:var(--brand)]" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <ArrowLeft size={14} aria-hidden /> Connectors
      </Link>

      <header style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
        <IconTile id={entry.id} size={64} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 className="type-title-1" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            {entry.name} <VerifiedMark verified={entry.verified} />
          </h1>
          <p className="type-body text-[color:var(--text-muted)]" style={{ margin: "4px 0 0" }}>{entry.tagline}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isMcp && !pasteFallback && !off && !memberConnected && (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void signIn("MEMBER")}>
              {needsSignIn ? "Sign in again" : "Connect to Droplet"}
            </button>
          )}
          {isMcp && memberConnected && (
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirm("disconnect")}>
              Disconnect
            </button>
          )}
          {!isMcp && canManage && !yours && entry.actions.connect !== "none" && (
            <button type="button" className="btn primary" onClick={connectSystem}>
              Connect
            </button>
          )}
          {!isMcp && canManage && yours && hub && hub.open.kind !== "unavailable" && (
            <button
              type="button"
              className="btn"
              onClick={() => (hub.open.kind === "route" ? router.push(hub.open.href) : hub.open.kind === "wizard" ? setWizardFor(hub.open.catalogId) : undefined)}
            >
              Manage
            </button>
          )}
          <DropMenu
            label="More actions"
            trigger={<MoreHorizontal size={16} aria-hidden />}
            items={menuItems}
          />
        </div>
      </header>

      {outcome && (
        <p className={outcome.error ? "type-footnote text-system-red" : "type-footnote"} role={outcome.error ? "alert" : "status"}>
          {outcome.text}
        </p>
      )}
      {error && <p role="alert" className="type-footnote text-system-red">{error}</p>}
      {off && (
        <p className="type-footnote text-[color:var(--text-muted)]" role="status">
          An owner or admin turned {entry.name} off for this Workspace. Nothing is sent to it.
        </p>
      )}
      {!isMcp && !canManage && !yours && (
        <p className="type-footnote text-[color:var(--text-muted)]">An owner or admin sets up {entry.name}.</p>
      )}
      {!isMcp && canManage && entry.actions.connect === "none" && !yours && (
        <p className="type-footnote text-[color:var(--text-muted)]">{entry.name} can’t be set up from the dashboard yet.</p>
      )}

      {/* The paste fallback: only a box without an https address needs it. */}
      {isMcp && pasteFallback && !off && (
        <section aria-label="Sign in" className="space-y-2">
          <p className="type-footnote text-[color:var(--text-muted)]">
            Your Droplet isn’t on https, so finish by pasting the address the browser ended on.
          </p>
          <McpSignInCard provider={entry.id} displayName={entry.name} />
        </section>
      )}

      {workspacePanel && isMcp && (
        <section aria-label="Workspace connection" className="card space-y-3">
          <h2 className="type-headline">Workspace connection</h2>
          <p className="type-footnote text-[color:var(--text-muted)]" role="status">
            {mcp?.workspace?.state === "CONNECTED"
              ? `Connected${mcp.workspace.ackBy ? ` · acknowledged by ${mcp.workspace.ackBy}` : ""}`
              : "Not connected"}
          </p>
          <label className="flex items-start gap-2 type-footnote">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>{WORKSPACE_ACK}</span>
          </label>
          <div className="flex items-center gap-3">
            <button type="button" className="btn" disabled={busy || !ack} onClick={() => void signIn("WORKSPACE")}>
              Create a Workspace connection
            </button>
            {mcp?.workspace && mcp.workspace.state !== "DISCONNECTED" && (
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirm("disconnect-workspace")}>
                Disconnect Workspace connection
              </button>
            )}
          </div>
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-8">
          <p className="type-body" style={{ margin: 0, lineHeight: 1.6 }}>{entry.description}</p>

          {isMcp && tools.length > 0 && (
            <section aria-label="Tools">
              <h2 className="type-title-3" style={{ marginBottom: 8 }}>Tools</h2>
              <div className="grid c2" style={{ gap: 8 }}>
                {shownTools.map((t) => (
                  <span key={t.name} className="chip" title={t.description} style={{ justifyContent: "flex-start" }}>
                    {t.name}
                  </span>
                ))}
              </div>
              {tools.length > 12 && (
                <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setAllTools((v) => !v)}>
                  {allTools ? "Show fewer" : `Show all ${tools.length}`}
                </button>
              )}
            </section>
          )}

          {isMcp && yours && entry.promptSuggestions && (
            <PromptSuggestions suggestions={entry.promptSuggestions} />
          )}

          {isMcp && yours && (
            <ToolPermissions
              serverId={entry.id}
              tools={tools}
              canEdit={entry.actions.canEditPermissions}
              onChanged={refresh}
            />
          )}

          {isMcp && <p className="type-footnote text-[color:var(--text-faint)]" style={{ margin: 0 }}>{TRUST_NOTE}</p>}
        </div>

        <aside aria-label="About this connector">
          <Fact label="MADE BY">
            {entry.madeBy.url ? (
              <a href={entry.madeBy.url} target="_blank" rel="noreferrer" className="text-[color:var(--brand)]">
                {entry.madeBy.name}
              </a>
            ) : (
              entry.madeBy.name
            )}
          </Fact>
          <Fact label="CATEGORIES">{entry.categories.join(", ")}</Fact>
          {fact && <Fact label="SIGN-IN">{fact}</Fact>}
          {isMcp && entry.connectorUrl && (
            <Fact label="CONNECTOR URL">
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, wordBreak: "break-all" }}>{entry.connectorUrl}</code>
                <button type="button" className="btn ghost sm" aria-label="Copy connector URL" onClick={() => void copyUrl()}>
                  <Copy size={13} aria-hidden />
                </button>
              </span>
              {copied && <span className="type-caption-1 text-[color:var(--text-faint)]" role="status">Copied</span>}
            </Fact>
          )}
          <Fact label="ADDED">{entry.addedAt}</Fact>
          <Fact label="MORE INFO">
            <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {entry.links.docs && <a className="text-[color:var(--brand)]" href={entry.links.docs} target="_blank" rel="noreferrer">Documentation <ExternalLink size={11} aria-hidden /></a>}
              {entry.links.support && <a className="text-[color:var(--brand)]" href={entry.links.support} target="_blank" rel="noreferrer">Support <ExternalLink size={11} aria-hidden /></a>}
              {entry.links.privacy && <a className="text-[color:var(--brand)]" href={entry.links.privacy} target="_blank" rel="noreferrer">Privacy policy <ExternalLink size={11} aria-hidden /></a>}
              {guide && <a className="text-[color:var(--brand)]" href={guide} target="_blank" rel="noreferrer">Setup guide</a>}
            </span>
          </Fact>
          {!isMcp && yours && canManage && (
            <div style={{ marginTop: 16 }}>
              <DisconnectControl provider={entry.id} displayName={entry.name} onDisconnected={() => void refresh()} />
            </div>
          )}
        </aside>
      </div>

      <RelatedConnectors ids={entry.related} all={all} canManage={canManage} />

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === "turn-off"
            ? `Turn off ${entry.name} for the Workspace?`
            : confirm === "disconnect-workspace"
              ? `Disconnect the Workspace’s ${entry.name} connection?`
              : `Disconnect your ${entry.name} sign-in?`
        }
        description={
          confirm === "turn-off"
            ? `Nobody in the Workspace can use ${entry.name} until an owner or admin turns it back on. Nothing is sent to it meanwhile.`
            : confirm === "disconnect-workspace"
              ? `Everyone who uses ${entry.name} through the Workspace connection loses it until an owner or admin connects it again. Members who signed in themselves keep their own sign-in.`
              : `Droplet will stop acting as you in ${entry.name}. You can connect again any time.`
        }
        confirmLabel={confirm === "turn-off" ? "Turn off" : "Disconnect"}
        onConfirm={() =>
          act(async () => {
            if (confirm === "turn-off") await setMcpServerEnabled(entry.id, false);
            else if (confirm === "disconnect-workspace" && mcp?.workspace) await disconnectMcpOAuth(mcp.workspace.id);
            else if (confirm === "disconnect" && mcp?.member) await disconnectMcpOAuth(mcp.member.id);
          }, "Droplet couldn’t finish that. Nothing changed. Try again.")
        }
        onCancel={() => setConfirm(null)}
      />

      <ConnectWizard catalogId={wizardFor} onClose={() => setWizardFor(null)} onConnected={() => void refresh()} />
      <LanApiSetupDialog open={lanApiOpen} onClose={() => setLanApiOpen(false)} onConnected={() => void refresh()} />
    </div>
  );
}
