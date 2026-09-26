"use client";

/**
 * WARP-2978 (ADR-059 P3 §8) — "Why Droplet flagged this": one block per
 * reason the viewer can see, its sentence, then an evidence line per snapshot
 * (`Person · Back camera · 2:14 AM · Closed (opening hours)`). The box sends
 * only the reasons whose evidence camera this viewer can see (DS-005); this
 * renders exactly those, in the order they came.
 */
import { ShieldAlert, User, VideoOff, type LucideIcon } from "lucide-react";
import type { IncidentReasonView } from "@/lib/types";
import { codeSentence, evidenceLine } from "./incident-copy";

function iconFor(code: string): LucideIcon {
  if (code === "after_hours_presence") return User;
  if (code === "camera_offline") return VideoOff;
  return ShieldAlert;
}

export function ReasonList({
  reasons,
  cameraLabel,
  timezone,
  now,
  labelledBy,
}: {
  reasons: readonly IncidentReasonView[];
  cameraLabel: (name: string) => string;
  timezone: string;
  now: Date;
  labelledBy: string;
}) {
  // One block per sentence (a code can read two ways: a camera vs the camera system).
  const blocks: Array<{ sentence: string; code: string; severity: string; lines: string[] }> = [];
  for (const r of reasons) {
    const sentence = codeSentence(r);
    let block = blocks.find((b) => b.sentence === sentence);
    if (!block) {
      block = { sentence, code: r.code, severity: r.severity, lines: [] };
      blocks.push(block);
    }
    block.lines.push(evidenceLine(r, cameraLabel, timezone, now));
  }
  return (
    <ul className="rows" aria-labelledby={labelledBy} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {blocks.map((b) => {
        const Icon = iconFor(b.code);
        const tint = b.severity === "alert" ? " sev-ic err" : b.severity === "notice" ? " sev-ic warn" : "";
        return (
          <li key={b.sentence} className="lrow" data-code={b.code} style={{ alignItems: "flex-start" }}>
            <span className={`ri${tint}`} aria-hidden>
              <Icon size={16} />
            </span>
            <span className="rt">
              <span className="nm" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                {b.sentence}
              </span>
              {b.lines.map((line, n) => (
                <span key={n} className="sub" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                  {line}
                </span>
              ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
