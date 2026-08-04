"use client";

import { pct } from "./helpers";

interface Props {
  usedW: number;
  budgetW: number;
  activePorts: number;
}

/**
 * PoE budget meter — the header's at-a-glance power read.
 * Big mono value over the shell `.meter` bar filled to used/budget.
 */
export function PoeBudget({ usedW, budgetW, activePorts }: Props) {
  const filled = pct(usedW, budgetW);
  return (
    <div className="min-w-[210px]">
      <div className="flex items-baseline gap-1.5 mb-1.5">
        <span className="type-subheadline font-semibold text-[color:var(--text)] font-mono">
          {usedW.toFixed(1)} W
        </span>
        <span className="type-caption-2 text-[color:var(--text-muted)]">
          of <span className="font-mono">{budgetW} W</span> · {activePorts} ports powered
        </span>
      </div>
      <div
        className="meter"
        role="meter"
        aria-label="PoE budget used"
        aria-valuenow={Math.round(usedW)}
        aria-valuemin={0}
        aria-valuemax={Math.round(budgetW)}
      >
        <span className="fill block" style={{ width: `${filled}%` }} />
      </div>
    </div>
  );
}
