"use client";

/**
 * Topbar — shared page chrome.
 *
 * Inputs from the redesign:
 *   • Breadcrumb trail (e.g. ["Workspace", "Files", "Recents"])
 *   • Optional status chip (system health, "x devices online", a typed alert)
 *   • Optional right-side actions (buttons the page wants on the chrome)
 *
 * Style: translucent material (matches sidebar's --color-toolbar-bg), 56px
 * tall on desktop, sticky to the top of the page content. Mobile branch
 * collapses the breadcrumb to just the last crumb and tucks actions into
 * an overflow if more than 2.
 *
 * NOT wired into any page yet. Phase 2 retrofits pages that today render
 * their own bespoke headers (Cameras, Files, Network, Devices, Settings).
 * The Home page intentionally does NOT use Topbar — its hero IS the chrome.
 */

import { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

export type StatusTone = "ok" | "warn" | "error" | "info" | "neutral";

interface Crumb {
  label: string;
  /** Optional — if omitted, the crumb is rendered as a non-link span. */
  href?: string;
}

interface TopbarProps {
  /** Trail rendered left-to-right, separated by chevrons. The LAST crumb
   *  is always rendered as the current page (label-primary, semibold). */
  crumbs: Crumb[];
  /** Optional status chip rendered to the right of the breadcrumb. */
  status?: {
    tone: StatusTone;
    label: string;
    /** Optional tooltip with extra detail. */
    title?: string;
  };
  /** Right-aligned slot — buttons, dropdowns, etc. */
  actions?: ReactNode;
}

const TONE_DOT: Record<StatusTone, string> = {
  ok: "bg-system-green",
  warn: "bg-system-orange",
  error: "bg-system-red",
  info: "bg-system-blue",
  neutral: "bg-label-quaternary",
};

export function Topbar({ crumbs, status, actions }: TopbarProps) {
  const lastIdx = crumbs.length - 1;

  return (
    <div
      className="
        sticky top-0 z-30
        bg-[var(--color-toolbar-bg)] dp-material
        border-b border-separator
      "
    >
      <div className="h-14 px-4 lg:px-8 flex items-center gap-3">
        {/* Breadcrumb. On mobile (< sm) we drop everything except the last
            crumb so the chrome stays single-line at 320px. */}
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 min-w-0">
          <ol className="flex items-center gap-1 min-w-0">
            {crumbs.map((c, i) => {
              const isLast = i === lastIdx;
              const hiddenOnMobile = !isLast;
              return (
                <li
                  key={`${c.label}-${i}`}
                  className={`flex items-center gap-1 min-w-0 ${
                    hiddenOnMobile ? "hidden sm:flex" : "flex"
                  }`}
                >
                  {i > 0 && (
                    <ChevronRight
                      size={12}
                      strokeWidth={1.5}
                      className="text-label-tertiary flex-shrink-0"
                      aria-hidden
                    />
                  )}
                  {isLast || !c.href ? (
                    <span
                      aria-current={isLast ? "page" : undefined}
                      className={`
                        type-subheadline truncate
                        ${isLast ? "text-label-primary font-semibold" : "text-label-secondary"}
                      `}
                    >
                      {c.label}
                    </span>
                  ) : (
                    <Link
                      href={c.href}
                      className="
                        type-subheadline text-label-secondary truncate
                        hover:text-label-primary transition-colors
                      "
                    >
                      {c.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Status chip — only renders if provided. Inline with the
            breadcrumb to keep the chrome single-row. */}
        {status && (
          <span
            title={status.title}
            className="
              hidden md:inline-flex items-center gap-2 px-2.5 h-7 rounded-full
              border border-separator bg-surface-tertiary
              type-caption-1 text-label-secondary
            "
          >
            <span
              aria-hidden
              className={`w-1.5 h-1.5 rounded-full ${TONE_DOT[status.tone]}`}
            />
            <span className="truncate">{status.label}</span>
          </span>
        )}

        {/* Actions — right-aligned. Pages drop buttons in here. */}
        {actions && (
          <div className="ml-auto flex items-center gap-2 flex-shrink-0">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
