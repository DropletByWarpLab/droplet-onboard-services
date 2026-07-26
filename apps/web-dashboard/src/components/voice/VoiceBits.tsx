"use client";

/**
 * WARP-1055 — shared visual pieces for the /voice surface + wizard:
 * live meter, status ring, check-state glyphs, countdown ring,
 * listening ring, playback arcs. Recreated from the design handoff
 * prototype (voice-bits.jsx) on the dashboard's real tokens.
 *
 * Honesty rule: every rendered level derives from the REAL
 * `input_rms_dbfs` field of `/api/voice/status` — the bar shaping is
 * a deterministic visualization of that one number, never random.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import {
  CheckCircle2,
  AlertTriangle,
  Ear,
  Mic,
  Check,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { meterFractionFromDbfs } from "./state";
import type { VoiceCheckStatus } from "./state";

/* ── Live input meter (§3.1) ─────────────────────────────────────────
   role="meter" with aria-valuenow throttled to ~1/s (§8). The visual
   updates at the page's 1 s status-poll cadence; under reduced motion
   the CSS transition is off and the fill quantizes to discrete steps
   (stepped ≤2 Hz — the poll is 1 Hz). */
export function LiveMeter({
  dbfs,
  flat = false,
  caption,
  bars = 24,
  big = false,
}: {
  dbfs: number | null | undefined;
  /** Hard-flat placeholder (no mic / broken / loading). */
  flat?: boolean;
  caption?: string;
  bars?: number;
  big?: boolean;
}) {
  const reduced = useReducedMotion();
  const fraction = flat ? 0 : meterFractionFromDbfs(dbfs);
  const level = reduced ? Math.round(fraction * 5) / 5 : fraction;

  // aria-valuenow throttled to ~1/s for screen readers (§8).
  const latest = useRef(0);
  latest.current = Math.round(fraction * 100);
  const [ariaVal, setAriaVal] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setAriaVal(latest.current), 1000);
    return () => clearInterval(id);
  }, []);

  const center = (bars - 1) / 2;
  return (
    <div>
      <div
        className={"vmeter" + (flat ? " flat" : "")}
        role="meter"
        aria-label="Live microphone input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={flat ? 0 : ariaVal}
        style={big ? { height: 64 } : undefined}
      >
        {Array.from({ length: bars }).map((_, i) => {
          // Deterministic center-weighted shape of the single real level.
          const falloff = 1 - (Math.abs(i - center) / center) * 0.55;
          const h = Math.max(0.06, level * falloff);
          return (
            <span
              key={i}
              className={flat || h <= 0.07 ? "idle" : ""}
              style={{ height: `${Math.round(h * 100)}%` }}
            />
          );
        })}
      </div>
      {caption ? <p className="vmeter-cap">{caption}</p> : null}
    </div>
  );
}

/* Wizard meter with the acceptable/target zone band (§4.1/§4.2).
   `zoneLabel` takes a node so a measured value inside the label can
   ride in mono while the instruction stays in the UI font (WARP-1056
   tidy of the WARP-1055 review note). */
export function ZoneMeter({
  dbfs,
  zoneLabel,
}: {
  dbfs: number | null | undefined;
  zoneLabel: ReactNode;
}) {
  return (
    <div className="vzone-meter">
      <div className="zone" aria-hidden="true" />
      <LiveMeter dbfs={dbfs} bars={34} big />
      <p className="vzone-lbl">{zoneLabel}</p>
    </div>
  );
}

/* ── Status ring (hero, §3.1): 72px, color = status color ── */
export function StatusRing({
  status,
  icon: Icon = Mic,
}: {
  status: "ok" | "warn" | "err" | "neutral";
  /** WARP-1599 — the off hero swaps in `MicOff`: state is never carried
   *  by color alone (§8), and a live mic glyph over "no audio is
   *  captured" would say the opposite of the words beside it. */
  icon?: LucideIcon;
}) {
  return (
    <div className="vring" data-status={status} aria-hidden="true">
      <Icon size={28} strokeWidth={1.5} />
    </div>
  );
}

/* ── Check-state glyphs: color + icon + word, never color alone (§8) ── */
export function CheckState({ status }: { status: VoiceCheckStatus }) {
  if (status === "ok") {
    return (
      <span className="ink-green" style={{ display: "flex" }}>
        <CheckCircle2 size={16} aria-label="Passing" />
      </span>
    );
  }
  if (status === "warn") {
    return <span className="vwarn-dot" role="img" aria-label="Needs attention" />;
  }
  if (status === "err") {
    return (
      <span className="ink-red" style={{ display: "flex" }}>
        <AlertTriangle size={16} aria-label="Failing" />
      </span>
    );
  }
  return (
    <span style={{ fontSize: 13, color: "var(--color-label-tertiary)" }}>—</span>
  );
}

/* ── Countdown ring (§4.1). Sweeping arc normally; numeral is the
      reduced-motion twin (§8). onDone fires once at zero. ── */
export function CountdownRing({
  seconds,
  running,
  onDone,
}: {
  seconds: number;
  running: boolean;
  onDone?: () => void;
}) {
  const reduced = useReducedMotion();
  const [left, setLeft] = useState(seconds);
  const doneRef = useRef(false);
  useEffect(() => {
    if (!running) return;
    doneRef.current = false;
    setLeft(seconds);
    const start = Date.now();
    const id = setInterval(() => {
      const rem = Math.max(0, seconds - (Date.now() - start) / 1000);
      setLeft(rem);
      if (rem <= 0 && !doneRef.current) {
        doneRef.current = true;
        clearInterval(id);
        onDone?.();
      }
    }, 100);
    return () => clearInterval(id);
    // Restart only when the run toggles — onDone identity is not a reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, seconds]);

  const r = 40;
  const c = 2 * Math.PI * r;
  const frac = seconds > 0 ? left / seconds : 0;
  return (
    <div className="vcount">
      {!reduced && (
        <svg className="ringsvg" width="88" height="88" viewBox="0 0 88 88" aria-hidden="true">
          <circle
            cx="44" cy="44" r={r} fill="none"
            stroke="var(--color-accent-subtle)" strokeWidth="4"
          />
          <circle
            cx="44" cy="44" r={r} fill="none"
            stroke="var(--color-accent)" strokeWidth="4" strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - frac)}
          />
        </svg>
      )}
      <span className="cicon">
        <Ear size={30} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <span className="cnum" aria-hidden="true">
        {Math.ceil(left)}s
      </span>
    </div>
  );
}

/* ── Listening ring (§4.3): 2s breathing pulse; static under reduced
      motion (CSS media query kills the animation). ── */
export function ListeningRing({ state }: { state: "listening" | "ok" }) {
  const ok = state === "ok";
  return (
    <div className={"vlisten" + (ok ? " ok" : " pulsing")} aria-hidden="true">
      {ok ? <Check size={30} strokeWidth={2} /> : <Mic size={30} strokeWidth={1.5} />}
    </div>
  );
}

/* ── Playback arcs (§4.4) — the visual twin of the test sound (§8). ── */
export function PlaybackArcs({ playing }: { playing: boolean }) {
  return (
    <div className={"varcs" + (playing ? " playing" : "")} aria-hidden="true">
      <span className="arc" />
      <span className="arc" />
      <span className="arc" />
      <Volume2 size={30} strokeWidth={1.5} />
    </div>
  );
}
