"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Edit3,
  X,
  Users as UsersIcon,
  ShieldOff,
  Shield,
  Check,
  Copy,
  Link as LinkIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useAuth } from "@/lib/auth";
import {
  fetchUsers,
  deleteUser as apiDeleteUser,
  updateUser,
  setUserEnabled,
  createInvite,
  listInvites,
  revokeInvite as apiRevokeInvite,
} from "@/lib/api";
import { isValidEmail, validatePassword } from "@droplet/auth-policy";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";
import type {
  AuthUser,
  InviteListItem,
  InviteRole,
  InviteCreateResponse,
} from "@/lib/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, type BadgeKind } from "@/components/shell/primitives";

const TTL_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: "24 hours", hours: 24 },
  { label: "72 hours", hours: 72 },
  { label: "7 days", hours: 24 * 7 },
];

/**
 * Admin-only user management page. Non-admin callers get a 403 from the
 * orchestrator on fetchUsers; we detect that and show a friendly notice
 * instead of letting the error bubble up.
 *
 * WARP-217: invite UX is now token-based — no admin-typed passwords. The
 * "Invite user" button opens a modal that POSTs to /api/auth/invites and
 * flips into a "Share this link" view with URL + QR + copy action. A new
 * "Pending invites" section below the user list lets admins see and
 * revoke outstanding invites.
 */
export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [invites, setInvites] = useState<InviteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Invite modal state — split into "form" and "share" phases.
  const [showInvite, setShowInvite] = useState(false);
  const [invitePhase, setInvitePhase] = useState<"form" | "share">("form");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteDisplay, setInviteDisplay] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("user");
  const [inviteTtlHours, setInviteTtlHours] = useState<number>(72);
  const [inviteResult, setInviteResult] = useState<InviteCreateResponse | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);

  // Stable id used to wire up `aria-labelledby` on the invite dialog.
  const inviteHeadingId = useId();
  // Held so we can restore focus to the trigger on Escape-close.
  const inviteTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Edit dialog state.
  const [editing, setEditing] = useState<AuthUser | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editPassword, setEditPassword] = useState("");

  // WARP-291: ConfirmDialog targets for the three destructive flows that
  // used to hit `window.confirm()`. Storing the target object (not just a
  // boolean) lets the dialog body render the username/displayName.
  const [revokeInvite, setRevokeInvite] = useState<InviteListItem | null>(null);
  const [deleteUserTarget, setDeleteUserTarget] = useState<AuthUser | null>(null);
  const [disableUserTarget, setDisableUserTarget] = useState<AuthUser | null>(
    null,
  );
  const { toast } = useToast();

  // Stable id for the Edit dialog headline (mirrors invite dialog pattern).
  const editHeadingId = useId();
  // The element that opened the Edit dialog — captured at open time so we
  // can restore focus on close. Each user row owns its own Edit button so
  // a single ref isn't sufficient; capture document.activeElement instead.
  const editTriggerRef = useRef<HTMLElement | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchUsers();
      setUsers(data.users || []);
      setIsAdmin(true);
      try {
        const inviteData = await listInvites();
        setInvites(inviteData.invites || []);
      } catch {
        // Pending invites are nice-to-have; if the orchestrator hasn't
        // migrated yet, don't block the user list.
        setInvites([]);
      }
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

  const resetInviteForm = () => {
    setInviteEmail("");
    setInviteDisplay("");
    setInviteRole("user");
    setInviteTtlHours(72);
    setInvitePhase("form");
    setInviteResult(null);
    setInviteCopied(false);
  };

  const closeInvite = useCallback(() => {
    setShowInvite(false);
    setError(null);
    // Reset only after the modal animates out next tick — minor polish.
    setTimeout(resetInviteForm, 0);
    // Restore focus to the "Invite user" trigger so keyboard users land
    // back where they came from (Tier-2 dialog heuristic).
    setTimeout(() => inviteTriggerRef.current?.focus(), 0);
  }, []);

  // Close the invite modal on Escape (Tier-2 dialog semantics).
  useEffect(() => {
    if (!showInvite) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeInvite();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showInvite, closeInvite]);

  const handleGenerateInvite = async () => {
    setError(null);
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !isValidEmail(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setInviteSubmitting(true);
    try {
      const result = await createInvite({
        email,
        displayName: inviteDisplay.trim() || undefined,
        role: inviteRole,
        ttlHours: inviteTtlHours,
      });
      setInviteResult(result);
      setInvitePhase("share");
      // Refresh the pending list.
      try {
        const inviteData = await listInvites();
        setInvites(inviteData.invites || []);
      } catch {
        // ignore
      }
    } catch (err: any) {
      setError(err?.message || "Failed to create invite");
    } finally {
      setInviteSubmitting(false);
    }
  };

  const handleCopyInviteUrl = async () => {
    if (!inviteResult) return;
    try {
      await navigator.clipboard.writeText(inviteResult.url);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      // Clipboard might be blocked (insecure context); leave the textbox
      // visible so the admin can manually select the link.
    }
  };

  const performRevokeInvite = async () => {
    const invite = revokeInvite;
    if (!invite) return;
    setError(null);
    // Optimistic: mark revoked locally; rollback on failure. Mirrors
    // the WARP-291 pattern (snapshot-and-rollback for destructives).
    const before = invites;
    setInvites((prev) =>
      prev.map((i) =>
        i.token === invite.token ? { ...i, revokedAt: new Date().toISOString() } : i,
      ),
    );
    try {
      await apiRevokeInvite(invite.token);
      setRevokeInvite(null);
      toast(`Invite for ${invite.username} revoked.`, "success");
    } catch (err: any) {
      setInvites(before);
      setError(err?.message || "Failed to revoke invite");
      throw err;
    }
  };

  const handleDelete = (u: AuthUser) => {
    if (u.id === currentUser?.username) {
      setError("You can't delete your own account.");
      return;
    }
    setDeleteUserTarget(u);
  };

  const performDeleteUser = async () => {
    const u = deleteUserTarget;
    if (!u) return;
    try {
      await apiDeleteUser(u.id);
      setDeleteUserTarget(null);
      toast(`Deleted ${u.id}.`, "success");
      await reload();
    } catch (err: any) {
      setError(err?.message || "Failed to delete user");
      throw err;
    }
  };

  // Enabling a user is recoverable and the audit doesn't ask for a confirm;
  // disabling is also recoverable but cuts a real user off, so we surface
  // the consequence first.
  const handleSetEnabled = (u: AuthUser, enabled: boolean) => {
    if (!enabled) {
      setDisableUserTarget(u);
      return;
    }
    void performEnable(u);
  };

  const performEnable = async (u: AuthUser) => {
    try {
      await setUserEnabled(u.id, true);
      await reload();
    } catch (err: any) {
      setError(err?.message || "Failed to enable user");
    }
  };

  const performDisable = async () => {
    const u = disableUserTarget;
    if (!u) return;
    try {
      await setUserEnabled(u.id, false);
      setDisableUserTarget(null);
      toast(`${u.id} disabled.`, "success");
      await reload();
    } catch (err: any) {
      setError(err?.message || "Failed to disable user");
      throw err;
    }
  };

  const openEdit = (u: AuthUser) => {
    // Capture the activating element so we can restore focus on close —
    // each row has its own Edit button, so a single ref pinned to the
    // page root would land focus in the wrong place.
    editTriggerRef.current = (document.activeElement as HTMLElement) ?? null;
    setEditing(u);
    setEditDisplayName(u.displayName || "");
    setEditPassword("");
  };

  const closeEdit = useCallback(() => {
    setEditing(null);
    // Restore focus to the row's Edit button (Tier-2 dialog heuristic;
    // mirrors the invite modal's close path).
    setTimeout(() => editTriggerRef.current?.focus(), 0);
  }, []);

  // Close the Edit dialog on Escape (mirrors the invite modal).
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, closeEdit]);

  const handleEditSave = async () => {
    if (!editing) return;
    const patch: { displayName?: string; password?: string } = {};
    if (editDisplayName.trim() && editDisplayName !== editing.displayName) {
      patch.displayName = editDisplayName.trim();
    }
    if (editPassword.trim()) {
      if (!validatePassword(editPassword).ok) {
        setError("Password doesn't meet the requirements yet.");
        return;
      }
      patch.password = editPassword;
    }
    if (!patch.displayName && !patch.password) {
      closeEdit();
      return;
    }
    try {
      await updateUser(editing.id, patch);
      closeEdit();
      await reload();
    } catch (err: any) {
      setError(err?.message || "Failed to update user");
    }
  };

  if (isAdmin === false) {
    return (
      <ShellPage icon={<UsersIcon size={15} />} label="Users" title="Users">
        <div className="card">
          <div className="empty">
            <span className="ei">
              <ShieldOff size={24} />
            </span>
            <span className="eh">Admin access required</span>
            <span style={{ maxWidth: "32ch" }}>
              Only administrators can manage users on this Droplet. Ask an admin
              to give you the <code>admin</code> group membership.
            </span>
          </div>
        </div>
      </ShellPage>
    );
  }

  // Status pill copy + badge kind for the pending-invites list.
  function inviteStatus(i: InviteListItem): { label: string; kind: BadgeKind } {
    if (i.revokedAt) return { label: "Revoked", kind: "muted" };
    if (i.acceptedAt) return { label: "Accepted", kind: "ok" };
    if (new Date(i.expiresAt).getTime() < Date.now())
      return { label: "Expired", kind: "warn" };
    return { label: "Pending", kind: "info" };
  }

  return (
    <ShellPage
      icon={<UsersIcon size={15} />}
      label="Users"
      title="Users"
      sub="Manage who can access this Droplet — invite teammates, set their role, and revoke access."
      actions={
        <button
          ref={inviteTriggerRef}
          onClick={() => {
            resetInviteForm();
            setShowInvite(true);
          }}
          className="btn primary"
          type="button"
        >
          <Plus size={14} />
          Invite user
        </button>
      }
    >
      {error && (
        <div
          className="card"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 16px",
            borderColor: "rgba(239,68,68,0.25)",
            background: "rgba(239,68,68,0.08)",
            color: "#ef4444",
            fontSize: 13,
          }}
        >
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error" type="button">
            <X size={14} />
          </button>
        </div>
      )}

      {/* User list */}
      <div className="card">
        {loading && users.length === 0 ? (
          <div className="empty" style={{ padding: "32px 20px" }}>
            Loading…
          </div>
        ) : users.length === 0 ? (
          <div className="empty">
            <span className="ei">
              <UsersIcon size={24} />
            </span>
            <span className="eh">No users yet</span>
            <span>Invite a teammate to get started.</span>
          </div>
        ) : (
          <div className="rows">
          {users.map((u) => {
            // aria-label uses the row's primary visible identifier so
            // screen-reader announcements match what sighted users see.
            const label = u.displayName || u.id;
            return (
            <div key={u.id} className="lrow">
              <span className="ri brand">
                <UsersIcon size={15} />
              </span>
              <span className="rt">
                <span className="nm">{u.displayName || u.id}</span>
                <span className="sub mono">
                  {u.id}
                  {u.id === currentUser?.username && (
                    <span style={{ color: "var(--brand)" }}> · you</span>
                  )}
                </span>
              </span>
              {/*
                Row actions are always rendered (not opacity-gated on hover) so
                they're discoverable on touch and reachable for keyboard-only
                users. Each button carries an aria-label naming the action +
                target user; the visual icons stay restrained via the muted
                text-label-tertiary token. Padding token p-2.5 yields a
                34 px × 34 px hit-target around the 14 px Lucide glyph,
                clearing the ≥ 32 px floor in the ui-ux brief.
              */}
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => openEdit(u)}
                  aria-label={`Edit user ${label}`}
                  className="p-2.5 rounded-sm text-label-tertiary hover:text-accent hover:bg-accent-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
                  title="Edit"
                >
                  <Edit3 size={14} />
                </button>
                {u.id !== currentUser?.username && (
                  <>
                    <button
                      onClick={() => handleSetEnabled(u, false)}
                      aria-label={`Disable user ${label}`}
                      className="p-2.5 rounded-sm text-label-tertiary hover:text-system-orange hover:bg-system-orange/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
                      title="Disable"
                    >
                      <Shield size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(u)}
                      aria-label={`Delete user ${label}`}
                      className="p-2.5 rounded-sm text-label-quaternary hover:text-system-red hover:bg-system-red/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
            );
          })}
          </div>
        )}
      </div>

      {/* Pending invites */}
      {invites.length > 0 && (
        <div>
          <div className="sect">
            <h2>Pending invites</h2>
          </div>
          <div className="card">
            <div className="rows">
            {invites.map((i) => {
              const status = inviteStatus(i);
              const canRevoke = !i.revokedAt && !i.acceptedAt;
              // Mirror the row's primary visible label (displayName falls
              // back to username) so the screen-reader announcement matches.
              const inviteLabel = i.displayName || i.username;
              return (
                <div key={i.token} className="lrow">
                  <span className="ri brand">
                    <LinkIcon size={15} />
                  </span>
                  <span className="rt">
                    <span className="nm">{i.displayName || i.username}</span>
                    <span className="sub mono">
                      {i.username} · {i.role === "admin" ? "admin" : "user"} · invited by{" "}
                      {i.createdBy}
                    </span>
                  </span>
                  <Badge kind={status.kind}>{status.label}</Badge>
                  {canRevoke && (
                    <div className="flex items-center gap-0.5">
                      <button
                        onClick={() => setRevokeInvite(i)}
                        aria-label={`Revoke invite for ${inviteLabel}`}
                        className="p-2.5 rounded-sm text-label-quaternary hover:text-system-red hover:bg-system-red/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors type-caption-1 px-2"
                        title="Revoke invite"
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            </div>
          </div>
        </div>
      )}

      {/* Invite modal */}
      {showInvite && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
          onClick={closeInvite}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={inviteHeadingId}
            className="bg-surface-primary rounded-lg max-w-md w-full shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
              <h3 id={inviteHeadingId} className="type-headline text-label-primary">
                {invitePhase === "form" ? "Invite user" : "Share this link"}
              </h3>
              <button
                onClick={closeInvite}
                className="p-1 text-label-tertiary hover:text-label-primary"
              >
                <X size={18} />
              </button>
            </div>

            {invitePhase === "form" ? (
              <>
                <div className="p-4 space-y-3">
                  <div>
                    <label className="type-caption-1 text-label-tertiary mb-1.5 block">
                      Work email
                    </label>
                    <input
                      autoFocus
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="you@company.com"
                      className="dp-input"
                    />
                  </div>
                  <div>
                    <label className="type-caption-1 text-label-tertiary mb-1.5 block">
                      Display name (optional)
                    </label>
                    <input
                      value={inviteDisplay}
                      onChange={(e) => setInviteDisplay(e.target.value)}
                      placeholder="Display name"
                      className="dp-input"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="type-caption-1 text-label-tertiary mb-1.5 block">
                        Role
                      </label>
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as InviteRole)}
                        className="dp-input"
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <div>
                      <label className="type-caption-1 text-label-tertiary mb-1.5 block">
                        Link expires in
                      </label>
                      <select
                        value={inviteTtlHours}
                        onChange={(e) => setInviteTtlHours(Number(e.target.value))}
                        className="dp-input"
                      >
                        {TTL_OPTIONS.map((opt) => (
                          <option key={opt.hours} value={opt.hours}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-separator">
                  <button
                    onClick={closeInvite}
                    className="type-subheadline text-accent hover:text-accent-hover px-3 py-2 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleGenerateInvite}
                    disabled={inviteSubmitting}
                    className="dp-btn-primary type-subheadline !min-h-[36px] !py-1.5"
                  >
                    {inviteSubmitting ? "Generating..." : "Generate link"}
                  </button>
                </div>
              </>
            ) : (
              <div className="p-4 space-y-4">
                <p className="type-subheadline text-label-secondary">
                  Send this link to {inviteEmail || "the new user"}. They'll set their own
                  password and join automatically.
                </p>
                {inviteResult && (
                  <>
                    <div
                      role="img"
                      aria-label={`QR code containing invite link for ${inviteEmail || "the new user"}`}
                      className="flex items-center justify-center bg-surface-secondary rounded-lg p-4"
                    >
                      <QRCodeSVG value={inviteResult.url} size={160} level="M" />
                    </div>
                    <div className="flex items-stretch gap-2">
                      <input
                        readOnly
                        value={inviteResult.url}
                        className="dp-input flex-1 type-footnote"
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button
                        onClick={handleCopyInviteUrl}
                        className="dp-btn-primary type-footnote !min-h-0 !py-2 !px-3 flex-shrink-0"
                        aria-label="Copy invite link"
                      >
                        {inviteCopied ? (
                          <>
                            <Check size={14} /> Copied
                          </>
                        ) : (
                          <>
                            <Copy size={14} /> Copy
                          </>
                        )}
                      </button>
                    </div>
                    <p className="type-caption-1 text-label-tertiary">
                      Expires{" "}
                      {new Date(inviteResult.expiresAt).toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                      .
                    </p>
                  </>
                )}
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    onClick={closeInvite}
                    className="dp-btn-primary type-subheadline !min-h-[36px] !py-1.5"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Edit dialog */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
          onClick={closeEdit}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={editHeadingId}
            className="bg-surface-primary rounded-lg max-w-md w-full shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
              <h3 id={editHeadingId} className="type-headline text-label-primary">
                Edit {editing.id}
              </h3>
              <button
                onClick={closeEdit}
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
                {editPassword && (
                  <PasswordRulesChecklist password={editPassword} />
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-separator">
              <button
                onClick={closeEdit}
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

      <ConfirmDialog
        open={revokeInvite !== null}
        onConfirm={performRevokeInvite}
        onCancel={() => setRevokeInvite(null)}
        title={
          revokeInvite
            ? `Revoke invite for "${revokeInvite.username}"?`
            : "Revoke invite?"
        }
        description="They won't be able to use this link anymore. If you change your mind, send them a fresh invite."
        confirmLabel="Revoke"
        variant="destructive"
      />

      <ConfirmDialog
        open={deleteUserTarget !== null}
        onConfirm={performDeleteUser}
        onCancel={() => setDeleteUserTarget(null)}
        title={
          deleteUserTarget
            ? `Delete user "${deleteUserTarget.id}"?`
            : "Delete user?"
        }
        description="The account, sessions, and all per-user state are removed. This cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
      />

      <ConfirmDialog
        open={disableUserTarget !== null}
        onConfirm={performDisable}
        onCancel={() => setDisableUserTarget(null)}
        title={
          disableUserTarget
            ? `Disable "${disableUserTarget.id}"?`
            : "Disable user?"
        }
        description="They won't be able to sign in or use paired devices until you re-enable them."
        confirmLabel="Disable"
        variant="destructive"
      />
    </ShellPage>
  );
}
