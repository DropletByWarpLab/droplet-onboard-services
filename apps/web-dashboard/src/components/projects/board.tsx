"use client";

// Board · List · placeholder views + the work-item card.

import { useState, type JSX } from "react";
import { PmIcon } from "./icons";
import {
  PriorityFlag,
  LabelTag,
  AvatarStack,
  DueChip,
  CountMeta,
  EmptyBlock,
  Skel,
} from "./bits";
import { cardAccent, isOverdue, fmtDate } from "./config";
import type { PmWorkItem, PmState } from "./types";

export type Domain = "populated" | "loading" | "empty" | "error" | "filtered";

function sortStates(states: PmState[]): PmState[] {
  return [...states].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function WorkItemCard({
  item,
  onOpen,
  readOnly,
  draggable,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  item: PmWorkItem;
  onOpen?: (i: PmWorkItem) => void;
  readOnly?: boolean;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  dragging?: boolean;
}): JSX.Element {
  return (
    <div
      className={"pm-card" + (dragging ? " dragging" : "")}
      style={{ "--pm-accent": cardAccent(item.priority) } as React.CSSProperties}
      role="button"
      tabIndex={0}
      draggable={draggable && !readOnly}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-label={`${item.key}, ${item.name}`}
      onClick={() => onOpen?.(item)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(item);
        }
      }}
    >
      <div className="pm-row" style={{ justifyContent: "space-between" }}>
        <span className="pm-mono" style={{ fontSize: 11, color: "var(--text-4)", fontWeight: 600 }}>
          {item.key}
        </span>
        <PriorityFlag p={item.priority} />
      </div>
      <div className="pm-clamp2" style={{ fontSize: 13.5, fontWeight: 500, lineHeight: 1.35, color: "var(--text)" }}>
        {item.name}
      </div>
      {item.labels.length > 0 && (
        <div className="pm-row" style={{ gap: 6, flexWrap: "wrap" }}>
          {item.labels.map((l) => (
            <LabelTag key={l.id} label={l} small />
          ))}
        </div>
      )}
      <div className="pm-row" style={{ justifyContent: "space-between", marginTop: 1 }}>
        <div className="pm-row" style={{ gap: 8 }}>
          <AvatarStack ids={item.assignees} size={22} />
          <DueChip item={item} />
        </div>
        <CountMeta item={item} />
      </div>
    </div>
  );
}

export function CardSkeleton(): JSX.Element {
  return (
    <div className="pm-card" style={{ cursor: "default", gap: 9 }}>
      <div className="pm-row" style={{ justifyContent: "space-between" }}>
        <Skel w={44} h={10} />
        <Skel w={14} h={14} r={4} />
      </div>
      <Skel w="92%" h={12} />
      <Skel w="70%" h={12} />
      <div className="pm-row" style={{ justifyContent: "space-between", marginTop: 2 }}>
        <Skel w={48} h={18} r={9} />
        <Skel w={22} h={22} r={11} />
      </div>
    </div>
  );
}

function StateColumnEmpty({ name }: { name: string }): JSX.Element {
  return (
    <div style={{ padding: "18px 10px", textAlign: "center", fontSize: 12, color: "var(--text-4)" }}>
      Nothing in {name}.
    </div>
  );
}

export function BoardView({
  states,
  items,
  domain,
  readOnly,
  onOpen,
  onTransition,
  onNewItem,
}: {
  states: PmState[];
  items: PmWorkItem[];
  domain: Domain;
  readOnly: boolean;
  onOpen: (i: PmWorkItem) => void;
  onTransition: (item: PmWorkItem, stateId: string) => void;
  onNewItem: (stateId: string) => void;
}): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overState, setOverState] = useState<string | null>(null);
  const cols = sortStates(states);

  if (domain === "loading") {
    return (
      <div className="pm-board">
        {(cols.length ? cols : Array.from({ length: 4 })).slice(0, 4).map((s, i) => (
          <div key={(s as PmState)?.id ?? i} className="pm-col">
            <div className="pm-col-h">
              <div className="pm-row" style={{ gap: 8 }}>
                <span className="pm-dot" style={{ background: (s as PmState)?.color ?? "var(--text-4)" }} />
                <Skel w={70} h={12} />
              </div>
            </div>
            <CardSkeleton />
            <CardSkeleton />
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
          heading="Couldn't load this project."
          body="Check the appliance connection and try again."
        />
      </div>
    );
  }
  if (domain === "empty") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="inbox"
          heading="No work items in this project yet — add one to get started."
          cta={
            !readOnly && cols.length ? (
              <button className="pm-btn primary" type="button" onClick={() => onNewItem(cols.find((s) => s.isDefault)?.id ?? cols[0].id)}>
                <PmIcon name="plus" size={14} />
                New item
              </button>
            ) : undefined
          }
        />
      </div>
    );
  }
  if (domain === "filtered") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock icon="filter" heading="No work items match these filters." body="Try clearing a filter." />
      </div>
    );
  }

  return (
    <div className="pm-board">
      {cols.map((s) => {
        const colItems = items
          .filter((it) => it.stateId === s.id)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        return (
          <div
            key={s.id}
            className={"pm-col" + (overState === s.id && dragId ? " dropzone" : "")}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              setOverState(s.id);
            }}
            onDragLeave={() => setOverState((cur) => (cur === s.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              const item = items.find((it) => it.id === dragId);
              if (item && item.stateId !== s.id) onTransition(item, s.id);
              setDragId(null);
              setOverState(null);
            }}
          >
            <div className="pm-col-h">
              <div className="pm-sect">
                <span className="pm-dot" style={{ background: s.color ?? "var(--text-4)" }} />
                {s.name}
                <span className="sx">{colItems.length}</span>
              </div>
              {!readOnly && (
                <button
                  className="pm-iconbtn"
                  style={{ width: 24, height: 24 }}
                  aria-label={`New item in ${s.name}`}
                  type="button"
                  onClick={() => onNewItem(s.id)}
                >
                  <PmIcon name="plus" size={14} />
                </button>
              )}
            </div>
            {colItems.length === 0 ? (
              <StateColumnEmpty name={s.name} />
            ) : (
              colItems.map((it) => (
                <WorkItemCard
                  key={it.id}
                  item={it}
                  onOpen={onOpen}
                  readOnly={readOnly}
                  draggable
                  dragging={dragId === it.id}
                  onDragStart={() => setDragId(it.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverState(null);
                  }}
                />
              ))
            )}
            {!readOnly && (
              <button
                className="pm-btn ghost sm"
                type="button"
                style={{ justifyContent: "flex-start", color: "var(--text-3)" }}
                onClick={() => onNewItem(s.id)}
              >
                <PmIcon name="plus" size={12} />
                New
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ListRow({
  item,
  onOpen,
}: {
  item: PmWorkItem;
  onOpen: (i: PmWorkItem) => void;
}): JSX.Element {
  const overdue = isOverdue(item);
  return (
    <div
      className="pm-row"
      tabIndex={0}
      role="button"
      aria-label={`${item.key}, ${item.name}`}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(item);
      }}
      style={{ gap: 13, padding: "10px 6px", borderBottom: "1px solid var(--border)", cursor: "pointer", minHeight: 44 }}
    >
      <span className="pm-mono" style={{ fontSize: 11.5, color: "var(--text-4)", width: 72, flex: "none" }}>
        {item.key}
      </span>
      <span className="pm-dot" style={{ background: item.state?.color ?? "var(--text-4)", flex: "none" }} />
      <PriorityFlag p={item.priority} size={13} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13.5,
          fontWeight: 500,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.name}
      </span>
      <div className="pm-row" style={{ gap: 6, flex: "none" }}>
        {item.labels.slice(0, 2).map((l) => (
          <LabelTag key={l.id} label={l} small />
        ))}
      </div>
      <span style={{ flex: "none" }}>
        <AvatarStack ids={item.assignees} size={22} />
      </span>
      <span
        className="pm-mono"
        style={{ fontSize: 11.5, color: overdue ? "var(--warn)" : "var(--text-4)", width: 56, flex: "none", textAlign: "right" }}
      >
        {fmtDate(item.dueDate) ?? "—"}
      </span>
    </div>
  );
}

export function ListView({
  states,
  items,
  domain,
  onOpen,
}: {
  states: PmState[];
  items: PmWorkItem[];
  domain: Domain;
  onOpen: (i: PmWorkItem) => void;
}): JSX.Element {
  if (domain === "loading") {
    return (
      <div className="pm-surface" style={{ padding: "4px 14px" }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="pm-row" style={{ gap: 13, padding: "12px 4px", borderBottom: "1px solid var(--border)" }}>
            <Skel w={56} h={11} />
            <Skel w={8} h={8} r={4} />
            <Skel w="50%" h={12} />
            <Skel w={44} h={18} r={9} style={{ marginLeft: "auto" }} />
            <Skel w={22} h={22} r={11} />
          </div>
        ))}
      </div>
    );
  }
  if (domain === "error") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock icon="alert" tone="error" heading="Couldn't load this project." body="Check the appliance connection and try again." />
      </div>
    );
  }
  if (domain === "empty") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock heading="No work items in this project yet — add one to get started." />
      </div>
    );
  }
  if (domain === "filtered") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock icon="filter" heading="No work items match these filters." body="Try clearing a filter." />
      </div>
    );
  }

  const groups = sortStates(states)
    .map((s) => [s, items.filter((it) => it.stateId === s.id)] as const)
    .filter(([, list]) => list.length);

  return (
    <div className="pm-surface" style={{ overflow: "hidden" }}>
      {groups.map(([s, list], gi) => (
        <div key={s.id}>
          <div
            className="pm-row"
            style={{
              gap: 8,
              padding: "10px 16px",
              background: "var(--bg-tint)",
              borderTop: gi ? "1px solid var(--border)" : "none",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span className="pm-dot" style={{ background: s.color ?? "var(--text-4)" }} />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.name}</span>
            <span style={{ fontSize: 12, color: "var(--text-4)" }}>{list.length}</span>
          </div>
          <div style={{ padding: "2px 14px" }}>
            {list.map((it) => (
              <ListRow key={it.id} item={it} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PlaceholderView({ kind }: { kind: "cycles" | "modules" }): JSX.Element {
  const map = {
    cycles: ["target", "Cycles aren't ready yet.", "Sprint planning will live here. We'll turn it on in a future update."],
    modules: ["layers", "Modules aren't ready yet.", "Grouping work into bigger efforts will live here. We'll turn it on in a future update."],
  } as const;
  const [icon, heading, body] = map[kind];
  return (
    <div className="pm-surface" style={{ padding: 8 }}>
      <EmptyBlock icon={icon} heading={heading} body={body} />
    </div>
  );
}
