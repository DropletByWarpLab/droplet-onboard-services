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

const PRESETS = [
  { label: "View only", bits: PERM_READ },
  { label: "Can edit", bits: PERM_READ | PERM_UPDATE },
  { label: "Full access", bits: PERM_READ | PERM_UPDATE | PERM_CREATE | PERM_DELETE | PERM_SHARE },
] as const;

// The bits that distinguish the presets from one another. The SHARE bit (16) is
// deliberately excluded: Nextcloud attaches it to almost every share regardless
// of access level, so it must not push a "View only" or "Can edit" share into
// "Full access".
const PRESET_MATCH_BITS = PERM_READ | PERM_UPDATE | PERM_CREATE | PERM_DELETE;

/**
 * Snap a raw Nextcloud OCS permission bitmask onto one of the three presets so
 * the access-level <select> always has a matching <option>.
 *
 * WARP-939: the OCS API returns masks like 17 (READ|SHARE) or 19
 * (READ|UPDATE|SHARE) that never equal a bare preset value (1 / 3 / 31). A
 * controlled <select value={rawMask}> then matched no option, fell back to the
 * first ("View only"), and the user could not see or change the real level.
 * We choose the most-capable preset whose editing bits are all granted by the
 * mask, ignoring the ubiquitous SHARE bit.
 */
export function presetBitsFor(rawPermissions: number): number {
  const editing = rawPermissions & PRESET_MATCH_BITS;
  // Walk presets from most to least capable; first whose editing bits are a
  // subset of the mask's editing bits wins.
  for (let i = PRESETS.length - 1; i >= 0; i--) {
    const presetEditing = PRESETS[i].bits & PRESET_MATCH_BITS;
    if ((editing & presetEditing) === presetEditing) {
      return PRESETS[i].bits;
    }
  }
  return PERM_READ;
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

  // WARP-1148/1149: Nextcloud's generalCreateChecks rejects any share of a
  // single FILE whose bitmask carries CREATE or DELETE — so the "Full access"
  // preset (31) could never be created or applied on a file. Mask those bits
  // for files (leaving READ|UPDATE|SHARE) so the most-capable valid share is
  // sent instead of a guaranteed 400.
  const sendablePermissions = (bits: number): number =>
    isDirectory ? bits : bits & ~(PERM_CREATE | PERM_DELETE);

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
              permissions: sendablePermissions(permissions),
            })
          : await createShare(filePath, {
              shareType: SHARE_TYPE_LINK,
              permissions: sendablePermissions(permissions),
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
    const masked = sendablePermissions(bits);
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="bg-surface-primary rounded-lg max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
          <div className="flex-1 min-w-0">
            <h3 className="type-headline text-label-primary">Share</h3>
            <p className="type-caption-1 text-label-tertiary truncate">
              {fileName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-label-tertiary hover:text-label-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-5">
          {/* Existing shares */}
          {shares.length > 0 && (
            <div>
              <h4 className="type-footnote text-label-secondary font-medium mb-2">
                Shared with
              </h4>
              <div className="space-y-2">
                {shares.map((share) =>
                  share.shareType === SHARE_TYPE_USER ? (
                    // ── Named-member share — recipient chip, no link to copy ──
                    <div key={share.id} className="dp-card p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-accent-subtle text-accent flex-shrink-0">
                          <User size={13} />
                        </span>
                        <span className="type-footnote text-label-primary flex-1 min-w-0 truncate">
                          {share.shareWithDisplayName ?? share.shareWith}
                        </span>
                        <button
                          onClick={() => handleRevoke(share.id)}
                          className="p-1.5 rounded-sm text-system-red hover:bg-system-red/10 transition-colors"
                          title="Remove access"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          value={presetBitsFor(share.permissions)}
                          onChange={(e) =>
                            handleUpdatePermissions(share.id, Number(e.target.value))
                          }
                          className="dp-input type-caption-1 !py-1 flex-1"
                        >
                          {PRESETS.map((preset) => (
                            <option key={preset.label} value={preset.bits}>
                              {preset.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ) : (
                    // ── Public link share — copy-link row (unchanged) ──
                    <div key={share.id} className="dp-card p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <Globe size={14} className="text-accent flex-shrink-0" />
                        <input
                          readOnly
                          value={share.url ?? ""}
                          className="dp-input type-caption-1 flex-1 !py-1.5"
                        />
                        <button
                          onClick={() => handleCopy(share)}
                          className="p-1.5 rounded-sm bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                          title="Copy link"
                        >
                          {copiedId === share.id ? (
                            <Check size={14} />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>
                        <button
                          onClick={() => handleRevoke(share.id)}
                          className="p-1.5 rounded-sm text-system-red hover:bg-system-red/10 transition-colors"
                          title="Revoke"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          value={presetBitsFor(share.permissions)}
                          onChange={(e) =>
                            handleUpdatePermissions(share.id, Number(e.target.value))
                          }
                          className="dp-input type-caption-1 !py-1 flex-1"
                        >
                          {PRESETS.map((preset) => (
                            <option key={preset.label} value={preset.bits}>
                              {preset.label}
                            </option>
                          ))}
                        </select>
                        {share.expireDate && (
                          <span className="type-caption-2 text-label-tertiary flex items-center gap-1">
                            <Calendar size={11} />
                            {share.expireDate}
                          </span>
                        )}
                        {share.hasPassword && (
                          <Lock size={11} className="text-label-tertiary" />
                        )}
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {/* Mode toggle */}
          <div className="flex gap-2 p-1 bg-surface-secondary rounded-md">
            <button
              onClick={() => setMode("person")}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 type-caption-1 rounded-sm transition-colors ${
                mode === "person"
                  ? "bg-surface-primary text-accent font-medium shadow-sm"
                  : "text-label-secondary hover:text-label-primary"
              }`}
            >
              <Users size={14} />
              Person
            </button>
            <button
              onClick={() => setMode("link")}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 type-caption-1 rounded-sm transition-colors ${
                mode === "link"
                  ? "bg-surface-primary text-accent font-medium shadow-sm"
                  : "text-label-secondary hover:text-label-primary"
              }`}
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
                  <label className="type-caption-1 text-label-tertiary">
                    Household member
                  </label>
                  {recipientsLoading ? (
                    <p className="type-footnote text-label-tertiary py-1">
                      Loading members…
                    </p>
                  ) : recipientsError ? (
                    <p className="type-footnote text-system-red py-1">
                      {recipientsError}
                    </p>
                  ) : recipients.length === 0 ? (
                    <p className="type-footnote text-label-tertiary py-1">
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
                            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-sm text-left transition-colors ${
                              active
                                ? "bg-accent-subtle"
                                : "bg-surface-secondary hover:bg-surface-tertiary"
                            }`}
                          >
                            <span
                              className={`flex items-center justify-center w-7 h-7 rounded-full flex-shrink-0 ${
                                active
                                  ? "bg-accent text-white"
                                  : "bg-surface-tertiary text-label-secondary"
                              }`}
                            >
                              <User size={14} />
                            </span>
                            <span className="flex-1 min-w-0">
                              <span
                                className={`block type-footnote truncate ${
                                  active
                                    ? "text-accent font-medium"
                                    : "text-label-primary"
                                }`}
                              >
                                {r.displayName}
                              </span>
                              {r.email && (
                                <span className="block type-caption-2 text-label-tertiary truncate">
                                  {r.email}
                                </span>
                              )}
                            </span>
                            {active && (
                              <Check size={15} className="text-accent flex-shrink-0" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Permissions */}
                <div className="space-y-2 mb-3">
                  <label className="type-caption-1 text-label-tertiary">
                    Access level
                  </label>
                  <div className="flex gap-2">
                    {PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        onClick={() => setPermissions(preset.bits)}
                        className={`flex-1 px-3 py-2 type-caption-1 rounded-sm transition-colors ${
                          permissions === preset.bits
                            ? "bg-accent-subtle text-accent font-medium"
                            : "bg-surface-secondary text-label-secondary hover:bg-surface-tertiary"
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Permissions */}
                <div className="space-y-2 mb-3">
                  <label className="type-caption-1 text-label-tertiary">
                    Access level
                  </label>
                  <div className="flex gap-2">
                    {PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        onClick={() => setPermissions(preset.bits)}
                        className={`flex-1 px-3 py-2 type-caption-1 rounded-sm transition-colors ${
                          permissions === preset.bits
                            ? "bg-accent-subtle text-accent font-medium"
                            : "bg-surface-secondary text-label-secondary hover:bg-surface-tertiary"
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Expiry */}
                <div className="space-y-1 mb-3">
                  <label className="type-caption-1 text-label-tertiary flex items-center gap-1.5">
                    <Calendar size={12} />
                    Expiration date (optional)
                  </label>
                  <input
                    type="date"
                    value={expireDate}
                    onChange={(e) => setExpireDate(e.target.value)}
                    min={new Date().toISOString().split("T")[0]}
                    className="dp-input type-footnote !py-1.5"
                  />
                </div>

                {/* Password */}
                <div className="space-y-1 mb-3">
                  <label className="type-caption-1 text-label-tertiary flex items-center gap-1.5">
                    <Lock size={12} />
                    Password (optional)
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Leave blank for no password"
                    className="dp-input type-footnote !py-1.5"
                  />
                </div>

                {/* Note */}
                <div className="space-y-1 mb-3">
                  <label className="type-caption-1 text-label-tertiary flex items-center gap-1.5">
                    <MessageSquare size={12} />
                    Note (optional)
                  </label>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What's this link for?"
                    rows={2}
                    className="dp-input type-footnote !py-1.5"
                  />
                </div>
              </>
            )}
          </div>

          {error && (
            <div className="p-2 bg-system-red/10 border border-system-red/20 rounded type-footnote text-system-red">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-separator">
          <button
            onClick={onClose}
            className="type-subheadline text-accent hover:text-accent-hover px-3 py-2 transition-colors"
          >
            Close
          </button>
          <button
            onClick={handleCreate}
            disabled={createDisabled}
            className="dp-btn-primary type-subheadline !min-h-[36px] !py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
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
