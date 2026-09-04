"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  ChevronRight,
  DownloadCloud,
  Mic,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProviderKeyForm } from "@/components/ProviderKeyForm";
import { PasskeysSection } from "@/components/settings/PasskeysSection";
import { FeaturesCard } from "@/components/settings/FeaturesCard";
import { PersonalityCard } from "@/components/settings/PersonalityCard";
import { EmailChannelSection } from "@/components/settings/EmailChannelSection";
import { DangerZoneSection } from "@/components/settings/DangerZoneSection";
import { BusinessProfileCard } from "@/components/settings/BusinessProfileCard";
import { LocationsCard } from "@/components/settings/LocationsCard";
import { LogsSection } from "@/components/settings/LogsSection";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";
import { validatePassword, isValidEmail } from "@droplet/auth-policy";
import { useDevice } from "@/lib/hooks/useDevice";
import { useModuleGate } from "@/lib/hooks/useModuleGate";
import { boxDisplayHost } from "@/lib/box-identity";
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
import { inferenceRuntimeLabel } from "@/lib/provider";

export default function SettingsPage() {
  const { device, health } = useDevice();
  const { user: currentUser } = useAuth();
  // WARP-1807: the tucked Knowledge row below mirrors the nav's module gate
  // (fail-open — hidden only on a positive "off").
  const isModuleOn = useModuleGate();
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
  // WARP-874: guard against double-submit — disable Create + ignore re-entry
  // while the create request is in flight.
  const [creating, setCreating] = useState(false);

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
    if (creating) return;
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

    setCreating(true);
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
    } finally {
      setCreating(false);
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
              {/* fit="content" (WARP-1344): the fill variant's flex-1/min-w-0
                  squeeze compressed the group to min-content inside this .lrow
                  and clipped "Light" to "Li…"; content sizing lets the labels
                  set the width and takes the indigo shell surface. */}
              <ThemeToggle fit="content" />
            </div>
          </div>
        </div>

        {/* Features (WARP-1368) — operator toggles for the WARP-1306 runtime
            modules (registry: orchestrator module-registry.ts). Self-gates to
            owner/admin like the cards below. */}
        <FeaturesCard />

        {/* Advanced (WARP-1807) — the way in to the tucked Knowledge + Context
            surfaces. Not daily operation, so they left the primary nav
            (hidden: true in nav-config), but they must stay reachable.
            Knowledge mirrors the nav's fail-open module gate; Context carries
            no module and always renders. */}
        <Sect title="Advanced" />
        <div className="card" style={{ padding: 0 }}>
          <div className="rows">
            {isModuleOn("knowledge") && (
              <Link
                href="/knowledge"
                className="lrow"
                style={{ padding: "12px 16px", alignItems: "center" }}
              >
                <span className="ri">
                  <BookOpen size={16} />
                </span>
                <span className="rt">
                  <span className="nm">Knowledge</span>
                  <span className="sub">
                    What&apos;s indexed for retrieval
                  </span>
                </span>
                <ChevronRight size={16} style={{ marginLeft: "auto", opacity: 0.5 }} />
              </Link>
            )}
            <Link
              href="/context"
              className="lrow"
              style={{ padding: "12px 16px", alignItems: "center" }}
            >
              <span className="ri">
                <Sparkles size={16} />
              </span>
              <span className="rt">
                <span className="nm">Context</span>
                <span className="sub">
                  Indexing coverage and pipeline health
                </span>
              </span>
              <ChevronRight size={16} style={{ marginLeft: "auto", opacity: 0.5 }} />
            </Link>
          </div>
        </div>

        {/* Workspace (WARP-1119) — the "AI personality" card (design brief §6
            Card 1). Owns its own "Workspace" group header and self-gates to
            owner/admin. The business-profile card (Phase 3) slots into the
            same group, after the personality card — it is headless (no <Sect>
            of its own), so it is passed as a child and rendered inside the
            Workspace <section> rather than as a sibling here.

            WARP-2667 — until now it was rendered ~325 lines further down,
            which put it under the "AI providers" heading and had owners
            reporting the business walkthrough as living on "the llm page".
            Both cards gate to owner/admin (PersonalityCard on user.role;
            BusinessProfileCard on an onboardingState that the GET view
            returns to owner/admin only), so the child never outlives its
            heading. */}
        <PersonalityCard>
          {/* WARP-1121 — Business profile (design brief §6 Card 2): what
              Droplet knows about the business + the interview entry points
              (Run business setup / Re-run onboarding). Renders nothing for
              roles whose GET view carries no onboardingState. */}
          <BusinessProfileCard />

          {/* WARP-1906 — premade buildings + conference rooms offered as
              suggestions in the event form's Location field. Workspace-scoped
              data (fetchWorkspaceLocations) and headless like the card above,
              so it belongs to this group too; it was stranded under "AI
              providers" by the same accident. Self-gates to owner/admin on
              the same `user.role` expression PersonalityCard uses, and
              renders nothing for lesser roles. */}
          <LocationsCard />
        </PersonalityCard>

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
              <div>
                {/* WARP-650: this field only carries a placeholder for sighted
                    users (design keeps the compact 2-up layout); a visually
                    hidden label gives it a programmatic name for screen
                    readers (WCAG 1.3.1 / 4.1.2), matching the sr-only + htmlFor
                    convention used elsewhere in the dashboard (e.g. MemoryPanel,
                    EmailWorkspace). */}
                <label htmlFor="new-user-email" className="sr-only">
                  Work email
                </label>
                <input
                  id="new-user-email"
                  type="email"
                  inputMode="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="new-user-display-name" className="sr-only">
                  Display name (optional)
                </label>
                <input
                  id="new-user-display-name"
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  placeholder="Display name (optional)"
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                />
              </div>
            </div>
            <div>
              <label htmlFor="new-user-password" className="sr-only">
                Password
              </label>
              <input
                id="new-user-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Create a password"
                className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
                onKeyDown={(e) => e.key === "Enter" && handleCreateUser()}
              />
            </div>
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
              <button
                onClick={handleCreateUser}
                disabled={creating}
                className="btn primary sm"
                type="button"
              >
                {creating ? "Creating…" : "Create"}
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
            {/* WARP-992: this row is what the factory-reset type-to-confirm
                modal tells the owner to read, so it must render the same
                canonical name the server compares against — never a leaked
                container-id hostname from a stale Device row. */}
            <InfoRow label="Hostname" value={boxDisplayHost(device?.hostname)} />
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

        {/* Voice (WARP-1055) — a single link row; calibration and mic
            health live on the /voice peer surface (design brief §2 —
            no duplicated controls here). */}
        <Sect title="Voice" />
        <div className="card" style={{ padding: 0 }}>
          <div className="rows">
            <Link
              href="/voice"
              className="lrow"
              style={{ padding: "12px 16px", alignItems: "center" }}
            >
              <span className="ri">
                <Mic size={16} />
              </span>
              <span className="rt">
                <span className="nm">Voice &amp; microphone</span>
                <span className="sub">
                  Mic health, wake word, and guided calibration
                </span>
              </span>
              <ChevronRight size={16} style={{ marginLeft: "auto", opacity: 0.5 }} />
            </Link>
          </div>
        </div>

        {/* Software updates (WARP-540) — a single link row; the OTA status,
            pending release, apply window, and history live on the dedicated
            /settings/updates surface (same pattern as the Voice row). */}
        <Sect title="Software updates" />
        <div className="card" style={{ padding: 0 }}>
          <div className="rows">
            <Link
              href="/settings/updates"
              className="lrow"
              style={{ padding: "12px 16px", alignItems: "center" }}
            >
              <span className="ri">
                <DownloadCloud size={16} />
              </span>
              <span className="rt">
                <span className="nm">Software updates</span>
                <span className="sub">
                  Current release, pending updates, and the apply window
                </span>
              </span>
              <ChevronRight size={16} style={{ marginLeft: "auto", opacity: 0.5 }} />
            </Link>
          </div>
        </div>

        {/* Diagnostics (WARP-823) — owner/admin downloadable, redacted log bundle. */}
        <LogsSection />

        {/* AI Providers */}
        <Sect title="AI providers" />

        {/* On-device inference. WARP-1926 — this row used to hardcode
            "Ollama (on-device)", so a Docker-Model-Runner box (the shipped
            default since WARP-1870) told its owner it was running a daemon
            that isn't installed. The runtime now comes from /api/health. */}
        <div className="card" style={{ padding: 0, marginBottom: 12 }}>
          <div className="rows">
            <div className="lrow" style={{ padding: "12px 16px" }}>
              <span className="rt">
                <span className="nm">
                  {inferenceRuntimeLabel(health?.inferenceRuntime)} (on-device)
                </span>
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
