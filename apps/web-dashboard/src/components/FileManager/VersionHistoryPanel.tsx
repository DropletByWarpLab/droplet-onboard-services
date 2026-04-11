"use client";

import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { fetchVersions, restoreVersion } from "@/lib/api";
import type { FileVersionInfo } from "@/lib/types";

interface VersionHistoryPanelProps {
  filePath: string;
  onRestored: () => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * File detail panel addition that lists previous versions of a file
 * and lets the user restore any one of them.
 */
export function VersionHistoryPanel({ filePath, onRestored }: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<FileVersionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [notSupported, setNotSupported] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setVersions(null);
    setError(null);
    setNotSupported(false);

    (async () => {
      try {
        const res = await fetchVersions(filePath);
        if (cancelled) return;
        if (res.fileId === 0 && res.versions.length === 0) {
          // Versions endpoint returned 501 (legacy backend) or 404 (no history)
          setVersions([]);
        } else {
          setVersions(res.versions);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load versions");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const handleRestore = async (versionId: string) => {
    setRestoringId(versionId);
    setError(null);
    try {
      await restoreVersion(filePath, versionId);
      onRestored();
      // Refetch to reflect new "current" version (the restored content becomes
      // the new latest, the previous current moves into history).
      const res = await fetchVersions(filePath);
      setVersions(res.versions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="pt-4 border-t border-separator">
      <div className="flex items-center gap-2 mb-3">
        <History size={14} className="text-label-tertiary" />
        <h4 className="type-footnote text-label-secondary font-medium">
          Version history
        </h4>
      </div>

      {error && (
        <p className="type-caption-1 text-system-red mb-2">{error}</p>
      )}

      {notSupported && (
        <p className="type-caption-1 text-label-tertiary">
          Versions require the Nextcloud backend.
        </p>
      )}

      {versions === null && !error && (
        <p className="type-caption-1 text-label-tertiary">Loading…</p>
      )}

      {versions && versions.length === 0 && !error && (
        <p className="type-caption-1 text-label-tertiary">
          No previous versions yet.
        </p>
      )}

      {versions && versions.length > 0 && (
        <ul className="space-y-1">
          {versions.map((v) => (
            <li
              key={v.versionId}
              className="flex items-center gap-2 py-1.5 px-2 rounded-sm hover:bg-surface-secondary transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="type-caption-1 text-label-primary truncate">
                  {formatDate(v.modifiedAt)}
                </p>
                <p className="type-caption-2 text-label-tertiary">
                  {formatSize(v.size)}
                </p>
              </div>
              <button
                onClick={() => handleRestore(v.versionId)}
                disabled={restoringId !== null}
                className="p-1.5 rounded-full text-label-tertiary hover:text-accent hover:bg-accent-subtle transition-colors disabled:opacity-50"
                title="Restore this version"
              >
                <RotateCcw size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
