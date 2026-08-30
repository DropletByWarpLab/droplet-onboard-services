"use client";

// WARP-2545 — the Customers list, the pipeline board and the record timeline.
//
// These reuse the Projects surface's `pm-*` classes rather than introducing a
// CRM stylesheet: the two live on one page behind one tab switch, and a second
// visual vocabulary would be visible the moment somebody switched tabs. The
// board deliberately mirrors `projects/board.tsx`'s column + HTML5-drag shape
// for the same reason (and because the ticket asks for it explicitly).

import { useMemo, useState, type JSX } from "react";

import { EmptyBlock, Skel } from "@/components/projects/bits";
import { PmIcon } from "@/components/projects/icons";

import { formatMinor, type CrmActivity, type CrmCompany, type CrmDeal, type CrmStage, type CrmStageSummary } from "./types";

export type CrmDomain = "populated" | "loading" | "empty" | "error" | "filtered";

/** Stage colour by OUTCOME, never by column position — an owner can reorder or
 *  rename their pipeline and the won column must stay the won column. */
function stageAccent(kind: CrmStage["kind"]): string {
  if (kind === "WON") return "var(--ok, #16a34a)";
  if (kind === "LOST") return "var(--text-4)";
  return "var(--accent)";
}

function fmtDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Customers ────────────────────────────────────────────────────────────────

export function CustomersView({
  companies,
  domain,
  readOnly,
  onOpen,
  onNew,
}: {
  companies: CrmCompany[];
  domain: CrmDomain;
  readOnly: boolean;
  onOpen: (c: CrmCompany) => void;
  onNew: () => void;
}): JSX.Element {
  if (domain === "loading") {
    return (
      <div className="pm-surface" style={{ padding: 10, display: "grid", gap: 10 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pm-row" style={{ gap: 12, padding: "10px 6px" }}>
            <Skel w={30} h={30} r={8} />
            <div style={{ display: "grid", gap: 6, flex: 1 }}>
              <Skel w="34%" h={12} />
              <Skel w="22%" h={10} />
            </div>
            <Skel w={54} h={18} r={9} />
          </div>
        ))}
      </div>
    );
  }
  if (domain === "error") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="alert"
          tone="error"
          heading="Couldn't load your customers."
          body="Check the appliance connection and try again."
        />
      </div>
    );
  }
  if (domain === "filtered") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock icon="search" heading="No customers match that search." body="Try a shorter search." />
      </div>
    );
  }
  if (domain === "empty") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="building"
          heading="No customers yet."
          body="Add the businesses you work with — deals and conversations hang off them."
          cta={
            readOnly ? undefined : (
              <button className="pm-btn primary" type="button" onClick={onNew}>
                <PmIcon name="plus" size={14} />
                New customer
              </button>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="pm-surface" style={{ overflowX: "auto" }}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, minWidth: 320 }}>
        {companies.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onOpen(c)}
              className="pm-row"
              style={{
                width: "100%",
                gap: 12,
                padding: "11px 12px",
                background: "transparent",
                border: 0,
                borderBottom: "1px solid var(--line)",
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  display: "grid",
                  placeItems: "center",
                  background: "rgba(99,102,241,0.10)",
                  color: "var(--accent)",
                  flex: "0 0 auto",
                }}
              >
                <PmIcon name="building" size={15} />
              </span>
              <span style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13.5, fontWeight: 550, color: "var(--text)" }}>{c.name}</span>
                <span style={{ fontSize: 12, color: "var(--text-4)" }}>
                  {c.domain ?? c.industry ?? "—"}
                </span>
              </span>
              <span className="pm-row" style={{ gap: 8, flex: "0 0 auto" }}>
                {c.origin === "EXTERNAL" && c.externalSystem && (
                  // Provenance is worth showing: it explains why a field the
                  // customer edits here may be overwritten by the next sync.
                  <span className="pm-chip" title={`Synced from ${c.externalSystem}`}>
                    <PmIcon name="link" size={12} />
                    {c.externalSystem}
                  </span>
                )}
                <span className="pm-chip" title="Open deals">
                  {c.openDealCount} {c.openDealCount === 1 ? "deal" : "deals"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Deals board ──────────────────────────────────────────────────────────────

export function DealCard({
  deal,
  onOpen,
  readOnly,
  draggable,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  deal: CrmDeal;
  onOpen?: (d: CrmDeal) => void;
  readOnly?: boolean;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  dragging?: boolean;
}): JSX.Element {
  const amount = formatMinor(deal.amountMinor, deal.currency);
  const close = fmtDay(deal.expectedCloseOn);
  return (
    <div
      className={"pm-card" + (dragging ? " dragging" : "")}
      style={{ "--pm-accent": stageAccent(deal.stage.kind) } as React.CSSProperties}
      role="button"
      tabIndex={0}
      draggable={draggable && !readOnly}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-label={`${deal.title}${amount ? `, ${amount}` : ""}`}
      onClick={() => onOpen?.(deal)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(deal);
        }
      }}
    >
      <div className="pm-clamp2" style={{ fontSize: 13.5, fontWeight: 500, lineHeight: 1.35, color: "var(--text)" }}>
        {deal.title}
      </div>
      {deal.companyName && (
        <div style={{ fontSize: 12, color: "var(--text-4)" }}>{deal.companyName}</div>
      )}
      <div className="pm-row" style={{ justifyContent: "space-between", marginTop: 1 }}>
        {/* An amount with no currency cannot happen (the column pair is a CHECK
            constraint), so `amount` is null only when the deal genuinely has no
            value yet — render the absence rather than a zero. */}
        <span className="pm-mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>
          {amount ?? "—"}
        </span>
        {close && (
          <span className="pm-chip" title="Expected close">
            <PmIcon name="cal" size={12} />
            {close}
          </span>
        )}
      </div>
    </div>
  );
}

export function DealBoard({
  stages,
  deals,
  summary,
  domain,
  readOnly,
  onOpen,
  onMove,
  onNew,
}: {
  stages: CrmStage[];
  deals: CrmDeal[];
  summary: CrmStageSummary[] | undefined;
  domain: CrmDomain;
  readOnly: boolean;
  onOpen: (d: CrmDeal) => void;
  onMove: (deal: CrmDeal, stageId: string) => void;
  onNew: (stageId: string) => void;
}): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);

  // Ordered by the explicit column, never by array order off the wire.
  const cols = useMemo(() => [...stages].sort((a, b) => a.sortOrder - b.sortOrder), [stages]);
  const byStage = useMemo(() => {
    const m = new Map<string, CrmStageSummary>();
    for (const s of summary ?? []) m.set(s.stageId, s);
    return m;
  }, [summary]);

  if (domain === "loading") {
    return (
      <div className="pm-board">
        {(cols.length ? cols : Array.from({ length: 4 })).slice(0, 4).map((s, i) => (
          <div key={(s as CrmStage)?.id ?? i} className="pm-col">
            <div className="pm-col-h">
              <div className="pm-row" style={{ gap: 8 }}>
                <span className="pm-dot" style={{ background: "var(--text-4)" }} />
                <Skel w={70} h={12} />
              </div>
            </div>
            <div className="pm-card">
              <Skel w="80%" h={12} />
              <Skel w="45%" h={10} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (domain === "error") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="alert"
          tone="error"
          heading="Couldn't load the pipeline."
          body="Check the appliance connection and try again."
        />
      </div>
    );
  }
  if (domain === "empty") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="briefcase"
          heading="No deals in this pipeline yet."
          body="A deal is a piece of work you're trying to win. Move it across as it progresses."
          cta={
            !readOnly && cols.length ? (
              <button
                className="pm-btn primary"
                type="button"
                onClick={() => onNew(cols.find((s) => s.kind === "OPEN")?.id ?? cols[0].id)}
              >
                <PmIcon name="plus" size={14} />
                New deal
              </button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="pm-board">
      {cols.map((s) => {
        const colDeals = deals.filter((d) => d.stageId === s.id);
        const stat = byStage.get(s.id);
        // A mixed-currency column reports currency: null and amountMinor "0".
        // Showing "0" there would be a lie about the column's value, so the
        // total is omitted and the count carries the column instead.
        const total = stat ? formatMinor(stat.amountMinor, stat.currency) : null;
        return (
          <div
            key={s.id}
            className={"pm-col" + (overStage === s.id && dragId ? " dropzone" : "")}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              setOverStage(s.id);
            }}
            onDragLeave={() => setOverStage((cur) => (cur === s.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              const deal = deals.find((d) => d.id === dragId);
              if (deal && deal.stageId !== s.id) onMove(deal, s.id);
              setDragId(null);
              setOverStage(null);
            }}
          >
            <div className="pm-col-h">
              <div className="pm-sect">
                <span className="pm-dot" style={{ background: stageAccent(s.kind) }} />
                {s.name}
                <span className="sx">{colDeals.length}</span>
              </div>
              {!readOnly && (
                <button
                  className="pm-iconbtn"
                  style={{ width: 24, height: 24 }}
                  type="button"
                  aria-label={`New deal in ${s.name}`}
                  onClick={() => onNew(s.id)}
                >
                  <PmIcon name="plus" size={14} />
                </button>
              )}
            </div>
            {total && (
              <div
                className="pm-mono"
                style={{ fontSize: 11.5, color: "var(--text-4)", padding: "0 2px 6px" }}
              >
                {total}
              </div>
            )}
            {colDeals.length === 0 ? (
              <div style={{ padding: "18px 10px", textAlign: "center", fontSize: 12, color: "var(--text-4)" }}>
                Nothing in {s.name}.
              </div>
            ) : (
              colDeals.map((d) => (
                <DealCard
                  key={d.id}
                  deal={d}
                  onOpen={onOpen}
                  readOnly={readOnly}
                  draggable
                  dragging={dragId === d.id}
                  onDragStart={() => setDragId(d.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverStage(null);
                  }}
                />
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────────

const KIND_ICON: Record<string, string> = {
  NOTE: "doc",
  EMAIL: "send",
  CALL: "signal",
  MEETING: "cal",
  TASK: "check",
  STAGE_CHANGE: "branch",
  CREATED: "spark",
  SYNCED: "refresh",
};

export function Timeline({
  activities,
  isLoading,
}: {
  activities: CrmActivity[] | undefined;
  isLoading: boolean;
}): JSX.Element {
  if (isLoading && !activities) {
    return (
      <div style={{ display: "grid", gap: 10, padding: 4 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="pm-row" style={{ gap: 10 }}>
            <Skel w={22} h={22} r={11} />
            <Skel w="60%" h={12} />
          </div>
        ))}
      </div>
    );
  }
  if (!activities || activities.length === 0) {
    return (
      <EmptyBlock
        icon="msg"
        heading="Nothing has happened here yet."
        body="Calls, notes and stage changes show up on this timeline."
      />
    );
  }
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
      {activities.map((a) => (
        <li key={a.id} className="pm-row" style={{ gap: 10, alignItems: "flex-start", padding: "8px 2px" }}>
          <span
            aria-hidden="true"
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              display: "grid",
              placeItems: "center",
              background: "var(--surface-2, rgba(127,127,127,0.10))",
              color: "var(--text-3)",
              flex: "0 0 auto",
            }}
          >
            <PmIcon name={KIND_ICON[a.kind] ?? "dotCircle"} size={13} />
          </span>
          <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 13, color: "var(--text)" }}>{a.summary}</span>
            <time
              dateTime={a.occurredAt}
              style={{ fontSize: 11.5, color: "var(--text-4)" }}
              // occurredAt, not createdAt: a backfilled email from March is not
              // something that happened today.
              title={new Date(a.occurredAt).toLocaleString()}
            >
              {new Date(a.occurredAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          </span>
        </li>
      ))}
    </ol>
  );
}
