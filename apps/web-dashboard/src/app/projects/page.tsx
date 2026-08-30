"use client";

/**
 * Projects — native PM surface (ADR-026 P4). Replaces the embedded Plane iframe
 * with a first-class, Droplet-owned tracker wired to /api/pm/*. One login (the
 * dashboard session), fully in the design system, light + dark, RBAC-gated
 * writes, and the same data the in-app AI reads/writes through the MCP tools.
 */

import { useMemo, useState, type JSX } from "react";
import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import { useAppCapabilities } from "@/lib/hooks/useAppCapabilities";
import { translateError } from "@/lib/friendly-errors";
import "./projects.css";

import { PmIcon } from "@/components/projects/icons";
import { PeopleContext } from "@/components/projects/bits";
import { ProjectsDisabled } from "@/components/projects/ProjectsDisabled";
import { canWrite, type PmProject, type PmWorkItem } from "@/components/projects/types";
import { isOverdue } from "@/components/projects/config";
import {
  useProjects,
  useSummary,
  useProjectStates,
  useProjectItems,
  usePeople,
  pmActions,
} from "@/components/projects/usePm";
import { IndexView } from "@/components/projects/IndexView";
import { BoardView, ListView, PlaceholderView, type Domain } from "@/components/projects/board";
import { ViewSwitcher, SavedViews, FilterBar, type ProjectView, type SavedView } from "@/components/projects/chrome";
import { DetailDrawer } from "@/components/projects/detail";
import { NewItemModal, NewProjectModal } from "@/components/projects/modals";
import { CrmTabs, type CrmTab } from "@/components/crm/CrmTabs";
import { CrmSurface } from "@/components/crm/CrmSurface";

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
  const { projects: projectsEnabled, crm: crmEnabled } = useAppCapabilities();
  if (!projectsEnabled) return <ProjectsDisabled />;
  // WARP-2545 — the CRM nests here rather than taking a route of its own, so
  // its module flag only ever ADDS sub-tabs. `crm` is already resolved against
  // its `requires: "projects"` edge server-side; a box with CRM on and
  // Projects off never reaches this line anyway.
  return <ProjectsWorkspace crmEnabled={crmEnabled} />;
}

function ProjectsWorkspace({ crmEnabled }: { crmEnabled: boolean }): JSX.Element {
  const { user } = useAuth();
  const role = user?.role;
  const readOnly = !canWrite(role);
  const { toast } = useToast();
  const { person } = usePeople();

  // WARP-2545. Defaults to "projects" so a box that turns the CRM on finds the
  // surface it already had, unchanged, and discovers the new tabs beside it —
  // rather than landing somewhere else the morning after an update.
  const [crmTab, setCrmTab] = useState<CrmTab>("projects");
  const [view, setView] = useState<ProjectView | "index">("index");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [savedView, setSavedView] = useState<SavedView>("all");
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [drawer, setDrawer] = useState<PmWorkItem | null>(null);
  const [modal, setModal] = useState<"newitem" | "newproject" | null>(null);

  const { projects, error: projErr, isLoading: projLoading, mutate: mutateProjects } = useProjects(showArchived);
  const { summary, mutate: mutateSummary } = useSummary();
  const { states } = useProjectStates(projectId);
  const { items, error: itemsErr, isLoading: itemsLoading, mutate: mutateItems } = useProjectItems(projectId);

  const project = useMemo(() => projects?.find((p) => p.id === projectId) ?? null, [projects, projectId]);

  const allItems = items ?? [];
  const filtered = useMemo(() => {
    let list = allItems;
    if (q.trim()) list = list.filter((i) => matchQuery(i, q.trim()));
    return applySavedView(list, savedView, user?.id);
  }, [allItems, q, savedView, user?.id]);

  const counts: Record<SavedView, number> = useMemo(
    () => ({
      all: allItems.length,
      mine: applySavedView(allItems, "mine", user?.id).length,
      active: applySavedView(allItems, "active", user?.id).length,
      overdue: applySavedView(allItems, "overdue", user?.id).length,
      noassignee: applySavedView(allItems, "noassignee", user?.id).length,
    }),
    [allItems, user?.id],
  );

  const filterActive = savedView !== "all" || q.trim() !== "";
  const boardDomain: Domain = itemsLoading
    ? "loading"
    : itemsErr
      ? "error"
      : allItems.length === 0
        ? "empty"
        : filtered.length === 0 && filterActive
          ? "filtered"
          : "populated";

  const refreshAll = () => {
    void mutateProjects();
    void mutateSummary();
    if (projectId) void mutateItems();
  };

  const openProject = (p: PmProject) => {
    setProjectId(p.id);
    setView("board");
    setSavedView("all");
    setQ("");
  };

  const backToIndex = () => {
    setView("index");
    setProjectId(null);
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

  // The CRM tabs replace the PM content; the PM chrome (view switcher, saved
  // views, filters) belongs to the Projects tab alone.
  const onCrmTab = crmEnabled && crmTab !== "projects";
  const isProjectView = !onCrmTab && (view === "board" || view === "list");

  // The nav label only becomes "CRM" once the module is on. A box that never
  // enables it keeps the surface it bought.
  const shellLabel = crmEnabled ? "CRM" : "Projects";

  const headerTitle = onCrmTab
    ? crmTab === "customers"
      ? "Customers"
      : "Deals"
    : view === "index"
      ? "Projects"
      : project?.name ?? "Projects";
  const headerSub = onCrmTab
    ? undefined
    : view === "index"
      ? `${summary?.activeProjects ?? projects?.filter((p) => !p.archived).length ?? 0} projects · ${summary?.itemsOpen ?? 0} items open`
      : project
        ? `${project.openCount} open · ${project.doneCount} done`
        : undefined;

  const actions = onCrmTab ? (
    // The CRM's own create actions live beside the content they create, where
    // the stage/column context that decides where a deal lands is visible.
    <Link className="btn" href="/chat">
      <PmIcon name="msg" size={14} /> Ask AI about your customers
    </Link>
  ) : view === "index" ? (
      <>
        {!readOnly && (
          <button className="btn primary" type="button" onClick={() => setModal("newproject")}>
            <FolderKanban size={14} /> New project
          </button>
        )}
        <button className="btn" type="button" onClick={refreshAll} aria-label="Refresh">
          <PmIcon name="refresh" size={15} />
        </button>
      </>
    ) : (
      <>
        <Link className="btn" href="/chat">
          <PmIcon name="msg" size={14} /> Ask AI about this project
        </Link>
        {!readOnly && project && (
          <button className="btn primary" type="button" onClick={() => setModal("newitem")}>
            <PmIcon name="plus" size={14} /> New item
          </button>
        )}
        <button className="btn" type="button" onClick={refreshAll} aria-label="Refresh">
          <PmIcon name="refresh" size={15} />
        </button>
      </>
    );

  return (
    <PeopleContext.Provider value={person}>
      <ShellPage icon={<FolderKanban size={15} />} label={shellLabel} title={headerTitle} sub={headerSub} actions={actions}>
        <div className="pm-scope">
          <div className="pm-page">
            {crmEnabled && (
              <div style={{ marginBottom: 14 }}>
                <CrmTabs
                  tab={crmTab}
                  onTab={(t) => {
                    setCrmTab(t);
                    // Returning to Projects lands on the index, not on whatever
                    // project was open three tab-switches ago.
                    if (t === "projects") backToIndex();
                  }}
                />
              </div>
            )}

            {!onCrmTab && view !== "index" && (
              <button className="pm-btn ghost sm" type="button" onClick={backToIndex} style={{ alignSelf: "flex-start", marginBottom: 14 }}>
                <PmIcon name="chevL" size={14} /> All projects
              </button>
            )}

            {isProjectView && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 14 }}>
                <div className="pm-row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <ViewSwitcher view={view} onView={(v) => setView(v)} />
                  <FilterBar q={q} onQ={setQ} />
                </div>
                <SavedViews active={savedView} onPick={setSavedView} counts={counts} />
              </div>
            )}
            {!onCrmTab && (view === "cycles" || view === "modules") && (
              <div style={{ marginBottom: 14 }}>
                <ViewSwitcher view={view} onView={(v) => setView(v)} />
              </div>
            )}

            <div style={{ flex: 1, minHeight: 0 }}>
              {onCrmTab && (
                <CrmSurface tab={crmTab === "customers" ? "customers" : "deals"} readOnly={readOnly} />
              )}
              {!onCrmTab && view === "index" && (
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
              {!onCrmTab && view === "board" && (
                <BoardView
                  states={states ?? []}
                  items={filtered}
                  domain={boardDomain}
                  readOnly={readOnly}
                  onOpen={setDrawer}
                  onTransition={onTransition}
                  onNewItem={() => setModal("newitem")}
                />
              )}
              {!onCrmTab && view === "list" && (
                <ListView states={states ?? []} items={filtered} domain={boardDomain} onOpen={setDrawer} />
              )}
              {!onCrmTab && view === "cycles" && <PlaceholderView kind="cycles" />}
              {!onCrmTab && view === "modules" && <PlaceholderView kind="modules" />}
            </div>
          </div>
        </div>
      </ShellPage>

      {drawer && (
        <DetailDrawer
          item={drawer}
          onClose={() => setDrawer(null)}
          onChanged={async () => {
            const fresh = await mutateItems();
            void mutateProjects();
            void mutateSummary();
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
    </PeopleContext.Provider>
  );
}
