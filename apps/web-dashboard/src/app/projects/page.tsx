"use client";

/**
 * Projects — native PM surface (ADR-026 P4). Replaces the embedded Plane iframe
 * with a first-class, Droplet-owned tracker wired to /api/pm/*. One login (the
 * dashboard session), fully in the design system, light + dark, RBAC-gated
 * writes, and the same data the in-app AI reads/writes through the MCP tools.
 *
 * WARP-3522 — the page's state is the URL. Project, tab, saved view, filter and
 * the open drawer are all read from `?p=&view=&item=&v=&f=` and every change is
 * a navigation (`useProjectsUrl`), so a link opens exactly this screen and Back /
 * Forward walk it. The filter runs through `POST /api/pm/work-items/query` on
 * the server; layouts consume its rows or admitted IDs — the same filter a
 * saved view stores and the assistant will send.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import Link from "next/link";
import { FolderKanban } from "lucide-react";
import {
  PM_BUILTIN_VIEWS,
  PM_VIEW_LIMIT,
  isPmBuiltinViewId,
  parsePmFilter,
  pmFiltersEqual,
  serializePmFilter,
  type PmFilter,
  type PmViewLayout,
} from "@droplet/shared-types";
import { ShellPage } from "@/components/shell/ShellPage";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import { useAppCapabilities } from "@/lib/hooks/useAppCapabilities";
import { translateError } from "@/lib/friendly-errors";
import "./projects.css";

import { PmIcon } from "@/components/projects/icons";
import { PeopleContext, EmptyBlock, Skel } from "@/components/projects/bits";
import { ProjectsDisabled } from "@/components/projects/ProjectsDisabled";
import { stageRecordPinHandoff } from "@/lib/pin-handoff";
import { canWrite, type PmProject, type PmWorkItem } from "@/components/projects/types";
import {
  useProjects,
  useSummary,
  useProjectStates,
  useProjectLabels,
  useWorkItemQuery,
  useWorkItemByKey,
  useSavedViews,
  useDepartments,
  usePeople,
  pmActions,
  viewActions,
  type ViewsScope,
} from "@/components/projects/usePm";
import { departmentOptions } from "@/components/projects/department";
import { IndexView } from "@/components/projects/IndexView";
import { BoardView, ListView, PlaceholderView, type Domain } from "@/components/projects/board";
import { ViewSwitcher, type ProjectView } from "@/components/projects/chrome";
import { FilterBar, FilterChips, type EditorOptions } from "@/components/projects/FilterBar";
import { ViewChips, type ViewChipItem } from "@/components/projects/ViewChips";
import { ViewsIndex } from "@/components/projects/ViewsIndex";
import { EMPTY_FILTER, type ChipLookups } from "@/components/projects/filter-model";
import { useProjectsUrl } from "@/components/projects/useProjectsUrl";
import { DetailDrawer } from "@/components/projects/detail";
import { CalendarView } from "@/components/projects/calendar/CalendarView";
import { TimelineView } from "@/components/projects/timeline/TimelineView";
import { MyWorkView } from "@/components/projects/mywork/MyWorkView";
import { NewItemModal, NewProjectModal } from "@/components/projects/modals";

// ── URL ↔ page vocabulary ───────────────────────────────────────────────────

const PROJECT_TABS: readonly ProjectView[] = ["board", "list", "calendar", "timeline", "cycles", "modules"];

/** The tab a `view=` names; anything else is the board. */
function tabOf(view: string | null): ProjectView {
  return PROJECT_TABS.find((t) => t === view) ?? "board";
}

/** A tab that is a layout a view can be saved in. */
function layoutOfTab(tab: ProjectView): PmViewLayout | null {
  return tab === "board" ? "BOARD" : tab === "list" ? "LIST" : tab === "calendar" ? "CALENDAR" : tab === "timeline" ? "TIMELINE" : null;
}

/** The tab a saved layout opens in. TABLE opens as the list until WS-6b. */
function tabOfLayout(layout: PmViewLayout): ProjectView {
  return layout === "BOARD" ? "board" : layout === "CALENDAR" ? "calendar" : layout === "TIMELINE" ? "timeline" : "list";
}

/** Brief §3.9, verbatim for one; counted for several. */
function staleNoticeText(count: number): string {
  return count === 1
    ? "One filter was removed because it no longer exists."
    : `${count} filters were removed because they no longer exist.`;
}

const FILTER_UNREADABLE = "That link's filter couldn't be read, so it was ignored.";
const VIEW_GONE = "That view isn't available anymore.";
const VIEW_UNREADABLE = "Couldn't load that view, so everything is shown.";

function ProjectsFallback(): JSX.Element {
  return (
    <ShellPage icon={<FolderKanban size={15} />} label="Projects" title="Projects">
      <div className="pm-scope">
        <div className="pm-page">
          <div className="pm-surface" style={{ padding: "4px 14px" }} aria-busy="true" aria-label="Loading projects">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="pm-row" style={{ gap: 13, padding: "12px 4px", borderBottom: "1px solid var(--border)" }}>
                <Skel w="40%" h={12} />
                <Skel w={44} h={18} r={9} style={{ marginLeft: "auto" }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </ShellPage>
  );
}

export default function ProjectsPage(): JSX.Element {
  // WARP-1154/1155 — the surface is driven by the orchestrator's explicit
  // capability flag (GET /api/capabilities), never by catching PM errors.
  // The hook fails open, so only an explicit `projects: false` lands here
  // (the sidebar entry is hidden by the same flag; this covers direct URLs).
  const { projects: projectsEnabled } = useAppCapabilities();
  if (!projectsEnabled) return <ProjectsDisabled />;
  // WARP-2558 (ADR-044) — this page reads the `projects` flag and nothing
  // else. It used to also read `crm` and render the CRM's sub-tabs, which is
  // why its header renamed itself when a module it does not own flipped. The
  // CRM lives at /customers now.
  //
  // WARP-3522 — `useSearchParams` must be read under a Suspense boundary
  // (Next app router), so the workspace lives inside one.
  return (
    <Suspense fallback={<ProjectsFallback />}>
      <ProjectsWorkspace />
    </Suspense>
  );
}

function ProjectsWorkspace(): JSX.Element {
  const { user } = useAuth();
  const role = user?.role;
  const readOnly = !canWrite(role);
  const { toast } = useToast();
  const { person, users } = usePeople();
  const { state: url, go, openItem, closeItem } = useProjectsUrl();

  const [showArchived, setShowArchived] = useState(false);
  const [modal, setModal] = useState<"newitem" | "newproject" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ── which project, which mode ──
  const { projects, error: projErr, isLoading: projLoading, mutate: mutateProjects } = useProjects(showArchived);
  // ProjectsWorkspace only mounts behind the `projects` capability gate above.
  const { summary, mutate: mutateSummary } = useSummary(true);

  const project: PmProject | null = useMemo(
    () => (url.p ? (projects?.find((p) => p.identifier.toLowerCase() === url.p!.toLowerCase()) ?? null) : null),
    [projects, url.p],
  );
  // A link to an ARCHIVED project: the default list hides those, so look again
  // with them included before calling the project missing.
  useEffect(() => {
    if (url.p && projects && !project && !showArchived) setShowArchived(true);
  }, [url.p, projects, project, showArchived]);
  const projectMissing = !!url.p && !!projects && !project && showArchived;

  const wantsAllViews =
    !url.p && (url.view === "views" || url.view === "workspace" || (!!url.v && !isPmBuiltinViewId(url.v)));
  const viewsScope: ViewsScope = project
    ? { kind: "project", projectId: project.id }
    : wantsAllViews
      ? { kind: "all" }
      : null;
  const { views: savedViews, error: viewsErr, isLoading: viewsLoading, mutate: mutateViews } = useSavedViews(viewsScope);

  // A `?v=<cross-project view>` with no project IS the workspace-wide list.
  const crossViewInUrl =
    !url.p && url.v && !isPmBuiltinViewId(url.v)
      ? savedViews?.find((v) => v.id === url.v && v.projectId === null)
      : undefined;
  type Mode = "index" | "views" | "workspace" | "project" | "my-work";
  const mode: Mode = url.p
    ? "project"
    : url.view === "my-work"
      ? "my-work"
      : url.view === "views"
        ? "views"
        : url.view === "workspace" || crossViewInUrl
          ? "workspace"
          : "index";
  const tab: ProjectView = mode === "project" ? tabOf(url.view) : "list";

  // ── the active view and the filter ──
  const scopedViews = useMemo(
    () => (savedViews ?? []).filter((v) => (mode === "project" ? v.projectId === project?.id : v.projectId === null)),
    [savedViews, mode, project],
  );
  const activeView = useMemo(() => {
    if (!url.v) return null;
    const builtin = PM_BUILTIN_VIEWS.find((b) => b.id === url.v);
    if (builtin) return { id: builtin.id, name: builtin.name, filter: builtin.filter, canEdit: false };
    const saved = scopedViews.find((v) => v.id === url.v);
    return saved ? { id: saved.id, name: saved.name, filter: saved.filter, canEdit: saved.canEdit } : null;
  }, [url.v, scopedViews]);
  const viewsReady = savedViews !== undefined;
  const namedSavedView = !!url.v && !isPmBuiltinViewId(url.v);
  // A saved view's filter is not known until the list arrives; querying before
  // then would flash the wrong rows (and "that view is gone" before it could be
  // looked for).
  const viewPending = namedSavedView && !activeView && !viewsReady && !viewsErr;
  const viewMissing = namedSavedView && !activeView && viewsReady && (mode === "project" || mode === "workspace");
  const viewUnreadable = namedSavedView && !activeView && !!viewsErr && (mode === "project" || mode === "workspace");

  const baseFilter: PmFilter = activeView?.filter ?? EMPTY_FILTER;
  // `f` absent → the view's own filter. `f` present → this, even when empty.
  // `f` unreadable → ignored (a hand-edited link degrades; it never errors).
  const fromUrl = url.f === null ? null : parsePmFilter(url.f);
  const fUnreadable = url.f !== null && fromUrl === null;
  const filter: PmFilter = fromUrl ?? baseFilter;
  const dirty = fromUrl !== null && !pmFiltersEqual(fromUrl, baseFilter);
  const filterActive = !pmFiltersEqual(filter, EMPTY_FILTER);

  /** The URL's `f` for a filter: absent when it IS the view's own, present (even empty) when not. */
  const filterParam = useCallback(
    (next: PmFilter): string | null => (pmFiltersEqual(next, baseFilter) ? null : serializePmFilter(next)),
    [baseFilter],
  );
  const writeFilter = useCallback(
    (next: PmFilter) => {
      setNotice(null);
      go({ f: filterParam(next) }, "replace");
    },
    [go, filterParam],
  );

  // ── the data ──
  const counts = useMemo(() => {
    const named: Record<string, PmFilter> = {};
    for (const b of PM_BUILTIN_VIEWS) named[b.id] = b.filter;
    for (const v of scopedViews) named[v.id] = v.filter;
    return Object.fromEntries(Object.entries(named).slice(0, 32));
  }, [scopedViews]);
  const queryEnabled = !viewPending && ((mode === "project" && !!project) || mode === "workspace");
  const query = useWorkItemQuery({
    enabled: queryEnabled,
    projectId: mode === "project" ? (project?.id ?? null) : null,
    filter,
    counts,
  });
  const { states } = useProjectStates(mode === "project" ? (project?.id ?? null) : null);
  const { labels } = useProjectLabels(mode === "project" ? (project?.id ?? null) : null);
  const { departments } = useDepartments();
  const allItems = query.items ?? [];

  // The server dropped something the filter named that no longer exists
  // (brief §3.9): say so once, and show the filter that was applied. The URL
  // gets the effective filter so the chips match what the board shows.
  const staleSig = query.stale?.map((s) => `${s.field}:${s.value}`).join(",") ?? "";
  const handledStale = useRef("");
  useEffect(() => {
    if (!staleSig) {
      handledStale.current = "";
      return;
    }
    if (handledStale.current === staleSig) return;
    handledStale.current = staleSig;
    setNotice(staleNoticeText(query.stale?.length ?? 0));
    // Not `writeFilter`: that clears the notice, which is the one thing this must keep.
    if (query.effectiveFilter) go({ f: filterParam(query.effectiveFilter) }, "replace");
  }, [staleSig, query.stale, query.effectiveFilter, go, filterParam]);

  const noticeText =
    notice ?? (fUnreadable ? FILTER_UNREADABLE : viewMissing ? VIEW_GONE : viewUnreadable ? VIEW_UNREADABLE : null);

  // ── the open drawer ──
  const listItem: PmWorkItem | undefined = url.item
    ? allItems.find((i) => i.key.toLowerCase() === url.item!.toLowerCase())
    : undefined;
  const byKey = useWorkItemByKey(url.item, !!url.item && !listItem);
  const drawerItem = listItem ?? byKey.item ?? null;
  // An item link that answers 404: say so ONCE, and take it out of the URL. (Once
  // per key: `go` and `toast` change identity, and without the guard this would
  // toast again on every render until the navigation lands.)
  const handledMissingItem = useRef<string | null>(null);
  useEffect(() => {
    if (!url.item || !byKey.error || handledMissingItem.current === url.item) return;
    handledMissingItem.current = url.item;
    toast(translateError(byKey.error, "projects"), "error");
    go({ item: null }, "replace");
  }, [byKey.error, url.item, go, toast]);

  // ── labels for the chips, options for the editors ──
  const deptOptions = useMemo(() => departmentOptions(allItems, departments), [allItems, departments]);
  const people = useMemo(
    () => (users ?? []).filter((u) => u.userId).map((u) => ({ value: u.userId as string, label: u.displayName })),
    [users],
  );
  const lookups: ChipLookups = useMemo(
    () => ({
      stateName: (id) => states?.find((s) => s.id === id)?.name,
      labelName: (id) => labels?.find((l) => l.id === id)?.name,
      personName: (id) => users?.find((u) => u.userId === id)?.displayName,
      departmentName: (ref) => deptOptions.find((d) => d.id === ref)?.name,
      projectName: (id) => projects?.find((p) => p.id === id)?.name,
    }),
    [states, labels, users, deptOptions, projects],
  );
  const editorOptions: EditorOptions = useMemo(
    () => ({
      scope: mode === "workspace" ? "workspace" : "project",
      states: states ?? [],
      labels: labels ?? [],
      people,
      departments: deptOptions,
      projects: projects ?? [],
    }),
    [mode, states, labels, people, deptOptions, projects],
  );

  // ── navigation ──
  const openProject = (p: PmProject) => {
    setNotice(null);
    go({ p: p.identifier, view: null, v: null, f: null, item: null }, "push");
  };
  const backToIndex = () => {
    setNotice(null);
    go({ p: null, view: null, v: null, f: null, item: null }, "push");
  };
  const openWorkspace = () => go({ p: null, view: "workspace", v: null, f: null, item: null }, "push");
  const openViewsIndex = () => go({ p: null, view: "views", v: null, f: null, item: null }, "push");
  const openMyWork = () => go({ p: null, view: "my-work", v: null, f: null, item: null }, "push");
  const switchTab = (next: ProjectView) => go({ view: next === "board" ? null : next }, "push");
  const pickView = (id: string) => {
    setNotice(null);
    const saved = scopedViews.find((v) => v.id === id);
    const opensIn = saved ? tabOfLayout(saved.layout ?? "BOARD") : null;
    go(
      {
        v: id === "all" ? null : id,
        f: null,
        ...(opensIn && mode === "project" ? { view: opensIn === "board" ? null : opensIn } : {}),
      },
      "replace",
    );
  };

  // The server query supplies the admitted IDs; schedule views never apply a
  // second client filter. Include each row in the revision so a different
  // result with the same size and newest timestamp still refreshes Timeline.
  const visibleIds = useMemo(
    () => (filterActive ? new Set(allItems.map((i) => i.id)) : null),
    [allItems, filterActive],
  );
  const itemsRevision = useMemo(
    () => JSON.stringify(allItems.map((i) => [i.id, i.updatedAt])),
    [allItems],
  );
  const refreshAfterSchedule = async () => {
    await query.refresh();
    void mutateProjects();
    void mutateSummary();
  };

  const refreshAll = async () => {
    void mutateProjects();
    void mutateSummary();
    void mutateViews();
    void byKey.mutate();
    await query.refresh();
  };

  const onTransition = async (item: PmWorkItem, stateId: string) => {
    try {
      await pmActions().transitionItem(item.id, stateId);
      await refreshAll();
    } catch (e) {
      // Friendly copy only — the orchestrator's snake_case codes never reach
      // a toast verbatim (WARP-1154; unknown codes get the domain fallback).
      toast(translateError(e, "projects"), "error");
    }
  };

  // ── saved views ──
  const personalCount = scopedViews.filter((v) => v.scope === "PERSONAL" && v.ownerId === user?.id).length;
  const sharedCount = scopedViews.filter((v) => v.scope === "SHARED").length;
  const canShare = role === "owner" || role === "admin" || (mode === "project" && !!project && project.leadId === user?.id);

  const saveView = async ({ name, scope }: { name: string; scope: "PERSONAL" | "SHARED" }) => {
    const res = await viewActions().create({
      projectId: mode === "project" ? (project?.id ?? null) : null,
      scope,
      name,
      layout: layoutOfTab(tab) ?? "LIST",
      filter,
    });
    await mutateViews();
    go({ v: res.view.id, f: null }, "replace");
    toast("View saved", "success");
  };
  const renameView = async (id: string, name: string) => {
    await viewActions().update(id, { name });
    await mutateViews();
    toast("View renamed", "success");
  };
  const deleteView = async (id: string) => {
    try {
      await viewActions().remove(id);
      await mutateViews();
      if (url.v === id) go({ v: null, f: null }, "replace");
      toast("View deleted", "success");
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    }
  };
  const updateActiveView = async () => {
    if (!activeView) return;
    try {
      const layout = mode === "project" ? layoutOfTab(tab) : null;
      await viewActions().update(activeView.id, { filter, ...(layout ? { layout } : {}) });
      await mutateViews();
      go({ f: null }, "replace");
      toast("View updated", "success");
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    }
  };

  const chipItems: ViewChipItem[] = [
    ...PM_BUILTIN_VIEWS.map((b) => ({ id: b.id, name: b.name, scope: "BUILTIN" as const, canEdit: false })),
    ...scopedViews.map((v) => ({
      id: v.id,
      name: v.name,
      scope: v.scope === "SHARED" ? ("SHARED" as const) : ("PERSONAL" as const),
      canEdit: v.canEdit,
    })),
  ];

  // ── what the body shows ──
  const loading = viewPending || (queryEnabled ? query.items === undefined && !query.error : true);
  const unfilteredTotal = query.counts?.all;
  const boardDomain: Domain = loading
    ? "loading"
    : query.error
      ? "error"
      : allItems.length === 0
        ? filterActive && (unfilteredTotal === undefined || unfilteredTotal > 0)
          ? "filtered"
          : "empty"
        : "populated";

  const total = query.total;
  const status = query.truncated
    ? `Showing the first ${allItems.length} of ${total}. Narrow the filter to see the rest.`
    : query.loadingMore
      ? `Showing ${allItems.length} of ${total}…`
      : filterActive && total !== undefined && !loading
        ? `${total} ${total === 1 ? "item matches" : "items match"}.`
        : null;

  const headerTitle =
    mode === "project" ? (project?.name ?? "Projects") : mode === "workspace" ? "All projects" : mode === "views" ? "Views" : mode === "my-work" ? "My work" : "Projects";
  const headerSub =
    mode === "index"
      ? `${summary?.activeProjects ?? projects?.filter((p) => !p.archived).length ?? 0} projects · ${summary?.itemsOpen ?? 0} items open`
      : mode === "my-work"
        ? "Your open work across every project"
        : mode === "project"
        ? project
          ? `${project.openCount} open · ${project.doneCount} done`
          : undefined
        : mode === "workspace" && total !== undefined
          ? `${total} ${total === 1 ? "item" : "items"}`
          : undefined;

  const refreshButton = (
    <button className="btn" type="button" onClick={() => void refreshAll()} aria-label="Refresh">
      <PmIcon name="refresh" size={15} />
    </button>
  );
  const actions =
    mode === "index" ? (
      <>
        {!readOnly && (
          <button className="btn primary" type="button" onClick={() => setModal("newproject")}>
            <FolderKanban size={14} /> New project
          </button>
        )}
        <button className="btn" type="button" onClick={openViewsIndex}>
          <PmIcon name="filter" size={14} /> Views
        </button>
        <button className="btn" type="button" onClick={openMyWork}>
          <PmIcon name="user" size={14} /> My work
        </button>
        {refreshButton}
      </>
    ) : mode === "project" ? (
      <>
        {/* WARP-2582 — record-scoped, and `project` is in hand here, so this
            hands over an identity instead of a bare navigation: the seed line
            names the project on turn 1 and the pin scopes every turn after.
            Note the honest limit — pm_list_projects / pm_get_work_item are in
            EXCLUDED_FROM_CHAT_TOOLS, so a project pin scopes retrieval and
            names the record; it does not unlock a PM read tool. */}
        {/* Rendered only with the record in hand — the CRM drawer does the
            same. A button that navigates to /chat with nothing staged would
            be a silent regression to a bare link. */}
        {project && (
          <Link
            className="btn"
            href="/chat"
            onClick={() =>
              stageRecordPinHandoff({
                kind: "project",
                id: project.id,
                name: project.name,
              })
            }
          >
            <PmIcon name="msg" size={14} /> Ask AI about this project
          </Link>
        )}
        {!readOnly && project && (
          <button className="btn primary" type="button" onClick={() => setModal("newitem")}>
            <PmIcon name="plus" size={14} /> New item
          </button>
        )}
        {refreshButton}
      </>
    ) : mode === "my-work" ? null : (
      refreshButton
    );

  const listing = (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 14 }}>
        <div className="pm-row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          {mode === "project" ? <ViewSwitcher view={tab} onView={switchTab} /> : <span className="pm-scope-label">Every project</span>}
          {(mode === "workspace" || layoutOfTab(tab) !== null) && (
            <FilterBar scope={editorOptions.scope} filter={filter} onChange={writeFilter} options={editorOptions} lookups={lookups} />
          )}
        </div>
        {(mode === "workspace" || layoutOfTab(tab) !== null) && (
          <>
            <ViewChips
              views={chipItems}
              activeId={activeView?.id ?? "all"}
              counts={query.counts}
              readOnly={readOnly}
              canShare={canShare}
              personalFull={personalCount >= PM_VIEW_LIMIT}
              sharedFull={sharedCount >= PM_VIEW_LIMIT}
              onPick={pickView}
              onSave={saveView}
              onRename={renameView}
              onDelete={deleteView}
              dirty={
                activeView && activeView.id !== "all" && dirty
                  ? { name: activeView.name, canUpdate: activeView.canEdit, onUpdate: updateActiveView, onReset: () => writeFilter(baseFilter) }
                  : null
              }
            />
            <FilterChips scope={editorOptions.scope} filter={filter} onChange={writeFilter} options={editorOptions} lookups={lookups} />
            {noticeText && (
              <div className="pm-note" role="status">
                {noticeText}
              </div>
            )}
            {status && (
              <div className="pm-status" role="status" aria-live="polite">
                {status}
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === "board" && mode === "project" && (
          <BoardView
            states={states ?? []}
            items={allItems}
            domain={boardDomain}
            readOnly={readOnly}
            onOpen={(i) => openItem(i.key)}
            onTransition={onTransition}
            onNewItem={() => setModal("newitem")}
            onRetry={() => void refreshAll()}
            onClearFilters={() => writeFilter(EMPTY_FILTER)}
          />
        )}
        {(tab === "list" || mode === "workspace") && (
          <ListView
            states={states ?? []}
            items={allItems}
            domain={boardDomain}
            onOpen={(i) => openItem(i.key)}
            projects={mode === "workspace" ? (projects ?? []) : undefined}
            onRetry={() => void refreshAll()}
            onClearFilters={() => writeFilter(EMPTY_FILTER)}
          />
        )}
        {tab === "calendar" && mode === "project" && (
          <CalendarView
            items={allItems}
            domain={boardDomain}
            readOnly={readOnly}
            onOpen={(i) => openItem(i.key)}
            onChanged={refreshAfterSchedule}
            onNewItem={() => setModal("newitem")}
          />
        )}
        {tab === "timeline" && mode === "project" && project && (
          <TimelineView
            projectId={project.id}
            visibleIds={visibleIds}
            revision={itemsRevision}
            domain={boardDomain}
            readOnly={readOnly}
            onOpen={(i) => openItem(i.key)}
            onChanged={refreshAfterSchedule}
            onNewItem={() => setModal("newitem")}
          />
        )}
        {tab === "cycles" && mode === "project" && <PlaceholderView kind="cycles" />}
        {tab === "modules" && mode === "project" && <PlaceholderView kind="modules" />}
      </div>
    </>
  );

  return (
    <PeopleContext.Provider value={person}>
      <ShellPage icon={<FolderKanban size={15} />} label="Projects" title={headerTitle} sub={headerSub} actions={actions}>
        <div className="pm-scope">
          <div className="pm-page">
            {mode !== "index" && (
              <button className="pm-btn ghost sm" type="button" onClick={backToIndex} style={{ alignSelf: "flex-start", marginBottom: 14 }}>
                <PmIcon name="chevL" size={14} /> All projects
              </button>
            )}

            {mode === "index" && !(namedSavedView && !savedViews && !viewsErr) && (
              <IndexView
                projects={projects}
                summary={summary}
                loading={projLoading}
                error={projErr}
                readOnly={readOnly}
                showArchived={showArchived}
                onToggleArchived={() => setShowArchived((v) => !v)}
                onOpenProject={openProject}
                onNewProject={() => setModal("newproject")}
                onRetry={() => {
                  void mutateProjects();
                }}
              />
            )}
            {mode === "views" && (
              <ViewsIndex
                views={savedViews && projects ? savedViews.filter((v) => v.projectId === null || projects.some((p) => p.id === v.projectId)) : undefined}
                projects={projects}
                loading={viewsLoading}
                error={viewsErr}
                onOpen={(v) => {
                  const owner = v.projectId ? projects?.find((p) => p.id === v.projectId) : null;
                  if (v.projectId && !owner) return;
                  const opensIn = tabOfLayout(v.layout ?? "BOARD");
                  go(
                    owner
                      ? { p: owner.identifier, view: opensIn === "board" ? null : opensIn, v: v.id, f: null, item: null }
                      : { p: null, view: "workspace", v: v.id, f: null, item: null },
                    "push",
                  );
                }}
                onOpenWorkspace={openWorkspace}
                onRetry={() => void mutateViews()}
              />
            )}
            {mode === "index" && namedSavedView && !savedViews && !viewsErr && <ListView states={[]} items={[]} domain="loading" onOpen={() => undefined} />}
            {mode === "project" && projectMissing && (
              <div className="pm-surface" style={{ padding: 8 }}>
                <EmptyBlock
                  icon="alert"
                  heading="We couldn't find that project anymore."
                  body="It may have been deleted."
                  cta={
                    <button className="pm-btn ghost" type="button" onClick={backToIndex}>
                      All projects
                    </button>
                  }
                />
              </div>
            )}
            {mode === "project" && !projectMissing && !project && projErr && (
              <div className="pm-surface" style={{ padding: 8 }}>
                <EmptyBlock
                  icon="alert"
                  tone="error"
                  heading="Couldn't load this project."
                  body="Check the appliance connection and try again."
                  cta={
                    <button className="pm-btn ghost" type="button" onClick={() => void mutateProjects()}>
                      Try again
                    </button>
                  }
                />
              </div>
            )}
            {(mode === "workspace" || (mode === "project" && !projectMissing && (project || (!projErr && projLoading)))) && listing}
            {mode === "my-work" && <MyWorkView />}
          </div>
        </div>
      </ShellPage>

      {drawerItem && <DetailDrawer item={drawerItem} onClose={closeItem} onChanged={refreshAll} />}
      {modal === "newitem" && project && (
        <NewItemModal project={project} onClose={() => setModal(null)} onCreated={() => void refreshAll()} />
      )}
      {modal === "newproject" && <NewProjectModal onClose={() => setModal(null)} onCreated={() => void refreshAll()} />}
    </PeopleContext.Provider>
  );
}
