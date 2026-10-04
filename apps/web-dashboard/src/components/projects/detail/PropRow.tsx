"use client";

import type { JSX, ReactNode } from "react";
import { PmIcon } from "../icons";

/** One labelled row of the drawer's properties card. `error` is the inline
 *  message for a control whose last write failed; `role="alert"` makes a screen
 *  reader say it (design brief §5.5). Exported so other drawer sections can add
 *  rows to the same card. */
export function PropRow({
  icon,
  label,
  error,
  children,
}: {
  icon: string;
  label: string;
  error?: string | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="pm-prop">
      <span className="lab">
        <PmIcon name={icon} size={14} />
        {label}
      </span>
      <span style={{ minWidth: 0 }}>
        {children}
        {error && (
          <div className="pm-field-error" role="alert">
            {error}
          </div>
        )}
      </span>
    </div>
  );
}
