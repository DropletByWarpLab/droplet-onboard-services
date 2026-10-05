"use client";

// The running-timer chip in the Projects header (WARP-3526): while the signed-in
// person has a timer going, every Projects view shows what it is on, how long it
// has run, and a Stop button. Renders nothing when no timer is running, so a box
// that never tracks time sees no new control.
//
// It sits in the page header's `actions`, which the shell renders OUTSIDE the
// page's own `.pm-scope`, so the chip brings its own scope wrapper for the
// `pm-*` tokens and buttons to resolve.

import { useState, type JSX } from "react";
import { Square } from "lucide-react";
import { useToast } from "@/components/Toast";
import { timeErrorCopy } from "./copy";
import { formatClock, formatMinutes } from "./format";
import { useNow, useRunningTimer, useTimeActions } from "./useTime";
import "./time.css";

export function TimerChip(): JSX.Element | null {
  const { timer } = useRunningTimer();
  const actions = useTimeActions();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const now = useNow(timer ? 1000 : null);

  if (!timer) return null;

  const stop = async (): Promise<void> => {
    setBusy(true);
    try {
      const { worklog, capped } = await actions.stopTimer();
      toast(
        capped
          ? `The timer ran for more than 24 hours, so ${formatMinutes(worklog.minutes)} was logged on ${timer.workItem.key}. Edit the entry to correct it.`
          : `Logged ${formatMinutes(worklog.minutes)} on ${timer.workItem.key}.`,
        capped ? "info" : "success",
      );
    } catch (e) {
      toast(timeErrorCopy(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="pm-scope">
      <span className="pm-timerchip" role="group" aria-label={`Timer running on ${timer.workItem.key}`}>
        <span className="pm-dot" style={{ background: "var(--info)" }} aria-hidden />
        <span role="timer" className="pm-mono" style={{ fontWeight: 600 }}>
          {formatClock(now - new Date(timer.startedAt).getTime())}
        </span>
        <span className="pm-mono" style={{ color: "var(--text-3)" }}>
          {timer.workItem.key}
        </span>
        <span className="pm-timerchip-name">{timer.workItem.name}</span>
        <button
          className="pm-btn sm"
          type="button"
          onClick={stop}
          disabled={busy}
          aria-label={`Stop the timer on ${timer.workItem.key}`}
        >
          <Square size={12} aria-hidden />
          {busy ? "Stopping…" : "Stop"}
        </button>
      </span>
    </span>
  );
}
