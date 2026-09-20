"use client";

/**
 * WARP-2563 (ADR-044) — the customer record's sections.
 *
 * This is the page the whole epic is for: the one place where who you sell to,
 * the work you deliver, and what the box has recorded about them are the same
 * record rather than three tabs. Every edge rendered here already existed in
 * the schema and had no reader.
 *
 * Split out of the route file because a page component that owns fetching AND
 * six section layouts is the file nobody opens. These take props and render.
 */

import type { JSX, ReactNode } from "react";
import Link from "next/link";

import { PmIcon } from "@/components/projects/icons";
import {
  formatMinor,
  type CrmActivity,
  type CrmDeal,
  type PartyLinkRow,
  type RecordPerson,
  type RecordProject,
} from "@/components/crm/types";

export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="pm-surface cr-section">
      <div className="pm-sect">
        {title}
        {count !== undefined ? <span className="cr-count">{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <p className="cr-empty">{children}</p>;
}

/* ── People ──────────────────────────────────────────────── */

export function People({ people }: { people: RecordPerson[] }): JSX.Element {
  if (people.length === 0) return <Empty>No people yet.</Empty>;
  return (
    <ul className="cr-list">
      {people.map((p) => (
        <li key={p.contactId} className="cr-row">
          <span className="cr-row-k">
            {p.displayName}
            {/* The primary contact is the person you were looking for. Marked
                rather than merely sorted first, because sort order is
                invisible once you are three rows down. */}
            {p.isPrimary ? (
              <span className="cr-badge" title="Primary contact">
                primary
              </span>
            ) : null}
          </span>
          <span className="cr-row-v">{p.title ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── Deals ───────────────────────────────────────────────── */

export function Deals({
  deals,
  projects,
  emptyText,
}: {
  deals: CrmDeal[];
  projects: RecordProject[];
  emptyText: string;
}): JSX.Element {
  if (deals.length === 0) return <Empty>{emptyText}</Empty>;
  const projectById = new Map(projects.map((p) => [p.id, p]));
  return (
    <ul className="cr-list">
      {deals.map((d) => {
        // Amounts are per deal and never summed: a customer's deals routinely
        // span currencies, and adding 500 EUR to 500 USD produces a number
        // that looks authoritative and means nothing.
        const money = formatMinor(d.amountMinor, d.currency);
        const project = d.projectId ? projectById.get(d.projectId) : undefined;
        return (
          <li key={d.id} className="cr-row">
            <span className="cr-row-k">
              {d.title}
              {/* The edge WARP-2117 put in the schema and nothing walked:
                  "a won deal becomes the job that delivers it". Shown from
                  the deal side here and from the project side below, so the
                  reader meets it whichever way round they arrived. */}
              {project ? (
                <Link className="cr-link" href={`/projects?project=${project.id}`}>
                  → {project.identifier}
                </Link>
              ) : null}
            </span>
            <span className="cr-row-v">
              {money ?? <span className="cr-muted">no amount</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ── Projects ────────────────────────────────────────────── */

export function Projects({ projects }: { projects: RecordProject[] }): JSX.Element {
  if (projects.length === 0) return <Empty>No projects yet.</Empty>;
  return (
    <ul className="cr-list">
      {projects.map((p) => (
        <li key={p.id} className="cr-row">
          <span className="cr-row-k">
            <Link className="cr-link" href={`/projects?project=${p.id}`}>
              {p.name}
            </Link>
          </span>
          <span className="cr-row-v">
            {/* A project reached through a deal says so; one that was not — a
                warranty callout, a second phase, work begun before the CRM
                was switched on — simply does not. Reading projects off the
                DEAL would have hidden that second kind entirely. */}
            {p.dealIds.length > 0 ? (
              <span className="cr-muted">
                from {p.dealIds.length === 1 ? "a deal" : `${p.dealIds.length} deals`}
              </span>
            ) : (
              <span className="cr-muted">{p.identifier}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ── Timeline ────────────────────────────────────────────── */

const KIND_ICON: Record<string, string> = {
  NOTE: "msg",
  EMAIL: "msg",
  CALL: "msg",
  MEETING: "board",
  TASK: "board",
  STAGE_CHANGE: "briefcase",
  CREATED: "plus",
  SYNCED: "refresh",
};

export function Timeline({ entries }: { entries: CrmActivity[] }): JSX.Element {
  if (entries.length === 0) return <Empty>Nothing recorded yet.</Empty>;
  return (
    <ul className="cr-list">
      {entries.map((a) => (
        <li key={a.id} className="cr-row cr-tl">
          <PmIcon name={KIND_ICON[a.kind] ?? "msg"} size={13} />
          <span className="cr-row-k">{a.summary}</span>
          {/* Dated by when it HAPPENED, not when the row was written. A
              backfilled email from March is not something that happened
              today, and this column is read as a chronology. */}
          <time className="cr-row-v" dateTime={a.occurredAt}>
            {new Date(a.occurredAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </time>
        </li>
      ))}
    </ul>
  );
}

/* ── Linked systems ──────────────────────────────────────── */

export function Links({ links }: { links: PartyLinkRow[] }): JSX.Element | null {
  // Absent rather than empty. On a box with no connector this section would be
  // a permanent "nothing here" for something the owner never asked for.
  if (links.length === 0) return null;
  return (
    <ul className="cr-list">
      {links.map((l) => (
        <li key={l.id} className="cr-row">
          {/* The provider KEY, shown as-is. Mapping it to a pretty name needs
              the connector catalog, and a wrong pretty name is worse than a
              key an operator recognises. */}
          <span className="cr-row-k">{l.externalSystem}</span>
          <span className="cr-row-v">
            <span className="cr-muted">{l.externalId}</span>
            {l.linkedBy === "MATCHED" && l.confidence !== null ? (
              <span className="cr-badge" title="Proposed by a matcher and accepted">
                {l.confidence}% match
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
