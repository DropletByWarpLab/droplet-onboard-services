"use client";

// My Work — a cross-project view of /projects (`view=my-work`), not a new nav row
// (WARP-3523). The signed-in user's open work in four server-side sections —
// Assigned, Created, Overdue, Due this week — each grouped by project and drawn
// with the same row the List view uses. Mentioned and Watching arrive with WS-2.
//
// It owns its own detail drawer: an item here can belong to any project, so the
// page's single-project board data is not the right thing to revalidate.

import "./mywork.css";
import { useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import { PmIcon } from "../icons";
import { EmptyBlock, Skel } from "../bits";
import { ListRow } from "../board";
import { DetailDrawer } from "../detail";
import type { PmWorkItem } from "../types";
import { addDays, formatDay } from "../calendar/dateOnly";
import { useToday } from "../calendar/useToday";
import type { PmMyWorkCounts, PmMyWorkProject, PmMyWorkSection } from "./types";
import { useMyWork } from "./useMyWork";

const SECTIONS: ReadonlyArray<{
  id: PmMyWorkSection;
  label: string;
  count: "assigned" | "created" | "overdue" | "dueThisWeek";
  emptyHeading: string;
  emptyBody: string;
}> = [
  {
    id: "assigned",
    label: "Assigned",
    count: "assigned",
    emptyHeading: "Nothing assigned to you.",
    emptyBody: "Items assigned to you will show up here.",
  },
  {
    id: "created",
    label: "Created",
    count: "created",
    emptyHeading: "Nothing created by you.",
    emptyBody: "Items you create will show up here.",
  },
  {
    id: "overdue",
    label: "Overdue",
    count: "overdue",
    emptyHeading: "Nothing overdue.",
    emptyBody: "Items assigned to you that pass their due date will show up here.",
  },
  {
    id: "due_this_week",
    label: "Due this week",
    count: "dueThisWeek",
    emptyHeading: "Nothing due this week.",
    emptyBody: "Items assigned to you with a due date in the next 7 days will show up here.",
  },
];

export function MyWorkView(): JSX.Element {
  const today = useToday();
  const [section, setSection] = useState<PmMyWorkSection>("assigned");
  const [drawer, setDrawer] = useState<PmWorkItem | null>(null);
  const { items, projects, counts, total, hasMore, error, isLoading, isValidating, isLoadingMore, loadMore, mutate } = useMyWork(
    section,
    today,
  );
  // The four counts are the same whichever section is selected, so while another
  // section's first page loads the chips keep the last numbers rather than
  // flashing to dashes.
  const lastCounts = useRef<PmMyWorkCounts | undefined>(undefined);
  if (counts) lastCounts.current = counts;
  const shownCounts = counts ?? lastCounts.current;

  const spec = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const groups = useMemo(() => {
    const byProject = new Map<string, PmWorkItem[]>();
    for (const it of items) byProject.set(it.projectId, [...(byProject.get(it.projectId) ?? []), it]);
    const known = new Map(projects.map((p) => [p.id, p]));
    // Projects in the server's order; an item whose project somehow is not listed still gets a group.
    const ordered: Array<{ project: PmMyWorkProject; items: PmWorkItem[] }> = projects
      .filter((p) => byProject.has(p.id))
      .map((p) => ({ project: p, items: byProject.get(p.id) ?? [] }));
    for (const [id, list] of byProject) {
      if (!known.has(id)) ordered.push({ project: { id, name: "Project", identifier: "", icon: null, color: null }, items: list });
    }
    return ordered;
  }, [items, projects]);

  const helper: Record<PmMyWorkSection, string> = {
    assigned: "Open items assigned to you, across every project.",
    created: "Open items you created, across every project.",
    overdue: "Assigned to you and past their due date.",
    due_this_week: `Assigned to you and due ${formatDay(today, "short")} – ${formatDay(addDays(today, 6), "short")}.`,
  };

  let body: JSX.Element;
  if (error && items.length === 0) {
    body = (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="alert"
          tone="error"
          heading="Couldn't load your work."
          body="Check the appliance connection and try again."
          cta={
            <button className="pm-btn ghost" type="button" onClick={() => void mutate()}>
              Try again
            </button>
          }
        />
      </div>
    );
  } else if (isLoading && items.length === 0) {
    body = (
      <div className="pm-surface" style={{ padding: "4px 14px" }} aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="pm-row" style={{ gap: 13, padding: "12px 4px", borderBottom: "1px solid var(--border)" }}>
            <Skel w={56} h={11} />
            <Skel w={8} h={8} r={4} />
            <Skel w="50%" h={12} />
            <Skel w={44} h={18} r={9} style={{ marginLeft: "auto" }} />
          </div>
        ))}
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock icon="check" heading={spec.emptyHeading} body={spec.emptyBody} />
      </div>
    );
  } else {
    body = (
      <div className="pm-mw-groups">
        {groups.map(({ project, items: list }) => (
          <section key={project.id} className="pm-mw-group" aria-label={project.name}>
            <h3 className="pm-mw-grouphead">
              <span
                className="pm-mw-swatch"
                style={{ "--swatch": project.color ?? "var(--accent)" } as CSSProperties}
                aria-hidden="true"
              >
                {project.name.trim().charAt(0).toUpperCase() || "P"}
              </span>
              <span className="name">{project.name}</span>
              {project.identifier && <span className="pm-mono pm-mw-key">{project.identifier}</span>}
              <span className="sx">{list.length}</span>
            </h3>
            <div className="pm-surface pm-mw-rows">
              {list.map((it) => (
                <ListRow key={it.id} item={it} onOpen={setDrawer} />
              ))}
            </div>
          </section>
        ))}
        <div className="pm-mw-footer">
          <span>
            Showing {items.length} of {total}
          </span>
          {hasMore && (
            <button className="pm-btn sm" type="button" onClick={loadMore} disabled={isLoadingMore}>
              {isLoadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="pm-mw">
      <div className="pm-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <div className="pm-row" style={{ gap: 8, flexWrap: "wrap", flex: "1 1 auto" }} role="group" aria-label="My work sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={"pm-chip" + (section === s.id ? " on" : "")}
              aria-current={section === s.id ? "true" : undefined}
              onClick={() => setSection(s.id)}
            >
              {s.label}
              <span className="n">{shownCounts ? shownCounts[s.count] : "–"}</span>
            </button>
          ))}
        </div>
        {/* The page header's Refresh is for the open project; this view revalidates its own lists. */}
        <button
          type="button"
          className={"pm-iconbtn pm-mw-refresh" + (isValidating ? " spinning" : "")}
          aria-label="Refresh"
          title="Refresh"
          aria-busy={isValidating || undefined}
          onClick={() => void mutate()}
        >
          <PmIcon name="refresh" size={15} />
        </button>
      </div>
      <p className="pm-mw-hint">
        <PmIcon name="user" size={13} />
        {helper[section]}
      </p>
      <div className="sr-only" role="status" aria-live="polite">
        {isLoading && items.length === 0 ? "" : `${total} ${total === 1 ? "item" : "items"} in ${spec.label}`}
      </div>

      {body}

      {drawer && (
        <DetailDrawer
          item={drawer}
          onClose={() => setDrawer(null)}
          onChanged={async () => {
            const fresh = await mutate();
            const up = fresh?.flatMap((p) => p.items).find((i) => i.id === drawer.id);
            if (up) setDrawer(up);
          }}
        />
      )}
    </div>
  );
}
