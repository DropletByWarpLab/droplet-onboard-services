"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Settings as SettingsIcon, Trash2, Users, X } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProviderKeyForm } from "@/components/ProviderKeyForm";
import { PasskeysSection } from "@/components/settings/PasskeysSection";
import { EmailChannelSection } from "@/components/settings/EmailChannelSection";
import { DangerZoneSection } from "@/components/settings/DangerZoneSection";
import { LogsSection } from "@/components/settings/LogsSection";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";
import { validatePassword, isValidEmail } from "@droplet/auth-policy";
import { useDevice } from "@/lib/hooks/useDevice";
import { useAuth } from "@/lib/auth";
import {
  listProviderKeys,
  fetchUsers,
  createUser,
  deleteUser as apiDeleteUser,
} from "@/lib/api";
import type { AuthUser } from "@/lib/types";
import { ShellPage } from "@/components/shell/ShellPage";
import { Sect, Badge } from "@/components/shell/primitives";

export default function SettingsPage() {
  const { device, health } = useDevice();
  const { user: currentUser } = useAuth();
  const [configuredProviders, setConfiguredProviders] = useState<string[]>([]);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [showAddUser, setShowAddUser] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  // WARP-824: admin types a temp password and (by default) requires the new
  // user to change it on first login. Default ON — an admin-minted account is
  // a temp-credential handoff unless the operator opts out.
  const [newMustChange, setNewMustChange] = useState(true);
  const [userError, setUserError] = useState<string | null>(null);
  const [deleteUserTarget, setDeleteUserTarget] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const providers = await listProviderKeys();
      setConfiguredProviders(providers);
    } catch {
      // Non-fatal
    }
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      const data = await fetchUsers();
      setUsers(data.users || []);
    } catch {
      // Non-fatal — might not have admin access
    }
  }, []);

  useEffect(() => {
    loadKeys();
    loadUsers();
  }, [loadKeys, loadUsers]);

  const handleCreateUser = async () => {
    setUserError(null);
    if (!isValidEmail(newEmail)) {
      setUserError("Enter a valid email address.");
      return;
    }
    if (!newPassword.trim()) {
      setUserError("Password is required.");
      return;
    }
    if (!validatePassword(newPassword).ok) {
      setUserError("Password doesn't meet the requirements yet.");
      return;
    }

    try {
      await createUser(newEmail, newPassword, newDisplayName || undefined, newMustChange);
      setNewEmail("");
      setNewDisplayName("");
      setNewPassword("");
      setNewMustChange(true);
      setShowAddUser(false);
      await loadUsers();
    } catch (err: any) {
      setUserError(err.message || "Failed to create user");
    }
  };

  const handleDeleteUser = (username: string) => {
    if (username === currentUser?.username) {
      setUserError("You cannot delete your own account");
      return;
    }
    setDeleteUserTarget(username);
  };

  const performDeleteUser = async () => {
    const username = deleteUserTarget;
    if (!username) return;
    try {
      await apiDeleteUser(username);
      setDeleteUserTarget(null);
      await loadUsers();
    } catch (err: any) {
      setUserError(err.message || "Failed to delete user");
      throw err;
    }
  };

  return (
    <ShellPage
      icon={<SettingsIcon size={15} />}
      label="Settings"
      title="Settings"
      sub="Appearance, accounts, device info, AI providers, and maintenance."
    >
      <div style={{ maxWidth: 880 }}>
        {/* Appearance */}
        <Sect title="Appearance" />
        <div className="card" style={{ padding: 0 }}>
          <div className="rows">
            <div className="lrow" style={{ padding: "12px 16px" }}>
              <span className="rt">
                <span className="nm">Theme</span>
              </span>
              <ThemeToggle />
            </div>
          </div>
        </div>

        {/* Passkeys (PR #377) — enrol a passwordless sign-in credential. */}
        <PasskeysSection />

        {/* User Management */}
        <div className="sect">
          <h2>Users</h2>
          <button
            onClick={() => setShowAddUser(true)}
            className="btn ghost sm"
            style={{ marginLeft: "auto" }}
            type="button"
          >
            <Plus size={13} />
            Add user
          </button>
        </div>

        {userError && (
          <div
            className="card"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              color: "#ef4444",
              marginBottom: 12,
              padding: 12,
            }}
          >
            <span>{userError}</span>
            <button onClick={() => setUserError(null)} aria-label="Dismiss error" type="button">
              <X size={12} />
            </button>
          </div>
        )}

        {/* Add user form */}
        {showAddUser && (
          <div className="card space-y-3" style={{ marginBottom: 12 }}>
            <p className="type-headline text-label-primary">New user</p>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="email"
                inputMode="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="you@company.com"
                className="dp-input"
                autoFocus
              />
              <input
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="Display name (optional)"
                className="dp-input"
              />
            </div>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Create a password"
              className="dp-input"
              onKeyDown={(e) => e.key === "Enter" && handleCreateUser()}
            />
            <PasswordRulesChecklist password={newPassword} />
            {/* WARP-824 — require the new user to replace the temporary
                password on first login. On by default; the orchestrator
                enforces the change server-side. */}
            <label htmlFor="must-change-password" className="flex items-start gap-2.5 pt-1 cursor-pointer">
              <input
                id="must-change-password"
                type="checkbox"
                checked={newMustChange}
                onChange={(e) => setNewMustChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-separator text-accent focus:ring-accent/40 cursor-pointer"
              />
              <span className="type-footnote text-label-secondary leading-snug">
                Require password change on first login
                <span className="block text-label-tertiary type-caption-1 mt-0.5">
                  You set a temporary password now; they choose their own when they first sign in.
                </span>
              </span>
            </label>
            <div className="flex items-center gap-2 pt-1">
              <button onClick={handleCreateUser} className="btn primary sm" type="button">
                Create
              </button>
              <button
                onClick={() => { setShowAddUser(false); setUserError(null); }}
                className="btn ghost sm"
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="card" style={{ padding: 0 }}>
          {users.length === 0 ? (
            <div className="empty" style={{ padding: "32px 20px" }}>
              <span>No users found</span>
            </div>
          ) : (
            <div className="rows">
              {users.map((u) => {
                // aria-label mirrors the row's primary visible identifier so
                // screen-reader announcements match what sighted users see
                // (WARP-220 pattern; applied site-wide in WARP-292).
                const label = u.displayName || u.id;
                return (
                  <div key={u.id} className="lrow" style={{ padding: "12px 16px" }}>
                    <span className="ri brand">
                      <Users size={15} />
                    </span>
                    <span className="rt">
                      <span className="nm">{u.displayName || u.id}</span>
                      <span className="sub mono">{u.id}</span>
                    </span>
                    {u.id !== currentUser?.username ? (
                      // Always rendered (no opacity-gate on hover) so the
                      // action is discoverable for touch + keyboard users.
                      // p-2.5 → 14 px icon + 20 px padding = 34 px hit-target,
                      // clearing the ≥ 32 px ui-ux floor.
                      <button
                        onClick={() => handleDeleteUser(u.id)}
                        aria-label={`Delete user ${label}`}
                        className="p-2.5 rounded-sm text-label-quaternary hover:text-system-red hover:bg-system-red/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : (
                      <Badge kind="info">You</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Outbound email (BUG-11) — SMTP relay for invite delivery. Sits with
            the people/account config since its primary consumer is invites. */}
        <EmailChannelSection />

        {/* Device Info */}
        <Sect title="Device information" />
        <div className="card" style={{ padding: 0 }}>
          <div className="rows">
            <InfoRow label="Hostname" value={device?.hostname ?? "Droplet"} />
            <InfoRow label="Hardware" value={device?.hardwareRev ?? "—"} />
            <InfoRow label="Network mode" value={device?.networkMode ?? "—"} />
            <InfoRow label="IP address" value={device?.ip ?? "Not assigned"} />
            <InfoRow
              label="Services"
              value={
                health
                  ? `DB: ${health.services.db ? "OK" : "Down"} | Cache: ${health.services.redis ? "OK" : "Down"} | AI: ${health.services.aiGateway ? "OK" : "Down"} | Screen: ${health.services.display ? "OK" : "Down"}`
                  : "Loading..."
              }
            />
            <InfoRow label="Uptime" value={health ? formatUptime(health.uptime) : "—"} />
          </div>
        </div>

        {/* Diagnostics (WARP-823) — owner/admin downloadable, redacted log bundle. */}
        <LogsSection />

        {/* AI Providers */}
        <Sect title="AI providers" />

        {/* Ollama / Local */}
        <div className="card" style={{ padding: 0, marginBottom: 12 }}>
          <div className="rows">
            <div className="lrow" style={{ padding: "12px 16px" }}>
              <span className="rt">
                <span className="nm">Ollama (on-device)</span>
                <span className="sub">Local LLM inference, never leaves your network</span>
              </span>
              <Badge kind={health?.services.aiGateway ? "ok" : "muted"}>
                {health?.services.aiGateway ? "Connected" : "Offline"}
              </Badge>
            </div>
          </div>
        </div>

        {/* Cloud providers */}
        <div className="card" style={{ padding: 0 }}>
          <div className="rows">
            <ProviderKeyForm
              provider="anthropic"
              label="Anthropic (Claude)"
              hasKey={configuredProviders.includes("anthropic")}
              onUpdate={loadKeys}
            />
            <ProviderKeyForm
              provider="openai"
              label="OpenAI (GPT)"
              hasKey={configuredProviders.includes("openai")}
              onUpdate={loadKeys}
            />
            <ProviderKeyForm
              provider="gemini"
              label="Gemini (Google)"
              hasKey={configuredProviders.includes("gemini")}
              onUpdate={loadKeys}
            />
          </div>
        </div>

        {/* Danger zone (WARP-828 + WARP-825) — owner-only home for irreversible
            device actions (reformat/remake storage AND factory reset). The
            section self-gates to the owner role internally and renders nothing
            for non-owners. Placed last so destructive actions sit apart from
            routine settings, fenced off in system-red. */}
        <DangerZoneSection />

        <ConfirmDialog
          open={deleteUserTarget !== null}
          onConfirm={performDeleteUser}
          onCancel={() => setDeleteUserTarget(null)}
          title={
            deleteUserTarget
              ? `Delete user "${deleteUserTarget}"?`
              : "Delete user?"
          }
          description="The account, sessions, and per-user state are removed. This cannot be undone."
          confirmLabel="Delete"
          variant="destructive"
        />
      </div>
    </ShellPage>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="lrow" style={{ padding: "12px 16px" }}>
      <span className="rt">
        <span className="nm" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{label}</span>
      </span>
      <span className="rmeta mono">{value}</span>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
