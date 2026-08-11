"use client";

/**
 * WARP-1270 (T18) — Surface B: the "Departments & teams" tab on /users.
 *
 * Design contract: TEAMS-DEPARTMENTS-FILES-ARCHITECTURE-BRIEF.md §3/§6 +
 * the departments design packet (shared_brain content/brand/handoffs/
 * departments/{DESIGN-BRIEF.md,prototype/dept.css,prototype/dept-data.jsx}).
 * Ported class-by-class onto the existing droplet-shell idiom this page
 * already uses (.card/.lrow/.badge/.meter/.chip/.ava/.dl — see
 * components/shell/droplet-shell.css) rather than the prototype's raw
 * dept.css, per the handoff's own instruction to match the app's styling,
 * not copy the reference file.
 *
 * Rights are neutral, text-first chips (`.chip`, never `--role-*` — brief
 * §1/§3, punch-list D-A..F). State chips DO use the system status ramp via
 * `.badge`. Quota meter bands: green <80%, orange 80–95%, red >95%.
 *
 * Authorization mirrors the backend exactly, so no dead affordances render:
 *   - Create department/team, archive/restore: owner/admin only
 *     (routes/departments.ts `requireRole("owner","admin")`).
 *   - Add member / change rights / remove member: owner/admin OR a
 *     `manager` of THIS unit (`departmentManagerOrAdmin` — the
 *     inherited-manager rule covers a parent department's manager on its
 *     child teams).
 *   - The unit list itself is already server-scoped (GET /api/departments):
 *     owner/admin get everything incl. archived; everyone else gets only
 *     units they hold a membership row in — the manager-delegation view
 *     falls out of that for free, no extra client-side filtering needed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Building2,
  Eye,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  UserPlus,
  Users as UsersIcon,
  type LucideIcon,
} from "lucide-react";
import type { Department, DepartmentDetail, DepartmentRight, RosterUser } from "@/lib/types";
import { CreateLibraryDialog } from "./CreateLibraryDialog";
import { formatStorageBytes } from "@/lib/storage-units";
import {
  listDepartments,
  getDepartment,
  archiveDepartment,
  restoreDepartment,
  addDepartmentMember,
  updateDepartmentMemberRight,
  removeDepartmentMember,
} from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { orgUnitDisplayName } from "@/lib/org-unit-name";
import { Badge, Meter, type BadgeKind } from "@/components/shell/primitives";

const RIGHTS: DepartmentRight[] = ["reader", "contributor", "manager"];
const RIGHT_LABEL: Record<DepartmentRight, string> = {
  reader: "Reader",
  contributor: "Contributor",
  manager: "Manager",
};
const RIGHT_ICON: Record<DepartmentRight, LucideIcon> = {
  reader: Eye,
  contributor: Pencil,
  manager: KeyRound,
};

/**
 * WARP-1808 — display-only name for a unit. The server seeds the HOUSEHOLD
 * unit's name as "Household" (a data contract — ids drive selection/lookup and
 * the name feeds nothing structural here), but the build is business-only, so
 * the RENDERED name is always "Workspace". Keyed off `kind`, never the name
 * string, and used at render sites only. WARP-1809 moved the mapping to the
 * shared `orgUnitDisplayName` (the People-page access drawer renders the same
 * rule on deptRights chips); this wrapper just adapts a Department row.
 */
function deptDisplayName(d: Department): string {
  return orgUnitDisplayName(d.kind, d.name);
}

/** Verbatim copy (design brief §2–§5) — ships as-is. */
const COPY = {
  emptyDepts:
    "No departments yet — create the first one to give a group of people their own file library.",
  removeConfirm: (name: string, lib: string) =>
    `Remove ${name} from ${lib}? They lose access to these files immediately.`,
  householdTip: "Workspace-wide access follows each person's role for now.",
  archiveBody: "Files stay stored and admins can still retrieve them. Members lose access now.",
  restoreBody: "Members regain access with the rights they had before it was archived.",
  syncingShort: "Syncing…",
  retrying: "Retrying",
  noLimit: "No limit",
  // WARP-1507: shown under a department stuck in "Needs attention" so the
  // user knows it self-heals once the underlying cause is fixed (the
  // orchestrator's reconciler re-attempts every ~5 min).
  setupUnfinished: "Setup didn't finish.",
  setupUnfinishedPrefix: "Setup didn't finish:",
  failedRetryNote: "The box retries automatically every few minutes, so this usually clears once the cause is fixed.",
};

/** Bytes-decimal-string → a short human size ("13.2 GB"). Never fabricates a
 *  value on bad input — falls back to an em dash. WARP-1561: this and the
 *  quota encoder below are now the dashboard-wide implementations from
 *  `@/lib/storage-units`; the local copies disagreed with the roles surface
 *  on both the display rounding and the byte fidelity of the editor pair.
 *  Used/consumed bytes are a fact when zero, so 0 renders "0 B" here. */
const formatBytes = (value: string | null | undefined): string =>
  formatStorageBytes(value, { zero: "0 B" });

/** Quota band per the design brief: green <80%, orange 80–95%, red >95%. */
function quotaBand(usedBytes: string | null, quotaBytes: string | null): "" | "ok" | "warn" | "danger" {
  if (quotaBytes == null) return "";
  const used = Number(usedBytes ?? 0);
  const quota = Number(quotaBytes);
  if (!Number.isFinite(used) || !Number.isFinite(quota) || quota <= 0) return "";
  const pct = (used / quota) * 100;
  if (pct > 95) return "danger";
  if (pct >= 80) return "warn";
  return "ok";
}

function StateChip({ state }: { state: Department["state"] }) {
  const map: Record<Department["state"], { label: string; kind: BadgeKind; icon?: LucideIcon }> = {
    active: { label: "Active", kind: "ok" },
    pending: { label: "Setting up…", kind: "warn", icon: Loader2 },
    provisioning: { label: "Setting up…", kind: "warn", icon: Loader2 },
    failed: { label: "Needs attention", kind: "danger", icon: AlertTriangle },
    archiving: { label: "Archiving…", kind: "warn", icon: Loader2 },
    archived: { label: "Archived", kind: "muted", icon: Archive },
  };
  const { label, kind, icon: Icon } = map[state] ?? { label: state, kind: "muted" as BadgeKind };
  return (
    <Badge kind={kind}>
      {Icon && (
        <Icon
          size={11}
          aria-hidden="true"
          className={Icon === Loader2 ? "animate-spin motion-reduce:animate-none" : undefined}
        />
      )}
      {label}
    </Badge>
  );
}

function RightsChip({ right }: { right: DepartmentRight }) {
  const Icon = RIGHT_ICON[right];
  return (
    <span className="chip" style={{ cursor: "default", height: 26, padding: "0 10px" }}>
      <Icon size={12} aria-hidden="true" />
      {RIGHT_LABEL[right]}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return <span className="ava">{initials || "?"}</span>;
}

const fieldStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-input)",
  color: "var(--text)",
};

// Inline equivalents of the shell's `.lrow .rt .nm` / `.sub` / `.rmeta`
// text treatments (droplet-shell.css) for spots in this panel that render
// that same row-title/sub-label/meta shape OUTSIDE an actual `.lrow`
// ancestor — those class rules are descendant-scoped and wouldn't apply.
const NM_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 13.5,
  fontWeight: 500,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const SUB_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "var(--text-muted)",
  marginTop: 1,
};
const RMETA_STYLE: React.CSSProperties = {
  fontSize: 12.5,
  color: "var(--text-muted)",
};


export interface DepartmentsPanelProps {
  /** Roster used to populate the "add member" picker — passed down so this
   *  panel doesn't duplicate the /users page's own fetchUsers() call. */
  people: RosterUser[];
  /** True for owner/admin — gates create/archive/restore affordances that
   *  the backend also gates to `requireRole("owner","admin")`. */
  isAdminTier: boolean;
}

export function DepartmentsPanel({ people, isAdminTier }: DepartmentsPanelProps) {
  const { toast } = useToast();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DepartmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);

  const [addMemberUserId, setAddMemberUserId] = useState("");
  const [addMemberRight, setAddMemberRight] = useState<DepartmentRight>("contributor");
  const [addMemberBusy, setAddMemberBusy] = useState(false);

  const [removeTarget, setRemoveTarget] = useState<{ userId: string; displayName: string } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Department | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<Department | null>(null);

  // ── Create department / team modal state ──
  const [createOpen, setCreateOpen] = useState(false);
  const [createParent, setCreateParent] = useState<Department | null>(null); // null = new department
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const newDeptTriggerRef = useRef<HTMLButtonElement | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { departments: rows } = await listDepartments();
      setDepartments(rows);
    } catch (err: any) {
      setError(err?.message || "Failed to load departments");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const d = await getDepartment(id);
      setDetail(d);
    } catch (err: any) {
      setError(err?.message || "Failed to load department detail");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  // Auto-select the first manageable unit once the list loads, so the
  // detail pane isn't a dead placeholder on first render for the common
  // case (one department, or a manager scoped to exactly one team).
  useEffect(() => {
    if (!loading && !selectedId && departments.length > 0) {
      const first = departments.find((d) => d.kind !== "HOUSEHOLD") ?? departments[0];
      if (first) setSelectedId(first.id);
    }
  }, [loading, departments, selectedId]);

  const topLevelDepartments = useMemo(
    () => departments.filter((d) => d.kind === "DEPARTMENT"),
    [departments],
  );
  const teamsByParent = useMemo(() => {
    const map = new Map<string, Department[]>();
    for (const d of departments) {
      if (d.kind !== "TEAM" || !d.parentId) continue;
      if (!map.has(d.parentId)) map.set(d.parentId, []);
      map.get(d.parentId)!.push(d);
    }
    return map;
  }, [departments]);
  const household = useMemo(() => departments.find((d) => d.kind === "HOUSEHOLD") ?? null, [departments]);

  const selected = departments.find((d) => d.id === selectedId) ?? null;
  const canManage = !!selected && (isAdminTier || selected.myRight === "manager");
  // WARP-1809 defense-in-depth: display name, not the raw row name. Today
  // this only ever names a DEPARTMENT/TEAM (member removal is HOUSEHOLD-
  // gated), for which the helper is identity — but a future gate change
  // must not be able to leak the seeded unit name into the confirm copy.
  const libraryLabel = selected ? deptDisplayName(selected) : "this library";

  const availablePeople = useMemo(() => {
    const memberIds = new Set((detail?.members ?? []).map((m) => m.userId));
    return people.filter((p) => p.userId && !memberIds.has(p.userId));
  }, [people, detail]);

  // ── Create department / team ──
  function openCreateDepartment() {
    createTriggerRef.current = newDeptTriggerRef.current;
    setCreateParent(null);
    setCreateOpen(true);
  }

  function openCreateTeam(parent: Department, trigger: HTMLButtonElement | null) {
    createTriggerRef.current = trigger;
    setCreateParent(parent);
    setCreateOpen(true);
  }

  /** The dialog owns the form and the create call; what happens AFTER a
   *  successful create is this panel's own posture — reload (the server
   *  returns state=pending and a reconciler provisions the groupfolder, so
   *  never fabricate an active row), select it, say it's setting up. */
  async function handleCreated(created: Department) {
    await reload();
    setSelectedId(created.id);
    toast(`${created.name} is setting up…`, "success");
  }

  // ── Rights / membership ──
  async function handleRightChange(userId: string, right: DepartmentRight) {
    if (!selected) return;
    setSavingUserId(userId);
    try {
      await updateDepartmentMemberRight(selected.id, userId, right);
      await loadDetail(selected.id);
    } catch (err: any) {
      toast(err?.message || "Failed to update rights", "error");
    } finally {
      setSavingUserId(null);
    }
  }

  async function performRemoveMember() {
    if (!selected || !removeTarget) return;
    await removeDepartmentMember(selected.id, removeTarget.userId);
    toast(`${removeTarget.displayName} removed from ${deptDisplayName(selected)}.`, "success");
    await loadDetail(selected.id);
  }

  async function handleAddMember() {
    if (!selected || !addMemberUserId) return;
    setAddMemberBusy(true);
    try {
      await addDepartmentMember(selected.id, addMemberUserId, addMemberRight);
      setAddMemberUserId("");
      setAddMemberRight("contributor");
      await loadDetail(selected.id);
    } catch (err: any) {
      toast(err?.message || "Failed to add member", "error");
    } finally {
      setAddMemberBusy(false);
    }
  }

  // ── Archive / restore ──
  // WARP-1809: toast labels route through deptDisplayName — identity for
  // every archivable unit today (archive/restore are HOUSEHOLD-gated), but
  // a future gate change can't leak the raw seeded name.
  async function performArchive() {
    if (!archiveTarget) return;
    await archiveDepartment(archiveTarget.id);
    toast(`${deptDisplayName(archiveTarget)} archived.`, "success");
    if (selectedId === archiveTarget.id) setSelectedId(null);
    await reload();
  }

  async function performRestore() {
    if (!restoreTarget) return;
    await restoreDepartment(restoreTarget.id);
    toast(`${deptDisplayName(restoreTarget)} is being restored…`, "success");
    await reload();
  }

  if (loading && departments.length === 0) {
    return <div className="card empty">Loading departments…</div>;
  }

  if (!loading && departments.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <span className="ei">
            <Building2 size={24} />
          </span>
          <span className="eh">No departments yet</span>
          <span style={{ maxWidth: "42ch" }}>{COPY.emptyDepts}</span>
          {isAdminTier && (
            <button
              ref={newDeptTriggerRef}
              type="button"
              className="btn primary"
              onClick={openCreateDepartment}
              style={{ marginTop: 8 }}
            >
              <Plus size={14} /> New department
            </button>
          )}
        </div>
        {renderCreateDialog()}
      </div>
    );
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: "380px 1fr", alignItems: "start" }} data-testid="departments-panel">
      {/* ── Left column: department list ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="sect" style={{ marginTop: 0, justifyContent: "space-between" }}>
          <h2>Departments</h2>
          {isAdminTier && (
            <button
              ref={newDeptTriggerRef}
              type="button"
              className="btn ghost sm"
              onClick={openCreateDepartment}
              aria-label="New department"
            >
              <Plus size={13} /> New department
            </button>
          )}
        </div>

        {topLevelDepartments.map((dept) => {
          const kids = teamsByParent.get(dept.id) ?? [];
          const isOn = dept.id === selectedId;
          return (
            <div
              key={dept.id}
              className="card hover"
              style={isOn ? { borderColor: "var(--brand)", boxShadow: "0 0 0 1px var(--brand)" } : undefined}
            >
              <button
                type="button"
                onClick={() => setSelectedId(dept.id)}
                style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left" }}
                aria-pressed={isOn}
              >
                <span
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "var(--brand-subtle)",
                    color: "var(--brand)",
                  }}
                >
                  <Building2 size={17} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={NM_STYLE}>{dept.name}</span>
                  <span style={SUB_STYLE}>
                    {dept.memberCount} {dept.memberCount === 1 ? "member" : "members"}
                    {dept.teamCount > 0 ? ` · ${dept.teamCount} ${dept.teamCount === 1 ? "team" : "teams"}` : ""}
                  </span>
                </span>
                <StateChip state={dept.state} />
              </button>

              {dept.quotaBytes && (
                <div style={{ marginTop: 12 }} className="mono">
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--text-muted)", marginBottom: 5 }}>
                    <span>{formatBytes(dept.usedBytes)} of {formatBytes(dept.quotaBytes)}</span>
                  </div>
                  <Meter
                    pct={dept.usedBytes ? Math.min(100, (Number(dept.usedBytes) / Number(dept.quotaBytes)) * 100) : 0}
                    kind={quotaBand(dept.usedBytes, dept.quotaBytes)}
                  />
                </div>
              )}

              {(kids.length > 0 || (isAdminTier && dept.state === "active")) && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--card-bd)" }}>
                  {kids.map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      onClick={() => setSelectedId(team.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: "100%",
                        padding: "7px 8px",
                        borderRadius: 8,
                        fontSize: 13.5,
                        textAlign: "left",
                        color: team.id === selectedId ? "var(--brand)" : "var(--text)",
                        fontWeight: team.id === selectedId ? 600 : 400,
                        background: team.id === selectedId ? "var(--brand-subtle)" : "transparent",
                      }}
                    >
                      <UsersIcon size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {team.name}
                      </span>
                      {team.state !== "active" && <StateChip state={team.state} />}
                    </button>
                  ))}
                  {isAdminTier && dept.state === "active" && (
                    <button
                      type="button"
                      onClick={(e) => openCreateTeam(dept, e.currentTarget)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "7px 8px",
                        borderRadius: 8,
                        fontSize: 13,
                        color: "var(--brand)",
                        fontWeight: 500,
                      }}
                    >
                      <Plus size={13} /> New team
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {household && (
          <>
            <div className="sect">
              <h2>System</h2>
            </div>
            <div className="card" data-testid="workspace-card">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "var(--inset)",
                    color: "var(--text-muted)",
                  }}
                >
                  <Building2 size={17} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={NM_STYLE}>{deptDisplayName(household)}</span>
                  <span style={SUB_STYLE}>
                    {household.memberCount} {household.memberCount === 1 ? "member" : "members"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedId(household.id)}
                  className="btn ghost sm"
                >
                  View
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Right column: detail pane ── */}
      <div className="card" style={{ minHeight: 420, padding: "22px 24px" }}>
        {!selected ? (
          <div className="empty">
            <span className="ei">
              <Building2 size={24} />
            </span>
            <span className="eh">Select a department or team</span>
          </div>
        ) : detailLoading && !detail ? (
          <div className="empty">Loading…</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14, paddingBottom: 18, borderBottom: "1px solid var(--card-bd)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "0.35px" }}>{deptDisplayName(selected)}</h2>
                  <span className="chip" style={{ cursor: "default", fontWeight: 500, color: "var(--text)" }}>
                    {selected.kind === "TEAM" ? "Team" : selected.kind === "HOUSEHOLD" ? "System" : "Department"}
                  </span>
                  <StateChip state={selected.state} />
                  {selected.myRight && <RightsChip right={selected.myRight} />}
                </div>
                {selected.quotaBytes ? (
                  <div style={{ marginTop: 14, maxWidth: 340 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-muted)", marginBottom: 5 }}>
                      <span>{formatBytes(detail?.usedBytes ?? null)} of {formatBytes(selected.quotaBytes)}</span>
                    </div>
                    <Meter
                      pct={
                        detail?.usedBytes
                          ? Math.min(100, (Number(detail.usedBytes) / Number(selected.quotaBytes)) * 100)
                          : 0
                      }
                      kind={quotaBand(detail?.usedBytes ?? null, selected.quotaBytes)}
                    />
                  </div>
                ) : (
                  <div className="mono" style={{ ...SUB_STYLE, marginTop: 14 }}>
                    {formatBytes(detail?.usedBytes ?? null)} used · {COPY.noLimit}
                  </div>
                )}
              </div>

              {isAdminTier && selected.kind !== "HOUSEHOLD" && (
                <div style={{ display: "flex", gap: 6 }}>
                  {selected.state === "archived" ? (
                    <button type="button" className="btn ghost sm" onClick={() => setRestoreTarget(selected)}>
                      <RotateCcw size={13} /> Restore
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setArchiveTarget(selected)}
                    >
                      <Archive size={13} /> Archive
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* WARP-1507: explain the "Needs attention" state — the failure
                reason the schema stored, plus the reassurance that the box
                keeps retrying on its own. Calm, muted treatment; the red
                "Needs attention" chip already carries the signal. */}
            {selected.state === "failed" && (
              <div
                role="status"
                style={{
                  display: "flex",
                  gap: 9,
                  alignItems: "flex-start",
                  margin: "16px 0 0",
                  padding: "11px 13px",
                  borderRadius: "var(--radius-input)",
                  background: "var(--inset)",
                  border: "1px solid var(--card-bd)",
                }}
              >
                <AlertTriangle
                  size={14}
                  aria-hidden="true"
                  style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 2 }}
                />
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--text)" }}>
                    {selected.provisionError ? (
                      <>
                        {COPY.setupUnfinishedPrefix}{" "}
                        <span
                          style={{
                            // `.mono` is descendant-scoped to .lrow/.dl dd in
                            // droplet-shell.css and wouldn't apply here (see the
                            // NM_STYLE note above / line 695) — set the mono
                            // family inline so the error actually renders mono.
                            fontFamily: "var(--font-mono)",
                            color: "var(--text-muted)",
                            wordBreak: "break-word",
                          }}
                        >
                          {selected.provisionError}
                        </span>
                      </>
                    ) : (
                      COPY.setupUnfinished
                    )}
                  </p>
                  <p style={{ margin: "5px 0 0", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted)" }}>
                    {COPY.failedRetryNote}
                  </p>
                </div>
              </div>
            )}

            {/* Member table */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "22px 0 10px" }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Members</h3>
              <span className="mono" style={RMETA_STYLE}>{detail?.members.length ?? 0}</span>
            </div>

            {selected.kind === "HOUSEHOLD" && (
              <p style={{ ...SUB_STYLE, marginBottom: 10 }}>{COPY.householdTip}</p>
            )}

            <div className="rows">
              {(detail?.members ?? []).map((m) => {
                const saving = savingUserId === m.userId;
                const disabled = selected.kind === "HOUSEHOLD" || !canManage || saving;
                return (
                  <div key={m.userId} className="lrow">
                    <Avatar name={m.displayName} />
                    <span className="rt">
                      <span className="nm">{m.displayName}</span>
                    </span>
                    {(saving || m.syncState === "pending") && (
                      <span className="rmeta" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        {COPY.syncingShort}
                      </span>
                    )}
                    {!saving && m.syncState === "failed" && (
                      // WARP-1507: surface the member's syncError. The `title`
                      // covers mouse hover, but a title on a non-focusable span
                      // is unreachable by keyboard/touch (WCAG 2.1.1) and, when
                      // the department itself stays "active", this is the SOLE
                      // disclosure path — so also render the reason as visually
                      // -hidden text in the accessible DOM. The box re-attempts
                      // this sync automatically (see the department notice above).
                      <span
                        className="rmeta"
                        title={m.syncError ?? undefined}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          color: "var(--brand)",
                          cursor: m.syncError ? "help" : undefined,
                        }}
                      >
                        <AlertTriangle size={12} aria-hidden="true" />
                        {COPY.retrying}
                        {m.syncError && <span className="sr-only">{m.syncError}</span>}
                      </span>
                    )}
                    <select
                      aria-label={`Rights for ${m.displayName}`}
                      value={m.right}
                      disabled={disabled}
                      onChange={(e) => handleRightChange(m.userId, e.target.value as DepartmentRight)}
                      className="outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
                      style={{ ...fieldStyle, width: "auto", height: 32, padding: "0 10px" }}
                    >
                      {RIGHTS.map((r) => (
                        <option key={r} value={r}>
                          {RIGHT_LABEL[r]}
                        </option>
                      ))}
                    </select>
                    {canManage && selected.kind !== "HOUSEHOLD" && (
                      <button
                        type="button"
                        onClick={() => setRemoveTarget({ userId: m.userId, displayName: m.displayName })}
                        aria-label={`Remove ${m.displayName} from ${deptDisplayName(selected)}`}
                        className="p-2.5 rounded-sm text-[var(--text-faint)] hover:text-[#ef4444] hover:bg-[rgba(239,68,68,0.1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
              {(detail?.members ?? []).length === 0 && (
                <div className="empty" style={{ padding: "24px 16px" }}>No members yet.</div>
              )}
            </div>

            {canManage && selected.kind !== "HOUSEHOLD" && availablePeople.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--card-bd)" }}>
                <select
                  aria-label="Person to add"
                  value={addMemberUserId}
                  onChange={(e) => setAddMemberUserId(e.target.value)}
                  className="outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
                  style={{ ...fieldStyle, flex: 1, height: 34, padding: "0 10px" }}
                >
                  <option value="">Add a person…</option>
                  {availablePeople.map((p) => (
                    <option key={p.userId!} value={p.userId!}>
                      {p.displayName || p.id}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Rights for new member"
                  value={addMemberRight}
                  onChange={(e) => setAddMemberRight(e.target.value as DepartmentRight)}
                  className="outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
                  style={{ ...fieldStyle, width: "auto", height: 34, padding: "0 10px" }}
                >
                  {RIGHTS.map((r) => (
                    <option key={r} value={r}>
                      {RIGHT_LABEL[r]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={handleAddMember}
                  disabled={!addMemberUserId || addMemberBusy}
                >
                  <UserPlus size={13} /> Add
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {renderCreateDialog()}

      <ConfirmDialog
        open={removeTarget !== null}
        onConfirm={performRemoveMember}
        onCancel={() => setRemoveTarget(null)}
        title="Remove member?"
        description={removeTarget ? COPY.removeConfirm(removeTarget.displayName, libraryLabel) : ""}
        confirmLabel="Remove"
        variant="destructive"
      />

      <ConfirmDialog
        open={archiveTarget !== null}
        onConfirm={performArchive}
        onCancel={() => setArchiveTarget(null)}
        title={archiveTarget ? `Archive ${deptDisplayName(archiveTarget)}?` : "Archive department?"}
        description={COPY.archiveBody}
        confirmLabel="Archive"
        variant="destructive"
      />

      <ConfirmDialog
        open={restoreTarget !== null}
        onConfirm={performRestore}
        onCancel={() => setRestoreTarget(null)}
        title={restoreTarget ? `Restore ${deptDisplayName(restoreTarget)}?` : "Restore department?"}
        description={COPY.restoreBody}
        confirmLabel="Restore"
        variant="neutral"
      />
    </div>
  );

  function renderCreateDialog() {
    return (
      <CreateLibraryDialog
        open={createOpen}
        parent={createParent}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
        triggerRef={createTriggerRef}
      />
    );
  }
}
