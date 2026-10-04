"use client";

// WARP-3520 -- the small marks the board cards and list rows share: the work
// item's KIND, its estimate, and its start date. Their own file rather than more
// lines in bits.tsx, which other slices edit concurrently.

import type { JSX } from "react";
import { PmIcon } from "./icons";
import { WORK_ITEM_TYPES, fmtDate, fmtEstimate } from "./config";
import type { PmWorkItem, WorkItemType } from "./types";

/** The kind as an icon. Never colour alone (design brief §5.1): the glyph differs
 *  per kind and the label is the accessible name and the tooltip. */
export function TypeIcon({ type = "task", size = 13 }: { type?: WorkItemType; size?: number }): JSX.Element {
  const meta = WORK_ITEM_TYPES[type] ?? WORK_ITEM_TYPES.task;
  return (
    <span className="pm-type" role="img" aria-label={meta.label} title={meta.label} style={{ color: meta.color }}>
      <PmIcon name={meta.icon} size={size} />
    </span>
  );
}

/** "5 pts". Renders nothing for an item that has not been estimated. */
export function EstimateChip({ estimate }: { estimate: number | null | undefined }): JSX.Element | null {
  const text = fmtEstimate(estimate);
  if (text === null) return null;
  return (
    <span className="pm-estimate" title={`Estimate: ${text}`}>
      {text}
    </span>
  );
}

/** "Starts Oct 4", sitting beside the due-date chip. Reuses `fmtDate`, exactly as
 *  the due chip does, so the two dates are always formatted the same way. */
export function StartChip({ item }: { item: Pick<PmWorkItem, "startDate"> }): JSX.Element | null {
  const text = fmtDate(item.startDate);
  if (text === null) return null;
  return (
    <span className="pm-duechip" title={`Starts ${text}`}>
      <PmIcon name="cal" size={11} />
      <span className="pm-mono" style={{ fontSize: 11 }}>
        <span className="pm-sr">Starts </span>
        {text}
      </span>
    </span>
  );
}
