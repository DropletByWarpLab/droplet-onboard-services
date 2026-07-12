"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Edit3,
  X,
  Users as UsersIcon,
  UserPlus,
  ShieldOff,
  Shield,
  Check,
  Copy,
  RefreshCw,
  Link as LinkIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useAuth } from "@/lib/auth";
import {
  fetchUsers,
  createUser as apiCreateUser,
  deleteUser as apiDeleteUser,
  updateUser,
  setUserEnabled,
  createInvite,
  listInvites,
  revokeInvite as apiRevokeInvite,
  fetchUserUsage,
  updateUserUsage,
  fetchAdminFilesUsage,
} from "@/lib/api";
import { isValidEmail, validatePassword, PASSWORD_MIN } from "@droplet/auth-policy";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";
import type {
  AuthUser,
  RosterUser,
  InviteListItem,
  InviteRole,
  CreateUserRole,
  InviteCreateResponse,
  AdminUsageUserRow,
} from "@/lib/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, type BadgeKind } from "@/components/shell/primitives";

const TTL_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: "24 hours", hours: 24 },
  { label: "72 hours", hours: 72 },
  { label: "7 days", hours: 24 * 7 },
];

// ── WARP-1042: client-side temporary-password generation ──
// Three seeded character classes guarantee the @droplet/auth-policy
// PASSWORD_REQUIRED_CLASSES floor; the remaining characters draw from the
// combined pool and a crypto-seeded Fisher-Yates shuffle removes the fixed
// class positions. Ambiguous glyphs (0/O, 1/l/I) are excluded because this
// string is read aloud or retyped by a human during the handoff.
const TEMP_PW_LOWER = "abcdefghjkmnpqrstuvwxyz";
const TEMP_PW_UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const TEMP_PW_DIGITS = "23456789";
const TEMP_PW_ALL = TEMP_PW_LOWER + TEMP_PW_UPPER + TEMP_PW_DIGITS;

function generateTempPassword(): string {
  const length = Math.max(16, PASSWORD_MIN);
  const rand = new Uint32Array(length * 2);
  crypto.getRandomValues(rand);
  const pools = [TEMP_PW_LOWER, TEMP_PW_UPPER, TEMP_PW_DIGITS];
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    const pool = i < pools.length ? pools[i] : TEMP_PW_ALL;
    chars.push(pool[rand[i]! % pool.length]!);
  }
  // Fisher-Yates with the second half of the random buffer so the seeded
  // classes don't sit at predictable positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rand[length + (length - 1 - i)]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

// ── WARP-1271 (T19a): usage-settings display helpers ──

/** Byte count (as a decimal string, per the ADR-029 §8 BigInt-string wire
 *  contract) → a short human size ("4.1 GB"). `null`/unparseable → an em
 *  dash — never a fabricated "0 B", which would read as "this user has no
 *  data" rather than "we don't know". */
function formatBytes(value: string | null | undefined): string {
  if (value == null || value === "—") return "—";
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = n;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

const STORAGE_UNIT_BYTES = { GB: 1024 ** 3, TB: 1024 ** 4 } as const;
type StorageUnit = keyof typeof STORAGE_UNIT_BYTES;

/** Bytes string → the {value, unit} pair the numeric+unit-select control
 *  edits. Picks TB when the value divides evenly into TB and is at least
 *  1 TB, else GB (rounded to 1 decimal) — a fresh policy always starts
 *  from a whole-GB/TB value an admin typed, so this round-trips cleanly. */
function bytesToUnitValue(bytes: string | null): { value: string; unit: StorageUnit } {
  if (bytes == null) return { value: "", unit: "GB" };
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return { value: "", unit: "GB" };
  if (n >= STORAGE_UNIT_BYTES.TB && n % STORAGE_UNIT_BYTES.TB === 0) {
    return { value: String(n / STORAGE_UNIT_BYTES.TB), unit: "TB" };
  }
  return { value: String(Math.round((n / STORAGE_UNIT_BYTES.GB) * 10) / 10), unit: "GB" };
}

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
  const [users, setUsers] = useState<RosterUser[]>([]);
  // DASH-001: self-identity compares the LOCAL user UUID (u.userId ↔
  // currentUser.id), never the Nextcloud username (u.id) against the local
  // username — separate namespaces (WARP-947). Falls back to the username
  // compare only when the row has no linked local UUID.
  const isSelf = (u: RosterUser): boolean =>
    u.userId != null && currentUser?.id != null
      ? u.userId === currentUser.id
      : u.id === currentUser?.username;
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
  // WARP-650: label/input associations for the invite form fields.
  const inviteEmailId = useId();
  const inviteDisplayId = useId();
  const inviteRoleId = useId();
  const inviteTtlId = useId();
  // Held so we can restore focus to the trigger on Escape-close.
  const inviteTriggerRef = useRef<HTMLButtonElement | null>(null);

  // WARP-1042: Create-local-account dialog state — "form" and "handoff"
  // phases (mirrors the invite modal's form/share split). The temporary
  // password lives ONLY in this state: it is auto-generated on open,
  // shown once in the handoff phase, and dropped on close.
  const [showCreate, setShowCreate] = useState(false);
  const [createPhase, setCreatePhase] = useState<"form" | "handoff">("form");
  const [createEmail, setCreateEmail] = useState("");
  const [createDisplay, setCreateDisplay] = useState("");
  // Canonical Role vocabulary (review finding): this dialog is NEW code, so
  // it must not lean on the server's legacy "user"→"family" compat shim.
  const [createRole, setCreateRole] = useState<CreateUserRole>("family");
  const [createPassword, setCreatePassword] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  // WARP-874-style double-submit guard: disable Create + ignore re-entry
  // while the request is in flight.
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createPwCopied, setCreatePwCopied] = useState(false);
  const createHeadingId = useId();
  const createDisplayId = useId();
  const createEmailId = useId();
  const createRoleId = useId();
  const createPasswordId = useId();
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Auto-focus target when the dialog opens in the form phase.
  const createDisplayRef = useRef<HTMLInputElement | null>(null);
  // UX review (WARP-1042): the form→handoff flip unmounts the focused
  // "Create account" button; without an explicit focus move a keyboard or
  // screen-reader user is dropped onto document.body OUTSIDE the aria-modal
  // dialog and has to traverse the whole page to reach the show-once copy
  // controls. Focus the temp-password field on flip (its onFocus selects
  // the value, ready to copy).
  const createHandoffPwRef = useRef<HTMLInputElement | null>(null);

  // Edit dialog state.
  const [editing, setEditing] = useState<RosterUser | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editPassword, setEditPassword] = useState("");

  // WARP-1271 (T19a): Usage section state — storage quota (numeric + unit,
  // empty = no limit), upload cap (MB), and the read-only used-bytes meter.
  const [editStorageValue, setEditStorageValue] = useState("");
  const [editStorageUnit, setEditStorageUnit] = useState<StorageUnit>("GB");
  const [editUploadCapMb, setEditUploadCapMb] = useState("");
  const [editUsedBytes, setEditUsedBytes] = useState<string | null>(null);
  const [editUsageLoading, setEditUsageLoading] = useState(false);

  // WARP-1271 (T19a): roster "used / limit" column, keyed by local User.id.
  // Sourced from the admin usage-roster endpoint (one call for every row,
  // vs. N per-user calls) — best-effort, never blocks the roster itself.
  const [usageRoster, setUsageRoster] = useState<Record<string, AdminUsageUserRow>>({});

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
  // WARP-650: label/input associations for the Edit dialog fields.
  const editDisplayNameId = useId();
  const editPasswordId = useId();
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
      // WARP-1271 (T19a): the roster's "used / limit" column is best-effort
      // — a failed fetch (e.g. Nextcloud unreachable) leaves the column
      // blank rather than failing the whole page.
      try {
        const usage = await fetchAdminFilesUsage();
        const byUserId: Record<string, AdminUsageUserRow> = {};
        for (const row of usage.users) byUserId[row.userId] = row;
        setUsageRoster(byUserId);
      } catch {
        setUsageRoster({});
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

  // ── WARP-1042: Create-local-account dialog handlers ──
  const resetCreateForm = () => {
    setCreateEmail("");
    setCreateDisplay("");
    setCreateRole("family");
    setCreatePassword("");
    setCreatePhase("form");
    setCreateError(null);
    setCreatePwCopied(false);
  };

  const openCreate = () => {
    resetCreateForm();
    // Fresh policy-compliant temp password every time the dialog opens.
    setCreatePassword(generateTempPassword());
    setShowCreate(true);
  };

  const closeCreate = useCallback(() => {
    // Review finding (WARP-1042): never dismiss while the create request is
    // in flight — the server would still mint the account while the 0-tick
    // reset below wipes the show-once temp password, so the admin never sees
    // the credentials. Guarding here covers every dismiss path (Escape,
    // backdrop, X, Cancel).
    if (createSubmitting) return;
    setShowCreate(false);
    // Reset after the modal unmounts next tick — this also drops the
    // temporary password from state (show-once contract).
    setTimeout(() => {
      setCreateEmail("");
      setCreateDisplay("");
      setCreateRole("family");
      setCreatePassword("");
      setCreatePhase("form");
      setCreateError(null);
      setCreatePwCopied(false);
    }, 0);
    // Escape close + focus restore to the trigger are owned by the
    // <Dialog> primitive (WARP-289) the create dialog mounts on.
  }, [createSubmitting]);

  // Move focus into the handoff phase when the create dialog flips —
  // <Dialog> only auto-focuses on OPEN, and the previously-focused
  // "Create account" button unmounts on the flip.
  useEffect(() => {
    if (!showCreate || createPhase !== "handoff") return;
    // Defer a tick so the handoff subtree is in the DOM.
    const t = window.setTimeout(() => createHandoffPwRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [showCreate, createPhase]);

  const handleCreateAccount = async () => {
    if (createSubmitting) return;
    setCreateError(null);
    const email = createEmail.trim().toLowerCase();
    if (!email || !isValidEmail(email)) {
      setCreateError("Enter a valid email address.");
      return;
    }
    if (!validatePassword(createPassword).ok) {
      setCreateError("Password doesn't meet the requirements yet.");
      return;
    }
    setCreateSubmitting(true);
    try {
      // mustChangePassword is hard-wired TRUE in this dialog — it only
      // mints temp-credential handoffs; the person chooses their own
      // password at first sign-in (WARP-824 forced-change gate).
      await apiCreateUser(
        email,
        createPassword,
        createDisplay.trim() || undefined,
        true,
        createRole,
      );
      setCreateEmail(email);
      setCreatePhase("handoff");
      // Refresh the roster behind the dialog; non-fatal if it fails.
      void reload();
    } catch (err: any) {
      setCreateError(err?.message || "Failed to create the account");
    } finally {
      setCreateSubmitting(false);
    }
  };

  const handleCopyTempPassword = async () => {
    try {
      await navigator.clipboard.writeText(createPassword);
      setCreatePwCopied(true);
      setTimeout(() => setCreatePwCopied(false), 2000);
    } catch {
      // Clipboard might be blocked (insecure context); the field stays
      // selectable so the admin can copy manually.
    }
  };

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

  const handleDelete = (u: RosterUser) => {
    if (isSelf(u)) {
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

  const openEdit = (u: RosterUser) => {
    // Capture the activating element so we can restore focus on close —
    // each row has its own Edit button, so a single ref pinned to the
    // page root would land focus in the wrong place.
    editTriggerRef.current = (document.activeElement as HTMLElement) ?? null;
    setEditing(u);
    setEditDisplayName(u.displayName || "");
    setEditPassword("");
    setEditStorageValue("");
    setEditStorageUnit("GB");
    setEditUploadCapMb("");
    setEditUsedBytes(null);

    // WARP-1271 (T19a): usage settings key on the LOCAL User UUID
    // (RosterUser.userId), not the Nextcloud username — rows without a
    // matching local row (userId: null) have no usage policy surface yet.
    if (u.userId) {
      setEditUsageLoading(true);
      fetchUserUsage(u.userId)
        .then((usage) => {
          const { value, unit } = bytesToUnitValue(usage.policy?.storageQuotaBytes ?? null);
          setEditStorageValue(value);
          setEditStorageUnit(unit);
          setEditUploadCapMb(
            usage.policy?.maxUploadSizeMb != null ? String(usage.policy.maxUploadSizeMb) : "",
          );
          setEditUsedBytes(usage.usedBytes);
        })
        .catch(() => {
          // Best-effort — the rest of the Edit dialog still works.
        })
        .finally(() => setEditUsageLoading(false));
    }
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

    // WARP-1271 (T19a): storage quota + upload cap. Empty storage value =
    // "No limit" → storageQuotaBytes: null (explicit clear, not "unchanged"
    // — the field is always sent when a userId exists, since the dialog
    // always shows the current desired state, not a sparse diff).
    let usagePatch: { storageQuotaBytes?: string | null; maxUploadSizeMb?: number | null } | null = null;
    if (editing.userId) {
      const trimmedStorage = editStorageValue.trim();
      let storageQuotaBytes: string | null = null;
      if (trimmedStorage) {
        const n = Number(trimmedStorage);
        if (!Number.isFinite(n) || n <= 0) {
          setError("Storage limit must be a positive number.");
          return;
        }
        storageQuotaBytes = String(Math.round(n * STORAGE_UNIT_BYTES[editStorageUnit]));
      }
      const trimmedUpload = editUploadCapMb.trim();
      let maxUploadSizeMb: number | null = null;
      if (trimmedUpload) {
        const n = Number(trimmedUpload);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          setError("Upload cap must be a positive whole number of MB.");
          return;
        }
        maxUploadSizeMb = n;
      }
      usagePatch = { storageQuotaBytes, maxUploadSizeMb };
    }

    if (!patch.displayName && !patch.password && !usagePatch) {
      closeEdit();
      return;
    }
    try {
      if (patch.displayName || patch.password) {
        await updateUser(editing.id, patch);
      }
      if (usagePatch && editing.userId) {
        await updateUserUsage(editing.userId, usagePatch);
      }
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
        <div className="flex items-center gap-2">
          {/* WARP-1042: mint a ready-to-use account with a temporary
              password — the no-email sibling of the invite flow. */}
          <button
            ref={createTriggerRef}
            onClick={openCreate}
            className="btn ghost"
            type="button"
          >
            <UserPlus size={14} />
            Create local account
          </button>
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
        </div>
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
                  {isSelf(u) && (
                    <span style={{ color: "var(--brand)" }}> · you</span>
                  )}
                </span>
              </span>
              {/* WARP-1271 (T19a): "used / limit" — mono, matches the
                  identity sub-line's treatment. Blank (not "—") when the
                  row has no local userId yet or the roster fetch failed;
                  a bare em dash on every row would read as "everyone has
                  no data", which is worse than showing nothing. */}
              {u.userId && usageRoster[u.userId] && (
                <span className="sub mono" style={{ color: "var(--text-faint)" }}>
                  {formatBytes(usageRoster[u.userId]!.used)} /{" "}
                  {usageRoster[u.userId]!.quota != null
                    ? formatBytes(usageRoster[u.userId]!.quota)
                    : "No limit"}
                </span>
              )}
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
                {!isSelf(u) && (
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
          className="droplet-shell fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm p-6"
          style={{ position: "fixed", background: "var(--scrim)" }}
          onClick={closeInvite}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={inviteHeadingId}
            className="max-w-md w-full overflow-hidden"
            style={{
              background: "var(--card-bg)",
              border: "1px solid var(--card-bd)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--lift)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderBottom: "1px solid var(--card-bd)" }}
            >
              <h3 id={inviteHeadingId} className="type-headline" style={{ color: "var(--text)" }}>
                {invitePhase === "form" ? "Invite user" : "Share this link"}
              </h3>
              <button
                onClick={closeInvite}
                className="p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                <X size={18} />
              </button>
            </div>

            {invitePhase === "form" ? (
              <>
                <div className="p-4 space-y-3">
                  <div>
                    <label htmlFor={inviteEmailId} className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                      Work email
                    </label>
                    <input
                      id={inviteEmailId}
                      autoFocus
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="you@company.com"
                      className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-input)",
                        color: "var(--text)",
                      }}
                    />
                  </div>
                  <div>
                    <label htmlFor={inviteDisplayId} className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                      Display name (optional)
                    </label>
                    <input
                      id={inviteDisplayId}
                      value={inviteDisplay}
                      onChange={(e) => setInviteDisplay(e.target.value)}
                      placeholder="Display name"
                      className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-input)",
                        color: "var(--text)",
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={inviteRoleId} className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                        Role
                      </label>
                      <select
                        id={inviteRoleId}
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as InviteRole)}
                        className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                        style={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius-input)",
                          color: "var(--text)",
                        }}
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor={inviteTtlId} className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                        Link expires in
                      </label>
                      <select
                        id={inviteTtlId}
                        value={inviteTtlHours}
                        onChange={(e) => setInviteTtlHours(Number(e.target.value))}
                        className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                        style={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius-input)",
                          color: "var(--text)",
                        }}
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
                <div
                  className="flex items-center justify-end gap-2 px-4 py-3"
                  style={{ borderTop: "1px solid var(--card-bd)" }}
                >
                  <button
                    onClick={closeInvite}
                    className="btn ghost"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleGenerateInvite}
                    disabled={inviteSubmitting}
                    className="btn primary"
                  >
                    {inviteSubmitting ? "Generating..." : "Generate link"}
                  </button>
                </div>
              </>
            ) : (
              <div className="p-4 space-y-4">
                <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
                  Send this link to {inviteEmail || "the new user"}. They'll set their own
                  password and join automatically.
                </p>
                {inviteResult && (
                  <>
                    <div
                      role="img"
                      aria-label={`QR code containing invite link for ${inviteEmail || "the new user"}`}
                      className="flex items-center justify-center p-4"
                      style={{ background: "var(--inset)", borderRadius: "var(--radius-card)" }}
                    >
                      {/* Solid white behind the QR — scanner contrast, not a
                          theme surface (mirrors PairDialog, WARP-1079). */}
                      <div className="p-4 bg-white rounded-[var(--radius-card)]">
                        <QRCodeSVG value={inviteResult.url} size={160} level="M" />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        readOnly
                        value={inviteResult.url}
                        className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors flex-1 type-footnote"
                        style={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius-input)",
                          color: "var(--text)",
                        }}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button
                        onClick={handleCopyInviteUrl}
                        className="btn ghost sm flex-shrink-0"
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
                    <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
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
                    className="btn primary"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* WARP-1042: Create local account dialog — mounted on the canonical
          <Dialog> primitive (WARP-289) so it inherits the focus trap,
          scroll-lock, Escape close, reduced-motion handling and
          focus-restore-to-trigger. Backdrop dismissal is disabled during
          the handoff phase so a stray click can't drop the show-once
          temporary password (explicit Done / X / Escape still work, and
          the Edit dialog can reset the password if it is lost anyway). */}
      <Dialog
        open={showCreate}
        onClose={closeCreate}
        triggerRef={createTriggerRef}
        labelledBy={createHeadingId}
        closeOnBackdrop={createPhase === "form"}
        initialFocusRef={createDisplayRef}
        // Sectioned layout (full-width header divider) — sections own their
        // padding (WARP-1153).
        flush
      >
        <>
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderBottom: "1px solid var(--card-bd)" }}
            >
              <h3 id={createHeadingId} className="type-headline" style={{ color: "var(--text)" }}>
                {createPhase === "form" ? "Create local account" : "Hand off the sign-in details"}
              </h3>
              <button
                onClick={closeCreate}
                aria-label="Close dialog"
                className="p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
                type="button"
              >
                <X size={18} />
              </button>
            </div>

            {createPhase === "form" ? (
              <>
                <div className="p-4 space-y-3">
                  <div>
                    <label
                      htmlFor={createDisplayId}
                      className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}
                    >
                      Display name (optional)
                    </label>
                    <input
                      id={createDisplayId}
                      ref={createDisplayRef}
                      value={createDisplay}
                      onChange={(e) => setCreateDisplay(e.target.value)}
                      placeholder="Display name"
                      className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-input)",
                        color: "var(--text)",
                      }}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={createEmailId}
                      className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}
                    >
                      Login email
                    </label>
                    <input
                      id={createEmailId}
                      type="email"
                      value={createEmail}
                      onChange={(e) => setCreateEmail(e.target.value)}
                      placeholder="alex@example.com"
                      className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-input)",
                        color: "var(--text)",
                      }}
                    />
                    {/* text-label-secondary, not tertiary: load-bearing helper
                        copy must clear WCAG 1.4.3 (tertiary ≈ 1.7:1 at caption
                        size — UX review WARP-1042). The class stays as the
                        pinned contrast contract (users.local-account.test.tsx);
                        the rendered color is the indigo --text-muted, which
                        also clears 4.5:1 in both themes (WARP-1080). */}
                    <p
                      className="type-caption-1 text-label-secondary mt-1.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Used to sign in — doesn't need to receive mail.
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor={createRoleId}
                      className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}
                    >
                      Role
                    </label>
                    <select
                      id={createRoleId}
                      value={createRole}
                      onChange={(e) => setCreateRole(e.target.value as CreateUserRole)}
                      className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-input)",
                        color: "var(--text)",
                      }}
                    >
                      <option value="family">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor={createPasswordId}
                      className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}
                    >
                      Temporary password
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id={createPasswordId}
                        value={createPassword}
                        onChange={(e) => setCreatePassword(e.target.value)}
                        className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors flex-1 font-mono type-footnote"
                        style={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius-input)",
                          color: "var(--text)",
                        }}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        onClick={() => setCreatePassword(generateTempPassword())}
                        className="btn primary sm flex-shrink-0"
                        aria-label="Regenerate password"
                        type="button"
                      >
                        <RefreshCw size={14} /> Regenerate
                      </button>
                    </div>
                    {/* Class = pinned WCAG contract (users.local-account.test.tsx);
                        rendered color = indigo --text-muted (WARP-1080). */}
                    <p
                      className="type-caption-1 text-label-secondary mt-1.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Auto-generated to meet the password rules — you can type your
                      own instead. They'll be asked to replace it at first sign-in.
                    </p>
                    {createPassword && !validatePassword(createPassword).ok && (
                      <PasswordRulesChecklist password={createPassword} />
                    )}
                  </div>
                  {createError && (
                    <p role="alert" className="type-footnote text-system-red">
                      {createError}
                    </p>
                  )}
                </div>
                <div
                  className="flex items-center justify-end gap-2 px-4 py-3"
                  style={{ borderTop: "1px solid var(--card-bd)" }}
                >
                  <button
                    onClick={closeCreate}
                    className="btn ghost"
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateAccount}
                    disabled={createSubmitting}
                    className="btn primary"
                    type="button"
                  >
                    Create account
                  </button>
                </div>
              </>
            ) : (
              <div className="p-4 space-y-4">
                <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
                  Give them this email and temporary password — they'll choose
                  their own the first time they sign in.
                </p>
                <div>
                  <label
                    htmlFor={createEmailId}
                    className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}
                  >
                    Sign-in email
                  </label>
                  <input
                    id={createEmailId}
                    readOnly
                    value={createEmail}
                    className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors font-mono type-footnote"
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-input)",
                      color: "var(--text)",
                    }}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
                <div>
                  <label
                    htmlFor={createPasswordId}
                    className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}
                  >
                    Temporary password
                  </label>
                  <div className="flex items-stretch gap-2">
                    <input
                      id={createPasswordId}
                      ref={createHandoffPwRef}
                      readOnly
                      value={createPassword}
                      className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors flex-1 font-mono type-footnote"
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-input)",
                        color: "var(--text)",
                      }}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button
                      onClick={handleCopyTempPassword}
                      className="btn ghost sm flex-shrink-0"
                      aria-label="Copy temporary password"
                      type="button"
                    >
                      {createPwCopied ? (
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
                  {/* The single most consequence-bearing sentence in the
                      dialog — secondary emphasis so it clears WCAG 1.4.3. The
                      class stays as the pinned contrast contract
                      (users.local-account.test.tsx); the rendered color is the
                      indigo --text-muted (WARP-1080). */}
                  <p
                    className="type-caption-1 text-label-secondary mt-1.5"
                    style={{ color: "var(--text-muted)" }}
                  >
                    This password won't be shown again after you close this dialog.
                  </p>
                </div>
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    onClick={closeCreate}
                    className="btn primary"
                    type="button"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
        </>
      </Dialog>

      {/* Edit dialog */}
      {editing && (
        <div
          className="droplet-shell fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm p-6"
          style={{ position: "fixed", background: "var(--scrim)" }}
          onClick={closeEdit}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={editHeadingId}
            className="max-w-md w-full overflow-hidden"
            style={{
              background: "var(--card-bg)",
              border: "1px solid var(--card-bd)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--lift)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderBottom: "1px solid var(--card-bd)" }}
            >
              <h3 id={editHeadingId} className="type-headline" style={{ color: "var(--text)" }}>
                Edit {editing.id}
              </h3>
              <button
                onClick={closeEdit}
                className="p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label htmlFor={editDisplayNameId} className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                  Display name
                </label>
                <input
                  id={editDisplayNameId}
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                />
              </div>
              <div>
                <label htmlFor={editPasswordId} className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                  Set new password (leave blank to keep)
                </label>
                <input
                  id={editPasswordId}
                  type="password"
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                  placeholder="••••••••"
                />
                {editPassword && (
                  <PasswordRulesChecklist password={editPassword} />
                )}
              </div>

              {/* WARP-1271 (T19a) — Usage section. Only meaningful for rows
                  with a local User row (userId); the roster otherwise still
                  lists Nextcloud-only accounts, but they have no local
                  UsagePolicy surface to edit yet. */}
              {editing.userId && (
                <div className="pt-2" style={{ borderTop: "1px solid var(--card-bd)" }}>
                  <div
                    className="type-caption-1 mb-1.5"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Usage
                  </div>
                  <div className="space-y-2.5">
                    <div>
                      <label
                        className="type-caption-1 mb-1.5 block"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Storage limit
                      </label>
                      <div className="flex gap-1.5">
                        <input
                          type="number"
                          min={0}
                          step="any"
                          inputMode="decimal"
                          value={editStorageValue}
                          onChange={(e) => setEditStorageValue(e.target.value)}
                          placeholder="No limit"
                          aria-label="Storage limit"
                          className="flex-1 px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                          style={{
                            background: "var(--surface)",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-input)",
                            color: "var(--text)",
                          }}
                        />
                        <select
                          value={editStorageUnit}
                          onChange={(e) => setEditStorageUnit(e.target.value as StorageUnit)}
                          aria-label="Storage limit unit"
                          className="px-2.5 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
                          style={{
                            background: "var(--surface)",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-input)",
                            color: "var(--text)",
                          }}
                        >
                          <option value="GB">GB</option>
                          <option value="TB">TB</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label
                        className="type-caption-1 mb-1.5 block"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Upload cap (MB per file)
                      </label>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={editUploadCapMb}
                        onChange={(e) => setEditUploadCapMb(e.target.value)}
                        placeholder="Device default"
                        aria-label="Upload cap in megabytes"
                        className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
                        style={{
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius-input)",
                          color: "var(--text)",
                        }}
                      />
                    </div>
                    <div className="type-caption-1 mono" style={{ color: "var(--text-faint)" }}>
                      {editUsageLoading ? "Loading usage…" : `${formatBytes(editUsedBytes)} used`}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div
              className="flex items-center justify-end gap-2 px-4 py-3"
              style={{ borderTop: "1px solid var(--card-bd)" }}
            >
              <button
                onClick={closeEdit}
                className="btn ghost"
              >
                Cancel
              </button>
              <button
                onClick={handleEditSave}
                className="btn primary"
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
