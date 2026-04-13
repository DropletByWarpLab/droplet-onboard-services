"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Users, X } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProviderKeyForm } from "@/components/ProviderKeyForm";
import { useDevice } from "@/lib/hooks/useDevice";
import { useAuth } from "@/lib/auth";
import {
  listProviderKeys,
  fetchUsers,
  createUser,
  deleteUser as apiDeleteUser,
} from "@/lib/api";
import type { AuthUser } from "@/lib/types";

const RESERVED_USERNAMES = ["admin", "root"];

export default function SettingsPage() {
  const { device, health } = useDevice();
  const { user: currentUser } = useAuth();
  const [configuredProviders, setConfiguredProviders] = useState<string[]>([]);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [userError, setUserError] = useState<string | null>(null);

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
    if (!newUsername.trim() || !newPassword.trim()) {
      setUserError("Username and password are required");
      return;
    }
    if (RESERVED_USERNAMES.includes(newUsername.trim().toLowerCase())) {
      setUserError("This username is reserved and cannot be used");
      return;
    }
    if (newPassword.length < 8) {
      setUserError("Password must be at least 8 characters");
      return;
    }

    try {
      await createUser(newUsername, newPassword, newDisplayName || undefined);
      setNewUsername("");
      setNewDisplayName("");
      setNewPassword("");
      setShowAddUser(false);
      await loadUsers();
    } catch (err: any) {
      setUserError(err.message || "Failed to create user");
    }
  };

  const handleDeleteUser = async (username: string) => {
    if (username === currentUser?.username) {
      setUserError("You cannot delete your own account");
      return;
    }
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    try {
      await apiDeleteUser(username);
      await loadUsers();
    } catch (err: any) {
      setUserError(err.message || "Failed to delete user");
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      <h1 className="type-large-title text-label-primary mb-8">Settings</h1>

      {/* Appearance */}
      <section className="mb-10">
        <h2 className="type-footnote text-label-secondary uppercase tracking-wider px-1 mb-2">
          Appearance
        </h2>
        <div className="dp-group">
          <div className="dp-row">
            <span className="type-body text-label-primary">Theme</span>
            <ThemeToggle />
          </div>
        </div>
      </section>

      {/* User Management */}
      <section className="mb-10">
        <div className="flex items-center justify-between px-1 mb-2">
          <h2 className="type-footnote text-label-secondary uppercase tracking-wider">
            Users
          </h2>
          <button
            onClick={() => setShowAddUser(true)}
            className="flex items-center gap-1 type-caption-1 text-accent hover:text-accent-hover transition-colors"
          >
            <Plus size={12} />
            Add User
          </button>
        </div>

        {userError && (
          <div className="mb-3 p-2.5 bg-system-red/10 border border-system-red/20 rounded type-footnote text-system-red flex items-center justify-between">
            <span>{userError}</span>
            <button onClick={() => setUserError(null)}>
              <X size={12} />
            </button>
          </div>
        )}

        {/* Add user form */}
        {showAddUser && (
          <div className="dp-card p-4 mb-3 space-y-3">
            <p className="type-headline text-label-primary">New User</p>
            <div className="grid grid-cols-2 gap-3">
              <input
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value.toLowerCase())}
                placeholder="Username"
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
              placeholder="Password (min. 8 characters)"
              className="dp-input"
              onKeyDown={(e) => e.key === "Enter" && handleCreateUser()}
            />
            <div className="flex items-center gap-2 pt-1">
              <button onClick={handleCreateUser} className="dp-btn-primary type-footnote !min-h-[36px] !py-1.5">
                Create
              </button>
              <button
                onClick={() => { setShowAddUser(false); setUserError(null); }}
                className="type-subheadline text-accent hover:text-accent-hover transition-colors px-3 py-1.5"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="dp-group">
          {users.length === 0 ? (
            <div className="dp-row">
              <span className="type-subheadline text-label-tertiary">No users found</span>
            </div>
          ) : (
            users.map((u) => (
              <div key={u.id} className="dp-row group">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="w-8 h-8 rounded-full bg-accent/15 flex items-center justify-center flex-shrink-0">
                    <Users size={14} className="text-accent" />
                  </div>
                  <div className="min-w-0">
                    <p className="type-callout text-label-primary truncate">
                      {u.displayName || u.id}
                    </p>
                    <p className="type-caption-1 text-label-tertiary">{u.id}</p>
                  </div>
                </div>
                {u.id !== currentUser?.username && (
                  <button
                    onClick={() => handleDeleteUser(u.id)}
                    className="p-1.5 rounded-sm text-label-quaternary hover:text-system-red hover:bg-system-red/10 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
                {u.id === currentUser?.username && (
                  <span className="type-caption-2 text-accent bg-accent/10 px-2 py-0.5 rounded-full">
                    You
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Device Info */}
      <section className="mb-10">
        <h2 className="type-footnote text-label-secondary uppercase tracking-wider px-1 mb-2">
          Device Information
        </h2>
        <div className="dp-group">
          <InfoRow label="Hostname" value={device?.hostname ?? "Droplet"} />
          <InfoRow label="Hardware" value={device?.hardwareRev ?? "—"} />
          <InfoRow label="Network Mode" value={device?.networkMode ?? "—"} />
          <InfoRow label="IP Address" value={device?.ip ?? "Not assigned"} />
          <InfoRow
            label="Services"
            value={
              health
                ? `DB: ${health.services.db ? "OK" : "Down"} | Cache: ${health.services.redis ? "OK" : "Down"} | AI: ${health.services.aiGateway ? "OK" : "Down"}`
                : "Loading..."
            }
          />
          <InfoRow label="Uptime" value={health ? formatUptime(health.uptime) : "—"} />
        </div>
      </section>

      {/* AI Providers */}
      <section className="mb-10">
        <h2 className="type-footnote text-label-secondary uppercase tracking-wider px-1 mb-2">
          AI Providers
        </h2>

        {/* Ollama / Local */}
        <div className="dp-group mb-3">
          <div className="dp-row">
            <div>
              <p className="type-body text-label-primary">Ollama (Local — Jetson)</p>
              <p className="type-caption-1 text-label-tertiary mt-0.5">
                Runs on your Jetson device over LAN
              </p>
            </div>
            <span
              className={`px-2.5 py-1 rounded-full type-caption-2 font-medium ${
                health?.services.aiGateway
                  ? "bg-system-green/15 text-system-green"
                  : "bg-label-quaternary/30 text-label-tertiary"
              }`}
            >
              {health?.services.aiGateway ? "Connected" : "Offline"}
            </span>
          </div>
        </div>

        {/* Cloud providers */}
        <div className="dp-group">
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
        </div>
      </section>

    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dp-row">
      <span className="type-body text-label-secondary">{label}</span>
      <span className="type-body text-label-primary font-mono text-sm">{value}</span>
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
