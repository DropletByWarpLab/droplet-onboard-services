"use client";

import { Clock, FolderSync, Play, Trash2 } from "lucide-react";
import type { SyncTargetInfo } from "@/lib/types";
import { deleteSyncTarget, triggerSync, updateSyncTarget } from "@/lib/api";

interface SyncTargetCardProps {
  target: SyncTargetInfo;
  onUpdate: () => void;
}

export function SyncTargetCard({ target, onUpdate }: SyncTargetCardProps) {
  const handleToggle = async () => {
    await updateSyncTarget(target.id, { enabled: !target.enabled });
    onUpdate();
  };

  const handleTrigger = async () => {
    await triggerSync(target.id);
  };

  const handleDelete = async () => {
    if (!confirm(`Remove sync target "${target.label}"?`)) return;
    await deleteSyncTarget(target.id);
    onUpdate();
  };

  const lastSyncText = target.lastSync
    ? new Date(target.lastSync).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Never";

  return (
    <div className="dp-card p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <FolderSync size={16} className="text-accent" />
          <h3 className="type-headline text-label-primary">{target.label}</h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleTrigger}
            className="p-1.5 rounded-full text-label-tertiary hover:text-accent hover:bg-accent-subtle transition-colors"
            aria-label="Sync now"
          >
            <Play size={14} />
          </button>
          <button
            onClick={handleDelete}
            className="p-1.5 rounded-full text-label-tertiary hover:text-system-red hover:bg-system-red/10 transition-colors"
            aria-label="Remove"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Details */}
      <div className="space-y-0 divide-y divide-separator">
        <div className="dp-row !px-0">
          <span className="type-footnote text-label-secondary">Path</span>
          <span className="type-footnote font-mono text-label-primary">
            {target.path}
          </span>
        </div>
        <div className="dp-row !px-0">
          <span className="type-footnote text-label-secondary">Interval</span>
          <span className="type-footnote text-label-primary">
            Every {target.intervalMin} min
          </span>
        </div>
        <div className="dp-row !px-0">
          <span className="type-footnote text-label-secondary">Files tracked</span>
          <span className="type-footnote text-label-primary">{target.fileCount}</span>
        </div>
        <div className="dp-row !px-0">
          <span className="type-footnote text-label-secondary">Last sync</span>
          <span className="type-footnote text-label-primary">{lastSyncText}</span>
        </div>
        <div className="dp-row !px-0">
          <span className="type-footnote text-label-secondary">Status</span>
          {/* Toggle switch */}
          <button
            onClick={handleToggle}
            aria-label={target.enabled ? "Disable sync" : "Enable sync"}
            className={`
              relative w-[51px] h-[31px] rounded-full transition-colors duration-200 ease-smooth
              ${target.enabled ? "bg-system-green" : "bg-label-quaternary"}
            `}
          >
            <span
              className={`
                absolute top-[2px] w-[27px] h-[27px] rounded-full bg-white shadow-sm
                transition-transform duration-200 ease-smooth
                ${target.enabled ? "left-[22px]" : "left-[2px]"}
              `}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
