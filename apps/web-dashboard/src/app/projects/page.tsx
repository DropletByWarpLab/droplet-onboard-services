"use client";

/**
 * Projects — native PM surface (ADR-026 P4). Replaces the embedded Plane iframe
 * with a first-class, Droplet-owned tracker wired to /api/pm/*. One login (the
 * dashboard session), fully in the design system, light + dark, RBAC-gated
 * writes, and the same data the in-app AI reads/writes through the MCP tools.
 */

import { Suspense, useMemo, useState, type JSX } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FolderKanban } from "lucide-react";
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
import { ListProgress, PeopleContext } from "@/components/projects/bits";
import { ProjectsDisabled } from "@/components/projects/ProjectsDisabled";
import { stageRecordPinHandoff } from "@/lib/pin-handoff";
import { canDeleteProject, canWrite, type PmProject, type PmWorkItem } from "@/components/projects/types";
import { isOverdue } from "@/components/projects/config";
import {
  useProjects,
  useSummary,
  useProjectStates,
  useProjectItems,
  useDepartments,
  usePeople,
  useProjectCycles,
  pmActions,
} from "@/components/projects/usePm";
import {
  DEPARTMENT_ANY,
  departmentOptions,
  matchesDepartment,
} from "@/components/projects/department";
import { IndexView } from "@/components/projects/IndexView";
import { BoardView, ListView, type Domain } from "@/components/projects/board";
import { CyclesView } from "@/components/projects/cycles";
import { ModulesView } from "@/components/projects/modules";
import { ViewSwitcher, SavedViews, FilterBar, type ProjectView, type SavedView } from "@/components/projects/chrome";
import { DetailDrawer } from "@/components/projects/detail";
import { InsightsView } from "@/components/projects/insights/InsightsView";
import { useInsightsDeepLink, useSyncInsightsParam } from "@/components/projects/insights/deepLink";
import { CalendarView } from "@/components/projects/calendar/CalendarView";
import { TimelineView } from "@/components/projects/timeline/TimelineView";
import { MyWorkView } from "@/components/projects/mywork/MyWorkView";
import {
  ConfirmArchiveProject,
  ConfirmDeleteProject,
  NewItemModal,
  NewProjectModal,
} from "@/components/projects/modals";
import { TimeAccessProvider } from "@/components/projects/time/access";
import { TimerChip } from "@/components/projects/time/TimerChip";
import { TimeView } from "@/components/projects/time/TimeView";

function matchQuery(item: PmWorkItem, q: string): boolean {
  const needle = q.toLowerCase();
  return item.name.toLowerCase().includes(needle) || item.key.toLowerCase().includes(needle);
}

function applySavedView(items: PmWorkItem[], view: SavedView, uid: string | undefined): PmWorkItem[] {
  switch (view) {
    case "mine":
      return uid ? items.filter((i) => i.assignees.includes(uid)) : [];
    case "active":
      return items.filter((i) => ["backlog", "unstarted", "started"].includes(i.state?.group ?? ""));
    case "overdue":
      return items.filter((i) => isOverdue(i));
    case "noassignee":
      return items.filter((i) => i.assignees.length === 0);
    default:
      return items;
  }
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
    <Suspense fallback={null}>
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
  // WARP-3370 — members archive and restore; only owner/admin may delete for good.
  const mayDelete = canDeleteProject(role);
  const { toast } = useToast();
  const { person } = usePeople();

  // WARP-3524 — `/projects?view=insights` opens the workspace-level Insights.
  const insightsLink = useInsightsDeepLink();
  // `my-work` is cross-project (WARP-3523), so it is not a ProjectView tab.
  // WARP-3526 — the time view is also addressable as `/projects?view=time`.
  const router = useRouter();
  const searchParams = useSearchParams();
  const [view, setView] = useState<ProjectView | "index" | "my-work">(
    searchParams?.get("view") === "time" ? "time" : insightsLink ? "insights" : "index",
  );
  const [projectId, setProjectId] = useState<string | null>(null);
  const [savedView, setSavedView] = useState<SavedView>("all");
  const [q, setQ] = useState("");
  // ADR-045 §5.3 — the department filter. Client-side like `savedView` and `q`:
  // the board already holds every item for the project in one fetch, so a
  // server round-trip buys nothing and would cost the instant saved-view
  // counts. The server-side `?department=` filter exists for the API and for
  // the assistant (`business_find` with a `department` argument, WARP-2719 —
  // `pm_list_work_items` was deleted by ADR-045 slice C), and applies the
  // identical rollup rule.
  const [department, setDepartment] = useState<string>(DEPARTMENT_ANY);
  const [showArchived, setShowArchived] = useState(false);
  const [drawer, setDrawer] = useState<PmWorkItem | null>(null);
  const [modal, setModal] = useState<"newitem" | "newproject" | "archive" | "delete" | null>(null);
  useSyncInsightsParam(view === "insights" && projectId === null);

  const { projects, error: projErr, isLoading: projLoading, mutate: mutateProjects } = useProjects(showArchived);
  // ProjectsWorkspace only mounts behind the `projects` capability gate above.
  const { summary, mutate: mutateSummary } = useSummary(true);
  const { states } = useProjectStates(projectId);
  const {
    items,
    total,
    hasMore,
    loadError,
    error: itemsErr,
    isLoading: itemsLoading,
    mutate: mutateItems,
  } = useProjectItems(projectId);
  const { departments } = useDepartments();
  // WARP-3521 — the project's cycles, so a board card can name its cycle.
  const { cycles, mutate: mutateCycles } = useProjectCycles(projectId);
  const cyclesById = useMemo(() => new Map((cycles ?? []).map((c) => [c.id, c])), [cycles]);

  const project = useMemo(() => projects?.find((p) => p.id === projectId) ?? null, [projects, projectId]);

  const allItems = items ?? [];
  // ADR-045 §5.3 — the scoped list unioned with every department visible on
  // this board, so an archived department (hidden from a non-admin's
  // /api/departments) or one the caller is not a member of is still filterable.
  const deptOptions = useMemo(
    () => departmentOptions(allItems, departments),
    [allItems, departments],
  );
  const filtered = useMemo(() => {
    let list = allItems;
    if (q.trim()) list = list.filter((i) => matchQuery(i, q.trim()));
    if (department !== DEPARTMENT_ANY) {
      list = list.filter((i) => matchesDepartment(i, department, deptOptions));
    }
    return applySavedView(list, savedView, user?.id);
  }, [allItems, q, department, deptOptions, savedView, user?.id]);

  // WARP-3371 — the pages arrive one after another, so for a moment the view
  // holds fewer items than the project has. `partial` is that moment, and while
  // it lasts `all` is the SERVER's exact total (never the length of what has
  // arrived) and every other count is marked as a floor.
  const partial = hasMore && total !== undefined && allItems.length < total;
  const counts: Record<SavedView, number> = useMemo(
    () => ({
      all: partial ? (total ?? allItems.length) : allItems.length,
      mine: applySavedView(allItems, "mine", user?.id).length,
      active: applySavedView(allItems, "active", user?.id).length,
      overdue: applySavedView(allItems, "overdue", user?.id).length,
      noassignee: applySavedView(allItems, "noassignee", user?.id).length,
    }),
    [allItems, partial, total, user?.id],
  );

  const filterActive =
    savedView !== "all" || q.trim() !== "" || department !== DEPARTMENT_ANY;
  const boardDomain: Domain = itemsLoading
    ? "loading"
    : itemsErr
      ? "error"
      : allItems.length === 0 && !partial
        ? "empty"
        : filtered.length === 0 && filterActive && !partial
          ? "filtered"
          : filtered.length === 0 && partial
            ? // Nothing in hand matches yet, but more is still on its way: the
              // honest answer is "still looking", not "no matches".
              "loading"
            : "populated";

  // WARP-3523 — what the timeline needs from the page's filters: the ids they
  // admit (null = no filter, show everything it returns), and a revision that
  // changes when the board data does, so an edit in the drawer reaches it.
  const visibleIds = useMemo(
    () => (filterActive ? new Set(filtered.map((i) => i.id)) : null),
    [filtered, filterActive],
  );
  const itemsRevision = useMemo(
    () => `${allItems.length}:${allItems.reduce((m, i) => (i.updatedAt > m ? i.updatedAt : m), "")}`,
    [allItems],
  );
  const refreshAfterSchedule = async () => {
    await mutateItems();
    void mutateProjects();
    void mutateSummary();
  };

  const refreshAll = () => {
    void mutateProjects();
    void mutateSummary();
    if (projectId) {
      void mutateItems();
      void mutateCycles();
    }
  };

  const openProject = (p: PmProject) => {
    setProjectId(p.id);
    setView("board");
    setSavedView("all");
    setQ("");
    setDepartment(DEPARTMENT_ANY);
  };

  const changeView = (next: ProjectView | "index") => {
    if (next === "time" || view === "time") {
      router.replace(next === "time" ? "/projects?view=time" : "/projects", { scroll: false });
    }
    setView(next);
  };

  const backToIndex = () => {
    changeView("index");
    setProjectId(null);
  };

  const openInsights = () => {
    setView("insights");
    setProjectId(null);
  };

  // WARP-3370 — leaving a project for good (archived or deleted): back to the
  // index, with the list and the KPIs re-read.
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

  const onTransition = async (item: PmWorkItem, stateId: string) => {
    try {
      await pmActions().transitionItem(item.id, stateId);
      const fresh = await mutateItems();
      void mutateProjects();
      void mutateSummary();
      if (drawer?.id === item.id && fresh) {
        const up = fresh.work_items.find((i) => i.id === item.id);
        if (up) setDrawer(up);
      }
    } catch (e) {
      // Friendly copy only — the orchestrator's snake_case codes never reach
      // a toast verbatim (WARP-1154; unknown codes get the domain fallback).
      toast(translateError(e, "projects"), "error");
    }
  };

  const isProjectView = view === "board" || view === "list" || view === "calendar" || view === "timeline";

  const timeOnly = view === "time" && !project;
  const headerTitle =
    view === "index" ? "Projects" : view === "my-work" ? "My work" : timeOnly ? "Time" : project?.name ?? "Projects";
  const headerSub =
    view === "index"
      ? `${summary?.activeProjects ?? projects?.filter((p) => !p.archived).length ?? 0} projects · ${summary?.itemsOpen ?? 0} items open`
      : view === "my-work"
        ? "Your open work across every project"
        : view === "insights" && !project
          ? "Insights across all projects"
          : timeOnly
            ? "Timesheet and report"
            : project
              ? `${project.openCount} open · ${project.doneCount} done`
              : undefined;

  const actions = view === "index" ? (
      <>
        <TimerChip />
        <button className="btn" type="button" onClick={() => changeView("time")}>
          <PmIcon name="clock" size={14} /> Time
        </button>
        {!readOnly && (
          <button className="btn primary" type="button" onClick={() => setModal("newproject")}>
            <FolderKanban size={14} /> New project
          </button>
        )}
        <button className="btn" type="button" onClick={openInsights}>
          <PmIcon name="chart" size={14} /> Insights
        </button>
        <button className="btn" type="button" onClick={() => setView("my-work")}>
          <PmIcon name="user" size={14} /> My work
        </button>
        <button className="btn" type="button" onClick={refreshAll} aria-label="Refresh">
          <PmIcon name="refresh" size={15} />
        </button>
      </>
    ) : (
      <>
        <TimerChip />
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
        {view !== "my-work" && (
          <button className="btn" type="button" onClick={refreshAll} aria-label="Refresh">
            <PmIcon name="refresh" size={15} />
          </button>
        )}
      </>
    );

  return (
    <PeopleContext.Provider value={person}>
      <ShellPage icon={<FolderKanban size={15} />} label="Projects" title={headerTitle} sub={headerSub} actions={actions}>
        <div className="pm-scope">
          <div className="pm-page">
            {view !== "index" && (
              <div className="pm-row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
                <button className="pm-btn ghost sm" type="button" onClick={backToIndex}>
                  <PmIcon name="chevL" size={14} /> All projects
                </button>
                {!readOnly && project && !project.archived && (
                  <button className="pm-btn ghost sm" type="button" onClick={() => setModal("archive")}>
                    <PmIcon name="archive" size={14} /> Archive project
                  </button>
                )}
              </div>
            )}
            {/* WARP-3370 — an archived project says so, and owns the two ways out:
                put it back, or (owner/admin) delete it for good. */}
            {view !== "index" && project?.archived && (
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

            {isProjectView && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 14 }}>
                <div className="pm-row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <ViewSwitcher view={view} onView={changeView} />
                  <FilterBar
                    q={q}
                    onQ={setQ}
                    departments={deptOptions}
                    department={department}
                    onDepartment={setDepartment}
                  />
                </div>
                <SavedViews active={savedView} onPick={setSavedView} counts={counts} partial={partial} />
                {(partial || loadError) && total !== undefined && (
                  <ListProgress
                    shown={allItems.length}
                    total={total}
                    failed={Boolean(loadError)}
                    onRetry={() => void mutateItems()}
                  />
                )}
              </div>
            )}
            {(view === "cycles" || view === "modules" || (view === "insights" && projectId !== null) || (view === "time" && projectId !== null)) && (
              <div style={{ marginBottom: 14 }}>
                <ViewSwitcher view={view} onView={changeView} />
              </div>
            )}

            <div style={{ flex: 1, minHeight: 0 }}>
              {view === "index" && (
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
              {view === "board" && (
                <BoardView
                  states={states ?? []}
                  items={filtered}
                  domain={boardDomain}
                  readOnly={readOnly}
                  partial={partial}
                  onOpen={setDrawer}
                  onTransition={onTransition}
                  onNewItem={() => setModal("newitem")}
                  cycles={cyclesById}
                />
              )}
              {view === "list" && (
                <ListView
                  states={states ?? []}
                  items={filtered}
                  domain={boardDomain}
                  partial={partial}
                  onOpen={setDrawer}
                  cycles={cyclesById}
                />
              )}
              {view === "cycles" && project && (
                <CyclesView
                  project={project}
                  states={states ?? []}
                  readOnly={readOnly}
                  onOpenItem={setDrawer}
                  onChanged={refreshAll}
                />
              )}
              {view === "modules" && project && (
                <ModulesView project={project} readOnly={readOnly} onOpenItem={setDrawer} onChanged={refreshAll} />
              )}
              {view === "calendar" && (
                <CalendarView
                  items={filtered}
                  domain={boardDomain}
                  readOnly={readOnly}
                  onOpen={setDrawer}
                  onChanged={refreshAfterSchedule}
                  onNewItem={() => setModal("newitem")}
                />
              )}
              {view === "timeline" && project && (
                <TimelineView
                  projectId={project.id}
                  visibleIds={visibleIds}
                  revision={itemsRevision}
                  domain={boardDomain}
                  readOnly={readOnly}
                  onOpen={setDrawer}
                  onChanged={refreshAfterSchedule}
                  onNewItem={() => setModal("newitem")}
                />
              )}
              {view === "my-work" && <MyWorkView />}
              {view === "insights" && <InsightsView projectId={projectId} />}
              {view === "time" && <TimeView projects={projects} projectId={projectId} />}
            </div>
          </div>
        </div>
      </ShellPage>

      {drawer && (
        <DetailDrawer
          item={drawer}
          readOnly={readOnly}
          onClose={() => setDrawer(null)}
          onChanged={async () => {
            const fresh = await mutateItems();
            void mutateProjects();
            void mutateSummary();
            void mutateCycles();
            if (drawer && fresh) {
              const up = fresh.work_items.find((i) => i.id === drawer.id);
              if (up) setDrawer(up);
            }
          }}
        />
      )}
      {modal === "newitem" && project && (
        <NewItemModal project={project} onClose={() => setModal(null)} onCreated={refreshAll} />
      )}
      {modal === "newproject" && <NewProjectModal onClose={() => setModal(null)} onCreated={refreshAll} />}
      {modal === "archive" && project && (
        <ConfirmArchiveProject project={project} onClose={() => setModal(null)} onArchived={afterProjectGone} />
      )}
      {modal === "delete" && project && (
        <ConfirmDeleteProject project={project} onClose={() => setModal(null)} onDeleted={afterProjectGone} />
      )}
    </PeopleContext.Provider>
  );
}
