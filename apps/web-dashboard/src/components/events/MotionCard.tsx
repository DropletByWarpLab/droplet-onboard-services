"use client";

import Link from "next/link";
import { Activity, Play } from "lucide-react";
import type { MotionActivity } from "@/lib/types";

export function motionRecordingLink(activity: MotionActivity) {
  const date = new Date(activity.startTime * 1000);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `/cameras/${encodeURIComponent(activity.camera)}/recordings?date=${day}`;
}

export function MotionCard({ activity, onOpen }: { activity: MotionActivity; onOpen: (activity: MotionActivity) => void }) {
  const seconds = Math.max(1, Math.round(activity.endTime - activity.startTime));
  return (
    <div className="card overflow-hidden" style={{ padding: 0 }}>
      <button type="button" onClick={() => onOpen(activity)} className="w-full text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
        <div className="flex items-center justify-center gap-2 h-24" style={{ background: "var(--inset)", color: "var(--text-muted)" }}><Activity size={28} /><Play size={20} /><span className="type-footnote">Play movement</span></div>
        <div className="p-3 space-y-1">
          {activity.outsideBusinessHours === true && <span className="badge warn">Outside business hours</span>}
          <p className="type-subheadline font-medium">Motion detected</p>
          <p className="type-caption-1 text-[color:var(--text-muted)]">{activity.camera.replace(/_/g, " ")}</p>
          <p className="type-caption-1 text-[color:var(--text-muted)]">{new Date(activity.startTime * 1000).toLocaleString()} · {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</p>
        </div>
      </button>
      <div className="px-3 pb-3"><Link href={motionRecordingLink(activity)} className="type-caption-1 text-[color:var(--brand)]">Browse recording</Link></div>
    </div>
  );
}
