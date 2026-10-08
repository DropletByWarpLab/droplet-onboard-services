"use client";

import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarDays, Mail, Plug, Search, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { ConnectorCard } from "@/components/integrations/ConnectorCard";
import type { ConnectAction } from "@/components/integrations/provider-descriptors";
import { useAuth } from "@/lib/auth";
import { useIntegrations, type HubEntry } from "@/lib/hooks/useIntegrations";
import { chatConnectionNavigationUrl, resumeChatConnectionReturn, saveChatConnectionReturn } from "@/lib/chat-connection-return";

// Setup code and its status requests are loaded only after choosing a connection.
const GoogleAccountCard = lazy(() => import("@/components/settings/GoogleAccountCard").then((module) => ({ default: module.GoogleAccountCard })));
const Microsoft365Card = lazy(() => import("@/components/settings/Microsoft365Card").then((module) => ({ default: module.Microsoft365Card })));
const EmailAccountCard = lazy(() => import("@/components/settings/EmailAccountCard").then((module) => ({ default: module.EmailAccountCard })));
const SubscriptionsPanel = lazy(() => import("@/components/calendar/SubscriptionsPanel").then((module) => ({ default: module.SubscriptionsPanel })));
const ConnectWizard = lazy(() => import("@/components/integrations/ConnectWizard").then((module) => ({ default: module.ConnectWizard })));
const SaasCredentialsSection = lazy(() => import("@/components/integrations/SaasCredentialsSection").then((module) => ({ default: module.SaasCredentialsSection })));

type SetupView = "google" | "m365" | "mailbox" | "calendar";
type Surface = "closed" | "catalog" | "credentials" | SetupView | { wizard: string };

const PERSONAL_CATEGORY = "Personal accounts";
const MAIL_CALENDAR_CATEGORY = "Mail and calendar";
const PERSONAL_CONNECTIONS = [
  { id: "google", name: "Google / Gmail", category: PERSONAL_CATEGORY, description: "Connect Gmail, Google Calendar, or both.", aliases: "google gmail mail calendar", icon: Mail },
  { id: "m365", name: "Microsoft / Outlook", category: PERSONAL_CATEGORY, description: "Connect Outlook mail, Microsoft calendars, and files.", aliases: "microsoft microsoft365 m365 outlook onedrive sharepoint", icon: Mail },
  { id: "mailbox", name: "Mailbox", category: MAIL_CALENDAR_CATEGORY, description: "Connect a mailbox using your mail server and account settings.", aliases: "imap smtp email mail mailbox", icon: Mail },
  { id: "calendar", name: "Calendar subscription", category: MAIL_CALENDAR_CATEGORY, description: "Add an iCloud calendar, calendar share link, or CalDAV subscription.", aliases: "icloud apple ics caldav feed calendar", icon: CalendarDays },
] as const;

function matchesEntry(entry: HubEntry, query: string): boolean {
  return [entry.meta.id, ...entry.providerKeys, entry.meta.name, entry.meta.category, entry.meta.description].join(" ").toLowerCase().includes(query);
}

/** Chat entry point to the same descriptor-driven setup flows as Integrations. */
export function ChatConnections() {
  const { user } = useAuth();
  const canManage = user?.role === "owner" || user?.role === "admin";
  const canConnectPersonal = canManage || user?.role === "family";
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const searchId = useId();
  const [surface, setSurface] = useState<Surface>("closed");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  // Keep the bound status refresh available through the wizard's onConnected.
  // Closed chat and family/guest sessions never request admin-only status.
  const { entries, isLoading, error, refresh } = useIntegrations(canManage && surface !== "closed");

  useEffect(() => {
    if (!canConnectPersonal) return;
    const provider = resumeChatConnectionReturn();
    if (provider) setSurface(provider);
  }, [canConnectPersonal]);

  useEffect(() => {
    if (!canConnectPersonal) setSurface("closed");
    else if (!canManage) setSurface((current) =>
      typeof current === "object" || current === "mailbox" || current === "credentials" ? "catalog" : current,
    );
  }, [canConnectPersonal, canManage]);

  if (!canConnectPersonal) return null;

  const query = search.trim().toLowerCase();
  const personal = PERSONAL_CONNECTIONS.filter((connection) =>
    (connection.id !== "mailbox" || canManage) &&
    (!category || category === connection.category) &&
    [connection.id, connection.name, connection.category, connection.description, connection.aliases].join(" ").toLowerCase().includes(query),
  );
  const catalog = canManage ? entries.filter((entry) => (!category || category === entry.meta.category) && matchesEntry(entry, query)) : [];
  const categories = [...new Set([
    PERSONAL_CATEGORY,
    MAIL_CALENDAR_CATEGORY,
    ...(canManage ? entries.map((entry) => entry.meta.category) : []),
  ])];
  const grouped = new Map<string, HubEntry[]>();
  for (const entry of catalog) {
    const group = grouped.get(entry.meta.category) ?? [];
    group.push(entry);
    grouped.set(entry.meta.category, group);
  }

  const run = (action: ConnectAction) => {
    switch (action.kind) {
      case "route":
        // This route already owns a reusable, role-gated configurator. Keep
        // its real credential fields in chat; other destinations still route.
        if (action.href === "/integrations/credentials") {
          setSurface("credentials");
          return;
        }
        setSurface("closed");
        router.push(action.href);
        return;
      case "wizard":
        setSurface({ wizard: action.catalogId });
        return;
      case "unavailable":
        // ConnectorCard renders the unavailable reason and a disabled action.
        return;
    }
  };

  const wizard = canManage && typeof surface === "object" ? surface.wizard : null;
  const selected = PERSONAL_CONNECTIONS.find((connection) => connection.id === surface);
  const catalogView = surface === "catalog" || surface === "closed";

  return <>
    <button
      ref={triggerRef}
      type="button"
      className="chat-iconbtn"
      title="Connections"
      aria-label="Connections"
      aria-haspopup="dialog"
      aria-expanded={surface !== "closed"}
      onClick={() => setSurface("catalog")}
    >
      <Plug size={17} aria-hidden="true" />
    </button>

    {/* Unmount the picker before mounting the wizard, so two modal focus traps
        and closing animations never overlap. The composer trigger stays put. */}
    {wizard ? <Suspense fallback={<Dialog open onClose={() => setSurface("catalog")} triggerRef={triggerRef} labelledBy={titleId}>
      <h2 id={titleId} className="type-title-2">Connection setup</h2>
      <p className="type-footnote mt-3" role="status">Loading connection setup…</p>
      <button type="button" className="btn mt-4" onClick={() => setSurface("catalog")}>All connections</button>
    </Dialog>}>
      <ConnectWizard catalogId={wizard} triggerRef={triggerRef} onClose={() => setSurface("catalog")} onConnected={() => void refresh()} />
    </Suspense> : <Dialog
      open={surface !== "closed"}
      onClose={() => setSurface("closed")}
      triggerRef={triggerRef}
      initialFocusRef={catalogView ? searchRef : undefined}
      labelledBy={titleId}
      describedBy={descriptionId}
      maxWidth="xl"
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="type-title-2 text-[var(--text)]">{selected?.name ?? (surface === "credentials" ? "Connector credentials" : "Connections")}</h2>
            <p id={descriptionId} className="type-footnote text-[var(--text-muted)] mt-2">
              {selected?.description ?? (surface === "credentials" ? "Set up or manage the cloud service credentials on this Droplet." : "Add accounts and systems for Droplet to use. Choose a connection to start its setup.")}
            </p>
          </div>
          <button type="button" className="btn" aria-label="Close connections" onClick={() => setSurface("closed")}><X size={18} aria-hidden="true" /></button>
        </div>

        {catalogView ? <>
          <div className="flex flex-col sm:flex-row gap-3">
            <label htmlFor={searchId} className="flex-1 min-w-0">
              <span className="type-caption-1 text-[var(--text-muted)]">Search connections</span>
              <span className="flex items-center gap-2 mt-1">
                <Search size={16} className="shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                <input ref={searchRef} id={searchId} className="input w-full" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, provider, or category" />
              </span>
            </label>
            <label className="flex flex-col gap-1 type-caption-1 text-[var(--text-muted)]">
              Filter connections
              <select className="input" value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="">All categories</option>
                {categories.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          </div>

          {canManage && isLoading && <p role="status" className="type-footnote text-[var(--text-muted)]">Checking connection status…</p>}
          {canManage && error && <div role="alert" className="card space-y-2">
            <p className="type-footnote text-[var(--text-muted)]">{error} Connection status may be out of date.</p>
            <button type="button" className="btn" onClick={() => void refresh()}>Retry connection status</button>
          </div>}

          {personal.length > 0 && <section aria-label="Accounts, mail, and calendars" className="space-y-3">
            <h3 className="type-headline text-[var(--text)]">Accounts, mail, and calendars</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {personal.map((connection) => <button key={connection.id} type="button" className="card text-left" data-connection-id={connection.id} onClick={() => setSurface(connection.id)}>
                <span className="flex items-center gap-2 type-headline text-[var(--text)]"><connection.icon size={18} aria-hidden="true" />{connection.name}</span>
                <span className="block type-footnote text-[var(--text-muted)] mt-2">{connection.description}</span>
                <span className="block type-caption-1 text-[var(--brand)] mt-3">Set up or manage</span>
              </button>)}
            </div>
          </section>}

          {!canManage && <p className="type-footnote text-[var(--text-muted)]">Your Droplet owner or administrator connects shared business systems and mailboxes.</p>}

          {[...grouped].map(([name, group]) => <section key={name} aria-label={name} className="space-y-3">
            <h3 className="type-headline text-[var(--text)]">{name}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {group.map((entry) => <div key={entry.meta.id} data-connection-id={entry.meta.id}>
                <ConnectorCard entry={entry} onConnect={() => run(entry.connect)} onOpen={() => run(entry.open)} onDisconnected={() => void refresh()} />
              </div>)}
            </div>
          </section>)}

          {personal.length === 0 && catalog.length === 0 && <p className="type-footnote text-[var(--text-muted)]" role="status">No connections match your search or filter.</p>}
        </> : <>
          <button type="button" className="btn" onClick={() => { if (surface === "credentials") void refresh(); setSurface("catalog"); }}><ArrowLeft size={16} aria-hidden="true" />All connections</button>
          <Suspense fallback={<p role="status" className="type-footnote">Loading connection setup…</p>}>
            {surface === "google" && <GoogleAccountCard returnTo="/chat" beforeConnect={() => saveChatConnectionReturn("google")} navigate={(url) => window.location.assign(chatConnectionNavigationUrl("google", url))} />}
            {surface === "m365" && <Microsoft365Card returnTo="/chat" beforeConnect={() => saveChatConnectionReturn("m365")} navigate={(url) => window.location.assign(chatConnectionNavigationUrl("m365", url))} />}
            {surface === "mailbox" && canManage && <EmailAccountCard />}
            {surface === "calendar" && <SubscriptionsPanel />}
            {surface === "credentials" && canManage && <SaasCredentialsSection />}
          </Suspense>
        </>}
      </div>
    </Dialog>}
  </>;
}
