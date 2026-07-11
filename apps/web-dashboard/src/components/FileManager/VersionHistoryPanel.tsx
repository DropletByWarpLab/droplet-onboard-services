"use client";

import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { fetchVersions, restoreVersion } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
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
        setError(translateError(err, "files"));
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
      setError(translateError(err, "files"));
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="pt-4" style={{ borderTop: "1px solid var(--card-bd)" }}>
      <div className="sect" style={{ margin: "0 0 12px" }}>
        <History size={14} style={{ color: "var(--text-muted)" }} />
        <h2>Version history</h2>
      </div>

      {error && (
        <p className="type-caption-1 mb-2" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}

      {notSupported && (
        <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          Versions require the Nextcloud backend.
        </p>
      )}

      {versions === null && !error && (
        <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          Loading…
        </p>
      )}

      {versions && versions.length === 0 && !error && (
        <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          No previous versions yet.
        </p>
      )}

      {versions && versions.length > 0 && (
        <ul className="rows">
          {versions.map((v) => (
            <li
              key={v.versionId}
              className="lrow rounded-[var(--radius-input)] hover:bg-[var(--hover)] transition-colors"
              style={{ padding: "8px" }}
            >
              <div className="rt">
                <span className="nm">{formatDate(v.modifiedAt)}</span>
                <span className="sub mono">{formatSize(v.size)}</span>
              </div>
              <button
                onClick={() => handleRestore(v.versionId)}
                disabled={restoringId !== null}
                className="btn ghost sm disabled:opacity-50"
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
