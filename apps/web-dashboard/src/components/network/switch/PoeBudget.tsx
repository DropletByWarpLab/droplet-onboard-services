"use client";

import { pct } from "./helpers";
import styles from "./switch.module.css";

interface Props {
  usedW: number;
  budgetW: number;
  activePorts: number;
}

/**
 * PoE budget meter — the header's at-a-glance power read.
 * Big mono value over a 6px rounded bar filled green→accent to used/budget.
 */
export function PoeBudget({ usedW, budgetW, activePorts }: Props) {
  const filled = pct(usedW, budgetW);
  return (
    <div className="min-w-[210px]">
      <div className="flex items-baseline gap-1.5 mb-1.5">
        <span className="type-subheadline font-semibold text-label-primary font-mono">
          {usedW.toFixed(1)} W
        </span>
        <span className="type-caption-2 text-label-tertiary">
          of <span className="font-mono">{budgetW} W</span> · {activePorts} ports powered
        </span>
      </div>
      <div
        className="h-1.5 rounded-full bg-surface-secondary overflow-hidden"
        role="meter"
        aria-label="PoE budget used"
        aria-valuenow={Math.round(usedW)}
        aria-valuemin={0}
        aria-valuemax={Math.round(budgetW)}
      >
        <span className={styles.poeBudgetFill} style={{ width: `${filled}%` }} />
      </div>
    </div>
  );
}
