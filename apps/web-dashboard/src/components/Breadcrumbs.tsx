"use client";

/**
 * WARP-214 — chevron-joined breadcrumb showing the recursion chain that
 * produced this chunk's text. Max depth-2 cap from the spec, so the chain
 * is at most three segments. Each segment is the MIME icon + filename;
 * segments are joined by chevrons.
 *
 * Returns null at depth 0 (~95% of files don't recurse) — keeps cards
 * clean. Returns null and warns once when chain is malformed so a
 * server-side schema regression doesn't blow up the dashboard.
 */

import { ChevronRight } from "lucide-react";
import { iconForMime } from "@/lib/mime-icons";
import type { ChainStep } from "@/lib/api";

export interface BreadcrumbsProps {
  chain?: ChainStep[];
}

let warnedOnceAboutMalformed = false;

export function Breadcrumbs({ chain }: BreadcrumbsProps) {
  if (!chain) return null;
  if (!Array.isArray(chain)) {
    if (!warnedOnceAboutMalformed) {
      console.warn("[Breadcrumbs] received non-array chain:", chain);
      warnedOnceAboutMalformed = true;
    }
    return null;
  }
  if (chain.length === 0) return null;

  return (
    <div
      className="breadcrumbs flex flex-wrap items-center gap-1 type-caption-1"
      role="list"
    >
      {chain.map((step, i) => {
        const Icon = iconForMime(step.mime);
        const isLast = i === chain.length - 1;
        return (
          <span
            key={`${step.filename}-${i}`}
            role="listitem"
            className="flex items-center gap-1"
          >
            <Icon
              size={12}
              className="flex-shrink-0 text-label-tertiary"
              aria-hidden
            />
            <span
              className={
                isLast
                  ? "text-label-primary font-medium"
                  : "text-label-tertiary"
              }
              title={step.filename}
            >
              {step.filename}
            </span>
            {!isLast && (
              <ChevronRight
                size={10}
                data-testid="breadcrumb-chevron"
                className="text-label-quaternary"
                aria-hidden
              />
            )}
          </span>
        );
      })}
    </div>
  );
}
