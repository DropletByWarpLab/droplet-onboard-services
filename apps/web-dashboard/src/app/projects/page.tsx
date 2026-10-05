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
import "./planning.css";
import "./cycles.css";
import "./modules.css";

import { PmIcon } from "@/components/projects/icons";
import { PeopleContext, EmptyBlock, Skel } from "@/components/projects/bits";
import { ProjectsDisabled } from "@/components/projects/ProjectsDisabled";
import { stageRecordPinHandoff } from "@/lib/pin-handoff";
import { canDeleteProject, canWrite, type PmProject, type PmWorkItem } from "@/components/projects/types";
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
  useProjectCycles,
  pmActions,
  viewActions,
  type ViewsScope,
} from "@/components/projects/usePm";
import { departmentOptions } from "@/components/projects/department";
import { IndexView } from "@/components/projects/IndexView";
import { BoardView, ListView, type Domain } from "@/components/projects/board";
import { ViewSwitcher, type ProjectView } from "@/components/projects/chrome";
import { FilterBar, FilterChips, type EditorOptions } from "@/components/projects/FilterBar";
import { ViewChips, type ViewChipItem } from "@/components/projects/ViewChips";
import { ViewsIndex } from "@/components/projects/ViewsIndex";
import { EMPTY_FILTER, type ChipLookups } from "@/components/projects/filter-model";
import { useProjectsUrl } from "@/components/projects/useProjectsUrl";
import { CyclesView } from "@/components/projects/cycles";
import { ModulesView } from "@/components/projects/modules";
import { DetailDrawer } from "@/components/projects/detail";
import { InsightsView } from "@/components/projects/insights/InsightsView";
import { CalendarView } from "@/components/projects/calendar/CalendarView";
import { TimelineView } from "@/components/projects/timeline/TimelineView";
import { MyWorkView } from "@/components/projects/mywork/MyWorkView";
import { TableView } from "@/components/projects/table/TableView";
import type { TableApi } from "@/components/projects/table/TableView";
import { DisplayControls } from "@/components/projects/table/DisplayControls";
import { useTableDisplay } from "@/components/projects/table/display";
import { useTableEdits } from "@/components/projects/table/useTableEdits";
import { useOptimisticRows } from "@/components/projects/table/useOptimisticRows";
import { BulkBar } from "@/components/projects/bulk/BulkBar";
import { useSelection } from "@/components/projects/bulk/selection";
import { useBulkActions } from "@/components/projects/bulk/useBulkActions";
import { ProjectsKeyboard } from "@/components/projects/palette/ProjectsKeyboard";
import type { PaletteLayout } from "@/components/projects/palette/commands";
import type { PmTableScope } from "@droplet/shared-types";
import {
  ConfirmArchiveProject,
  ConfirmDeleteProject,
  NewItemModal,
  NewProjectModal,
} from "@/components/projects/modals";
import { TimeAccessProvider } from "@/components/projects/time/access";
import { TimerChip } from "@/components/projects/time/TimerChip";
import { TimeView } from "@/components/projects/time/TimeView";

// ── URL ↔ page vocabulary ───────────────────────────────────────────────────

const PROJECT_TABS: readonly ProjectView[] = ["board", "list", "table", "calendar", "timeline", "cycles", "modules", "insights", "time"];

/** The tab a `view=` names; anything else is the board. */
function tabOf(view: string | null): ProjectView {
  return PROJECT_TABS.find((t) => t === view) ?? "board";
}

/** A tab that is a layout a view can be saved in. */
function layoutOfTab(tab: ProjectView): PmViewLayout | null {
  if (tab === "board") return "BOARD";
  if (tab === "list") return "LIST";
  if (tab === "table") return "TABLE";
  if (tab === "calendar") return "CALENDAR";
  if (tab === "timeline") return "TIMELINE";
  return null;
}

/** The tab a saved layout opens in. */
function tabOfLayout(layout: PmViewLayout): ProjectView {
  if (layout === "BOARD") return "board";
  if (layout === "TABLE") return "table";
  if (layout === "CALENDAR") return "calendar";
  if (layout === "TIMELINE") return "timeline";
  return "list";
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
  // WARP-3524 — `useSearchParams` (the `?view=insights` deep link) has to sit
  // under a Suspense boundary, or the route cannot be prerendered. Time has
  // the same requirement and receives the current user through its provider.
  return (
    <Suspense fallback={<ProjectsFallback />}>
      <ProjectsWithTimeAccess />
    </Suspense>
  );
}

/** The session, handed to the time surface (see components/projects/time/access.tsx). */
function ProjectsWithTimeAccess(): JSX.Element {
  const { user } = useAuth();
  return (
    <TimeAccessProvider user={user}>
      <ProjectsWorkspace />
    </TimeAccessProvider>
  );
}

function ProjectsWorkspace(): JSX.Element {
  const { user } = useAuth();
  const role = user?.role;
  const readOnly = !canWrite(role);
  const mayDelete = canDeleteProject(role);
  const { toast } = useToast();
  const { person, people: users } = usePeople();
  const { state: url, go, openItem, closeItem } = useProjectsUrl();
  const tableApi = useRef<TableApi | null>(null);

  const [showArchived, setShowArchived] = useState(false);
  const [modal, setModal] = useState<"newitem" | "newproject" | "archive" | "delete" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

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
  type Mode = "index" | "views" | "workspace" | "project" | "my-work" | "time" | "insights";
  const mode: Mode = url.p
    ? "project"
    : url.view === "insights"
      ? "insights"
      : url.view === "time"
      ? "time"
      : url.view === "my-work"
      ? "my-work"
    : url.view === "views"
      ? "views"
      : url.view === "workspace" || crossViewInUrl
        ? "workspace"
        : "index";
  const tab: ProjectView = mode === "project"
    ? tabOf(url.view)
    : mode === "workspace" && crossViewInUrl
      ? tabOfLayout(crossViewInUrl.layout ?? "LIST")
      : "list";

  // ── the active view and the filter ──
  const scopedViews = useMemo(
    () => (savedViews ?? []).filter((v) => (mode === "project" ? v.projectId === project?.id : v.projectId === null)),
    [savedViews, mode, project],
  );
  const activeView = useMemo(() => {
    if (!url.v) return null;
    const builtin = PM_BUILTIN_VIEWS.find((b) => b.id === url.v);
    if (builtin) return { id: builtin.id, name: builtin.name, filter: builtin.filter, canEdit: false, groupBy: null, sortBy: null, columns: null };
    const saved = scopedViews.find((v) => v.id === url.v);
    return saved ? { ...saved, canEdit: saved.canEdit } : null;
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
  const queryEnabled = !viewPending && ((mode === "project" && !!project && tab !== "time" && tab !== "insights") || mode === "workspace");
  const tableScope: PmTableScope = mode === "workspace" ? "workspace" : "project";
  const tableLayout = tab === "table" ? "table" : "list";
  const tableDisplay = useTableDisplay({
    saved: activeView ? {
      groupBy: activeView.groupBy ?? null,
      sortBy: activeView.sortBy ?? null,
      columns: activeView.columns ?? null,
    } : null,
    scopeKey: `${mode}:${project?.id ?? "workspace"}:${activeView?.id ?? "default"}:${tableLayout}`,
    scope: tableScope,
    layout: tableLayout,
  });
  const usesDisplay = (mode === "project" || mode === "workspace") && tab === "table";
  const query = useWorkItemQuery({
    enabled: queryEnabled,
    projectId: mode === "project" ? (project?.id ?? null) : null,
    filter,
    counts,
    sort: usesDisplay ? tableDisplay.resolved.sort ?? undefined : undefined,
    groupBy: usesDisplay ? tableDisplay.resolved.groupBy ?? undefined : undefined,
  });
  const { states } = useProjectStates(mode === "project" ? (project?.id ?? null) : null);
  const { labels } = useProjectLabels(mode === "project" ? (project?.id ?? null) : null);
  const { departments } = useDepartments();
  const allItems = query.items ?? [];
  const optimistic = useOptimisticRows();
  const visibleItems = optimistic.apply(allItems);
  const selection = useSelection();
  // WARP-3521 — the project's cycles, so a board card can name its cycle.
  const projectId = mode === "project" ? (project?.id ?? null) : null;
  const { cycles, mutate: mutateCycles } = useProjectCycles(projectId);
  const cyclesById = useMemo(() => new Map((cycles ?? []).map((c) => [c.id, c])), [cycles]);

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
    () => (users ?? []).map((u) => ({ value: u.id, label: u.displayName })),
    [users],
  );
  const lookups: ChipLookups = useMemo(
    () => ({
      stateName: (id) => states?.find((s) => s.id === id)?.name,
      labelName: (id) => labels?.find((l) => l.id === id)?.name,
      personName: (id) => users?.find((u) => u.id === id)?.displayName,
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
  const openInsights = () => go({ p: null, view: "insights", v: null, f: null, item: null }, "push");
  const openMyWork = () => go({ p: null, view: "my-work", v: null, f: null, item: null }, "push");
  const openTime = () => go({ p: null, view: "time", v: null, f: null, item: null }, "push");
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
    if (projectId) void mutateCycles();
  };

  const afterProjectGone = () => {
    backToIndex();
    void mutateProjects();
    void mutateSummary();
  };

  const onRestore = async () => {
    if (!project) return;
    try {
      await pmActions().restoreProject(project.id);
      toast("Project restored", "success");
      void mutateProjects();
      void mutateSummary();
    } catch (e) {
      toast(translateError(e, "projects"), "error");
    }
  };

  const edits = useTableEdits({
    optimistic,
    refresh: query.refresh,
    toast,
    announce: setAnnouncement,
  });
  const bulk = useBulkActions({
    selection,
    rows: visibleItems,
    lookups: { states: states ?? [], labels: labels ?? [], personName: (id) => users?.find((u) => u.id === id)?.displayName ?? `User ${id.slice(0, 4)}` },
    optimistic,
    refresh: query.refresh,
    toast,
    announce: setAnnouncement,
  });
  const tableGroupContext = useMemo(() => ({
    personName: (id: string) => users?.find((u) => u.id === id)?.displayName ?? `User ${id.slice(0, 4)}`,
    projectName: (id: string) => projects?.find((p) => p.id === id)?.name,
  }), [users, projects]);
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
    const layout = layoutOfTab(tab) ?? "LIST";
    const res = await viewActions().create({
      projectId: mode === "project" ? (project?.id ?? null) : null,
      scope,
      name,
      layout,
      filter,
      ...(layout === "TABLE" ? {
        groupBy: tableDisplay.raw.groupBy,
        sortBy: tableDisplay.raw.sortBy,
        columns: tableDisplay.raw.columns,
      } : {}),
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
      const layout = layoutOfTab(tab);
      await viewActions().update(activeView.id, {
        filter,
        ...(layout ? { layout } : {}),
        ...(layout === "TABLE" ? {
          groupBy: tableDisplay.raw.groupBy,
          sortBy: tableDisplay.raw.sortBy,
          columns: tableDisplay.raw.columns,
        } : {}),
      });
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

  const paletteLayouts: Array<{ id: PaletteLayout; label: string }> =
    mode === "project"
      ? [
          { id: "board", label: "Board" },
          { id: "list", label: "List" },
          { id: "table", label: "Table" },
          { id: "calendar", label: "Calendar" },
          { id: "timeline", label: "Timeline" },
        ]
      : mode === "workspace"
        ? [
            { id: "list", label: "List" },
            { id: "table", label: "Table" },
          ]
        : [];
  const keyboardPalette = {
    readOnly,
    scope: mode === "project" ? "project" as const : mode === "workspace" || mode === "my-work" ? "workspace" as const : mode === "views" ? "views" as const : "index" as const,
    project: project ? { name: project.name, identifier: project.identifier } : null,
    projects: projects ?? [],
    views: chipItems.map(({ id, name }) => ({ id, name })),
    layouts: paletteLayouts,
    selectionCount: selection.count,
    canArchive: mode === "workspace" || !project?.archived,
    states: states ?? [],
    labels: labels ?? [],
    people,
    meId: user?.id ?? null,
    handlers: {
      createItem: () => setModal("newitem"),
      openProject,
      openAll: openWorkspace,
      openViewsIndex,
      pickView,
      switchLayout: (layout: PaletteLayout) => switchTab(layout),
      clearSelection: selection.clear,
      bulk: (op: Parameters<typeof bulk.run>[0]) => void bulk.run(op),
    },
  };

  // ── what the body shows ──
  const loading = viewPending || (queryEnabled ? query.items === undefined && !query.error : true);
  const unfilteredTotal = query.counts?.all;
  const partialFailure = !!query.partialError && allItems.length > 0;
  const boardDomain: Domain = loading
    ? "loading"
    : query.error && !partialFailure
      ? "error"
      : allItems.length === 0
        ? filterActive && (unfilteredTotal === undefined || unfilteredTotal > 0)
          ? "filtered"
          : "empty"
        : "populated";

  const total = query.total;
  const status = query.error && !partialFailure
    ? null
    : partialFailure
    ? `Showing ${allItems.length} of ${total} work items. Couldn't load the rest.`
    : query.truncated
    ? `Showing the first ${allItems.length} of ${total}. Narrow the filter to see the rest.`
    : query.loadingMore
      ? `Showing ${allItems.length} of ${total} work items — loading the rest…`
      : filterActive && total !== undefined && !loading
        ? `${total} ${total === 1 ? "item matches" : "items match"}.`
        : null;

  const headerTitle =
    mode === "project" ? (project?.name ?? "Projects") : mode === "workspace" ? "All projects" : mode === "views" ? "Views" : mode === "my-work" ? "My work" : mode === "time" ? "Time" : mode === "insights" ? "Insights" : "Projects";
  const headerSub =
    mode === "index"
      ? `${summary?.activeProjects ?? projects?.filter((p) => !p.archived).length ?? 0} projects · ${summary?.itemsOpen ?? 0} items open`
      : mode === "my-work"
        ? "Your open work across every project"
        : mode === "insights"
          ? "Insights across all projects"
        : mode === "time"
          ? "Timesheet and report"
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
        <button className="btn" type="button" onClick={openTime}>
          <PmIcon name="clock" size={14} /> Time
        </button>
        {!readOnly && (
          <button className="btn primary" type="button" onClick={() => setModal("newproject")}>
            <FolderKanban size={14} /> New project
          </button>
        )}
        <button className="btn" type="button" onClick={openViewsIndex}>
          <PmIcon name="filter" size={14} /> Views
        </button>
        <button className="btn" type="button" onClick={openInsights}>
          <PmIcon name="chart" size={14} /> Insights
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
          {(mode === "workspace" || tab === "board" || tab === "list" || tab === "table" || tab === "calendar" || tab === "timeline") && (
            <FilterBar scope={editorOptions.scope} filter={filter} onChange={writeFilter} options={editorOptions} lookups={lookups} />
          )}
        </div>
        {usesDisplay && (
          <DisplayControls
            layout="table"
            scope={tableScope}
            groupBy={tableDisplay.resolved.groupBy}
            onGroupBy={tableDisplay.setGroupBy}
            columns={tableDisplay.resolved.columns}
            onColumns={tableDisplay.setColumns}
            departments={deptOptions.length > 0}
          />
        )}
        {(mode === "workspace" || tab === "board" || tab === "list" || tab === "table" || tab === "calendar" || tab === "timeline") && (
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
                activeView && activeView.id !== "all" && (dirty || (usesDisplay && tableDisplay.dirty))
                  ? {
                      name: activeView.name,
                      canUpdate: activeView.canEdit,
                      onUpdate: updateActiveView,
                      onReset: () => {
                        writeFilter(baseFilter);
                        tableDisplay.reset();
                      },
                    }
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
                {partialFailure && <button className="pm-btn ghost sm" type="button" onClick={() => void refreshAll()}>Retry</button>}
              </div>
            )}
            {announcement && <div className="pm-status" role="status" aria-live="polite">{announcement}</div>}
          </>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === "board" && mode === "project" && (
          <BoardView
            states={states ?? []}
            items={allItems}
            cycles={cyclesById}
            domain={boardDomain}
            readOnly={readOnly}
            partial={query.loadingMore || query.truncated}
            onOpen={(i) => openItem(i.key)}
            onTransition={onTransition}
            onNewItem={() => setModal("newitem")}
            onRetry={() => void refreshAll()}
            onClearFilters={() => writeFilter(EMPTY_FILTER)}
            partial={query.loadingMore || query.truncated}
            cycles={cyclesById}
          />
        )}
        {tab === "list" && (mode === "project" || mode === "workspace") && (
          <ListView
            states={states ?? []}
            items={allItems}
            cycles={cyclesById}
            domain={boardDomain}
            partial={query.loadingMore || query.truncated}
            onOpen={(i) => openItem(i.key)}
            projects={mode === "workspace" ? (projects ?? []) : undefined}
            onRetry={() => void refreshAll()}
            onClearFilters={() => writeFilter(EMPTY_FILTER)}
            partial={query.loadingMore || query.truncated}
            cycles={cyclesById}
          />
        )}
        {tab === "table" && (mode === "project" || mode === "workspace") && (
          <TableView
            rows={visibleItems}
            domain={boardDomain}
            scope={tableScope}
            columns={tableDisplay.resolved.columns}
            sort={tableDisplay.resolved.sort}
            onSort={tableDisplay.setSort}
            groupBy={tableDisplay.resolved.groupBy}
            groupCounts={query.groups}
            loadingMore={query.loadingMore}
            readOnly={readOnly}
            selection={selection}
            pending={optimistic.pending}
            states={states ?? []}
            people={people}
            groupContext={tableGroupContext}
            projects={projects ?? []}
            edits={edits}
            onOpen={(item) => openItem(item.key)}
            onAnnounce={setAnnouncement}
            onRetry={() => void refreshAll()}
            onClearFilters={() => writeFilter(EMPTY_FILTER)}
            onNewItem={() => setModal("newitem")}
            apiRef={tableApi}
          />
        )}
        {tab === "calendar" && mode === "project" && (
          <CalendarView
            items={allItems}
            domain={boardDomain}
            readOnly={readOnly}
            onOpen={(item) => openItem(item.key)}
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
            onOpen={(item) => openItem(item.key)}
            onChanged={refreshAfterSchedule}
            onNewItem={() => setModal("newitem")}
          />
        )}
        {tab === "insights" && mode === "project" && project && <InsightsView projectId={project.id} />}
        {tab === "time" && mode === "project" && project && <TimeView projects={projects} projectId={project.id} />}
        {tab === "cycles" && mode === "project" && project && (
          <CyclesView project={project} states={states ?? []} readOnly={readOnly} onOpenItem={(i) => openItem(i.key)} onChanged={refreshAll} />
        )}
        {tab === "modules" && mode === "project" && project && (
          <ModulesView project={project} readOnly={readOnly} onOpenItem={(i) => openItem(i.key)} onChanged={refreshAll} />
        )}
      </div>
      {tab === "table" && selection.count > 0 && !readOnly && (
        <BulkBar
          count={selection.count}
          capped={selection.capped}
          busy={bulk.busy}
          scope={tableScope}
          states={states ?? []}
          labels={labels ?? []}
          people={people}
          canArchive={mode === "workspace" || !project?.archived}
          onRun={(op) => void bulk.run(op)}
          onClear={selection.clear}
        />
      )}
      <ProjectsKeyboard
        enabled
        blocked={modal !== null || !!url.item}
        readOnly={readOnly}
        tableApi={usesDisplay ? tableApi : null}
        onCreate={mode === "project" && project && !readOnly ? () => setModal("newitem") : null}
        selectionCount={selection.count}
        onClearSelection={selection.clear}
        onOpenItem={openItem}
        palette={keyboardPalette}
      />
    </>
  );

  return (
    <PeopleContext.Provider value={person}>
      <ShellPage icon={<FolderKanban size={15} />} label="Projects" title={headerTitle} sub={headerSub} actions={<><TimerChip />{actions}</>}>
        <div className="pm-scope">
          <div className="pm-page">
            {mode !== "index" && (
              <button className="pm-btn ghost sm" type="button" onClick={backToIndex} style={{ alignSelf: "flex-start", marginBottom: 14 }}>
                <PmIcon name="chevL" size={14} /> All projects
              </button>
            )}
            {mode === "project" && project && !readOnly && !project.archived && (
              <button className="pm-btn ghost sm" type="button" onClick={() => setModal("archive")} style={{ alignSelf: "flex-start", marginBottom: 14 }}>
                <PmIcon name="archive" size={14} /> Archive project
              </button>
            )}

            {/* WARP-3370 — an archived project says so, and owns the two ways out:
                put it back, or (owner/admin) delete it for good. */}
            {mode === "project" && project?.archived && (
              <div
                className="pm-surface pm-row"
                role="status"
                style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 16px", marginBottom: 14 }}
              >
                <span style={{ fontSize: 13, color: "var(--text-2)" }}>
                  This project is archived. It&apos;s hidden from your project list.
                </span>
                <span className="pm-row" style={{ gap: 8 }}>
                  {!readOnly && (
                    <button className="pm-btn sm" type="button" onClick={() => void onRestore()}>
                      <PmIcon name="restore" size={14} /> Restore
                    </button>
                  )}
                  {mayDelete && (
                    <button className="pm-btn danger sm" type="button" onClick={() => setModal("delete")}>
                      <PmIcon name="trash" size={14} /> Delete permanently
                    </button>
                  )}
                </span>
              </div>
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
            {mode === "my-work" && <MyWorkView />}
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
            {mode === "insights" && <InsightsView projectId={null} />}
            {mode === "time" && <TimeView projects={projects} projectId={null} />}
          </div>
        </div>
      </ShellPage>

      {drawerItem && <DetailDrawer item={drawerItem} readOnly={readOnly} onClose={closeItem} onChanged={refreshAll} />}
      {modal === "newitem" && project && (
        <NewItemModal project={project} onClose={() => setModal(null)} onCreated={() => void refreshAll()} />
      )}
      {modal === "newproject" && <NewProjectModal onClose={() => setModal(null)} onCreated={() => void refreshAll()} />}
      {modal === "archive" && project && (
        <ConfirmArchiveProject project={project} onClose={() => setModal(null)} onArchived={afterProjectGone} />
      )}
      {modal === "delete" && project && (
        <ConfirmDeleteProject project={project} onClose={() => setModal(null)} onDeleted={afterProjectGone} />
      )}
    </PeopleContext.Provider>
  );
}
