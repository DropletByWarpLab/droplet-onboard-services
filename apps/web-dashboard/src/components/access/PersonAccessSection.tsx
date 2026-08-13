"use client";

/**
 * WARP-1532 (RBAC v2 T8) — Surface C: the person editor's access sections.
 *
 * Mounted inside the existing /users Edit dialog (the design's "extend the
 * person editor in place"), between Identity and Usage:
 *
 *   Role       — a select of assignable roles (custom + built-in Admin /
 *                Staff / Guest — never Owner or Service; options above the
 *                actor's tier disabled per WARP-623). The §8 rails render
 *                as disabled-with-honest-copy, never hidden.
 *   What they  — a collapsed-by-default READ-ONLY drawer resolving tier →
 *   can do       role grants → department rights → usage via
 *                GET /api/people/:id/effective-access. Never invents access.
 *   Exceptions — the D-A escape hatch, collapsed behind "+ Add an
 *                exception"; controlled by the parent (PUT on dialog Save).
 *
 * The section is presentational + drawer-fetch only: the parent owns the
 * pending role value, the exceptions list, and the save/sync lifecycle, so
 * the dialog keeps ONE Save button (§11 one-confirm-per-write).
 */

import { useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronRight, Eye, KeyRound, Loader2, Lock, ShieldCheck, X } from "lucide-react";
import { fetchEffectiveAccess } from "@/lib/api";
import type {
  AccessExceptionInput,
  AccessRole,
  AccessTier,
  EffectiveAccess,
  FeatureAccessLevel,
  RosterUser,
} from "@/lib/types";
import {
  GATEABLE_FEATURES,
  featureDef,
  formatStorageBytes,
  tierLabel,
} from "@/lib/access";
// WARP-1809: every user holds a boot-seeded HOUSEHOLD membership, so the
// drawer's deptRights chips would otherwise echo the seeded server name;
// the shared kind-keyed mapping renders it as "Workspace" instead.
import { orgUnitDisplayName } from "@/lib/org-unit-name";
import { ACCESS_COPY } from "./copy";
import { AccessChip, GuardNote } from "./bits";
// WARP-1533: the option-building logic is shared with the invite modal's
// role picker (design §7 — "identical control, no new pattern").
import { RoleSelectOptions } from "./role-options";
import { CameraAccessSection } from "./CameraAccessSection";
import "./access.css";

export type PersonAccessValue = `role:${string}` | `tier:${string}`;

/** The §8 rail state for a target person — shared by the Role section and
 *  the (separately mounted, §17-ordered) Exceptions section. */
export function personGuardState(
  person: RosterUser,
  people: RosterUser[],
  actingUserId: string | null,
): { isOwner: boolean; isSelf: boolean; lastAdminBlocked: boolean; locked: boolean } {
  const isOwner = person.role === "owner";
  const isSelf = person.userId != null && actingUserId != null && person.userId === actingUserId;
  // Last-operator rail: this person is an operator and the roster shows no
  // OTHER owner/admin. Only computable once the roster carries roles — when
  // role data is absent we stay silent and let the backend enforce (never
  // fabricate a guard from missing data).
  const isOperator = person.role === "admin" || person.role === "owner";
  const operators = people.filter((p) => p.role === "owner" || p.role === "admin");
  const lastAdminBlocked = !isOwner && isOperator && operators.length <= 1;
  return { isOwner, isSelf, lastAdminBlocked, locked: isOwner || isSelf || lastAdminBlocked };
}

/** The honest disabled reason for a locked target, in §8 priority order. */
function guardReason(g: ReturnType<typeof personGuardState>): string | undefined {
  if (g.isOwner) return ACCESS_COPY.ownerTooltip;
  if (g.isSelf) return ACCESS_COPY.selfLockout;
  if (g.lastAdminBlocked) return ACCESS_COPY.lastAdmin;
  return undefined;
}

export interface PersonAccessSectionProps {
  person: RosterUser;
  /** Full roster — powers the last-operator computation (§8). */
  people: RosterUser[];
  /** Active custom roles for the select. */
  roles: AccessRole[];
  actingTier: AccessTier;
  /** Local User.id of the acting admin — self-lockout detection. */
  actingUserId: string | null;
  /** Controlled select value ("role:<id>" or "tier:<tier>"). */
  value: string;
  onChange: (value: string) => void;
  /** Page-owned sync line (§12 sessionRevoke → Applied). */
  syncText: string | null;
  /** "Manage roles →" recovery path for the last-admin rail. */
  onManageRoles: () => void;
}

type DrawerState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; data: EffectiveAccess }
  | { phase: "error" };

export function PersonAccessSection({
  person,
  people,
  roles,
  actingTier,
  actingUserId,
  value,
  onChange,
  syncText,
  onManageRoles,
}: PersonAccessSectionProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState>({ phase: "idle" });

  const guards = useMemo(
    () => personGuardState(person, people, actingUserId),
    [person, people, actingUserId],
  );
  const { isOwner, isSelf, lastAdminBlocked, locked } = guards;

  const guard = isOwner ? (
    <GuardNote icon={<Lock size={15} aria-hidden="true" />}>{ACCESS_COPY.ownerTooltip}</GuardNote>
  ) : isSelf ? (
    <GuardNote warn icon={<ShieldCheck size={15} aria-hidden="true" />}>
      {ACCESS_COPY.selfLockout}
    </GuardNote>
  ) : lastAdminBlocked ? (
    <GuardNote warn icon={<AlertTriangle size={15} aria-hidden="true" />}>
      {ACCESS_COPY.lastAdmin}{" "}
      <button
        type="button"
        onClick={onManageRoles}
        style={{ color: "var(--brand)", fontWeight: 600, background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}
      >
        {ACCESS_COPY.manageRolesLink}
      </button>
    </GuardNote>
  ) : null;

  async function openDrawer() {
    const next = !drawerOpen;
    setDrawerOpen(next);
    if (!next || drawer.phase === "ready" || drawer.phase === "loading" || !person.userId) return;
    setDrawer({ phase: "loading" });
    try {
      const data = await fetchEffectiveAccess(person.userId);
      setDrawer({ phase: "ready", data });
    } catch {
      setDrawer({ phase: "error" });
    }
  }

  const fieldStyle: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-input)",
    color: "var(--text)",
  };

  return (
    <div className="pt-2 space-y-4" style={{ borderTop: "1px solid var(--card-bd)" }}>
      {/* ── Identity tier (read-only — set by the role's starting point) ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        <AccessChip icon={isOwner ? <KeyRound size={12} aria-hidden="true" /> : <ShieldCheck size={12} aria-hidden="true" />}>
          {person.role ? `${tierLabel(person.role)} tier` : "Tier —"}
        </AccessChip>
        <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          {ACCESS_COPY.identityHint}
        </span>
      </div>

      {/* ── Role (§6.2) ── */}
      <div>
        <div className="type-caption-1 mb-1.5" style={{ color: "var(--text-muted)" }}>
          Role
        </div>
        {guard && <div className="mb-2">{guard}</div>}
        <select
          aria-label="Assigned role"
          value={value}
          disabled={locked}
          title={isOwner ? ACCESS_COPY.ownerTooltip : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
          style={{ ...fieldStyle, opacity: locked ? 0.55 : 1 }}
        >
          <RoleSelectOptions roles={roles} actingTier={actingTier} includeOwnerOption={isOwner} />
        </select>
        {!locked && (
          <p className="type-caption-1 mt-1.5" style={{ color: "var(--text-muted)", lineHeight: 1.5 }}>
            Changing the role signs {(person.displayName || person.id).split(" ")[0]} out of their
            other sessions; the new access takes effect immediately.
          </p>
        )}
        {syncText && (
          <div
            role="status"
            aria-live="polite"
            className="type-caption-1 mt-1.5"
            style={{ color: "var(--text-muted)", display: "flex", alignItems: "flex-start", gap: 5 }}
          >
            {syncText === ACCESS_COPY.applied ? (
              <Check size={12} aria-hidden="true" style={{ color: "var(--success)", flexShrink: 0, marginTop: 2 }} />
            ) : (
              <Loader2
                size={12}
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
                style={{ flexShrink: 0, marginTop: 2 }}
              />
            )}
            <span>{syncText}</span>
          </div>
        )}
      </div>

      {/* ── What they can do (§6.3 — read-only effective access) ── */}
      <div>
        <div className="type-caption-1 mb-1.5" style={{ color: "var(--text-muted)" }}>
          What they can do
        </div>
        <div className="acc-drawer" data-testid="access-effective-drawer">
          <button type="button" className="acc-drawer-h" aria-expanded={drawerOpen} onClick={() => void openDrawer()}>
            <Eye size={15} aria-hidden="true" />
            {ACCESS_COPY.effectiveAccessTitle}
            {person.role && <AccessChip mono>{tierLabel(person.role)}</AccessChip>}
            <span className={`chev${drawerOpen ? " open" : ""}`}>
              <ChevronRight size={15} aria-hidden="true" />
            </span>
          </button>
          {drawerOpen && (
            <div className="acc-drawer-body">
              {drawer.phase === "loading" && <div className="acc-skel" style={{ height: 34 }} />}
              {drawer.phase === "error" && (
                <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                  {ACCESS_COPY.rolesErrorTitle} — try again in a moment.
                </span>
              )}
              {drawer.phase === "ready" && (
                <>
                  <div className="acc-eff-line">
                    {drawer.data.features.map((f) => {
                      const def = featureDef(f.moduleId);
                      if (!def) return null;
                      const level = def.levels.find((l) => l.value === f.level);
                      const suffix = def.levels.length > 1 && level ? ` · ${level.label.toLowerCase()}` : "";
                      return <AccessChip key={f.moduleId}>{`${def.label}${suffix}`}</AccessChip>;
                    })}
                    {/* §6.3 — absence is part of the honest answer ("No
                        network"): a muted chip per gateable feature the
                        resolver did NOT grant. The always-on trio is not
                        gateable and never renders as absent. */}
                    {GATEABLE_FEATURES.filter(
                      (def) => !drawer.data.features.some((f) => f.moduleId === def.moduleId),
                    ).map((def) => (
                      <AccessChip key={`no-${def.moduleId}`} tone="muted">
                        {`No ${def.label.toLowerCase()}`}
                      </AccessChip>
                    ))}
                    {drawer.data.deptRights.map((d) => (
                      <AccessChip key={d.id}>{`${orgUnitDisplayName(d.kind, d.name)}: ${d.right}`}</AccessChip>
                    ))}
                    <AccessChip mono>
                      Storage {formatStorageBytes(drawer.data.usage.storageQuotaBytes) === "—"
                        ? "—"
                        : formatStorageBytes(drawer.data.usage.storageQuotaBytes)}
                    </AccessChip>
                  </div>
                  <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                    {ACCESS_COPY.effectiveHint}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── WARP-1976: which cameras can they see? ──
          Mounted here, in the person panel, because access is managed where
          PEOPLE are managed. Owners/admins render as unrestricted rather
          than getting a checklist that would do nothing. */}
      <CameraAccessSection
        userId={person.userId}
        tier={person.role}
        displayName={person.displayName || person.id}
      />
    </div>
  );
}

/**
 * §6.5 Exceptions — the D-A escape hatch, mounted by the page AFTER the
 * Usage section (§17 order: Identity → Role → effective access → Usage →
 * Exceptions; exceptions are the fine print, last). §8: for a locked
 * target (owner / self / last admin) the block stays visible with the add
 * affordance disabled and titled by the honest reason — never hidden.
 * Chips are neutral text-first (§1/§15): the Check/X icon + the Allow/Deny
 * word disambiguate; no status color for a non-status fact.
 */
export function PersonExceptionsSection({
  person,
  people,
  actingUserId,
  exceptions,
  onExceptionsChange,
}: {
  person: RosterUser;
  people: RosterUser[];
  actingUserId: string | null;
  /** Controlled exception list (PUT by the parent on Save). */
  exceptions: AccessExceptionInput[];
  onExceptionsChange: (next: AccessExceptionInput[]) => void;
}) {
  const [addingException, setAddingException] = useState(false);
  const [exceptionModule, setExceptionModule] = useState("");
  const [exceptionEffect, setExceptionEffect] = useState<"allow" | "deny">("allow");
  const [exceptionLevel, setExceptionLevel] = useState<FeatureAccessLevel>("view");

  const guards = useMemo(
    () => personGuardState(person, people, actingUserId),
    [person, people, actingUserId],
  );
  const { locked } = guards;

  const fieldStyle: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-input)",
    color: "var(--text)",
  };

  function addException() {
    if (!exceptionModule) return;
    const row: AccessExceptionInput = {
      moduleId: exceptionModule as AccessExceptionInput["moduleId"],
      effect: exceptionEffect,
      ...(exceptionEffect === "allow" ? { level: exceptionLevel } : {}),
    };
    onExceptionsChange([...exceptions, row]);
    setAddingException(false);
    setExceptionModule("");
    setExceptionEffect("allow");
    setExceptionLevel("view");
  }

  const exceptionCandidates = GATEABLE_FEATURES.filter(
    (f) => !exceptions.some((ex) => ex.moduleId === f.moduleId),
  );
  const selectedExceptionFeature = featureDef(exceptionModule);

  return (
    <div className="pt-2" style={{ borderTop: "1px solid var(--card-bd)", marginTop: 10 }}>
      <div className="type-caption-1 mb-1.5" style={{ color: "var(--text-muted)" }}>
        Exceptions
      </div>
      {exceptions.length > 0 && (
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 8 }}>
          {exceptions.map((ex) => {
            const def = featureDef(ex.moduleId);
            const level = def?.levels.find((l) => l.value === ex.level);
            const label = `${ex.effect === "allow" ? "Allow" : "Deny"}: ${def?.label ?? ex.moduleId}${
              ex.effect === "allow" && level ? ` · ${level.label}` : ""
            }`;
            return (
              <AccessChip
                key={ex.moduleId}
                icon={ex.effect === "allow" ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
              >
                {label}
                {!locked && (
                  <button
                    type="button"
                    aria-label={`Remove exception for ${def?.label ?? ex.moduleId}`}
                    onClick={() => onExceptionsChange(exceptions.filter((e) => e.moduleId !== ex.moduleId))}
                    style={{ display: "inline-flex", background: "none", border: "none", padding: 0, marginLeft: 2, cursor: "pointer", color: "inherit" }}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                )}
              </AccessChip>
            );
          })}
        </div>
      )}
      {!addingException && (
        <button
          type="button"
          className="btn ghost sm"
          disabled={locked}
          title={guardReason(guards)}
          onClick={() => setAddingException(true)}
        >
          {ACCESS_COPY.addException}
        </button>
      )}
      {!locked && addingException && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <select
            aria-label="Exception feature"
            value={exceptionModule}
            onChange={(e) => setExceptionModule(e.target.value)}
            className="px-2.5 py-2 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
            style={fieldStyle}
          >
            <option value="">Feature…</option>
            {exceptionCandidates.map((f) => (
              <option key={f.moduleId} value={f.moduleId}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Exception effect"
            value={exceptionEffect}
            onChange={(e) => setExceptionEffect(e.target.value as "allow" | "deny")}
            className="px-2.5 py-2 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
            style={fieldStyle}
          >
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
          {exceptionEffect === "allow" && (
            <select
              aria-label="Exception level"
              value={exceptionLevel}
              onChange={(e) => setExceptionLevel(e.target.value as FeatureAccessLevel)}
              className="px-2.5 py-2 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
              style={fieldStyle}
            >
              {(selectedExceptionFeature?.levels ?? []).map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
              {!selectedExceptionFeature && <option value="view">View</option>}
            </select>
          )}
          <button type="button" className="btn primary sm" onClick={addException} disabled={!exceptionModule}>
            Add exception
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setAddingException(false)}>
            Cancel
          </button>
        </div>
      )}
      <p className="type-caption-1 mt-1.5" style={{ color: "var(--text-muted)" }}>
        {ACCESS_COPY.exceptionsHint}
      </p>
    </div>
  );
}
