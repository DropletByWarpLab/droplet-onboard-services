"use client";

/**
 * WARP-2978 (ADR-059 P3 §8, D23) — "Acknowledgements": every person's first
 * acknowledgement and the resolve, oldest first. Who, when (site time), the
 * device as it described itself (reported, never proof), whether it came
 * from the person's own alert notification, and — for owners and admins,
 * only when the box sends it — whether the sign-in was confirmed live. A
 * resolve's note is shown under its line, as the person wrote it.
 */
import { CheckCircle2, CircleCheckBig } from "lucide-react";
import type { IncidentAckView } from "@/lib/types";
import { ackLine } from "./incident-copy";

export function AckHistory({
  acks,
  timezone,
  now,
  labelledBy,
}: {
  acks: readonly IncidentAckView[];
  timezone: string;
  now: Date;
  labelledBy: string;
}) {
  return (
    <ul className="rows" aria-labelledby={labelledBy} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {acks.map((a, n) => {
        const Icon = a.action === "resolve" ? CircleCheckBig : CheckCircle2;
        return (
          <li key={`${a.at}-${n}`} className="lrow" data-action={a.action} style={{ alignItems: "flex-start" }}>
            <span className="ri brand" aria-hidden>
              <Icon size={16} />
            </span>
            <span className="rt">
              <span className="nm" style={{ whiteSpace: "normal", overflowWrap: "anywhere", fontWeight: 400 }}>
                {ackLine(a, timezone, now)}
              </span>
              {a.note && (
                <span className="sub" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text)" }}>
                  {a.note}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
