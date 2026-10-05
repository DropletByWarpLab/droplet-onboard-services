"use client";

import type { JSX } from "react";
import { AvatarStack, PriorityFlag, Skel, StatePill } from "@/components/projects/bits";
import { SLA_LABELS, relativeTime, toPmState } from "./support-config";
import type { SlaStatus, TicketSummary } from "./types";

/** The SLA slot: nothing until a policy applies (`NONE`), then a plain-word
 *  badge. WS-14 feeds it; the words carry the meaning, the tint only backs them. */
export function SlaBadge({ status }: { status: SlaStatus }): JSX.Element | null {
  if (status === "NONE") return null;
  const { label, tone } = SLA_LABELS[status];
  return <span className={"sp-sla " + tone}>{label}</span>;
}

function TicketRow({
  ticket,
  selected,
  onSelect,
  showDesk,
}: {
  ticket: TicketSummary;
  selected: boolean;
  onSelect: (t: TicketSummary) => void;
  showDesk: boolean;
}): JSX.Element {
  const { requester } = ticket;
  return (
    <li>
      <button
        type="button"
        className={"sp-row" + (selected ? " sel" : "")}
        aria-current={selected ? "true" : undefined}
        aria-label={`${ticket.key}, ${ticket.subject}, from ${requester.name}`}
        onClick={() => onSelect(ticket)}
      >
        <span className="who">
          {requester.name}
          {requester.gone && <span className="sp-gone"> (no longer in contacts)</span>}
        </span>
        <span className="sub">{ticket.subject}</span>
        <span className="meta">
          <span className="pm-mono">{ticket.key}</span>
          {showDesk && <span>{ticket.deskName}</span>}
          <StatePill state={toPmState(ticket.status, ticket.deskId)} />
          <PriorityFlag p={ticket.priority} size={13} />
          <AvatarStack ids={ticket.assignees.map((a) => a.id)} size={20} />
          <SlaBadge status={ticket.slaStatus} />
          <span className="pm-mono" style={{ marginLeft: "auto" }} title={new Date(ticket.updatedAt).toLocaleString()}>
            {relativeTime(ticket.updatedAt)}
          </span>
        </span>
      </button>
    </li>
  );
}

/** The ticket list for one queue: rows, "Showing N of M" and a Load more. The
 *  skeleton, empty and error states belong to the page (it knows the queue and
 *  whether a search is active); this is the populated body. */
export function TicketList({
  tickets,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
  selectedId,
  onSelect,
  showDesk,
}: {
  tickets: TicketSummary[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  selectedId: string | null;
  onSelect: (t: TicketSummary) => void;
  showDesk: boolean;
}): JSX.Element {
  return (
    <div className="pm-surface sp-list">
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Tickets">
        {tickets.map((t) => (
          <TicketRow key={t.id} ticket={t} selected={t.id === selectedId} onSelect={onSelect} showDesk={showDesk} />
        ))}
      </ul>
      <div className="sp-more">
        <span role="status">
          Showing {tickets.length} of {total}
        </span>
        {hasMore && (
          <button className="pm-btn sm" type="button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}

export function TicketListSkeleton(): JSX.Element {
  return (
    <div className="pm-surface sp-list" aria-busy="true" aria-label="Loading tickets">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="sp-row" style={{ cursor: "default" }}>
          <Skel w="40%" h={12} />
          <Skel w="75%" h={12} />
          <Skel w="55%" h={10} />
        </div>
      ))}
    </div>
  );
}
