"use client";

import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { ArrowLeft, Search, X } from "lucide-react";
import { CONNECTION_STATUS_LABEL, connectOutcomeTurn, parseConnectCard, parseConnectionsOverview, providerDescriptor, type ConnectCard, type ConnectionsOverview } from "@droplet/shared-types";
import { Dialog } from "@/components/Dialog";
import { ThemedSelect } from "@/components/ui/ThemedSelect";
import { PROVIDER_DESCRIPTORS } from "@/components/integrations/provider-descriptors";
import { authFetch, useAuth } from "@/lib/auth";
import { useIntegrations } from "@/lib/hooks/useIntegrations";
import { useChatConnectionOAuth } from "@/lib/hooks/useChatConnectionOAuth";

const GoogleAccountCard = lazy(() => import("@/components/settings/GoogleAccountCard").then((module) => ({ default: module.GoogleAccountCard })));
const Microsoft365Card = lazy(() => import("@/components/settings/Microsoft365Card").then((module) => ({ default: module.Microsoft365Card })));
const EmailAccountCard = lazy(() => import("@/components/settings/EmailAccountCard").then((module) => ({ default: module.EmailAccountCard })));
const SubscriptionsPanel = lazy(() => import("@/components/calendar/SubscriptionsPanel").then((module) => ({ default: module.SubscriptionsPanel })));
const ConnectWizard = lazy(() => import("@/components/integrations/ConnectWizard").then((module) => ({ default: module.ConnectWizard })));
const SaasCredentialsSection = lazy(() => import("@/components/integrations/SaasCredentialsSection").then((module) => ({ default: module.SaasCredentialsSection })));
const AccountProviderSetup = lazy(() => import("@/components/settings/AccountProviderSetup").then((module) => ({ default: module.AccountProviderSetup })));
const LanApiConnectionSetup = lazy(() => import("./connect/LanApiConnectionSetup").then((module) => ({ default: module.LanApiConnectionSetup })));

export type ConnectSetupRequest =
  | { kind: "overview"; overview: ConnectionsOverview }
  | { kind: "card"; card: ConnectCard };

function PersonalAccountSetup({ card, onConnected }: { card: ConnectCard & { family: "google" | "m365" }; onConnected: () => void }) {
  const [revision, setRevision] = useState(0);
  const onReturn = useCallback(() => setRevision((current) => current + 1), []);
  const oauth = useChatConnectionOAuth(card.family, { onConnected, onReturn });
  const closeRef = useRef(oauth.close);
  closeRef.current = oauth.close;
  useEffect(() => () => closeRef.current(), []);
  const navigation = { returnTo: "/chat/connect-return" as const, beforeConnect: oauth.beforeConnect, navigate: oauth.navigate, afterConnect: oauth.afterConnect };
  return <div className="space-y-3">
    {oauth.error && <p role="alert" className="type-footnote text-system-red">{oauth.error}</p>}
    {oauth.status && <p role="status" className="type-footnote">{oauth.status}</p>}
    {oauth.status?.startsWith("Finish approval") && <button type="button" className="btn" onClick={oauth.cancel}>Cancel sign-in</button>}
    {card.family === "google" ? <GoogleAccountCard key={revision} {...navigation} /> : <Microsoft365Card key={revision} {...navigation} />}
  </div>;
}

/** Existing connection setup UI, opened by a successful chat tool result only. */
export function ChatConnections({ request, onClose, onOutcome, triggerRef }: {
  request: ConnectSetupRequest | null;
  onClose: () => void;
  onOutcome?: (turn: string) => void;
  triggerRef?: RefObject<HTMLElement | null>;
}) {
  const { user } = useAuth();
  const canManage = user?.role === "owner" || user?.role === "admin";
  const canConnectPersonal = canManage || user?.role === "family";
  const { refresh } = useIntegrations(Boolean(request) && canManage);
  const titleId = useId();
  const descriptionId = useId();
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [card, setCard] = useState<ConnectCard | null>(request?.kind === "card" ? request.card : null);
  const [overview, setOverview] = useState<ConnectionsOverview | null>(request?.kind === "overview" ? request.overview : null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lookupRevision = useRef(0);
  const reported = useRef(new Set<string>());
  const principal = useRef("");
  const principalKey = `${user?.id}:${user?.role}`;
  principal.current = principalKey;
  const activeRequest = useRef(request);
  activeRequest.current = request;

  useEffect(() => {
    lookupRevision.current += 1;
    setCard(request?.kind === "card" ? request.card : null);
    setOverview(request?.kind === "overview" ? request.overview : null);
    setLoadingProvider(null);
    setError(null);
    reported.current.clear();
  }, [request]);
  useEffect(() => () => { lookupRevision.current += 1; activeRequest.current = null; }, []);

  const refreshOverview = useCallback(async () => {
    if (!request || request.kind !== "overview") return;
    const actor = principal.current;
    const revision = lookupRevision.current;
    try {
      const response = await authFetch("/api/connections");
      if (!response.ok) throw new Error("status unavailable");
      const next = parseConnectionsOverview(await response.json());
      if (!next) throw new Error("invalid connection status");
      if (principal.current === actor && revision === lookupRevision.current) setOverview(next);
    } catch {
      if (principal.current === actor && revision === lookupRevision.current) setError("Droplet could not refresh connection status. The list may be out of date.");
    }
  }, [request]);

  const completed = useCallback((turn: string, provider = card?.provider) => {
    if (!request || activeRequest.current !== request || principal.current !== principalKey) return;
    void refresh();
    void refreshOverview();
    if (provider && !reported.current.has(provider)) {
      reported.current.add(provider);
      onOutcome?.(turn);
    }
  }, [card, onOutcome, refresh, refreshOverview, request, principalKey]);
  const connected = useCallback(() => { if (card) completed(connectOutcomeTurn(card.displayName, "connected")); }, [card, completed]);
  const verifyWizardConnection = async () => {
    const actor = principal.current;
    const revision = lookupRevision.current;
    try {
      const rows = await refresh();
      if (principal.current !== actor || lookupRevision.current !== revision) return;
      void refreshOverview();
      const actual = rows?.find((row) => row.provider === card?.provider);
      if (actual?.status === "CONNECTED" || actual?.status === "CAPABILITY_LIMITED") connected();
    } catch {
      if (principal.current === actor && lookupRevision.current === revision) setError("Droplet could not confirm the connection's status. Check its status before trying again.");
    }
  };

  const choose = async (provider: string) => {
    if (!canConnectPersonal || loadingProvider) return;
    const actor = principal.current;
    const revision = ++lookupRevision.current;
    setLoadingProvider(provider);
    setError(null);
    try {
      const response = await authFetch(`/api/connections/card?q=${encodeURIComponent(provider)}`);
      if (!response.ok) throw new Error("connection setup unavailable");
      const body: unknown = await response.json();
      const next = parseConnectCard(body && typeof body === "object" && "card" in body ? body.card : body);
      if (!next) throw new Error("invalid connection setup");
      if (principal.current === actor && revision === lookupRevision.current) setCard(next);
    } catch {
      if (principal.current === actor && revision === lookupRevision.current) setError("Droplet could not load this connection's setup. Try again.");
    } finally {
      if (principal.current === actor && revision === lookupRevision.current) setLoadingProvider(null);
    }
  };

  const back = () => {
    lookupRevision.current += 1;
    setLoadingProvider(null);
    setError(null);
    void refresh();
    void refreshOverview();
    if (overview) setCard(null);
    else onClose();
  };
  const allowed = Boolean(card && canConnectPersonal && (card.scope !== "box" || canManage));
  const personalCard = card?.family === "google" || card?.family === "m365";
  const manageExistingAccount = personalCard && card?.blocked?.reason === "already_connected";
  const descriptor = card?.family === "integration" ? PROVIDER_DESCRIPTORS.find((entry) => entry.meta.id === card.provider || entry.providerKeys.includes(card.provider)) : undefined;
  const action = descriptor?.connect;
  const backendDescriptor = card?.family === "integration" ? providerDescriptor(card.provider) : undefined;
  const wizard = request && card && allowed && !card.blocked && action?.kind === "wizard" && backendDescriptor?.catalog?.id === action.catalogId ? action.catalogId : null;
  const pending = <p className="type-footnote" role="status">Loading connection setup…</p>;

  // The picker unmounts before the canonical wizard mounts; never two active
  // modal focus traps. No setup action changes the chat page's location.
  if (wizard) return <Suspense fallback={<Dialog open onClose={back} triggerRef={triggerRef} labelledBy={titleId}>
    <h2 id={titleId} className="type-title-2">Connection setup</h2>{pending}
    <button type="button" className="btn mt-4" onClick={back}>Close setup</button>
  </Dialog>}>
    <ConnectWizard catalogId={wizard} triggerRef={triggerRef} onClose={back} onConnected={() => void verifyWizardConnection()} />
  </Suspense>;

  const query = search.trim().toLowerCase();
  const familyAliases = { google: "gmail google calendar", m365: "microsoft outlook onedrive sharepoint", mailbox: "imap smtp mail email", calendar: "ics caldav icloud apple calendar", integration: "" };
  const available = overview?.available.filter((entry) => {
    const local = PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.providerKeys.includes(entry.provider));
    return (!category || entry.category === category) && [entry.provider, entry.displayName, entry.category, entry.family, familyAliases[entry.family], local?.meta.description, ...(local?.providerKeys ?? [])].join(" ").toLowerCase().includes(query);
  }) ?? [];
  const categories = [...new Set(overview?.available.flatMap((entry) => entry.category ? [entry.category] : []) ?? [])];

  return <Dialog open={Boolean(request)} onClose={onClose} triggerRef={triggerRef} initialFocusRef={!card ? searchRef : undefined} labelledBy={titleId} describedBy={descriptionId} maxWidth="xl">
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={titleId} className="type-title-2 text-[var(--text)]">{card ? `Connect ${card.displayName}` : "Connections"}</h2>
          <p id={descriptionId} className="type-footnote text-[var(--text-muted)] mt-2">{card?.summary ?? "Choose an account or system to connect. Setup opens here in chat."}</p>
        </div>
        <button type="button" className="btn" aria-label="Close connection setup" onClick={onClose}><X size={18} aria-hidden="true" /></button>
      </div>
      {error && <p role="alert" className="type-footnote text-system-red">{error}</p>}
      {loadingProvider && <p role="status" className="type-footnote">Checking setup…</p>}

      {card ? <>
        {overview && <button type="button" className="btn" onClick={back}><ArrowLeft size={16} aria-hidden="true" />All connections</button>}
        {!allowed ? <p className="type-footnote">Ask your Droplet owner or administrator to connect this system.</p> : card.blocked && !manageExistingAccount ? <div className="space-y-3">
          <p className="type-footnote" role="status">{card.blocked.message}</p>
          {personalCard && card.blocked.reason === "setup_required" && canManage && <Suspense fallback={pending}><AccountProviderSetup onSaved={() => void choose(card.provider)} /></Suspense>}
        </div> : <Suspense fallback={pending}>
          {(card.family === "google" || card.family === "m365") && <PersonalAccountSetup key={`${card.provider}:${user?.id}:${user?.role}`} card={card as ConnectCard & { family: "google" | "m365" }} onConnected={connected} />}
          {card.family === "mailbox" && canManage && <EmailAccountCard onConnected={connected} />}
          {card.family === "calendar" && <SubscriptionsPanel onConnected={() => completed("Calendar subscription was added. The first sync is pending.")} />}
          {card.family === "integration" && (card.provider === "eaglesoft-api" && backendDescriptor?.track === "lan" ? <LanApiConnectionSetup key={`${card.provider}:${user?.id}:${user?.role}`} onConnected={connected} /> : action?.kind === "route" && action.href === "/integrations/credentials" ? <SaasCredentialsSection onConnected={(provider) => {
            const connectedDescriptor = PROVIDER_DESCRIPTORS.find((entry) => entry.providerKeys.includes(provider));
            if (connectedDescriptor) completed(connectOutcomeTurn(connectedDescriptor.meta.name, "connected"), provider);
          }} /> : <p className="type-footnote" role="status">{action?.kind === "unavailable" ? action.reason : "This connection has no setup flow available in chat yet."}</p>)}
        </Suspense>}
      </> : overview ? <>
        <p className="type-footnote text-[var(--text-muted)]">{overview.counts.connected} connected · {overview.counts.needsAttention} need attention · {overview.counts.available} available</p>
        {overview.connected.length > 0 && <section aria-label="Connected systems" className="space-y-3">
          <h3 className="type-headline">Connected systems</h3>
          {overview.connected.map((entry) => <div key={entry.id} className="card" data-connection-id={entry.id}>
            <div className="flex items-center justify-between gap-3"><span className="type-headline">{entry.displayName}</span><span className="type-caption-1">{CONNECTION_STATUS_LABEL[entry.status]}</span></div>
            {entry.detail && <p className="type-footnote text-[var(--text-muted)] mt-2">{entry.detail}</p>}
            {entry.statusDetail && <p className="type-footnote text-[var(--text-muted)] mt-2">{entry.statusDetail}</p>}
            {entry.canReconnect && canConnectPersonal && <button type="button" className="btn mt-3" disabled={Boolean(loadingProvider)} onClick={() => void choose(entry.provider)}>Reconnect {entry.displayName}</button>}
          </div>)}
        </section>}
        <div className="flex flex-col sm:flex-row gap-3">
          <label htmlFor={searchId} className="flex-1 min-w-0"><span className="type-caption-1 text-[var(--text-muted)]">Search connections</span><span className="flex items-center gap-2 mt-1"><Search size={16} className="shrink-0" aria-hidden="true" /><input ref={searchRef} id={searchId} className="input w-full" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, provider, or category" /></span></label>
          <label className="flex flex-col gap-1 type-caption-1 text-[var(--text-muted)]">Filter connections<ThemedSelect className="input" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{categories.map((name) => <option key={name} value={name}>{name}</option>)}</ThemedSelect></label>
        </div>
        <section aria-label="Available connections" className="space-y-3">
          <h3 className="type-headline">Available connections</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{available.map((entry) => <div key={`${entry.family}:${entry.provider}`} className="card" data-connection-id={entry.provider}>
            <h4 className="type-headline">{entry.displayName}</h4>{entry.category && <p className="type-caption-1 text-[var(--text-muted)] mt-2">{entry.category}</p>}
            <button type="button" className="btn mt-3" disabled={!canConnectPersonal || !entry.canConnect || (entry.scope === "box" && !canManage) || Boolean(loadingProvider)} onClick={() => void choose(entry.provider)}>Set up {entry.displayName}</button>
            {(!entry.canConnect || (entry.scope === "box" && !canManage)) && <p className="type-caption-1 text-[var(--text-muted)] mt-2">Ask an owner or administrator to connect this.</p>}
          </div>)}</div>
          {available.length === 0 && <p className="type-footnote" role="status">No connections match your search or filter.</p>}
        </section>
      </> : null}
    </div>
  </Dialog>;
}
