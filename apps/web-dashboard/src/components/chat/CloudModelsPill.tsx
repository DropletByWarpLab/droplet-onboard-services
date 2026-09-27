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
 * No new poll: it reads the `/api/models` SWR key the Models page already
 * refreshes every 30 s, so turning cloud off hides it within one refresh.
 *
 * Colours: `text-system-orange bg-system-orange/10` is the compound the
 * WARP-1475 rule in globals.css repoints to an AA-clearing orange;
 * cloud-models-pill.contrast.test.ts measures it on the composer surface.
 */
import { useId, useState } from "react";
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

  const access = data?.cloudAccess;
  if (!access?.escapeEnabled || access.allowedForYou === false) return null;

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 h-6 px-2 rounded-full type-caption-2 font-medium whitespace-nowrap text-system-orange bg-system-orange/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Cloud size={11} aria-hidden="true" />
        Cloud models on
      </button>
      {open && (
        <div
          id={panelId}
          role="note"
          className="absolute bottom-full left-0 mb-2 z-20 w-72 rounded-lg border border-separator bg-surface-primary p-3 shadow-lg type-footnote text-label-primary"
        >
          <p>{CLOUD_PILL_EXPLAINER}</p>
          {isAdminRole(user?.role) && (
            <p className="mt-2">
              <Link href="/models" className="text-accent underline">
                Manage cloud models
              </Link>
            </p>
          )}
        </div>
      )}
    </span>
  );
}
