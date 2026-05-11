"use client";

import { useState } from "react";
import { Plus, Trash2, RefreshCw, Globe, AlertCircle, Copy, Check } from "lucide-react";
import {
  useCalendarSources,
  createSource,
  deleteSource,
  syncSource,
  getPublishUrl,
} from "@/lib/hooks/useCalendar";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function SubscriptionsPanel() {
  const { sources, refresh, isLoading } = useCalendarSources();
  const { toast } = useToast();
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authMode, setAuthMode] = useState<"none" | "basic">("none");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [publishUrl, setPublishUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(
    null,
  );

  async function handleAdd() {
    if (!name.trim() || !url.trim()) {
      toast("Name and URL are required", "error");
      return;
    }
    if (authMode === "basic" && (!username.trim() || !password)) {
      toast("Basic auth needs both username and password", "error");
      return;
    }
    setBusy("add");
    try {
      await createSource({
        name,
        url,
        authMode,
        username: authMode === "basic" ? username : undefined,
        password: authMode === "basic" ? password : undefined,
      });
      toast("Subscription added — first sync runs within 30s", "success");
      setName("");
      setUrl("");
      setUsername("");
      setPassword("");
      setShowNew(false);
      refresh();
    } catch (err) {
      // WARP-294: friendly translation; never raw err.message.
      toast(translateError(err, "subscription"), "error");
    } finally {
      setBusy(null);
    }
  }

  async function handleSync(id: string) {
    setBusy(id);
    try {
      const r = await syncSource(id);
      if (r.error) {
        // WARP-294: r.error is the server-side sync error string —
        // route it through the helper so users see "We couldn't sync
        // that calendar right now" instead of CalDAV / ICS internals.
        toast(translateError({ message: r.error }, "subscription"), "error");
      } else {
        toast(`Synced — added ${r.added}, updated ${r.updated}`, "success");
      }
      refresh();
    } catch (err) {
      // WARP-294: friendly translation; never raw err.message.
      toast(translateError(err, "subscription"), "error");
    } finally {
      setBusy(null);
    }
  }

  function handleDelete(id: string, name: string) {
    setDeleteTarget({ id, name });
  }

  async function performDelete() {
    const target = deleteTarget;
    if (!target) return;
    setBusy(target.id);
    try {
      await deleteSource(target.id);
      setDeleteTarget(null);
      toast("Subscription removed", "success");
      refresh();
    } catch (err) {
      // WARP-294: friendly translation; never raw err.message.
      toast(translateError(err, "subscription"), "error");
      throw err;
    } finally {
      setBusy(null);
    }
  }

  async function loadPublishUrl() {
    try {
      const { url } = await getPublishUrl();
      const fullUrl = `${window.location.origin}${url}`;
      setPublishUrl(fullUrl);
    } catch (err) {
      // WARP-294: friendly translation; never raw err.message.
      toast(translateError(err, "subscription"), "error");
    }
  }

  async function copyPublish() {
    if (!publishUrl) return;
    await navigator.clipboard.writeText(publishUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="dp-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-label-secondary" />
          <h2 className="type-headline text-label-primary">External calendars</h2>
        </div>
        <button
          onClick={() => setShowNew((v) => !v)}
          className="text-label-secondary hover:text-label-primary"
        >
          <Plus size={16} />
        </button>
      </div>

      {showNew && (
        <div className="mb-3 flex flex-col gap-2 p-2 rounded bg-surface-secondary">
          <input
            type="text"
            placeholder="Display name (e.g. Personal iCloud)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="dp-input text-sm"
            maxLength={200}
          />
          <input
            type="url"
            placeholder="https://… (CalDAV or ICS feed URL)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="dp-input text-sm"
            maxLength={2048}
          />
          <select
            value={authMode}
            onChange={(e) => setAuthMode(e.target.value as "none" | "basic")}
            className="dp-input text-sm"
          >
            <option value="none">No auth (public ICS)</option>
            <option value="basic">Basic auth (CalDAV)</option>
          </select>
          {authMode === "basic" && (
            <>
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="dp-input text-sm"
              />
              <input
                type="password"
                placeholder="Password / app password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="dp-input text-sm"
              />
            </>
          )}
          <button onClick={handleAdd} disabled={busy === "add"} className="dp-btn-primary text-sm">
            {busy === "add" ? "Adding…" : "Add subscription"}
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="type-caption-1 text-label-tertiary">Loading…</div>
      ) : sources.length === 0 ? (
        <div className="type-caption-1 text-label-tertiary py-2">
          No external calendars subscribed yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {sources.map((s) => (
            <li key={s.id} className="flex items-start gap-2 p-2 rounded bg-surface-secondary">
              <div className="flex-1 min-w-0">
                <div className="type-subheadline text-label-primary truncate">{s.name}</div>
                <div className="type-caption-1 text-label-tertiary truncate">{s.url}</div>
                <div className="type-caption-1 text-label-tertiary mt-0.5">
                  {s.lastSyncAt ? (
                    <>Last synced {new Date(s.lastSyncAt).toLocaleString()}</>
                  ) : (
                    <>Not yet synced</>
                  )}
                  {s.lastSyncError && (
                    // WARP-294: the orchestrator stores a raw sync
                    // error here (HTTP code, CalDAV parser message).
                    // Translate before rendering so users see plain
                    // copy instead of "401 Unauthorized" / "ETIMEDOUT".
                    <span className="text-system-red ml-1 inline-flex items-center gap-1">
                      <AlertCircle size={10} />{" "}
                      {translateError({ message: s.lastSyncError }, "subscription")}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleSync(s.id)}
                disabled={busy === s.id}
                className="text-label-secondary hover:text-label-primary"
                title="Sync now"
              >
                <RefreshCw size={14} className={busy === s.id ? "animate-spin" : ""} />
              </button>
              <button
                onClick={() => handleDelete(s.id, s.name)}
                className="text-label-tertiary hover:text-system-red"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 pt-3 border-t border-separator">
        <h3 className="type-subheadline text-label-secondary mb-2">
          Subscribe phones / other calendar apps
        </h3>
        {publishUrl ? (
          <div className="flex items-center gap-2 p-2 rounded bg-surface-secondary">
            <code className="type-caption-1 flex-1 truncate text-label-secondary">{publishUrl}</code>
            <button
              onClick={copyPublish}
              className="text-label-secondary hover:text-label-primary"
              title="Copy"
            >
              {copied ? <Check size={14} className="text-system-green" /> : <Copy size={14} />}
            </button>
          </div>
        ) : (
          <button onClick={loadPublishUrl} className="dp-btn-secondary text-sm">
            Reveal publish URL
          </button>
        )}
        <p className="type-caption-1 text-label-tertiary mt-2">
          Use this URL in your phone's "Subscribe to calendar" flow. Your local
          events will appear automatically.
        </p>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        onConfirm={performDelete}
        onCancel={() => setDeleteTarget(null)}
        title={
          deleteTarget
            ? `Remove subscription "${deleteTarget.name}"?`
            : "Remove subscription?"
        }
        description="All synced events from this calendar are removed from your dashboard. You can re-add the subscription later."
        confirmLabel="Remove"
        variant="destructive"
      />
    </div>
  );
}
