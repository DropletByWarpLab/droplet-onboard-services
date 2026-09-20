"use client";

// Projects index (launchpad) — KPI summary strip + project-card grid.

import { PmIcon } from "./icons";
import { Avatar, EmptyBlock, Skel, usePerson } from "./bits";
import { GROUP_ORDER, GROUP_BAR_COLOR } from "./config";
import type { PmProject, PmSummary } from "./types";

import type { JSX } from "react";

function Kpi({
  eyebrow,
  value,
  note,
  dotColor,
  loading,
}: {
  eyebrow: string;
  value: number | string;
  note: string;
  dotColor?: string;
  loading?: boolean;
}): JSX.Element {
  return (
    <div className="pm-kpi">
      <div className="lbl">{eyebrow}</div>
      <div>
        <div className="val">{loading ? <Skel w={40} h={26} r={6} /> : value}</div>
        <div className="meta">
          {dotColor && !loading && <span className="pm-dot" style={{ background: dotColor }} />}
          {!loading && <span>{note}</span>}
        </div>
      </div>
    </div>
  );
}

function ProjectCard({ p, onOpen }: { p: PmProject; onOpen: (p: PmProject) => void }): JSX.Element {
  const person = usePerson();
  const lead = p.leadId ? person(p.leadId).name : "No lead";
  const spark = GROUP_ORDER.map((g) => p.groups[g] ?? 0);
  const maxBar = Math.max(...spark, 1);
  return (
    <div
      className="pm-card"
      role="button"
      tabIndex={0}
      aria-label={`${p.name}, ${p.identifier}`}
      onClick={() => onOpen(p)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(p);
        }
      }}
      style={{ padding: 16, gap: 12, borderRadius: 14 }}
    >
      <div className="pm-row" style={{ gap: 11 }}>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            flex: "none",
            background: `color-mix(in srgb, ${p.color ?? "#6366f1"} 16%, transparent)`,
            color: p.color ?? "#6366f1",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <PmIcon name={p.icon ?? "board"} size={17} />
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 15,
            fontWeight: 600,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p.name}
        </span>
        <span className="pm-linechip">{p.identifier}</span>
      </div>
      <div className="pm-row" style={{ gap: 8, fontSize: 12, color: "var(--text-3)", flexWrap: "wrap" }}>
        <span className="pm-row" style={{ gap: 5 }}>
          {p.leadId ? <Avatar id={p.leadId} size={18} /> : <PmIcon name="user" size={13} />}
          {lead}
        </span>
        <span style={{ color: "var(--text-4)" }}>·</span>
        <span>{p.openCount} open</span>
        <span style={{ color: "var(--text-4)" }}>·</span>
        <span>{p.doneCount} done</span>
      </div>
      <div className="pm-row" style={{ justifyContent: "space-between", marginTop: 1 }}>
        <span className="pm-row" style={{ gap: 3, alignItems: "flex-end", height: 18 }}>
          {spark.map((h, i) => (
            <span
              key={GROUP_ORDER[i]}
              title={`${GROUP_ORDER[i]}: ${h}`}
              style={{
                width: 6,
                height: `${Math.max(3, (h / maxBar) * 18)}px`,
                borderRadius: 1,
                background: h ? GROUP_BAR_COLOR[GROUP_ORDER[i]] : "var(--bg-sunken)",
              }}
            />
          ))}
        </span>
        {p.archived && (
          <span className="pm-tag" style={{ background: "var(--bg-sunken)", color: "var(--text-3)" }}>
            Archived
          </span>
        )}
      </div>
    </div>
  );
}

/** Map a projects-fetch error to recoverable copy + tone. An auth failure
 *  (401/403) reads as a session problem; a disabled Projects module (the
 *  orchestrator's `module_disabled` code, WARP-1154) is a PERMANENT condition
 *  — calm tone, honest copy, and `retryable: false` so we never dangle a Retry
 *  button that can't help; a server fault (any other HTTP status) stays
 *  alarmingly red; a network/timeout blip (no status on the error) gets a
 *  calmer tone and connection-oriented copy. Mirrors the Try-again affordance
 *  in app/error.tsx — the user is never left at a dead end. */
function describeError(error: Error & { status?: number; code?: string }): {
  icon: string;
  tone?: "error";
  heading: string;
  body: string;
  retryable: boolean;
} {
  const status = error.status;
  if (error.code === "module_disabled") {
    // The page is normally gated off the /api/capabilities probe before any
    // PM request fires; this branch is defense in depth for a stale probe or
    // a direct URL hit racing a toggle. Never "server error, try again".
    //
    // WARP-1528: `module_disabled` now has TWO meanings — the box-wide toggle
    // and a per-person feature grant (requireFeatureAccess returns the
    // identical body deliberately, so a denial can't be used to enumerate what
    // other people can reach). This copy used to name the workspace reason,
    // which is simply false for a narrowed person — and leaks by contradiction
    // to anyone who has watched a colleague use Projects. Reason-free, matching
    // ModuleRouteGuard's formulation verbatim so there is ONE wording.
    return {
      icon: "board",
      heading: "Projects isn't available.",
      body: "This feature is switched off for this Droplet, or it isn't part of your access. An owner or admin can turn it on.",
      retryable: false,
    };
  }
  if (status === 401 || status === 403) {
    return {
      icon: "alert",
      tone: "error",
      heading: "You're signed out.",
      body: "Your session may have expired — sign in again.",
      retryable: true,
    };
  }
  if (typeof status === "number") {
    return {
      icon: "alert",
      tone: "error",
      heading: "Couldn't load your projects.",
      body: "The appliance hit a server error. Try again in a moment.",
      retryable: true,
    };
  }
  // No HTTP status → fetch never reached the server (network / timeout).
  return {
    icon: "refresh",
    heading: "Couldn't reach the appliance.",
    body: "Check your connection and try again.",
    retryable: true,
  };
}

export function IndexView({
  projects,
  summary,
  loading,
  error,
  readOnly,
  showArchived,
  onToggleArchived,
  onOpenProject,
  onNewProject,
  onRetry,
}: {
  projects: PmProject[] | undefined;
  summary: PmSummary | undefined;
  loading: boolean;
  error: (Error & { status?: number; code?: string }) | boolean | undefined;
  readOnly: boolean;
  showArchived: boolean;
  onToggleArchived: () => void;
  onOpenProject: (p: PmProject) => void;
  onNewProject: () => void;
  onRetry?: () => void;
}): JSX.Element {
  if (error) {
    const e = typeof error === "object" ? error : (new Error("Request failed") as Error & { status?: number });
    const { icon, tone, heading, body, retryable } = describeError(e);
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon={icon}
          tone={tone}
          heading={heading}
          body={body}
          cta={
            retryable && onRetry ? (
              <button className="pm-btn primary" type="button" onClick={onRetry}>
                <PmIcon name="refresh" size={14} />
                Retry
              </button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const list = projects ?? [];
  const isEmpty = !loading && list.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="pm-grid-kpi">
        <Kpi eyebrow="Active projects" value={summary?.activeProjects ?? 0} note="across the workspace" loading={loading} />
        <Kpi eyebrow="Items open" value={summary?.itemsOpen ?? 0} note="backlog → in progress" loading={loading} />
        <Kpi eyebrow="Done this week" value={summary?.doneThisWeek ?? 0} note="last 7 days" dotColor="var(--ok)" loading={loading} />
        <Kpi eyebrow="Overdue" value={summary?.overdue ?? 0} note="needs attention" dotColor="var(--warn)" loading={loading} />
      </div>

      <div className="pm-row" style={{ gap: 8 }}>
        <button className={"pm-chip" + (showArchived ? " on" : "")} type="button" onClick={onToggleArchived}>
          <PmIcon name="eye" size={13} />
          Show archived
        </button>
      </div>

      {isEmpty ? (
        <div className="pm-surface" style={{ padding: 8 }}>
          <EmptyBlock
            icon="board"
            heading="No projects yet."
            body="Create one to start tracking work."
            cta={
              !readOnly ? (
                <button className="pm-btn primary" type="button" onClick={onNewProject}>
                  <PmIcon name="plus" size={14} />
                  New project
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="pm-grid-projects">
          {loading
            ? Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="pm-card" style={{ cursor: "default", padding: 16, gap: 12, borderRadius: 14 }}>
                  <div className="pm-row" style={{ gap: 11 }}>
                    <Skel w={30} h={30} r={8} />
                    <Skel w="55%" h={13} />
                    <Skel w={40} h={20} r={10} style={{ marginLeft: "auto" }} />
                  </div>
                  <Skel w="70%" h={11} />
                  <Skel w="100%" h={18} />
                </div>
              ))
            : list.map((p) => <ProjectCard key={p.id} p={p} onOpen={onOpenProject} />)}
        </div>
      )}
    </div>
  );
}
