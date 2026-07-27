"use client";

/**
 * WARP-1532 (RBAC v2 T8) — Surface A: the "Roles & access" tab on /users.
 *
 * Two panes (§4): a left column of custom-role cards above the read-mostly
 * built-in five, and a right detail pane summarising the selected role's
 * four axes, its people, and the create / duplicate / archive / delete
 * affordances. Every list names its own §10 state trio — loading skeletons,
 * the §4.1 empty card, and the error card with Retry — so a down
 * orchestrator never looks like a brand-new box. Contract-driven: against a
 * live box this panel renders its error state until the T3 routes merge;
 * that is expected and correct.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ChevronRight,
  Cloud,
  Cpu,
  Gauge,
  KeyRound,
  Lock,
  MoreHorizontal,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  User,
  UserPlus,
  X,
} from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import {
  assignAccessRole,
  createAccessRole,
  updateAccessRole,
  archiveAccessRole,
  restoreAccessRole,
  deleteAccessRole,
  duplicateAccessRole,
  listAccessRoles,
} from "@/lib/api";
import type {
  AccessRole,
  AccessRolePayload,
  AccessSyncState,
  AccessTier,
  RosterUser,
} from "@/lib/types";
import {
  ACCESS_FEATURES,
  TIER_RANK,
  blankRoleDraft,
  featureDef,
  formatStorageBytes,
  roleToDraft,
  tierLabel,
  type RoleDraft,
} from "@/lib/access";
import { ACCESS_COPY } from "./copy";
import { AccessChip, GuardNote, SyncChip } from "./bits";
import { RoleBuilderSheet, type ConnectorOption } from "./RoleBuilderSheet";
import "./access.css";

type ListState = "loading" | "ready" | "error";

interface BuiltinDef {
  id: AccessTier;
  icon: typeof KeyRound;
  meta: string;
  lock?: boolean;
}

const BUILTINS: BuiltinDef[] = [
  { id: "owner", icon: KeyRound, meta: ACCESS_COPY.ownerRowMeta, lock: true },
  { id: "admin", icon: ShieldCheck, meta: ACCESS_COPY.adminMeta },
  { id: "family", icon: User, meta: ACCESS_COPY.staffMeta },
  { id: "guest", icon: User, meta: ACCESS_COPY.guestMeta },
  { id: "service", icon: Cpu, meta: ACCESS_COPY.serviceMeta },
];

/** What the panel can locally know about a role's sync: the server's own
 *  states, plus the client-only `applied` — the terminal-success beat §10
 *  requires ("Applying… → Applied"). */
type ChipSyncState = AccessSyncState | "applied";

/** How long `Applied` stays up before fading. Long enough to be seen and
 *  announced, short enough that a roster of roles doesn't accumulate green
 *  confetti. */
const APPLIED_LINGER_MS = 4000;

/** Ties the disabled Assign-people button to the note that explains it —
 *  only ever one role detail on screen, so a constant id is safe. */
const ARCHIVED_REASON_ID = "access-archived-reason";

/** A row that is merely AT REST in `synced` shows nothing — §12 reserves the
 *  chip for work in flight, work that just landed, or work that needs a human;
 *  a green tick on every card at page load would be noise, not information.
 *  `applied` is different: it is only ever set from a mutation THIS client just
 *  performed, so it reports something the viewer actually did. */
function chipState(state: ChipSyncState | undefined): ChipSyncState | null {
  return state === undefined || state === "synced" ? null : state;
}

function initials(name: string): string {
  return (
    name
      .split(" ")
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

/** Track the browser's own connectivity signal for the §10 offline banner —
 *  access data is local, so the panel keeps reading; only the apply waits. */
function useOffline(): boolean {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    setOffline(typeof navigator !== "undefined" && !navigator.onLine);
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return offline;
}

export interface RolesAccessPanelProps {
  /** Roster from the page — powers people-with-this-role + assignment. */
  people: RosterUser[];
  /** Acting admin's tier (owner|admin) — rank caps in the builder. */
  actingTier: AccessTier;
  /** Configured connectors for the builder's off-box axis. */
  connectors: ConnectorOption[];
  /** "Change role →" hands the person to the page-level person editor. */
  onOpenPerson: (person: RosterUser) => void;
  /** Files deep-link inside the builder → the Departments & teams tab. */
  onOpenDepartments: () => void;
}

export function RolesAccessPanel({
  people,
  actingTier,
  connectors,
  onOpenPerson,
  onOpenDepartments,
}: RolesAccessPanelProps) {
  const { toast } = useToast();
  const offline = useOffline();
  const [roles, setRoles] = useState<AccessRole[]>([]);
  const [listState, setListState] = useState<ListState>("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [builder, setBuilder] = useState<{ mode: "create" | "edit"; base: RoleDraft } | null>(null);
  const [builderBusy, setBuilderBusy] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignChecked, setAssignChecked] = useState<Set<string>>(new Set());
  const [assignBusy, setAssignBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AccessRole | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<AccessRole | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<AccessRole | null>(null);
  // WARP-1576 — what the LAST save of this role left behind. Clearing a
  // role's storage default is the one usage edit that pushes nothing (a
  // cleared default means "unmanaged", never "unlimited"), so the members
  // who had no quota of their own quietly stay on whatever Nextcloud already
  // enforces. The server counts them; without this the operator gets silence
  // where a consequence happened. Held rather than toasted because it stays
  // TRUE until someone edits those people — a 4-second toast would be the
  // wrong lifetime for a fact about other people's storage.
  const [retainedQuota, setRetainedQuota] = useState<{ roleId: string; count: number } | null>(
    null,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // §8 delete-in-use escape hatch: "Reassign people →" moves focus to the
  // people-with-this-role list (the cheapest honest recovery path — the
  // Change-role affordances live right there).
  const peopleListRef = useRef<HTMLDivElement | null>(null);
  // A refetch scheduled after a pending mutation so the sync chip converges
  // on server truth without polling forever.
  const refetchTimer = useRef<number | null>(null);
  // WARP-1528 — the sync states we learned from MUTATION responses, keyed by
  // role id. The API returns `syncState` as a SIBLING of `role`
  // (`{ role, syncState }` — which is exactly what lib/api.ts types), and the
  // server's role serializer never puts it inside the row. Reading
  // `role.syncState` therefore always saw `undefined` and the §10 "Applying…"
  // chip could never appear on a real box. The sibling is captured here; the
  // row's own field stays the fallback so a future orchestrator that does
  // emit it on reads works without another change.
  const [syncStates, setSyncStates] = useState<Record<string, ChipSyncState>>({});
  // Retires an `applied` chip after its linger. Separate from the refetch
  // timer: they run back to back, not instead of each other.
  const appliedTimer = useRef<number | null>(null);

  const clearApplied = useCallback((roleId: string) => {
    if (appliedTimer.current != null) window.clearTimeout(appliedTimer.current);
    appliedTimer.current = window.setTimeout(() => {
      setSyncStates((prev) => {
        if (prev[roleId] !== "applied") return prev;
        const next = { ...prev };
        delete next[roleId];
        return next;
      });
    }, APPLIED_LINGER_MS);
  }, []);

  const noteSyncState = useCallback(
    (roleId: string, state: AccessSyncState | undefined) => {
      if (!state) return;
      // A mutation that comes back already `synced` skipped the cascade
      // entirely — there is nothing to wait for, so it lands straight on the
      // terminal beat rather than showing a "pending" that was never true.
      const resolved: ChipSyncState = state === "synced" ? "applied" : state;
      setSyncStates((prev) => ({ ...prev, [roleId]: resolved }));
      if (resolved === "applied") clearApplied(roleId);
    },
    [clearApplied],
  );

  // WARP-1560: archived rows are KEPT and grouped, not dropped. The server
  // has always returned them carrying their `state` for exactly this reason
  // (effective-access.service.ts — archive stops a role being assignable,
  // it never strips access from the people holding it), and filtering them
  // out client-side is what made archive a one-way door.
  const reload = useCallback(async (background = false) => {
    if (!background) setListState((s) => (s === "ready" ? s : "loading"));
    try {
      const { roles: rows } = await listAccessRoles();
      setRoles(rows);
      setListState("ready");
    } catch {
      if (!background) setListState("error");
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      if (refetchTimer.current != null) window.clearTimeout(refetchTimer.current);
      if (appliedTimer.current != null) window.clearTimeout(appliedTimer.current);
    };
  }, [reload]);

  /** One delayed background refetch — lets a "pending" syncState converge
   *  without a poll loop, then reports the landing.
   *
   *  On success the chip goes to `applied`, not away. A chip that simply
   *  VANISHES is indistinguishable from a chip that never appeared — which is
   *  precisely the bug this panel just had — so disappearance can't be the
   *  success signal. What the client legitimately knows at this point is
   *  narrow but real: its own write returned 2xx AND the subsequent re-read
   *  succeeded. That is what `Applied` claims, and no more. `failed` is never
   *  auto-cleared; that one needs a human. */
  const scheduleSyncRefetch = useCallback(
    (roleId: string | null) => {
      if (refetchTimer.current != null) window.clearTimeout(refetchTimer.current);
      refetchTimer.current = window.setTimeout(() => {
        void reload(true).then(() => {
          if (!roleId) return;
          setSyncStates((prev) => {
            if (prev[roleId] !== "pending") return prev;
            return { ...prev, [roleId]: "applied" };
          });
          clearApplied(roleId);
        });
      }, 1500);
    },
    [reload, clearApplied],
  );

  /** The sync state to render for a role: what the mutation told us, else
   *  whatever the row itself carries. `synced` renders nothing. */
  const syncStateFor = useCallback(
    (r: AccessRole): ChipSyncState | undefined => syncStates[r.id] ?? r.syncState,
    [syncStates],
  );

  const activeRoles = useMemo(() => roles.filter((r) => r.state !== "archived"), [roles]);
  const archivedRoles = useMemo(() => roles.filter((r) => r.state === "archived"), [roles]);

  // Auto-select the first custom role once loaded so the detail pane isn't
  // a dead placeholder (Departments precedent). An ACTIVE role always wins:
  // landing on an archived one would open the surface on a role nobody can
  // be assigned to.
  useEffect(() => {
    if (listState !== "ready" || selectedId) return;
    const first = activeRoles[0] ?? archivedRoles[0];
    if (first) setSelectedId(first.id);
  }, [listState, activeRoles, archivedRoles, selectedId]);

  // Close the overflow menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const selectedRole = roles.find((r) => r.id === selectedId) ?? null;
  const selectedBuiltin = BUILTINS.find((b) => b.id === selectedId) ?? null;

  const peopleWithRole = useMemo(
    () => (selectedRole ? people.filter((p) => p.accessRoleId === selectedRole.id) : []),
    [people, selectedRole],
  );

  /** Assignment candidates: local rows only, never the owner or a service
   *  principal (§8 owner untouchable; service not assignable), and not the
   *  people who already hold the role. FAIL CLOSED (QA send-back 4): a row
   *  whose tier is unknown (roster extension not merged yet) is excluded —
   *  an unknown row could be the owner, so it is never offered. */
  const assignCandidates = useMemo(
    () =>
      people.filter(
        (p) =>
          p.userId &&
          (p.role === "admin" || p.role === "family" || p.role === "guest") &&
          p.accessRoleId !== selectedRole?.id,
      ),
    [people, selectedRole],
  );
  /** True when the roster carries local rows without tier data — the §10
   *  degraded (pre-T3/T7) mode the assign dialog must explain honestly. */
  const assignDegraded = useMemo(
    () => people.some((p) => p.userId && p.role == null),
    [people],
  );

  const openCreate = () => setBuilder({ mode: "create", base: blankRoleDraft("family") });
  const openEdit = (role: AccessRole) => setBuilder({ mode: "edit", base: roleToDraft(role) });

  async function handleBuilderSave(payload: AccessRolePayload) {
    if (!builder) return;
    setBuilderBusy(true);
    try {
      let touchedId: string | null = null;
      if (builder.mode === "create") {
        const { role, syncState } = await createAccessRole(payload);
        setBuilder(null);
        await reload();
        setSelectedId(role.id);
        touchedId = role.id;
        noteSyncState(role.id, syncState);
      } else if (builder.base.id) {
        const roleId = builder.base.id;
        const { syncState, retainedQuotaCount } = await updateAccessRole(roleId, payload);
        setBuilder(null);
        await reload();
        touchedId = roleId;
        noteSyncState(roleId, syncState);
        // WARP-1576 — the field only comes back on a CLEAR, and a count of
        // zero is a real answer ("nobody was left behind"), not something to
        // announce. Every other save retires whatever the previous one said,
        // so the line can never outlive the edit it describes.
        setRetainedQuota(
          retainedQuotaCount && retainedQuotaCount > 0
            ? { roleId, count: retainedQuotaCount }
            : null,
        );
      }
      toast(`'${payload.name}' saved — applying now.`, "success");
      scheduleSyncRefetch(touchedId);
    } catch (err: any) {
      toast(err?.message || "Failed to save the role", "error");
    } finally {
      setBuilderBusy(false);
    }
  }

  async function handleDuplicate(role: AccessRole) {
    try {
      const { role: copy } = await duplicateAccessRole(role.id);
      await reload();
      setSelectedId(copy.id);
      toast(`'${role.name}' duplicated — edit the copy.`, "success");
    } catch (err: any) {
      toast(err?.message || "Failed to duplicate the role", "error");
    }
  }

  async function performArchive() {
    if (!archiveTarget) return;
    try {
      await archiveAccessRole(archiveTarget.id);
    } catch (err: any) {
      // §10: never a silent failure — surface it and keep the confirm open
      // (ConfirmDialog leaves the dialog up on a rejected onConfirm).
      toast(err?.message || "Failed to archive the role", "error");
      throw err;
    }
    // The role stays selected: it is still on screen, now under Archived,
    // and the operator's next move is often Restore or Delete. Dropping the
    // selection here would empty the detail pane for no reason.
    await reload();
    toast(`'${archiveTarget.name}' archived.`, "success");
  }

  /** WARP-1560 — archive's way back. The PATCH answers `pending` when the
   *  role carries a storage default its members are inheriting again, so
   *  the §10 chip reports a wait that is really happening. */
  async function performRestore() {
    if (!restoreTarget) return;
    const { id, name } = restoreTarget;
    try {
      const { syncState } = await restoreAccessRole(id);
      noteSyncState(id, syncState);
    } catch (err: any) {
      toast(err?.message || "Failed to restore the role", "error");
      throw err;
    }
    await reload();
    toast(`'${name}' restored.`, "success");
    scheduleSyncRefetch(id);
  }

  /** WARP-1576 asked whether the delete confirm should carry
   *  `retainedQuotaCount` too. It cannot: DELETE is refused (409) while ANY
   *  member or pending invite references the role, so a delete that succeeds
   *  had nobody to leave on a retained quota. The disclosure belongs to the
   *  clear-the-default path alone. */
  async function performDelete() {
    if (!deleteTarget) return;
    try {
      await deleteAccessRole(deleteTarget.id);
    } catch (err: any) {
      toast(err?.message || "Failed to delete the role", "error");
      throw err;
    }
    if (selectedId === deleteTarget.id) setSelectedId(null);
    await reload();
    toast(`'${deleteTarget.name}' deleted.`, "success");
  }

  async function performAssign() {
    if (!selectedRole || assignChecked.size === 0) return;
    setAssignBusy(true);
    const assignedRoleId = selectedRole.id;
    try {
      const { syncState } = await assignAccessRole(assignedRoleId, Array.from(assignChecked));
      noteSyncState(assignedRoleId, syncState);
      setAssignOpen(false);
      setAssignChecked(new Set());
      const first = people.find((p) => p.userId && assignChecked.has(p.userId));
      const firstName = (first?.displayName || first?.id || "").split(" ")[0] ?? "";
      toast(
        assignChecked.size === 1 && firstName
          ? ACCESS_COPY.sessionRevoke(firstName)
          : "Assignment applies immediately — people are signed out to re-authenticate.",
        "success",
      );
      await reload(true);
      scheduleSyncRefetch(assignedRoleId);
    } catch (err: any) {
      toast(err?.message || "Failed to assign the role", "error");
    } finally {
      setAssignBusy(false);
    }
  }

  // ── Left pane ──
  function renderRolesList() {
    if (listState === "loading") {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="acc-skel" data-testid="access-roles-skeleton" />
          ))}
        </div>
      );
    }
    if (listState === "error") {
      return (
        <div className="card">
          <div className="empty">
            <span className="ei">
              <AlertTriangle size={24} />
            </span>
            <span className="eh">{ACCESS_COPY.rolesErrorTitle}</span>
            <span style={{ maxWidth: "36ch" }}>
              Access data is local — this is a connection issue, not lost access.
            </span>
            <button type="button" className="btn ghost sm" onClick={() => void reload()} style={{ marginTop: 8 }}>
              <RefreshCw size={13} /> {ACCESS_COPY.retry}
            </button>
          </div>
        </div>
      );
    }
    if (activeRoles.length === 0) {
      // WARP-1560: "No custom roles yet" stops being true the moment a role
      // exists but is merely filed away — say which of the two it is.
      const allArchived = archivedRoles.length > 0;
      return (
        <div className="card">
          <div className="empty">
            <span className="ei">{allArchived ? <Archive size={24} /> : <KeyRound size={24} />}</span>
            <span style={{ maxWidth: "42ch" }}>
              {allArchived ? ACCESS_COPY.emptyRolesAllArchived : ACCESS_COPY.emptyRoles}
            </span>
            <button type="button" className="btn primary" onClick={openCreate} style={{ marginTop: 8 }}>
              <Plus size={14} /> New role
            </button>
          </div>
        </div>
      );
    }
    return (
      <div
        data-testid="access-active-roles"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        {activeRoles.map((role) => renderRoleCard(role))}
      </div>
    );
  }

  function renderRoleCard(role: AccessRole) {
    const isArchived = role.state === "archived";
    return (
      <button
        key={role.id}
        type="button"
        className={`acc-rolecard${isArchived ? " archived" : ""}${selectedId === role.id ? " on" : ""}`}
        aria-pressed={selectedId === role.id}
        onClick={() => setSelectedId(role.id)}
      >
        <span className="acc-glyph">
          {isArchived ? (
            <Archive size={17} aria-hidden="true" />
          ) : (
            <KeyRound size={17} aria-hidden="true" />
          )}
        </span>
        <span className="body">
          <span className="nm">{role.name}</span>
          <span className="meta">
            <span className="mono">{role.slug}</span>·
            <span>
              {role.peopleCount === 1 ? "1 person" : `${role.peopleCount} people`} · based on{" "}
              {tierLabel(role.startingPoint)}
            </span>
            {/* State is a word, not a hue — §13 keeps the --role-* ramp out
                of this surface entirely. Default tone, NOT `muted`: muted
                resolves to --text-faint (#a6aab5 on --inset ≈ 2.1:1), which
                is fine for the absence chips it was built for ("No
                connectors") and not fine for a word carrying state. The
                card's own glyph supplies the icon half of icon-plus-word. */}
            {isArchived && <AccessChip>{ACCESS_COPY.archived}</AccessChip>}
            <SyncChip state={chipState(syncStateFor(role))} />
          </span>
        </span>
        <ChevronRight size={15} aria-hidden="true" style={{ color: "var(--text-faint)", flexShrink: 0 }} />
      </button>
    );
  }

  // ── Right pane ──

  /** Read-only catalog summary for a built-in person tier (§4.2 parity —
   *  QA send-back 5): every feature at the ceiling level the ADR-004 floor
   *  allows that tier, plus the truthful usage defaults (built-in tiers set
   *  none, so the box default applies). The off-box axis is intentionally
   *  NOT summarised here: built-ins carry no role grant — cloud/connector
   *  reach resolves from the workspace settings, and a static chip would
   *  claim something this panel cannot know. */
  function renderBuiltinAxisSummary(tier: AccessTier) {
    const chips = ACCESS_FEATURES.map((def) => {
      let ceiling = def.levels[0]!;
      for (const level of def.levels) {
        if (!level.minTier || TIER_RANK[tier] >= TIER_RANK[level.minTier]) ceiling = level;
      }
      const suffix = def.levels.length > 1 ? ` · ${ceiling.label.toLowerCase()}` : "";
      return { key: def.moduleId, label: `${def.label}${suffix}` };
    });
    return (
      <>
        <div>
          <div className="type-caption-1 mb-2" style={{ color: "var(--text-faint)", fontWeight: 600 }}>
            Features
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {chips.map((chip) => (
              <AccessChip key={chip.key}>{chip.label}</AccessChip>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
          <span className="type-caption-1" style={{ color: "var(--text-faint)", fontWeight: 600, minWidth: 78 }}>
            Usage
          </span>
          <AccessChip mono icon={<Gauge size={12} aria-hidden="true" />}>
            No limit storage
          </AccessChip>
          <AccessChip mono>Box default upload</AccessChip>
        </div>
      </>
    );
  }

  function renderAxisSummary(role: AccessRole) {
    const featureChips: Array<{ key: string; label: string }> = [];
    for (const grant of role.featureGrants) {
      const def = featureDef(grant.moduleId);
      if (!def) continue;
      const level = def.levels.find((l) => l.value === grant.level);
      const suffix = def.levels.length > 1 && level ? ` · ${level.label.toLowerCase()}` : "";
      featureChips.push({ key: grant.moduleId, label: `${def.label}${suffix}` });
    }
    return (
      <>
        <div>
          <div className="type-caption-1 mb-2" style={{ color: "var(--text-faint)", fontWeight: 600 }}>
            Features
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {featureChips.map((chip) => (
              <AccessChip key={chip.key}>{chip.label}</AccessChip>
            ))}
            {featureChips.length === 0 && <AccessChip tone="muted">No features on</AccessChip>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
          <span className="type-caption-1" style={{ color: "var(--text-faint)", fontWeight: 600, minWidth: 78 }}>
            Usage
          </span>
          <AccessChip mono icon={<Gauge size={12} aria-hidden="true" />}>
            {role.storageQuotaBytes ? formatStorageBytes(role.storageQuotaBytes) : "No limit"} storage
          </AccessChip>
          <AccessChip mono>
            {role.maxUploadSizeMb != null ? `${role.maxUploadSizeMb} MB` : "Box default"} upload
          </AccessChip>
        </div>
        {/* WARP-1576 — the consequence sits WITH the axis it belongs to, one
            line under the chips it explains, rather than in a toast whose
            lifetime is wrong for a fact about other people's storage.
            The live region is PERMANENTLY MOUNTED and only its content is
            conditional — the WARP-1528 SyncChip lesson: a screen reader only
            reliably announces mutations to a region it was already watching,
            so creating the region together with its text is a coin-flip.
            `display: contents` keeps it out of the parent's 16px column gap
            while leaving the element in the accessibility tree. */}
        <div role="status" aria-live="polite" style={{ display: "contents" }}>
          {retainedQuota?.roleId === role.id && (
            <GuardNote icon={<Gauge size={15} aria-hidden="true" />}>
              {ACCESS_COPY.retainedQuota(retainedQuota.count)}
            </GuardNote>
          )}
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
          <span className="type-caption-1" style={{ color: "var(--text-faint)", fontWeight: 600, minWidth: 78 }}>
            Off the box
          </span>
          {role.cloudModelsAllowed ? (
            <AccessChip tone="orange" icon={<Cloud size={12} aria-hidden="true" />}>
              Cloud models on
            </AccessChip>
          ) : (
            <AccessChip icon={<Cloud size={12} aria-hidden="true" />}>Cloud models off</AccessChip>
          )}
          {role.connectorGrants.length > 0 ? (
            role.connectorGrants.map((grant) => (
              <AccessChip key={grant.provider} icon={<Plug size={12} aria-hidden="true" />}>
                {grant.provider} · {grant.level === "read_write" ? "read & write" : "read"}
              </AccessChip>
            ))
          ) : (
            <AccessChip tone="muted">No connectors</AccessChip>
          )}
          {role.mayOperateLocks && (
            <AccessChip icon={<Lock size={12} aria-hidden="true" />}>May operate locks</AccessChip>
          )}
        </div>
      </>
    );
  }

  function renderDetail() {
    if (selectedBuiltin) {
      const Icon = selectedBuiltin.icon;
      return (
        <div className="card" data-testid="access-role-detail" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 18px", borderBottom: "1px solid var(--card-bd)" }}>
            <span className="acc-glyph" style={{ width: 34, height: 34, borderRadius: 9, background: "var(--inset)", color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon size={17} aria-hidden="true" />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{tierLabel(selectedBuiltin.id)}</div>
              <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 1 }}>Built-in role</div>
            </div>
            {selectedBuiltin.lock && (
              <AccessChip icon={<Lock size={12} aria-hidden="true" />}>Fixed</AccessChip>
            )}
          </div>
          <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
            {/* QA send-back 5: read-only axis summary above the notes —
                service is a system principal, not a person tier, so it
                keeps its note only. */}
            {selectedBuiltin.id !== "service" && renderBuiltinAxisSummary(selectedBuiltin.id)}
            <GuardNote icon={<ShieldCheck size={15} aria-hidden="true" />}>{ACCESS_COPY.builtinFixed}</GuardNote>
            {selectedBuiltin.id === "owner" && (
              <GuardNote icon={<Lock size={15} aria-hidden="true" />}>{ACCESS_COPY.ownerDetailNote}</GuardNote>
            )}
            {selectedBuiltin.id === "service" && (
              <GuardNote icon={<Cpu size={15} aria-hidden="true" />}>
                System identities — the box&apos;s own voice and MCP principals. Not assignable to a person.
              </GuardNote>
            )}
          </div>
        </div>
      );
    }

    if (!selectedRole) {
      return (
        <div className="card" data-testid="access-role-detail">
          <div className="empty" style={{ padding: "32px 20px" }}>
            <span className="ei">
              <KeyRound size={24} />
            </span>
            <span className="eh">Create a role to see its details here.</span>
          </div>
        </div>
      );
    }

    const inUse = selectedRole.peopleCount > 0;
    const isArchived = selectedRole.state === "archived";
    return (
      <div className="card" data-testid="access-role-detail" style={{ padding: 0, overflow: "visible" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 18px", borderBottom: "1px solid var(--card-bd)" }}>
          <span
            className="acc-glyph"
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              // An archived role drops out of the brand tint into the same
              // neutral inset the built-in rows use: filed away, still legible.
              background: isArchived ? "var(--inset)" : "var(--brand-subtle)",
              color: isArchived ? "var(--text-muted)" : "var(--brand)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {isArchived ? (
              <Archive size={17} aria-hidden="true" />
            ) : (
              <KeyRound size={17} aria-hidden="true" />
            )}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{selectedRole.name}</div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 1, fontFamily: "var(--font-mono)" }}>
              {selectedRole.slug}
            </div>
          </div>
          {isArchived && <AccessChip>{ACCESS_COPY.archived}</AccessChip>}
          <AccessChip>Based on {tierLabel(selectedRole.startingPoint)}</AccessChip>
          <SyncChip state={chipState(syncStateFor(selectedRole))} />
          <div ref={menuRef} style={{ position: "relative" }}>
            <button
              type="button"
              className="p-2 rounded-sm"
              aria-label="Role actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              style={{ color: "var(--text-muted)", border: "1px solid var(--card-bd)", borderRadius: 8 }}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <MoreHorizontal size={16} />
            </button>
            {menuOpen && (
              <div
                role="menu"
                style={{ position: "absolute", right: 0, top: 40, zIndex: 20, minWidth: 176, background: "var(--card-bg)", border: "1px solid var(--card-bd)", borderRadius: 12, boxShadow: "var(--lift)", padding: 6, display: "flex", flexDirection: "column", gap: 1 }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="btn ghost sm"
                  style={{ justifyContent: "flex-start", border: "none" }}
                  onClick={() => {
                    setMenuOpen(false);
                    void handleDuplicate(selectedRole);
                  }}
                >
                  Duplicate
                </button>
                {/* Already archived → the way back is the pane's primary
                    button, not a second copy of it buried in here. */}
                {!isArchived && (
                  <button
                    type="button"
                    role="menuitem"
                    className="btn ghost sm"
                    style={{ justifyContent: "flex-start", border: "none" }}
                    onClick={() => {
                      setMenuOpen(false);
                      setArchiveTarget(selectedRole);
                    }}
                  >
                    Archive…
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="btn ghost sm"
                  disabled={inUse}
                  title={inUse ? ACCESS_COPY.deleteRoleInUse(selectedRole.peopleCount) : undefined}
                  style={{ justifyContent: "flex-start", border: "none", color: inUse ? undefined : "var(--danger)" }}
                  onClick={() => {
                    setMenuOpen(false);
                    setDeleteTarget(selectedRole);
                  }}
                >
                  Delete…
                </button>
                {inUse && (
                  // §8: the in-use block is never a dead-end — hand the
                  // admin straight to the people who hold the role.
                  <button
                    type="button"
                    role="menuitem"
                    className="btn ghost sm"
                    style={{ justifyContent: "flex-start", border: "none", color: "var(--brand)" }}
                    onClick={() => {
                      setMenuOpen(false);
                      peopleListRef.current?.focus();
                    }}
                  >
                    {ACCESS_COPY.reassignPeopleLink}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
          {renderAxisSummary(selectedRole)}

          {/* WARP-1560 — an archived role has exactly one next step, so it
              takes the filled slot and Edit steps back to ghost. Assign is
              never removed: an affordance that silently disappears teaches
              nothing, so it stays, disabled, with its reason spelled out
              underneath (the `.acc-lvl-reason` pattern one axis over). */}
          <div style={{ display: "flex", gap: 8 }}>
            {isArchived && (
              <button
                type="button"
                className="btn primary sm"
                onClick={() => setRestoreTarget(selectedRole)}
              >
                <RotateCcw size={13} /> Restore
              </button>
            )}
            <button
              type="button"
              className={isArchived ? "btn ghost sm" : "btn primary sm"}
              onClick={() => openEdit(selectedRole)}
            >
              Edit role
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={isArchived}
              aria-describedby={isArchived ? ARCHIVED_REASON_ID : undefined}
              onClick={() => { setAssignChecked(new Set()); setAssignOpen(true); }}
            >
              <UserPlus size={13} /> Assign people
            </button>
          </div>
          {isArchived && (
            <GuardNote id={ARCHIVED_REASON_ID} icon={<Archive size={15} aria-hidden="true" />}>
              {ACCESS_COPY.archivedNotAssignable}
            </GuardNote>
          )}

          <div
            ref={peopleListRef}
            tabIndex={-1}
            data-testid="access-people-with-role"
            style={{ outline: "none" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                {ACCESS_COPY.peopleWithRole}
              </span>
              {/* Server truth for the count — the roster join is best-effort
                  until the T3/T7 roster extension merges. */}
              <AccessChip mono>{selectedRole.peopleCount}</AccessChip>
            </div>
            {peopleWithRole.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {peopleWithRole.map((p) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 4px" }}>
                    <span className="ava">{initials(p.displayName || p.id)}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.displayName || p.id}
                    </span>
                    <button type="button" className="btn ghost sm" onClick={() => onOpenPerson(p)}>
                      Change role <ChevronRight size={13} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : selectedRole.peopleCount > 0 ? (
              // The server says the role is held but the roster rows can't
              // be linked yet (no accessRoleId data pre-T3/T7) — render the
              // §12 unknown mark, never a fabricated "no one" claim.
              <div className="type-caption-1 mono" style={{ color: "var(--text-faint)", padding: "4px 2px" }}>
                {ACCESS_COPY.unknownValue}
              </div>
            ) : (
              <GuardNote icon={<User size={15} aria-hidden="true" />}>{ACCESS_COPY.emptyPeopleInRole}</GuardNote>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {offline && (
        <div className="acc-banner" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          {ACCESS_COPY.offlineBanner}
        </div>
      )}

      <div className="acc-twopane">
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <div className="sect" style={{ marginTop: 0, justifyContent: "space-between" }}>
              <h2>{ACCESS_COPY.yourRoles}</h2>
              {listState === "ready" && activeRoles.length > 0 && (
                // §4.1: the primary action of the pane is filled accent —
                // the Departments ghost sibling is a recorded divergence.
                <button type="button" className="btn primary sm" onClick={openCreate}>
                  <Plus size={13} /> New role
                </button>
              )}
            </div>
            {renderRolesList()}
          </div>
          {/* WARP-1560 — the section only exists when it has something in
              it; a permanently-empty "Archived roles" header would be one
              more thing to read on every visit for nothing. */}
          {listState === "ready" && archivedRoles.length > 0 && (
            <div>
              <div className="sect" style={{ justifyContent: "space-between" }}>
                <h2>{ACCESS_COPY.archivedRoles}</h2>
              </div>
              <div
                data-testid="access-archived-roles"
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {archivedRoles.map((role) => renderRoleCard(role))}
              </div>
            </div>
          )}
          <div>
            <div className="sect" style={{ justifyContent: "space-between" }}>
              <h2>{ACCESS_COPY.builtinRoles}</h2>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {BUILTINS.map((builtin) => {
                const Icon = builtin.icon;
                return (
                  <button
                    key={builtin.id}
                    type="button"
                    className={`acc-rolecard builtin${selectedId === builtin.id ? " on" : ""}`}
                    aria-pressed={selectedId === builtin.id}
                    onClick={() => setSelectedId(builtin.id)}
                  >
                    <span className="acc-glyph">
                      <Icon size={14} aria-hidden="true" />
                    </span>
                    <span className="body">
                      <span className="nm">{tierLabel(builtin.id)}</span>
                      <span className="meta">{builtin.meta}</span>
                    </span>
                    {builtin.lock ? (
                      <Lock size={13} aria-hidden="true" style={{ color: "var(--text-faint)", flexShrink: 0 }} />
                    ) : (
                      <ChevronRight size={14} aria-hidden="true" style={{ color: "var(--text-faint)", flexShrink: 0 }} />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div>{renderDetail()}</div>
      </div>

      {/* Role builder sheet — keyed so a fresh open resets the draft. */}
      {builder && (
        <RoleBuilderSheet
          key={`${builder.mode}-${builder.base.id ?? "new"}`}
          open
          mode={builder.mode}
          base={builder.base}
          actingTier={actingTier}
          connectors={connectors}
          busy={builderBusy}
          onSave={handleBuilderSave}
          onClose={() => setBuilder(null)}
          onOpenDepartments={onOpenDepartments}
        />
      )}

      {/* Assign-people multi-select (§4.2). */}
      <AssignPeopleDialog
        open={assignOpen}
        candidates={assignCandidates}
        degraded={assignDegraded}
        checked={assignChecked}
        busy={assignBusy}
        onToggle={(userId) =>
          setAssignChecked((prev) => {
            const next = new Set(prev);
            if (next.has(userId)) next.delete(userId);
            else next.add(userId);
            return next;
          })
        }
        onAssign={() => void performAssign()}
        onClose={() => setAssignOpen(false)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onConfirm={performDelete}
        onCancel={() => setDeleteTarget(null)}
        title={deleteTarget ? `Delete '${deleteTarget.name}'?` : "Delete role?"}
        description={deleteTarget ? ACCESS_COPY.deleteRoleUnused(deleteTarget.name) : ""}
        confirmLabel="Delete role"
        variant="destructive"
      />

      <ConfirmDialog
        open={archiveTarget !== null}
        onConfirm={performArchive}
        onCancel={() => setArchiveTarget(null)}
        title={archiveTarget ? `Archive '${archiveTarget.name}'?` : "Archive role?"}
        // WARP-1560 — the packet's sentence is whole again: the Archived
        // section and its Restore button are what make the promise real.
        description={ACCESS_COPY.archiveRole}
        confirmLabel="Archive"
        variant="neutral"
      />

      <ConfirmDialog
        open={restoreTarget !== null}
        onConfirm={performRestore}
        onCancel={() => setRestoreTarget(null)}
        title={restoreTarget ? `Restore '${restoreTarget.name}'?` : "Restore role?"}
        description={ACCESS_COPY.restoreRole}
        confirmLabel="Restore role"
        variant="neutral"
      />
    </div>
  );
}

function AssignPeopleDialog({
  open,
  candidates,
  degraded,
  checked,
  busy,
  onToggle,
  onAssign,
  onClose,
}: {
  open: boolean;
  candidates: RosterUser[];
  /** Roster rows exist whose tier is unknown — excluded fail-closed. */
  degraded: boolean;
  checked: Set<string>;
  busy: boolean;
  onToggle: (userId: string) => void;
  onAssign: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} labelledBy="access-assign-heading" maxWidth="sm">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="access-assign-heading" style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text)" }}>
            Assign people
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1" style={{ color: "var(--text-muted)" }}>
            <X size={16} />
          </button>
        </div>
        {candidates.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
            {degraded
              ? // Fail-closed honesty: unknown-tier rows are never offered
                // (one could be the owner), so say why the list is empty.
                "No one can be offered yet — this Droplet hasn't reported everyone's current role."
              : "Everyone who can hold this role already has it."}
          </p>
        ) : (
          <div style={{ border: "1px solid var(--card-bd)", borderRadius: "var(--radius-input)", overflow: "hidden" }}>
            {candidates.map((p, i) => (
              <label
                key={p.id}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderTop: i === 0 ? "none" : "1px solid var(--card-bd)", cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  checked={!!p.userId && checked.has(p.userId)}
                  onChange={() => p.userId && onToggle(p.userId)}
                />
                <span className="ava">{initials(p.displayName || p.id)}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--text)" }}>
                  {p.displayName || p.id}
                </span>
              </label>
            ))}
          </div>
        )}
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
          {/* Mirrors §12 sessionRevoke semantics: the new access takes
              effect immediately, not at next sign-in. */}
          Assigning applies immediately — people are signed out and their new access takes effect
          immediately.
        </p>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={onAssign} disabled={busy || checked.size === 0}>
            {busy ? "Assigning…" : "Assign"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
