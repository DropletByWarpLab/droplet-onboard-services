"use client";

/**
 * WARP-2871 — one cloud provider row on the Models page.
 *
 * Replaces the WARP-836 shown-but-disabled switch. The row states the key
 * situation honestly (saved / none / unknown), decides ONE badge from
 * key × escape × role via `cloudProviderState`, and — for owners/admins only —
 * carries the key actions that used to live on Settings (ProviderKeyForm,
 * retired). Members get no buttons at all: read-only state, no disabled walls.
 */

import { useState } from "react";
import { Cloud, ExternalLink, Trash2 } from "lucide-react";
import { saveProviderKey, deleteProviderKey } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import { formatRelativeTime } from "@/lib/relative-time";
import { Badge, type BadgeKind } from "@/components/shell/primitives";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { CloudAccessInfo, CloudProviderRow as Row } from "@/lib/types";

/** Provider id → display name + the headline model family shown as sub-text. */
export const PROVIDER_META: Record<
  Row["provider"],
  { name: string; family: string; /** Where an admin mints a key. */ console: string }
> = {
  anthropic: { name: "Anthropic", family: "Claude", console: "https://console.anthropic.com/settings/keys" },
  openai: { name: "OpenAI", family: "GPT", console: "https://platform.openai.com/api-keys" },
};

/** The one badge per row. Order matters: an unknown key beats everything
 *  (we can't claim anything), then no key, then the box-wide switch, then the
 *  caller's role verdict. */
export function cloudProviderState(
  row: Row,
  cloudAccess: CloudAccessInfo,
): { kind: BadgeKind; label: string } {
  if (row.hasKey === null) return { kind: "muted", label: "Unknown" };
  if (row.hasKey === false) return { kind: "muted", label: "Not set up" };
  if (!cloudAccess.escapeEnabled) return { kind: "info", label: "Key saved · cloud off" };
  if (cloudAccess.allowedForYou === false) return { kind: "warn", label: "Blocked for your role" };
  if (cloudAccess.allowedForYou === null) return { kind: "muted", label: "Key saved" };
  return { kind: "ok", label: "Ready" };
}

function keyLine(row: Row): string {
  if (row.hasKey === null) return "Key status unavailable";
  if (!row.hasKey) return "No key yet";
  return row.lastUsedAt
    ? `Key saved · Last used ${formatRelativeTime(row.lastUsedAt)}`
    : "Key saved · Never used";
}

// Aligns the inline editor under `.rt`: `.ri` 34px + the 13px row gap + 2px
// row padding (droplet-shell.css `.lrow`).
const EDITOR_INDENT = 49;

export function CloudProviderRow({
  row,
  cloudAccess,
  canManage,
  onChanged,
}: {
  row: Row;
  cloudAccess: CloudAccessInfo;
  /** Owner/admin — only they see the key actions. */
  canManage: boolean;
  onChanged: () => void;
}) {
  const meta = PROVIDER_META[row.provider];
  const state = cloudProviderState(row, cloudAccess);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = key.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveProviderKey(row.provider, trimmed);
      setKey("");
      setEditing(false);
      onChanged();
    } catch (err) {
      // WARP-294: never the raw orchestrator message.
      setError(translateError(err, "provider-key"));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await deleteProviderKey(row.provider);
      setError(null);
      onChanged();
    } catch (err) {
      setError(translateError(err, "provider-key"));
      // Re-throw so ConfirmDialog stays open for a retry (its contract).
      throw err;
    }
  }

  return (
    <>
      <div className="lrow">
        <span className={state.kind === "ok" ? "ri brand" : "ri"} aria-hidden>
          <Cloud size={16} />
        </span>
        <span className="rt">
          <span className="nm">{meta.name}</span>
          <span className="sub">
            {meta.family} · {keyLine(row)}
          </span>
        </span>
        <Badge kind={state.kind}>{state.label}</Badge>
        {canManage && row.hasKey === false && !editing && (
          <button type="button" className="btn sm" onClick={() => setEditing(true)}>
            Add key
          </button>
        )}
        {canManage && row.hasKey === true && !editing && (
          <>
            <button type="button" className="btn sm" onClick={() => setEditing(true)}>
              Replace key
            </button>
            <button
              type="button"
              className="btn sm ghost"
              aria-label={`Remove ${meta.name} key`}
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </>
        )}
      </div>

      {editing && (
        <div style={{ padding: `0 2px 12px ${EDITOR_INDENT}px` }}>
          <label
            className="type-caption-1"
            htmlFor={`cloud-key-${row.provider}`}
            style={{ display: "block", color: "var(--text-muted)", marginBottom: 6 }}
          >
            {meta.name} API key
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`cloud-key-${row.provider}`}
              type="password"
              autoComplete="off"
              placeholder="Paste the key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
              className="w-full px-3 outline-none"
              style={{
                height: 36,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
            />
            <button
              type="button"
              className="btn primary sm"
              disabled={saving || !key.trim()}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save key"}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setKey("");
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
          <p className="type-caption-1" style={{ color: "var(--text-muted)", marginTop: 6 }}>
            Stored encrypted on your Droplet. Only admins can add, replace or remove keys.{" "}
            <a
              href={meta.console}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--brand)", display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              Get a key from {meta.name}
              <ExternalLink size={12} aria-hidden />
            </a>
          </p>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="type-footnote"
          style={{ color: "var(--system-red, #ff3b30)", padding: `0 2px 10px ${EDITOR_INDENT}px` }}
        >
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onConfirm={remove}
        onCancel={() => setConfirmRemove(false)}
        title={`Remove ${meta.name} key?`}
        description={`Cloud models from ${meta.name} will stop working on this Droplet until an admin adds a new key. The saved key cannot be recovered.`}
        confirmLabel="Remove key"
        variant="destructive"
      />
    </>
  );
}
