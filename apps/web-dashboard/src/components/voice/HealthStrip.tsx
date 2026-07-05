"use client";

/**
 * WARP-1055 — the §3.2 health-checks strip: four cards (Input level,
 * Background noise, Wake word, Mic processor), each icon + label +
 * one-line result + state glyph + mono timestamp. A failing card
 * exposes exactly ONE inline text action; no card ever dead-ends.
 *
 * §7.2: collapses to a single explanatory card when no microphone is
 * detected. §7.3: after two failed re-tests the processor card
 * escalates to the power-cycle copy + Get help link (the restart
 * endpoint is WARP-1057 — deliberately NOT a button here).
 */

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  AudioLines,
  Ear,
  Mic,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { CheckState } from "./VoiceBits";
import type { VoiceCheckAction, VoiceCheckModel } from "./state";
import "./voice.css";

const CHECK_ICONS: Record<VoiceCheckModel["id"], LucideIcon> = {
  level: AudioLines,
  noise: Ear,
  wake: Mic,
  dsp: Volume2,
};

export function HealthStrip({
  checks,
  dspEscalated = false,
  onAction,
}: {
  checks: VoiceCheckModel[] | "collapsed";
  /** §7.3 — two failed re-tests: swap the processor card's action for
   *  the power-cycle escalation copy. */
  dspEscalated?: boolean;
  onAction: (action: VoiceCheckAction) => void;
}) {
  if (checks === "collapsed") {
    return (
      <div
        className="vcard vcheck"
        data-status="err"
        style={{
          marginTop: 14,
          minHeight: 0,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <span className="vcheck-ico">
          <AlertTriangle size={15} aria-hidden="true" />
        </span>
        <p className="result" style={{ flex: 1 }}>
          Health checks are paused — they resume the moment a microphone is
          detected.
        </p>
      </div>
    );
  }

  return (
    <div className="vchecks">
      {checks.map((check) => {
        const Icon = CHECK_ICONS[check.id];
        const escalate = check.id === "dsp" && check.status === "err" && dspEscalated;
        return (
          <div key={check.id} className="vcard vcheck" data-status={check.status}>
            <div className="vcheck-top">
              <span className="vcheck-ico">
                <Icon size={15} aria-hidden="true" />
              </span>
              <span className="lbl">{check.label}</span>
              <span className="state">
                <CheckState status={check.status} />
              </span>
            </div>
            <p className="result">
              {check.value ? (
                <span>
                  <span className="mono">{check.value}</span>
                  {" · "}
                </span>
              ) : null}
              {escalate
                ? "The processor didn't come back. A power cycle of the Droplet usually clears this."
                : check.result}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="stamp mono">{check.stamp}</span>
              {escalate ? (
                <Link
                  href="/help"
                  className="vtext-btn"
                  style={{ marginLeft: "auto" }}
                >
                  Get help <ArrowRight size={12} aria-hidden="true" />
                </Link>
              ) : check.action && check.actionLabel ? (
                <button
                  type="button"
                  className="vtext-btn"
                  style={{ marginLeft: "auto" }}
                  onClick={() => onAction(check.action as VoiceCheckAction)}
                >
                  {check.actionLabel}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
