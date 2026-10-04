"use client";

// WARP-3522 — the cross-project "Views" index: every saved view the caller can
// see, wherever it lives, plus the door to a workspace-wide list (the only place
// a cross-project view can be authored). Three states, per brief §3.10: loading
// (skeleton rows, not a spinner), error (calm copy, Try again), empty (teaches
// where views come from).

import type { JSX } from "react";
import type { PmSavedViewDto } from "@droplet/shared-types";
import { PmIcon } from "./icons";
import { EmptyBlock, Skel } from "./bits";
import type { PmProject } from "./types";

const LAYOUT_LABEL: Record<NonNullable<PmSavedViewDto["layout"]>, string> = {
  BOARD: "Board",
  LIST: "List",
  TABLE: "Table",
  CALENDAR: "Calendar",
  TIMELINE: "Timeline",
};

function ViewRow({
  view,
  projectName,
  onOpen,
}: {
  view: PmSavedViewDto;
  projectName: string;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button type="button" className="pm-vrow" onClick={onOpen}>
      <span className="pm-vrow-name">
        {view.scope === "SHARED" && <PmIcon name="users" size={13} />}
        {view.name}
        {view.scope === "SHARED" && <span className="sr-only"> (shared)</span>}
      </span>
      <span className="pm-tag">{projectName}</span>
      <span className="pm-vrow-meta">{view.layout ? LAYOUT_LABEL[view.layout] : ""}</span>
    </button>
  );
}

function Section({
  title,
  views,
  projectName,
  onOpen,
}: {
  title: string;
  views: PmSavedViewDto[];
  projectName: (v: PmSavedViewDto) => string;
  onOpen: (v: PmSavedViewDto) => void;
}): JSX.Element | null {
  if (views.length === 0) return null;
  return (
    <section aria-label={title} style={{ marginBottom: 18 }}>
      <div className="pm-sect" style={{ marginBottom: 8 }}>
        {title}
        <span className="sx">{views.length}</span>
      </div>
      <div className="pm-surface">
        {views.map((v) => (
          <ViewRow key={v.id} view={v} projectName={projectName(v)} onOpen={() => onOpen(v)} />
        ))}
      </div>
    </section>
  );
}

export interface ViewsIndexProps {
  views: PmSavedViewDto[] | undefined;
  projects: PmProject[] | undefined;
  loading: boolean;
  error: unknown;
  onOpen: (view: PmSavedViewDto) => void;
  onOpenWorkspace: () => void;
  onRetry: () => void;
}

export function ViewsIndex({ views, projects, loading, error, onOpen, onOpenWorkspace, onRetry }: ViewsIndexProps): JSX.Element {
  const projectName = (v: PmSavedViewDto): string =>
    v.projectId === null ? "All projects" : (projects?.find((p) => p.id === v.projectId)?.name ?? "A project");

  const door = (
    <button type="button" className="pm-vrow pm-vrow-door" onClick={onOpenWorkspace}>
      <span className="pm-vrow-name">
        <PmIcon name="layers" size={14} />
        All work across projects
      </span>
      <span className="pm-vrow-meta">Filter everything at once, and save it as a view</span>
    </button>
  );

  if (error) {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="alert"
          tone="error"
          heading="Couldn't load your views."
          body="Check the appliance connection and try again."
          cta={
            <button type="button" className="pm-btn ghost" onClick={onRetry}>
              Try again
            </button>
          }
        />
      </div>
    );
  }

  if (loading || !views) {
    return (
      <div>
        <div className="pm-surface" style={{ marginBottom: 18 }}>{door}</div>
        <div className="pm-surface" style={{ padding: "4px 14px" }} aria-busy="true" aria-label="Loading views">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="pm-row" style={{ gap: 13, padding: "12px 4px", borderBottom: "1px solid var(--border)" }}>
              <Skel w="30%" h={12} />
              <Skel w={64} h={18} r={9} style={{ marginLeft: "auto" }} />
              <Skel w={44} h={11} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const shared = views.filter((v) => v.scope === "SHARED");
  const mine = views.filter((v) => v.scope === "PERSONAL");

  return (
    <div>
      <div className="pm-surface" style={{ marginBottom: 18 }}>{door}</div>
      {views.length === 0 ? (
        <div className="pm-surface" style={{ padding: 8 }}>
          <EmptyBlock
            icon="filter"
            heading="No saved views yet."
            body="Filter a project's board or list, then choose Save view. It will be listed here."
          />
        </div>
      ) : (
        <>
          <Section title="Shared" views={shared} projectName={projectName} onOpen={onOpen} />
          <Section title="Yours" views={mine} projectName={projectName} onOpen={onOpen} />
        </>
      )}
    </div>
  );
}
