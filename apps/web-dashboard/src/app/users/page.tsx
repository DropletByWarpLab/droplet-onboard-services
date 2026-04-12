"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  Trash2,
  Edit3,
  X,
  Users as UsersIcon,
  ShieldOff,
  Shield,
  Check,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  fetchUsers,
  createUser,
  deleteUser as apiDeleteUser,
  updateUser,
  setUserEnabled,
} from "@/lib/api";
import type { AuthUser } from "@/lib/types";

/**
 * Admin-only user management page. Non-admin callers get a 403 from the
 * orchestrator on fetchUsers; we detect that and show a friendly notice
 * instead of letting the error bubble up.
 */
export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Invite form state
  const [showInvite, setShowInvite] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteDisplay, setInviteDisplay] = useState("");
  const [invitePassword, setInvitePassword] = useState("");

  // Edit dialog state (only displayName + email — password change is a separate action)
  const [editing, setEditing] = useState<AuthUser | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editPassword, setEditPassword] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchUsers();
      setUsers(data.users || []);
      setIsAdmin(true);
    } catch (err: any) {
      if (String(err?.message ?? "").includes("403")) {
        setIsAdmin(false);
      } else {
        setError(err?.message || "Failed to load users");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleInvite = async () => {
    setError(null);
    if (!inviteName.trim() || !invitePassword.trim()) {
      setError("Username and password are required");
      return;
    }
    if (invitePassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    try {
      await createUser(inviteName, invitePassword, inviteDisplay || undefined);
      setInviteName("");
      setInviteDisplay("");
      setInvitePassword("");
      setShowInvite(false);
      await reload();
    } catch (err: any) {
      setError(err?.message || "Failed to create user");
    }
  };

  const handleDelete = async (u: AuthUser) => {
    if (u.id === currentUser?.username) {
      setError("You can't delete your own account.");
      return;
    }
    if (!confirm(`Delete user "${u.id}"? This cannot be undone.`)) return;
    try {
      await apiDeleteUser(u.id);
      await reload();
    } catch (err: any) {
      setError(err?.message || "Failed to delete user");
    }
  };

  const handleToggleEnabled = async (u: AuthUser, enabled: boolean) => {
    try {
      await setUserEnabled(u.id, enabled);
      await reload();
    } catch (err: any) {
      setError(err?.message || `Failed to ${enabled ? "enable" : "disable"} user`);
    }
  };

  const openEdit = (u: AuthUser) => {
    setEditing(u);
    setEditDisplayName(u.displayName || "");
    setEditPassword("");
  };

  const handleEditSave = async () => {
    if (!editing) return;
    const patch: { displayName?: string; password?: string } = {};
    if (editDisplayName.trim() && editDisplayName !== editing.displayName) {
      patch.displayName = editDisplayName.trim();
    }
    if (editPassword.trim()) {
      if (editPassword.length < 8) {
        setError("Password must be at least 8 characters");
        return;
      }
      patch.password = editPassword;
    }
    if (!patch.displayName && !patch.password) {
      setEditing(null);
      return;
    }
    try {
      await updateUser(editing.id, patch);
      setEditing(null);
      await reload();
    } catch (err: any) {
      setError(err?.message || "Failed to update user");
    }
  };

  if (isAdmin === false) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl">
        <h1 className="type-large-title text-label-primary mb-4">Users</h1>
        <div className="dp-card py-16 flex flex-col items-center text-label-tertiary">
          <ShieldOff size={32} className="mb-3 text-label-quaternary" />
          <p className="type-subheadline">Admin access required</p>
          <p className="type-caption-1 mt-1 text-label-quaternary max-w-sm text-center">
            Only administrators can manage users on this Droplet. Ask an admin
            to give you the <code>admin</code> group membership.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="type-large-title text-label-primary">Users</h1>
        <button
          onClick={() => setShowInvite(true)}
          className="dp-btn-primary type-subheadline !py-2 !px-4 !min-h-[36px]"
        >
          <Plus size={14} />
          Invite user
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-system-red/10 border border-system-red/20 rounded type-footnote text-system-red flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* Invite form */}
      {showInvite && (
        <div className="dp-card p-4 mb-4 space-y-3">
          <p className="type-headline text-label-primary">New user</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              autoFocus
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value.toLowerCase())}
              placeholder="username"
              className="dp-input"
            />
            <input
              value={inviteDisplay}
              onChange={(e) => setInviteDisplay(e.target.value)}
              placeholder="Display name (optional)"
              className="dp-input"
            />
          </div>
          <input
            type="password"
            value={invitePassword}
            onChange={(e) => setInvitePassword(e.target.value)}
            placeholder="Password (min 8 chars)"
            className="dp-input"
            onKeyDown={(e) => e.key === "Enter" && handleInvite()}
          />
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleInvite}
              className="dp-btn-primary type-footnote !min-h-[36px] !py-1.5"
            >
              Create
            </button>
            <button
              onClick={() => {
                setShowInvite(false);
                setError(null);
              }}
              className="type-subheadline text-accent hover:text-accent-hover px-3 py-1.5 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* List */}
      <div className="dp-group">
        {loading && users.length === 0 ? (
          <div className="dp-row flex items-center justify-center text-label-tertiary type-subheadline">
            Loading…
          </div>
        ) : users.length === 0 ? (
          <div className="dp-row flex items-center justify-center text-label-tertiary type-subheadline">
            No users yet.
          </div>
        ) : (
          users.map((u) => (
            <div key={u.id} className="dp-row group">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-9 h-9 rounded-full bg-accent/15 flex items-center justify-center flex-shrink-0">
                  <UsersIcon size={14} className="text-accent" />
                </div>
                <div className="min-w-0">
                  <p className="type-callout text-label-primary truncate">
                    {u.displayName || u.id}
                  </p>
                  <p className="type-caption-1 text-label-tertiary truncate">
                    {u.id}
                    {u.id === currentUser?.username && (
                      <span className="ml-2 text-accent">· you</span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => openEdit(u)}
                  className="p-1.5 rounded-sm text-label-tertiary hover:text-accent hover:bg-accent-subtle transition-colors"
                  title="Edit"
                >
                  <Edit3 size={14} />
                </button>
                {u.id !== currentUser?.username && (
                  <>
                    <button
                      onClick={() => handleToggleEnabled(u, false)}
                      className="p-1.5 rounded-sm text-label-tertiary hover:text-system-orange hover:bg-system-orange/10 transition-colors"
                      title="Disable"
                    >
                      <Shield size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(u)}
                      className="p-1.5 rounded-sm text-label-quaternary hover:text-system-red hover:bg-system-red/10 transition-colors"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Edit dialog */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
          onClick={() => setEditing(null)}
        >
          <div
            className="bg-surface-primary rounded-lg max-w-md w-full shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
              <h3 className="type-headline text-label-primary">
                Edit {editing.id}
              </h3>
              <button
                onClick={() => setEditing(null)}
                className="p-1 text-label-tertiary hover:text-label-primary"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="type-caption-1 text-label-tertiary mb-1.5 block">
                  Display name
                </label>
                <input
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                  className="dp-input"
                />
              </div>
              <div>
                <label className="type-caption-1 text-label-tertiary mb-1.5 block">
                  Set new password (leave blank to keep)
                </label>
                <input
                  type="password"
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  className="dp-input"
                  placeholder="••••••••"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-separator">
              <button
                onClick={() => setEditing(null)}
                className="type-subheadline text-accent hover:text-accent-hover px-3 py-2 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleEditSave}
                className="dp-btn-primary type-subheadline !min-h-[36px] !py-1.5"
              >
                <Check size={14} />
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
