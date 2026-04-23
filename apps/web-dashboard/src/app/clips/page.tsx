"use client";

import { useState } from "react";
import { Film, RefreshCw, X } from "lucide-react";
import { useClips, type Clip } from "@/lib/hooks/useClips";

function fmtRel(epochSec: number): string {
  const ms = Date.now() - epochSec * 1000;
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function fmtDuration(start: number, end: number | null): string {
  if (!end) return "—";
  const sec = Math.max(0, Math.round(end - start));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export default function ClipsPage() {
  const { clips, refresh, isLoading } = useClips({ limit: 60 });
  const [playing, setPlaying] = useState<Clip | null>(null);

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="type-large-title text-label-primary">Clips</h1>
          <p className="type-subheadline text-label-tertiary mt-1">
            {clips.length > 0
              ? `${clips.length} recent clip${clips.length === 1 ? "" : "s"}`
              : "No clips yet — they'll appear here as your cameras detect events"}
          </p>
        </div>
        <button
          onClick={() => refresh()}
          disabled={isLoading}
          className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
          <span className="type-subheadline">Refresh</span>
        </button>
      </div>

      {isLoading && clips.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="dp-card aspect-video animate-pulse bg-surface-secondary" />
          ))}
        </div>
      ) : clips.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-label-tertiary">
          <Film size={32} className="mb-2 opacity-50" />
          <p className="type-body">No clips recorded yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {clips.map((c) => (
            <button
              key={c.id}
              onClick={() => setPlaying(c)}
              className="dp-card overflow-hidden text-left hover:ring-2 ring-accent transition group"
            >
              <div className="aspect-video bg-surface-secondary relative overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={c.thumbnail_url}
                  alt={`${c.label} on ${c.camera}`}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                  loading="lazy"
                />
                <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-white type-caption">
                  {fmtDuration(c.start_time, c.end_time)}
                </div>
              </div>
              <div className="p-2.5">
                <div className="flex items-center justify-between">
                  <span className="type-subheadline text-label-primary capitalize">
                    {c.label}
                  </span>
                  <span className="type-caption text-label-tertiary">
                    {Math.round(c.score * 100)}%
                  </span>
                </div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="type-caption text-label-tertiary truncate">{c.camera}</span>
                  <span className="type-caption text-label-tertiary">{fmtRel(c.start_time)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Inline player modal */}
      {playing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setPlaying(null)}
        >
          <div className="relative max-w-4xl w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setPlaying(null)}
              className="absolute -top-10 right-0 text-white hover:text-system-red"
            >
              <X size={24} />
            </button>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={playing.clip_url}
              controls
              autoPlay
              className="w-full rounded-lg shadow-2xl bg-black"
            />
            <div className="mt-2 text-white type-subheadline">
              {playing.label} on {playing.camera} · {fmtRel(playing.start_time)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
