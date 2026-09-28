"use client";

/**
 * WARP-3161 — "Cloud models on" pill in the chat composer (Mac parity,
 * WARP-3030; decided by Romain 2026-09-25).
 *
 * Shown while the box's `cloud_model_escape` channel is on, unless the box
 * says this person's turns never go to cloud (`allowedForYou === false`,
 * cloud-access.service.ts: escape AND role). `null` (unknown) shows it: the
 * safe side of "your text may leave the Droplet" is to say so.
 *
 * It reads the `/api/models` SWR key (the Models page's), which refreshes
 * every 30 s, so turning cloud off hides it within one refresh. That means
 * an open chat tab now polls GET /api/models every 30 s too.
 *
 * Colours: shell tokens only (`--card-bg`, `--card-bd`, `--text`,
 * `--text-muted`, `--brand`). There is no warning token, so the cloud icon
 * and the words carry the meaning; cloud-models-pill.contrast.test.ts
 * measures the text on the pill in both themes.
 */
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Cloud } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/access";
import { useModelsPage } from "@/lib/hooks/useModelsPage";

export const CLOUD_PILL_EXPLAINER =
  "An admin has allowed cloud models on this Droplet. When a cloud model answers, your message and anything you attach are sent to that provider, outside your company. Local models keep chat on your Droplet.";

export function CloudModelsPill() {
  const { data } = useModelsPage();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);

  // Outside click or Escape closes the explainer (the ContextPinsPopover
  // pattern).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const access = data?.cloudAccess;
  if (!access?.escapeEnabled || access.allowedForYou === false) return null;

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 h-6 px-2 rounded-[var(--radius-pill)] border border-[var(--card-bd)] bg-[var(--card-bg)] text-[var(--text)] type-caption-2 font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
      >
        <Cloud size={11} aria-hidden="true" />
        Cloud models on
      </button>
      {open && (
        <div
          id={panelId}
          role="note"
          className="absolute bottom-full left-0 mb-2 z-20 w-72 rounded-lg border border-[var(--card-bd)] bg-[var(--card-bg)] p-3 shadow-lg type-footnote text-[var(--text)]"
        >
          <p>{CLOUD_PILL_EXPLAINER}</p>
          {isAdminRole(user?.role) && (
            <p className="mt-2">
              <Link href="/models" className="text-[var(--text)] underline">
                Manage cloud models
              </Link>
            </p>
          )}
        </div>
      )}
    </span>
  );
}
