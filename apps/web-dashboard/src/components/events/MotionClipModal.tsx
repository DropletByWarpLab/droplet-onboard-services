"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { RefreshCw, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { HlsPlayer } from "@/components/recordings/HlsPlayer";
import type { MotionActivity } from "@/lib/types";
import { motionRecordingLink } from "./MotionCard";

export function MotionClipModal({ activity, onClose }: { activity: MotionActivity; onClose: () => void }) {
  const headingId = useId();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  return (
    <Dialog open onClose={onClose} labelledBy={headingId} maxWidth="xl">
      <div className="flex items-center justify-between mb-3">
        <h2 id={headingId} className="type-headline">Recorded movement</h2>
        <button type="button" className="icon-btn" aria-label="Close motion recording" onClick={onClose}><X size={18} /></button>
      </div>
      <p className="type-footnote text-[color:var(--text-muted)] mb-3">{activity.camera.replace(/_/g, " ")} · {new Date(activity.startTime * 1000).toLocaleString()}</p>
      {activity.outsideBusinessHours === true && <span className="badge warn mb-3">Outside business hours</span>}
      {error ? <div role="alert" className="space-y-3"><p className="type-footnote">{error}</p><button type="button" className="btn" onClick={() => { setError(null); setAttempt((n) => n + 1); }}><RefreshCw size={14} /> Retry recording</button></div>
        : <HlsPlayer key={`${activity.id}-${attempt}`} src={activity.playbackUrl} className="w-full max-h-[60vh] rounded-lg bg-black" onError={setError} muted />}
      <div className="mt-3"><Link className="btn ghost sm" href={motionRecordingLink(activity)}>Browse recording</Link></div>
    </Dialog>
  );
}
