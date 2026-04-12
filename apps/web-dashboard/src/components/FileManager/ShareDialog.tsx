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
} from "lucide-react";
import { createShare, updateShare, deleteShare } from "@/lib/api";
import type { ShareDetail } from "@/lib/types";

interface ShareDialogProps {
  filePath: string;
  fileName: string;
  existingShares?: ShareDetail[];
  onClose: () => void;
  onChange?: () => void;
}

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

/**
 * Full sharing dialog. Supports creating new public links with permissions,
 * expiry, password, and note, plus listing/editing/revoking existing shares
 * on the same file.
 */
export function ShareDialog({
  filePath,
  fileName,
  existingShares = [],
  onClose,
  onChange,
}: ShareDialogProps) {
  const [permissions, setPermissions] = useState<number>(PERM_READ);
  const [expireDate, setExpireDate] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareDetail[]>(existingShares);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    setShares(existingShares);
  }, [existingShares]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await createShare(filePath, {
        shareType: 3,
        permissions,
        expireDate: expireDate || undefined,
        password: password || undefined,
        note: note || undefined,
      });
      setShares([created, ...shares]);
      setPassword("");
      setNote("");
      setExpireDate("");
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Share creation failed");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (shareId: number) => {
    if (!confirm("Revoke this share link?")) return;
    try {
      await deleteShare(shareId);
      setShares(shares.filter((s) => s.id !== shareId));
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revoke failed");
    }
  };

  const handleCopy = (share: ShareDetail) => {
    if (!share.url) return;
    navigator.clipboard.writeText(share.url);
    setCopiedId(share.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleUpdatePermissions = async (shareId: number, bits: number) => {
    try {
      await updateShare(shareId, { permissions: bits });
      setShares(
        shares.map((s) =>
          s.id === shareId ? { ...s, permissions: bits } : s
        )
      );
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  };

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
                Active links
              </h4>
              <div className="space-y-2">
                {shares.map((share) => (
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
                        value={share.permissions}
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
                ))}
              </div>
            </div>
          )}

          {/* New share form */}
          <div>
            <h4 className="type-footnote text-label-secondary font-medium mb-2">
              Create new link
            </h4>

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
            disabled={creating}
            className="dp-btn-primary type-subheadline !min-h-[36px] !py-1.5"
          >
            {creating ? (
              "Creating…"
            ) : (
              <>
                <LinkIcon size={14} />
                Create link
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
