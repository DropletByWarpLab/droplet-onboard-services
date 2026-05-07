"use client";

/**
 * "Brain memory" tab — list of BrainMemoryItem rows for the authed
 * user with per-item Delete + "Download original" + "Export all as
 * zip" affordances.
 *
 * The actual delete + export endpoints land in WARP-205. This tab
 * renders the buttons today but degrades gracefully:
 *   - When `/api/files/brain` returns 404 (WARP-203 not merged), the
 *     tab shows the same friendly empty state as Recently-indexed.
 *   - When delete / export endpoints return 404 (WARP-205 not merged),
 *     the buttons surface an inline "coming soon" state instead of
 *     blowing up.
 *
 * That way the UI shape is stable across the partial-deploy window
 * during the WARP-203 → 204 → 205 rollout.
 */

import { useEffect, useState } from "react";
import {
  Download,
  FileArchive,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  getBrainMemoryItems,
  type BrainMemoryItemInfo,
} from "@/lib/api";
import { authFetch } from "@/lib/auth";

interface State {
  loading: boolean;
  items: BrainMemoryItemInfo[];
  unavailable: boolean;
  error: string | null;
}

const INITIAL: State = {
  loading: true,
  items: [],
  unavailable: false,
  error: null,
};

export function BrainMemoryTab() {
  const [state, setState] = useState<State>(INITIAL);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [exportPending, setExportPending] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(INITIAL);
    getBrainMemoryItems()
      .then(({ items, unavailable }) => {
        if (cancelled) return;
        setState({
          loading: false,
          items,
          unavailable: !!unavailable,
          error: null,
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setState({
          loading: false,
          items: [],
          unavailable: false,
          error: err.message,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDelete(item: BrainMemoryItemInfo) {
    if (!confirm(`Delete "${item.filename}" from brain memory?`)) return;
    setPendingDelete(item.id);
    setActionMessage(null);
    try {
      const res = await authFetch(
        `/api/files/brain/${encodeURIComponent(item.id)}`,
        { method: "DELETE" }
      );
      if (res.status === 404) {
        setActionMessage(
          "Delete will be online once the brain memory service is fully set up."
        );
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Delete failed: ${res.status}`);
      }
      setState((s) => ({ ...s, items: s.items.filter((i) => i.id !== item.id) }));
    } catch (err) {
      setActionMessage(`Delete failed: ${(err as Error).message}`);
    } finally {
      setPendingDelete(null);
    }
  }

  async function handleExportAll() {
    setExportPending(true);
    setActionMessage(null);
    try {
      const res = await authFetch(`/api/files/brain/export?all=1`);
      if (res.status === 404) {
        setActionMessage(
          "Export will be online once the brain memory service is fully set up."
        );
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Export failed: ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "brain-memory.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionMessage(`Export failed: ${(err as Error).message}`);
    } finally {
      setExportPending(false);
    }
  }

  if (state.loading) {
    return (
      <div className="dp-card p-6 type-footnote text-label-tertiary">
        Loading…
      </div>
    );
  }

  if (state.error) {
    return (
      <div role="alert" className="dp-card p-4 type-footnote text-system-red">
        Couldn&apos;t load brain memory: {state.error}
      </div>
    );
  }

  if (state.unavailable || state.items.length === 0) {
    return (
      <div className="dp-card p-8 text-center" data-testid="brain-memory-empty">
        <Sparkles size={28} className="text-label-quaternary mx-auto mb-3" />
        <p className="type-subheadline text-label-primary">
          No files indexed yet.
        </p>
        <p className="type-footnote text-label-tertiary mt-1">
          Drop a file in chat or upload to your Droplet&apos;s Nextcloud at{" "}
          <a href="/files" className="text-accent hover:underline">
            /files
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="type-footnote text-label-tertiary px-1">
          {state.items.length} item{state.items.length === 1 ? "" : "s"}
        </p>
        <button
          type="button"
          onClick={handleExportAll}
          disabled={exportPending}
          className="
            inline-flex items-center gap-1.5 type-footnote text-label-secondary
            px-3 py-1.5 rounded-md bg-surface-secondary
            hover:bg-surface-tertiary hover:text-label-primary
            transition-colors disabled:opacity-50
          "
          data-testid="brain-export-all"
        >
          <FileArchive size={14} />
          {exportPending ? "Preparing…" : "Export all as zip"}
        </button>
      </div>

      {actionMessage && (
        <div className="dp-card p-3 type-footnote text-label-secondary" role="status">
          {actionMessage}
        </div>
      )}

      <ul className="space-y-2" data-testid="brain-memory-list">
        {state.items.map((item) => (
          <li
            key={item.id}
            className="dp-card p-3 flex items-start gap-3"
            data-testid="brain-memory-item"
          >
            <div className="w-8 h-8 rounded-md bg-accent-subtle flex items-center justify-center flex-shrink-0">
              <Sparkles size={14} className="text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="type-subheadline text-label-primary truncate">
                {item.filename}
              </p>
              <p className="type-caption-1 text-label-tertiary">
                {item.mimeType} · {(item.sizeBytes / 1024).toFixed(1)} KB ·{" "}
                {new Date(item.uploadedAt).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <a
                href={`/api/files/brain/${encodeURIComponent(item.id)}/download`}
                className="
                  p-1.5 rounded-md text-label-tertiary
                  hover:bg-surface-secondary hover:text-label-primary
                  transition-colors
                "
                title="Download original"
                aria-label="Download original"
                data-testid="brain-download"
              >
                <Download size={14} />
              </a>
              <button
                type="button"
                onClick={() => handleDelete(item)}
                disabled={pendingDelete === item.id}
                className="
                  p-1.5 rounded-md text-label-tertiary
                  hover:bg-system-red/10 hover:text-system-red
                  transition-colors disabled:opacity-50
                "
                title="Delete"
                aria-label="Delete"
                data-testid="brain-delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
