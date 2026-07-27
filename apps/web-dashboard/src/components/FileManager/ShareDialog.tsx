"use client";

import { useEffect, useState } from "react";
import {
  X,
  Link as LinkIcon,
  Copy,
  Check,
  Calendar,
  Lock,
  MessageSquare,
  Trash2,
  Globe,
  User,
  Users,
} from "lucide-react";
import {
  createShare,
  updateShare,
  deleteShare,
  fetchShareRecipients,
} from "@/lib/api";
import type { ShareDetail, ShareRecipient } from "@/lib/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { translateError } from "@/lib/friendly-errors";

interface ShareDialogProps {
  filePath: string;
  fileName: string;
  /**
   * WARP-1148/1149: whether the share target is a folder. Nextcloud rejects
   * single-FILE shares that carry the CREATE or DELETE permission bits
   * ("File shares cannot have create or delete permissions"), so for files the
   * dialog masks those bits out of whatever preset the user picks before
   * sending. Folders keep the full bitmask.
   *
   * WARP-1601: it also selects which access levels the dialog offers at all —
   * see FILE_LEVELS / FOLDER_LEVELS below. A file and a folder do not have the
   * same set of assignable levels, so this prop drives both existing-share
   * selects and both create forms.
   */
  isDirectory?: boolean;
  existingShares?: ShareDetail[];
  onClose: () => void;
  onChange?: () => void;
}

// Nextcloud OCS share types.
const SHARE_TYPE_USER = 0; // named household member
const SHARE_TYPE_LINK = 3; // public link

type ShareMode = "person" | "link";

// Permission bits (Nextcloud OCS)
const PERM_READ = 1;
const PERM_UPDATE = 2;
const PERM_CREATE = 4;
const PERM_DELETE = 8;
const PERM_SHARE = 16;

export interface AccessLevel {
  label: string;
  bits: number;
  /** Plain-language expansion of the label, surfaced as a native tooltip. */
  hint: string;
}

/**
 * WARP-1601: the assignable access levels are NOT the same for a file and a
 * folder, so the dialog offers a different list for each instead of one static
 * set.
 *
 * CREATE (4) and DELETE (8) describe what a recipient may do to the *contents*
 * of a container, and Nextcloud rejects them outright on a single-file share.
 * "Full access" (31) is therefore unrepresentable on a file: picking it used to
 * send 19 and then render as "Can edit", making the two options look identical
 * while silently flipping the recipient's re-share bit.
 *
 * The honest third level for a file is re-share (19) — a real, distinct,
 * storable state — so files get it under its own name. Levels that a file
 * cannot hold are ABSENT rather than greyed out: a file has no contents to
 * create or delete, so "Full access" could never become available, and a
 * permanently-disabled option would be dead UI in every share row. The same
 * list drives the person select, the link select, and both create forms, so the
 * treatment is consistent everywhere.
 */
const FILE_LEVELS: readonly AccessLevel[] = [
  { label: "View only", bits: PERM_READ, hint: "Can open and download this file" },
  {
    label: "Can edit",
    bits: PERM_READ | PERM_UPDATE,
    hint: "Can open and change this file",
  },
  {
    label: "Can edit + reshare",
    bits: PERM_READ | PERM_UPDATE | PERM_SHARE,
    hint: "Can open, change, and share this file with other people",
  },
];

const FOLDER_LEVELS: readonly AccessLevel[] = [
  { label: "View only", bits: PERM_READ, hint: "Can open and download the contents" },
  {
    label: "Can edit",
    bits: PERM_READ | PERM_UPDATE,
    hint: "Can open and change the contents",
  },
  {
    label: "Full access",
    bits: PERM_READ | PERM_UPDATE | PERM_CREATE | PERM_DELETE | PERM_SHARE,
    hint: "Can edit, add, and delete items, and share this folder with other people",
  },
];

export function accessLevelsFor(isDirectory: boolean): readonly AccessLevel[] {
  return isDirectory ? FOLDER_LEVELS : FILE_LEVELS;
}

// The bits that distinguish the levels of a FOLDER from one another. The SHARE
// bit (16) is deliberately excluded: Nextcloud attaches it to almost every
// share regardless of access level, so it must not push a "View only" or "Can
// edit" folder share into "Full access".
const FOLDER_MATCH_BITS = PERM_READ | PERM_UPDATE | PERM_CREATE | PERM_DELETE;

// On a FILE, SHARE is the only bit separating "Can edit" (3) from "Can edit +
// reshare" (19) — CREATE/DELETE can never be set — so here it must be matched
// rather than ignored, or the two levels collapse again (WARP-1601).
const FILE_MATCH_BITS = PERM_READ | PERM_UPDATE | PERM_SHARE;

/**
 * Snap a raw Nextcloud OCS permission bitmask onto one of the levels offered
 * for this target kind, so the access-level <select> always has a matching
 * <option>.
 *
 * WARP-939: the OCS API returns masks like 17 (READ|SHARE) or 19
 * (READ|UPDATE|SHARE) that never equal a bare preset value (1 / 3 / 31). A
 * controlled <select value={rawMask}> then matched no option, fell back to the
 * first ("View only"), and the user could not see or change the real level.
 * We choose the most-capable level whose distinguishing bits are all granted by
 * the mask.
 */
export function presetBitsFor(rawPermissions: number, isDirectory = false): number {
  const levels = accessLevelsFor(isDirectory);
  const matchBits = isDirectory ? FOLDER_MATCH_BITS : FILE_MATCH_BITS;
  const granted = rawPermissions & matchBits;
  // Walk levels from most to least capable; first whose distinguishing bits are
  // a subset of the mask's wins.
  for (let i = levels.length - 1; i >= 0; i--) {
    const required = levels[i].bits & matchBits;
    if ((granted & required) === required) {
      return levels[i].bits;
    }
  }
  return PERM_READ;
}

/**
 * WARP-1148/1149: Nextcloud's generalCreateChecks rejects any share of a single
 * FILE whose bitmask carries CREATE or DELETE. The file level list no longer
 * offers those bits, but this stays as the last line of defence on every
 * outbound write — a mask can also arrive from a stored share row.
 */
export function sendablePermissions(bits: number, isDirectory: boolean): number {
  return isDirectory ? bits : bits & ~(PERM_CREATE | PERM_DELETE);
}

/**
 * Full sharing dialog (WARP-879 / WS-1). Two modes:
 *   • Person — share with a named household member (OCS shareType 0). The
 *     member picker is populated from GET /api/files/share-recipients, which
 *     reads the local directory (ADR-013) so every household role can use it.
 *   • Link   — create a public link (OCS shareType 3) with permissions,
 *     expiry, password, and note. Unchanged from the prior behavior.
 *
 * The existing-shares list branches on share.shareType: a person share (0)
 * renders a recipient chip with no copy-link affordance; a public link (3)
 * keeps the copy-link row.
 */
export function ShareDialog({
  filePath,
  fileName,
  isDirectory = false,
  existingShares = [],
  onClose,
  onChange,
}: ShareDialogProps) {
  const [mode, setMode] = useState<ShareMode>("person");
  const [permissions, setPermissions] = useState<number>(PERM_READ);
  const [expireDate, setExpireDate] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareDetail[]>(existingShares);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [revokeTargetId, setRevokeTargetId] = useState<number | null>(null);

  // Person-mode roster
  const [recipients, setRecipients] = useState<ShareRecipient[]>([]);
  const [recipientsLoading, setRecipientsLoading] = useState(true);
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  const [selectedRecipient, setSelectedRecipient] = useState<string | null>(null);

  useEffect(() => {
    setShares(existingShares);
  }, [existingShares]);

  useEffect(() => {
    let cancelled = false;
    setRecipientsLoading(true);
    setRecipientsError(null);
    fetchShareRecipients()
      .then((rows) => {
        if (!cancelled) setRecipients(rows);
      })
      .catch((err) => {
        if (!cancelled) setRecipientsError(translateError(err, "files"));
      })
      .finally(() => {
        if (!cancelled) setRecipientsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // WARP-1601: files and folders do not offer the same access levels.
  const levels = accessLevelsFor(isDirectory);
  const toSendable = (bits: number): number =>
    sendablePermissions(bits, isDirectory);

  const handleCreate = async () => {
    if (mode === "person" && !selectedRecipient) return;
    setCreating(true);
    setError(null);
    try {
      const created =
        mode === "person"
          ? await createShare(filePath, {
              shareType: SHARE_TYPE_USER,
              shareWith: selectedRecipient as string,
              permissions: toSendable(permissions),
            })
          : await createShare(filePath, {
              shareType: SHARE_TYPE_LINK,
              permissions: toSendable(permissions),
              expireDate: expireDate || undefined,
              password: password || undefined,
              note: note || undefined,
            });
      setShares([created, ...shares]);
      setPassword("");
      setNote("");
      setExpireDate("");
      setSelectedRecipient(null);
      onChange?.();
    } catch (err) {
      // WARP-1148: share failures translate through the share domain — never
      // the "files" domain, whose fallback is the file-LOADING copy.
      setError(translateError(err, "share"));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = (shareId: number) => {
    setRevokeTargetId(shareId);
  };

  const performRevoke = async () => {
    const shareId = revokeTargetId;
    if (shareId == null) return;
    try {
      await deleteShare(shareId);
      setShares(shares.filter((s) => s.id !== shareId));
      setRevokeTargetId(null);
      onChange?.();
    } catch (err) {
      setError(translateError(err, "share"));
      throw err;
    }
  };

  const handleCopy = (share: ShareDetail) => {
    if (!share.url) return;
    navigator.clipboard.writeText(share.url);
    setCopiedId(share.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleUpdatePermissions = async (shareId: number, bits: number) => {
    const masked = toSendable(bits);
    try {
      await updateShare(shareId, { permissions: masked });
      setShares(
        shares.map((s) =>
          s.id === shareId ? { ...s, permissions: masked } : s
        )
      );
      onChange?.();
    } catch (err) {
      setError(translateError(err, "share"));
    }
  };

  const createDisabled =
    creating || (mode === "person" && !selectedRecipient);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm p-6"
      style={{ background: "var(--scrim)" }}
      onClick={onClose}
    >
      <div
        className="max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden"
        style={{
          background: "var(--card-bg)",
          border: "1px solid var(--card-bd)",
          borderRadius: "var(--radius-card)",
          boxShadow: "var(--lift)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--card-bd)" }}
        >
          <div className="flex-1 min-w-0">
            <h3 className="type-headline" style={{ color: "var(--text)" }}>
              Share
            </h3>
            <p
              className="type-caption-1 truncate"
              style={{ color: "var(--text-muted)" }}
            >
              {fileName}
            </p>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-5">
          {/* Existing shares */}
          {shares.length > 0 && (
            <div>
              <h4
                className="type-footnote font-medium mb-2"
                style={{ color: "var(--text-muted)" }}
              >
                Shared with
              </h4>
              <div className="space-y-2">
                {shares.map((share) =>
                  share.shareType === SHARE_TYPE_USER ? (
                    // ── Named-member share — recipient chip, no link to copy ──
                    <div
                      key={share.id}
                      className="card space-y-2"
                      style={{ padding: "12px", borderRadius: "var(--radius-card)" }}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="flex items-center justify-center w-6 h-6 rounded-full flex-shrink-0"
                          style={{
                            background: "var(--brand-subtle)",
                            color: "var(--brand)",
                          }}
                        >
                          <User size={13} />
                        </span>
                        <span
                          className="type-footnote flex-1 min-w-0 truncate"
                          style={{ color: "var(--text)" }}
                        >
                          {share.shareWithDisplayName ?? share.shareWith}
                        </span>
                        <button
                          onClick={() => handleRevoke(share.id)}
                          className="p-1.5 rounded-[var(--radius-input)] transition-colors hover:bg-[rgba(239,68,68,0.1)]"
                          style={{ color: "#ef4444" }}
                          title="Remove access"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          aria-label="Access level"
                          value={presetBitsFor(share.permissions, isDirectory)}
                          onChange={(e) =>
                            handleUpdatePermissions(share.id, Number(e.target.value))
                          }
                          className="type-caption-1 px-3 !py-1 flex-1 outline-none focus:border-[var(--brand)]"
                          style={{
                            background: "var(--surface)",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-input)",
                            color: "var(--text)",
                          }}
                        >
                          {levels.map((level) => (
                            <option
                              key={level.label}
                              value={level.bits}
                              title={level.hint}
                            >
                              {level.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ) : (
                    // ── Public link share — copy-link row (unchanged) ──
                    <div
                      key={share.id}
                      className="card space-y-2"
                      style={{ padding: "12px", borderRadius: "var(--radius-card)" }}
                    >
                      <div className="flex items-center gap-2">
                        <Globe
                          size={14}
                          className="flex-shrink-0"
                          style={{ color: "var(--brand)" }}
                        />
                        <input
                          readOnly
                          value={share.url ?? ""}
                          className="type-caption-1 px-3 flex-1 !py-1.5 outline-none focus:border-[var(--brand)]"
                          style={{
                            background: "var(--surface)",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-input)",
                            color: "var(--text)",
                          }}
                        />
                        <button
                          onClick={() => handleCopy(share)}
                          className="p-1.5 rounded-[var(--radius-input)] transition-colors hover:bg-[rgba(99,102,241,0.2)]"
                          style={{
                            background: "var(--brand-subtle)",
                            color: "var(--brand)",
                          }}
                          title="Copy link"
                        >
                          {copiedId === share.id ? (
                            <Check size={14} style={{ color: "var(--success)" }} />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>
                        <button
                          onClick={() => handleRevoke(share.id)}
                          className="p-1.5 rounded-[var(--radius-input)] transition-colors hover:bg-[rgba(239,68,68,0.1)]"
                          style={{ color: "#ef4444" }}
                          title="Revoke"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          aria-label="Access level"
                          value={presetBitsFor(share.permissions, isDirectory)}
                          onChange={(e) =>
                            handleUpdatePermissions(share.id, Number(e.target.value))
                          }
                          className="type-caption-1 px-3 !py-1 flex-1 outline-none focus:border-[var(--brand)]"
                          style={{
                            background: "var(--surface)",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-input)",
                            color: "var(--text)",
                          }}
                        >
                          {levels.map((level) => (
                            <option
                              key={level.label}
                              value={level.bits}
                              title={level.hint}
                            >
                              {level.label}
                            </option>
                          ))}
                        </select>
                        {share.expireDate && (
                          <span
                            className="type-caption-2 flex items-center gap-1"
                            style={{ color: "var(--text-muted)" }}
                          >
                            <Calendar size={11} />
                            {share.expireDate}
                          </span>
                        )}
                        {share.hasPassword && (
                          <Lock size={11} style={{ color: "var(--text-muted)" }} />
                        )}
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {/* Mode toggle */}
          <div
            className="flex gap-2 p-1"
            style={{ background: "var(--surface-2)", borderRadius: "10px" }}
          >
            <button
              onClick={() => setMode("person")}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 type-caption-1 rounded-[var(--radius-input)] transition-colors ${
                mode === "person"
                  ? "font-medium shadow-sm"
                  : "text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
              }`}
              style={
                mode === "person"
                  ? { background: "var(--surface)", color: "var(--brand)" }
                  : undefined
              }
            >
              <Users size={14} />
              Person
            </button>
            <button
              onClick={() => setMode("link")}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 type-caption-1 rounded-[var(--radius-input)] transition-colors ${
                mode === "link"
                  ? "font-medium shadow-sm"
                  : "text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
              }`}
              style={
                mode === "link"
                  ? { background: "var(--surface)", color: "var(--brand)" }
                  : undefined
              }
            >
              <LinkIcon size={14} />
              Link
            </button>
          </div>

          {/* New share form */}
          <div>
            {mode === "person" ? (
              <>
                {/* Member picker */}
                <div className="space-y-2 mb-3">
                  <label
                    className="type-caption-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Household member
                  </label>
                  {recipientsLoading ? (
                    <p
                      className="type-footnote py-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Loading members…
                    </p>
                  ) : recipientsError ? (
                    <p
                      className="type-footnote py-1"
                      style={{ color: "#ef4444" }}
                    >
                      {recipientsError}
                    </p>
                  ) : recipients.length === 0 ? (
                    <p
                      className="type-footnote py-1"
                      style={{ color: "var(--text-muted)" }}
                    >
                      No other household members yet
                    </p>
                  ) : (
                    <div className="space-y-1.5 max-h-44 overflow-auto">
                      {recipients.map((r) => {
                        const active = selectedRecipient === r.shareWith;
                        return (
                          <button
                            key={r.shareWith}
                            onClick={() => setSelectedRecipient(r.shareWith)}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius-input)] text-left transition-colors ${
                              active ? "" : "hover:bg-[var(--hover)]"
                            }`}
                            style={{
                              background: active
                                ? "var(--brand-subtle)"
                                : "var(--surface-2)",
                            }}
                          >
                            <span
                              className="flex items-center justify-center w-7 h-7 rounded-full flex-shrink-0"
                              style={
                                active
                                  ? { background: "var(--brand)", color: "#fff" }
                                  : {
                                      background: "var(--surface)",
                                      color: "var(--text-muted)",
                                    }
                              }
                            >
                              <User size={14} />
                            </span>
                            <span className="flex-1 min-w-0">
                              <span
                                className={`block type-footnote truncate ${
                                  active ? "font-medium" : ""
                                }`}
                                style={{
                                  color: active
                                    ? "var(--brand)"
                                    : "var(--text)",
                                }}
                              >
                                {r.displayName}
                              </span>
                              {r.email && (
                                <span
                                  className="block type-caption-2 truncate"
                                  style={{ color: "var(--text-muted)" }}
                                >
                                  {r.email}
                                </span>
                              )}
                            </span>
                            {active && (
                              <Check
                                size={15}
                                className="flex-shrink-0"
                                style={{ color: "var(--brand)" }}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Permissions */}
                <div className="space-y-2 mb-3">
                  <label
                    className="type-caption-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Access level
                  </label>
                  <div className="flex gap-2">
                    {levels.map((level) => {
                      const active = permissions === level.bits;
                      return (
                        <button
                          key={level.label}
                          onClick={() => setPermissions(level.bits)}
                          title={level.hint}
                          className={`flex-1 px-3 py-2 type-caption-1 rounded-[var(--radius-input)] transition-colors ${
                            active ? "font-medium" : "hover:bg-[var(--hover)]"
                          }`}
                          style={
                            active
                              ? {
                                  background: "var(--brand-subtle)",
                                  color: "var(--brand)",
                                }
                              : {
                                  background: "var(--surface-2)",
                                  color: "var(--text-muted)",
                                }
                          }
                        >
                          {level.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Permissions */}
                <div className="space-y-2 mb-3">
                  <label
                    className="type-caption-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Access level
                  </label>
                  <div className="flex gap-2">
                    {levels.map((level) => {
                      const active = permissions === level.bits;
                      return (
                        <button
                          key={level.label}
                          onClick={() => setPermissions(level.bits)}
                          title={level.hint}
                          className={`flex-1 px-3 py-2 type-caption-1 rounded-[var(--radius-input)] transition-colors ${
                            active ? "font-medium" : "hover:bg-[var(--hover)]"
                          }`}
                          style={
                            active
                              ? {
                                  background: "var(--brand-subtle)",
                                  color: "var(--brand)",
                                }
                              : {
                                  background: "var(--surface-2)",
                                  color: "var(--text-muted)",
                                }
                          }
                        >
                          {level.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Expiry */}
                <div className="space-y-1 mb-3">
                  <label
                    className="type-caption-1 flex items-center gap-1.5"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <Calendar size={12} />
                    Expiration date (optional)
                  </label>
                  <input
                    type="date"
                    value={expireDate}
                    onChange={(e) => setExpireDate(e.target.value)}
                    min={new Date().toISOString().split("T")[0]}
                    className="type-footnote px-3 !py-1.5 w-full outline-none focus:border-[var(--brand)]"
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-input)",
                      color: "var(--text)",
                    }}
                  />
                </div>

                {/* Password */}
                <div className="space-y-1 mb-3">
                  <label
                    className="type-caption-1 flex items-center gap-1.5"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <Lock size={12} />
                    Password (optional)
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Leave blank for no password"
                    className="type-footnote px-3 !py-1.5 w-full outline-none focus:border-[var(--brand)] placeholder:text-[color:var(--text-muted)]"
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-input)",
                      color: "var(--text)",
                    }}
                  />
                </div>

                {/* Note */}
                <div className="space-y-1 mb-3">
                  <label
                    className="type-caption-1 flex items-center gap-1.5"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <MessageSquare size={12} />
                    Note (optional)
                  </label>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What's this link for?"
                    rows={2}
                    className="type-footnote px-3 !py-1.5 w-full outline-none focus:border-[var(--brand)] placeholder:text-[color:var(--text-muted)]"
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-input)",
                      color: "var(--text)",
                    }}
                  />
                </div>
              </>
            )}
          </div>

          {error && (
            <div
              className="p-2 type-footnote"
              style={{
                color: "#ef4444",
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.2)",
                borderRadius: "var(--radius-input)",
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-4 py-3"
          style={{ borderTop: "1px solid var(--card-bd)" }}
        >
          <button onClick={onClose} className="btn ghost">
            Close
          </button>
          <button
            onClick={handleCreate}
            disabled={createDisabled}
            className="btn primary"
          >
            {creating ? (
              mode === "person" ? (
                "Sharing…"
              ) : (
                "Creating…"
              )
            ) : mode === "person" ? (
              <>
                <User size={14} />
                Share
              </>
            ) : (
              <>
                <LinkIcon size={14} />
                Create link
              </>
            )}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={revokeTargetId !== null}
        onConfirm={performRevoke}
        onCancel={() => setRevokeTargetId(null)}
        title="Remove this share?"
        description="The recipient loses access immediately. You can always share again later."
        confirmLabel="Remove"
        variant="destructive"
      />
    </div>
  );
}
