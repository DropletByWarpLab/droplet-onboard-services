"use client";

// Who asked: the live contact (or the intake snapshot once the contact is gone),
// the customer they belong to, and the other tickets they have raised.

import Link from "next/link";
import type { JSX } from "react";
import { StatePill } from "@/components/projects/bits";
import { toPmState } from "./support-config";
import { useRequesterTickets } from "./useSupport";
import type { Ticket } from "./types";

export function RequesterCard({
  ticket,
  onSelectTicket,
}: {
  ticket: Ticket;
  onSelectTicket: (ref: string) => void;
}): JSX.Element {
  const card = ticket.requesterCard;
  const isContact = card.kind === "CONTACT";
  const { tickets, total } = useRequesterTickets(isContact && !card.gone ? card.id : null);
  const others = (tickets ?? []).filter((t) => t.id !== ticket.id).slice(0, 5);

  return (
    <section className="pm-surface sp-card" aria-label="Customer">
      <h3>{isContact ? "Customer" : "Requested by"}</h3>
      <div className="sp-kv">
        <span style={{ color: "var(--text)", fontWeight: 600, fontSize: 14 }}>{card.name}</span>
        {card.gone && <span>No longer in contacts — shown as when the ticket was opened.</span>}
        {!isContact && <span>Member of your team</span>}
        {card.email && <a href={`mailto:${card.email}`}>{card.email}</a>}
        {card.phone && <span>{card.phone}</span>}
        {card.organization && <span>{card.organization}</span>}
      </div>
      {card.company && (
        <div className="sp-kv">
          <span className="k">Company</span>
          <Link href={`/customers/${card.company.id}`}>{card.company.name}</Link>
        </div>
      )}
      {others.length > 0 && (
        <div className="sp-kv">
          <span className="k">Other tickets from this customer · {Math.max(0, total - 1)}</span>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {others.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="pm-btn ghost sm"
                  style={{ height: "auto", padding: "4px 6px", width: "100%", justifyContent: "flex-start", gap: 8, whiteSpace: "normal", textAlign: "left" }}
                  onClick={() => onSelectTicket(t.key)}
                >
                  <span className="pm-mono">{t.key}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>{t.subject}</span>
                  <StatePill state={toPmState(t.status, t.deskId)} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
