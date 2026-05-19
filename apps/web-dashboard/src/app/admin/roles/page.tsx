"use client";

import { ShieldCheck, Check, Minus } from "lucide-react";
import Link from "next/link";
import { ProfileModeToggle } from "@/components/ProfileModeToggle";
import { RolePill } from "@/components/RolePill";
import {
  useProfileMode,
  rolesForMode,
  type DisplayRole,
} from "@/lib/profileMode";

// ─────────────────────────────────────────────────────────────────────
// Permission rows. Hand-curated to mirror the shared-brain canonical
// 4-role policy (owner/admin/family/guest); the Business taxonomy
// (manager/member/viewer) maps onto the canonical roles for storage.
//
// IMPORTANT: this surface is read-only today — RBAC per-route guards
// (M2.2) are not yet implemented in the orchestrator, so editing here
// would have no server effect. The page exists to communicate the
// model while the backend catches up.
// ─────────────────────────────────────────────────────────────────────

type Capability = {
  group: "Workspace" | "Operations" | "Admin" | "Destructive";
  label: string;
  // true = allowed, false = forbidden. Keyed by DisplayRole.
  allow: Partial<Record<DisplayRole, boolean>>;
};

const CAPABILITIES: Capability[] = [
  // Workspace
  { group: "Workspace", label: "Chat with Droplet AI",      allow: { owner: true, admin: true, manager: true, member: true, family: true, viewer: true, guest: true } },
  { group: "Workspace", label: "Read shared files",         allow: { owner: true, admin: true, manager: true, member: true, family: true, viewer: true, guest: true } },
  { group: "Workspace", label: "Upload / share files",      allow: { owner: true, admin: true, manager: true, member: true, family: true, viewer: false, guest: false } },
  { group: "Workspace", label: "Pair / control smart-home", allow: { owner: true, admin: true, manager: true, member: true, family: true, viewer: false, guest: false } },

  // Operations
  { group: "Operations", label: "View cameras + events",       allow: { owner: true, admin: true, manager: true, member: true, family: true, viewer: true, guest: false } },
  { group: "Operations", label: "Export / share clips",        allow: { owner: true, admin: true, manager: true, member: false, family: false, viewer: false, guest: false } },
  { group: "Operations", label: "Edit network rules + VLANs",  allow: { owner: true, admin: true, manager: false, member: false, family: false, viewer: false, guest: false } },

  // Admin
  { group: "Admin", label: "Invite / remove people",          allow: { owner: true, admin: true, manager: false, member: false, family: false, viewer: false, guest: false } },
  { group: "Admin", label: "Edit role assignments",           allow: { owner: true, admin: true, manager: false, member: false, family: false, viewer: false, guest: false } },
  { group: "Admin", label: "View activity log",               allow: { owner: true, admin: true, manager: false, member: false, family: false, viewer: false, guest: false } },
  { group: "Admin", label: "Manage SSO / login providers",    allow: { owner: true, admin: true, manager: false, member: false, family: false, viewer: false, guest: false } },
  { group: "Admin", label: "Issue BYOK API keys",             allow: { owner: true, admin: true, manager: false, member: false, family: false, viewer: false, guest: false } },

  // Destructive
  { group: "Destructive", label: "Factory reset device",        allow: { owner: true, admin: false, manager: false, member: false, family: false, viewer: false, guest: false } },
  { group: "Destructive", label: "Wipe storage / brain",        allow: { owner: true, admin: false, manager: false, member: false, family: false, viewer: false, guest: false } },
  { group: "Destructive", label: "Change billing plan",         allow: { owner: true, admin: false, manager: false, member: false, family: false, viewer: false, guest: false } },
];

const GROUPS: Capability["group"][] = ["Workspace", "Operations", "Admin", "Destructive"];

export default function RolesPage() {
  const [mode] = useProfileMode();
  const roles = rolesForMode(mode);

  return (
    <div>
      <div className="dp-top">
        <div className="dp-crumbs">
          <Link href="/" style={{ color: "var(--rd-text-3)" }}>Home</Link>
          <span aria-hidden>›</span>
          <span className="here">Roles &amp; permissions</span>
        </div>
        <div className="dp-top-right">
          <ProfileModeToggle />
        </div>
      </div>

      <div className="dp-page">
        <div className="dp-page-h">
          <div>
            <p className="dp-cap">Admin</p>
            <h1>Roles &amp; permissions</h1>
            <p className="sub">
              Read-only preview. {mode === "home"
                ? "Home mode shows the four canonical roles the orchestrator persists."
                : "Business mode adds Manager, Member, and Viewer; these map onto the canonical roles under the hood."}{" "}
              Editing lands with WARP-M2.2 (RBAC per-route guards).
            </p>
          </div>
        </div>

        <div className="dp-panel">
          <div className="dp-panel-h">
            <div>
              <h3>Permission matrix</h3>
              <p className="sub">{CAPABILITIES.length} capabilities · {roles.length} roles ({mode})</p>
            </div>
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--rd-text-3)" }}>
              <span className="flex items-center gap-1.5"><Check size={11} strokeWidth={2} style={{ color: "var(--rd-ok)" }} /> Allowed</span>
              <span className="flex items-center gap-1.5"><Minus size={11} strokeWidth={2} style={{ color: "var(--rd-text-4)" }} /> Denied</span>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="dp-tbl">
              <thead>
                <tr>
                  <th style={{ minWidth: 220 }}>Capability</th>
                  {roles.map((r) => (
                    <th key={r} style={{ textAlign: "center" }}>
                      <span style={{ display: "inline-flex", justifyContent: "center" }}>
                        <RolePill role={r} />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {GROUPS.map((group) => (
                  <Group key={group} group={group} roles={roles} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function Group({ group, roles }: { group: Capability["group"]; roles: DisplayRole[] }) {
  const rows = CAPABILITIES.filter((c) => c.group === group);
  return (
    <>
      <tr>
        <td colSpan={roles.length + 1} style={{ background: "var(--rd-bg-tint)", color: "var(--rd-text-3)", textTransform: "uppercase", fontSize: 11, letterSpacing: "0.04em", fontWeight: 600, height: 32 }}>
          {group}
        </td>
      </tr>
      {rows.map((row, i) => (
        <tr key={`${group}-${i}`}>
          <td>{row.label}</td>
          {roles.map((r) => {
            const allowed = row.allow[r];
            return (
              <td key={r} style={{ textAlign: "center" }}>
                {allowed ? (
                  <Check size={14} strokeWidth={2} style={{ color: "var(--rd-ok)" }} />
                ) : (
                  <Minus size={14} strokeWidth={2} style={{ color: "var(--rd-text-4)" }} />
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
