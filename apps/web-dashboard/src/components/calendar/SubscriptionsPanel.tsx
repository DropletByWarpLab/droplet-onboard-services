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
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Globe size={16} style={{ color: "var(--text-muted)" }} />
          <h2 className="type-headline" style={{ color: "var(--text)" }}>External calendars</h2>
        </div>
        <button
          onClick={() => setShowNew((v) => !v)}
          className="text-[color:var(--text-muted)] hover:text-[color:var(--text)] max-lg:inline-flex max-lg:items-center max-lg:justify-center max-lg:h-11 max-lg:w-11"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Calendar UX clarity (Samantha QA #bugs): the Google / iCloud / Outlook
          framing used to live only inside the hidden add-form, so the section's
          purpose was invisible until you expanded it. This one-line intro sits
          directly under the header so the user understands it at a glance. */}
      <p className="type-caption-1 mb-3" style={{ color: "var(--text-muted)" }}>
        Show your Google, iCloud, or Outlook calendar here — paste its share
        link below.
      </p>

      {showNew && (
        // WARP-308: the previous form conflated protocol with auth ("No
        // auth (public ICS)" vs "Basic auth (CalDAV)"), which implied
        // every CalDAV server needs auth and every ICS feed is public.
        // Neither is true. The new form has ONE auth question — the
        // backend's CalDAV client (caldav.client.ts) already auto-detects
        // protocol via a PROPFIND fallback, so the user doesn't need to
        // declare it. We just need to know: does this feed require
        // sign-in?
        <div className="mb-3 flex flex-col gap-2 p-2 rounded" style={{ background: "var(--inset)" }}>
          <label className="flex flex-col gap-1">
            <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>
              Display name
            </span>
            <input
              type="text"
              placeholder="e.g. Personal iCloud"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-sm outline-none focus:border-[var(--brand)] placeholder:text-[color:var(--text-muted)]"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
                padding: "8px 10px",
              }}
              maxLength={200}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>
              Calendar URL
            </span>
            <input
              type="url"
              placeholder="https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="text-sm outline-none focus:border-[var(--brand)] placeholder:text-[color:var(--text-muted)]"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
                padding: "8px 10px",
              }}
              maxLength={2048}
            />
            <span className="type-caption-2" style={{ color: "var(--text-muted)" }}>
              Paste an ICS / iCal share link or a CalDAV server URL — we&rsquo;ll
              auto-detect.
            </span>
          </label>
          <label
            data-testid="auth-toggle"
            className="flex items-center gap-2 type-caption-1 mt-1"
            style={{ color: "var(--text-muted)" }}
          >
            <input
              type="checkbox"
              checked={authMode === "basic"}
              onChange={(e) => setAuthMode(e.target.checked ? "basic" : "none")}
            />
            Requires a username and password
          </label>
          {authMode === "basic" && (
            <div className="flex flex-col gap-2 pl-6">
              <input
                type="text"
                aria-label="Username"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="text-sm outline-none focus:border-[var(--brand)] placeholder:text-[color:var(--text-muted)]"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                  padding: "8px 10px",
                }}
              />
              <input
                type="password"
                aria-label="Password"
                placeholder="Password or app password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="text-sm outline-none focus:border-[var(--brand)] placeholder:text-[color:var(--text-muted)]"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                  padding: "8px 10px",
                }}
              />
            </div>
          )}
          <p className="type-caption-2 mt-1" style={{ color: "var(--text-muted)" }}>
            Most share links from Google, iCloud, or Outlook don&rsquo;t need
            sign-in. CalDAV servers and private feeds usually do.
          </p>
          <button
            onClick={handleAdd}
            disabled={busy === "add"}
            className="btn primary text-sm"
          >
            {busy === "add" ? "Adding…" : "Add subscription"}
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="type-caption-1" style={{ color: "var(--text-muted)" }}>Loading…</div>
      ) : sources.length === 0 ? (
        <div className="type-caption-1 py-2" style={{ color: "var(--text-muted)" }}>
          No external calendars subscribed yet. Use the &ldquo;+&rdquo; button
          above to pull in events from another calendar.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {sources.map((s) => (
            <li key={s.id} className="flex items-start gap-2 p-2 rounded" style={{ background: "var(--inset)" }}>
              <div className="flex-1 min-w-0">
                <div className="type-subheadline truncate" style={{ color: "var(--text)" }}>{s.name}</div>
                <div className="type-caption-1 truncate" style={{ color: "var(--text-muted)" }}>{s.url}</div>
                <div className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
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
                    <span className="ml-1 inline-flex items-center gap-1" style={{ color: "var(--danger)" }}>
                      <AlertCircle size={10} />{" "}
                      {translateError({ message: s.lastSyncError }, "subscription")}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleSync(s.id)}
                disabled={busy === s.id}
                className="text-[color:var(--text-muted)] hover:text-[color:var(--text)] max-lg:inline-flex max-lg:items-center max-lg:justify-center max-lg:h-11 max-lg:w-11"
                title="Sync now"
              >
                <RefreshCw size={14} className={busy === s.id ? "animate-spin" : ""} />
              </button>
              <button
                onClick={() => handleDelete(s.id, s.name)}
                className="text-[color:var(--text-muted)] hover:text-[color:var(--danger)]"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 pt-3" style={{ borderTop: "1px solid var(--card-bd)" }}>
        <h3 className="type-subheadline mb-2" style={{ color: "var(--text-muted)" }}>
          Subscribe phones / other calendar apps
        </h3>
        {publishUrl ? (
          <div className="flex items-center gap-2 p-2 rounded" style={{ background: "var(--inset)" }}>
            <code className="type-caption-1 flex-1 truncate" style={{ color: "var(--text-muted)" }}>{publishUrl}</code>
            <button
              onClick={copyPublish}
              className="text-[color:var(--text-muted)] hover:text-[color:var(--text)] max-lg:inline-flex max-lg:items-center max-lg:justify-center max-lg:h-11 max-lg:w-11"
              title="Copy"
            >
              {copied ? <Check size={14} style={{ color: "var(--success)" }} /> : <Copy size={14} />}
            </button>
          </div>
        ) : (
          <button onClick={loadPublishUrl} className="btn ghost text-sm">
            Reveal publish URL
          </button>
        )}
        <p className="type-caption-1 mt-2" style={{ color: "var(--text-muted)" }}>
          This goes the other direction — paste this URL into your phone's
          "Subscribe to calendar" flow and your Droplet events show up there
          automatically.
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
