"use client";

/**
 * Support — the service desk (ADR-069, WARP-3528). Customers' requests as
 * tickets: queues with live counts, the ticket list, and the ticket workspace
 * with its conversation (public replies and internal notes), requester card,
 * linked work and escalation.
 *
 * Built from the Projects primitives (`.pm-scope`, bits, Dialog) so /support is
 * one visual system with /projects. State lives in the URL so a ticket can be
 * linked and the browser's back button works:
 *
 *   /support?queue=mine&desk=<id>&t=SUP-12
 */

import { Suspense, useCallback, useMemo, useState, type JSX } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LifeBuoy } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useAuth } from "@/lib/auth";
import { useAppCapabilities } from "@/lib/hooks/useAppCapabilities";
import { EmptyBlock, PeopleContext, SafetyChip } from "@/components/projects/bits";
import { PmIcon } from "@/components/projects/icons";
import { makePerson } from "@/components/projects/config";
import "@/app/projects/projects.css";
import "@/components/support/support.css";
import { SupportDisabled } from "@/components/support/SupportDisabled";
import { QueueRail } from "@/components/support/QueueRail";
import { TicketList, TicketListSkeleton } from "@/components/support/TicketList";
import { TicketWorkspace } from "@/components/support/TicketWorkspace";
import { DeskModal } from "@/components/support/DeskModal";
import { SlaSettingsModal } from "@/components/support/SlaSettingsModal";
import { NewTicketModal } from "@/components/support/NewTicketModal";
import { EMPTY_COPY, isSupportQueue } from "@/components/support/support-config";
import {
  useAgents,
  useDesks,
  useQueueCounts,
  useRevalidateSupport,
  useTicketList,
} from "@/components/support/useSupport";
import { canManageDesks, canWrite, type Desk, type SupportQueue, type TicketSummary } from "@/components/support/types";

export default function SupportPage(): JSX.Element {
  // The surface is driven by the orchestrator's explicit capability flag, never
  // by catching a 404. The probe fails CLOSED (a new module), so this renders
  // the honest "off" state until the box says otherwise; the sidebar entry and
  // the route guard hide it per person on top of this.
  const { support } = useAppCapabilities();
  if (!support) return <SupportDisabled />;
  return (
    <Suspense fallback={null}>
      <SupportWorkspace />
    </Suspense>
  );
}

type Modal = null | "ticket" | "desk-new" | "desk-edit" | "sla";

function SupportWorkspace(): JSX.Element {
  const { user } = useAuth();
  const writable = canWrite(user?.role);
  const manage = canManageDesks(user?.role);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const revalidate = useRevalidateSupport();
  const [modal, setModal] = useState<Modal>(null);
  const [search, setSearch] = useState("");

  // ── URL state ────────────────────────────────────────────────────────────
  const rawQueue = params.get("queue");
  const queue: SupportQueue = isSupportQueue(rawQueue) ? rawQueue : "open";
  const deskParam = params.get("desk");
  const ticketRef = params.get("t");

  const setParams = useCallback(
    (patch: Record<string, string | null>, push = false) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (push) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [params, pathname, router],
  );

  // ── data ─────────────────────────────────────────────────────────────────
  const { desks, error: desksError, isLoading: desksLoading, mutate: mutateDesks } = useDesks();
  const deskId = desks?.some((d) => d.id === deskParam) ? deskParam : null;
  const { agents } = useAgents();
  const { counts } = useQueueCounts(deskId);
  const list = useTicketList({ deskId, queue, q: search });

  // Names for avatars, resolved by the server: every assignee on a loaded
  // ticket plus the agent list. Never `User 1a2b`.
  const people = useMemo(() => {
    const names = new Map<string, string>();
    for (const a of agents ?? []) names.set(a.id, a.displayName);
    for (const t of list.tickets) for (const a of t.assignees) names.set(a.id, a.displayName);
    return (id: string) => makePerson(id, names.get(id) ?? "Former member");
  }, [agents, list.tickets]);

  const changed = useCallback(() => {
    void revalidate();
    void mutateDesks();
  }, [revalidate, mutateDesks]);

  const noDesks = !!desks && desks.length === 0;
  const searching = search.trim().length > 0;
  const selectedId = list.tickets.find((t) => t.key === ticketRef || t.id === ticketRef)?.id ?? null;
  // The desk "Desk settings" edits: the one in scope, or the only one there is.
  const scopedDesk: Desk | undefined = desks?.find((d) => d.id === deskId) ?? (desks?.length === 1 ? desks[0] : undefined);

  const actions = (
    <>
      {writable && !noDesks && (
        <button className="btn primary" type="button" onClick={() => setModal("ticket")}>
          <PmIcon name="plus" size={14} /> New ticket
        </button>
      )}
      {manage && scopedDesk && (
        <button className="btn" type="button" onClick={() => setModal("sla")}>Service levels</button>
      )}
      {manage && scopedDesk && (
        <button className="btn" type="button" onClick={() => setModal("desk-edit")}>
          Desk settings
        </button>
      )}
      {manage && !noDesks && (
        <button className="btn" type="button" onClick={() => setModal("desk-new")}>
          New desk
        </button>
      )}
      <button className="btn" type="button" onClick={changed} aria-label="Refresh">
        <PmIcon name="refresh" size={15} />
      </button>
    </>
  );

  let body: JSX.Element;
  if (desksLoading && !desks) {
    body = <TicketListSkeleton />;
  } else if (desksError && !desks) {
    body = (
      <div className="pm-surface">
        <EmptyBlock
          icon="inbox"
          tone="error"
          heading="Couldn't load support."
          body="Check the appliance connection and try again."
          cta={<button className="pm-btn ghost" type="button" onClick={() => void mutateDesks()}>Try again</button>}
        />
      </div>
    );
  } else if (noDesks) {
    body = (
      <div className="pm-surface">
        <EmptyBlock
          icon="inbox"
          heading="No service desk yet."
          body={manage ? "A desk is where customers' requests land. Set one up to start." : "Ask an owner or admin to set one up."}
          cta={
            manage ? (
              <button className="pm-btn primary" type="button" onClick={() => setModal("desk-new")}>
                Set up a desk
              </button>
            ) : undefined
          }
        />
      </div>
    );
  } else {
    let listBody: JSX.Element;
    if (list.isLoading) {
      listBody = <TicketListSkeleton />;
    } else if (list.error && list.tickets.length === 0) {
      listBody = (
        <div className="pm-surface">
          <EmptyBlock
            icon="inbox"
            tone="error"
            heading="Couldn't load tickets."
            body="Check the appliance connection and try again."
            cta={<button className="pm-btn ghost" type="button" onClick={() => void list.mutate()}>Try again</button>}
          />
        </div>
      );
    } else if (list.tickets.length === 0) {
      const copy = searching ? { heading: "No tickets match that search.", body: "Try clearing it." } : EMPTY_COPY[queue];
      listBody = (
        <div className="pm-surface">
          <EmptyBlock
            icon="inbox"
            heading={copy.heading}
            body={copy.body}
            cta={searching ? <button className="pm-btn ghost" type="button" onClick={() => setSearch("")}>Clear search</button> : undefined}
          />
        </div>
      );
    } else {
      listBody = (
        <TicketList
          tickets={list.tickets}
          total={list.total}
          hasMore={list.hasMore}
          loadingMore={list.isLoadingMore}
          onLoadMore={list.loadMore}
          selectedId={selectedId}
          onSelect={(t: TicketSummary) => setParams({ t: t.key }, true)}
          showDesk={!deskId && (desks?.length ?? 0) > 1}
        />
      );
    }

    // Below 1024px the ticket REPLACES the list; at and above it, they sit side by side.
    body = (
      <div className="sp-layout">
        <QueueRail
          counts={counts}
          queue={queue}
          onQueue={(q) => setParams({ queue: q, t: null })}
          desks={desks ?? []}
          deskId={deskId}
          onDesk={(id) => setParams({ desk: id, t: null })}
        />
        <div className={"sp-pane sp-col" + (ticketRef ? " sp-hide-narrow" : "")}>
          <div className="pm-search">
            <PmIcon name="search" size={14} />
            <input
              type="search"
              aria-label="Search tickets"
              placeholder="Search tickets"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {listBody}
        </div>
        <div className={"sp-pane" + (ticketRef ? "" : " sp-hide-narrow")}>
          {ticketRef ? (
            <TicketWorkspace
              key={ticketRef}
              ticketRef={ticketRef}
              desks={desks ?? []}
              agents={agents ?? []}
              onClose={() => setParams({ t: null })}
              onSelectTicket={(ref) => setParams({ t: ref }, true)}
              onChanged={changed}
            />
          ) : (
            <div className="pm-surface">
              <EmptyBlock icon="msg" heading="No ticket open." body="Select a ticket to read the conversation." />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <PeopleContext.Provider value={people}>
      <ShellPage
        icon={<LifeBuoy size={15} />}
        label="Support"
        title="Support"
        sub={counts ? `${counts.open} open · ${counts.unassigned} unassigned` : undefined}
        actions={actions}
      >
        <div className="pm-scope">
          <div className="pm-page">
            <div style={{ marginBottom: 12 }}>
              <SafetyChip tier="read" />
            </div>
            {body}
          </div>
        </div>
      </ShellPage>

      {modal === "ticket" && desks && (
        <NewTicketModal
          desks={desks}
          defaultDeskId={scopedDesk?.id ?? desks[0]?.id ?? null}
          agents={agents ?? []}
          onClose={() => setModal(null)}
          onCreated={(t) => {
            changed();
            setParams({ t: t.key }, true);
          }}
        />
      )}
      {(modal === "desk-new" || modal === "desk-edit") && (
        <DeskModal
          desk={modal === "desk-edit" ? scopedDesk : undefined}
          onClose={() => setModal(null)}
          onSaved={() => changed()}
        />
      )}
      {modal === "sla" && scopedDesk && <SlaSettingsModal desk={scopedDesk} agents={agents ?? []} onClose={() => setModal(null)} />}
    </PeopleContext.Provider>
  );
}
