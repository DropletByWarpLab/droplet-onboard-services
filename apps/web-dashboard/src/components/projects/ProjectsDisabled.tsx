"use client";

import { useState, type JSX } from "react";
import { FolderKanban } from "lucide-react";
import { mutate } from "swr";
import { ShellPage } from "@/components/shell/ShellPage";
import { EmptyBlock } from "@/components/projects/bits";
import { useAuth } from "@/lib/auth";
import { setAppModuleEnabled, type AppCapabilities } from "@/lib/api";
import { APP_CAPABILITY_DEFAULTS } from "@/lib/hooks/useAppCapabilities";

/** Honest "module off" state (WARP-1154/1155). Rendered when the orchestrator
 *  explicitly reports the Projects module disabled — no PM request ever fires
 *  from here.
 *
 *  WARP-1306 — the enable path lives right here for the people who can act on
 *  it: an owner/admin gets a working "Turn on Projects" button (PATCH
 *  /api/admin/modules/projects — the same module-toggles write the server
 *  gates to owner/admin), and on success the /api/capabilities SWR cache is
 *  flipped in place so the workspace renders immediately instead of waiting
 *  out the probe's 30 s HTTP cache. Everyone else keeps the honest "an owner
 *  or admin can turn it on" copy with no dead affordance.
 *
 *  Lives in its own module (not the `projects/page.tsx` route file) because
 *  Next.js App Router rejects any non-reserved named export from a page route. */
export function ProjectsDisabled(): JSX.Element {
  const { user } = useAuth();
  const canEnable = user?.role === "owner" || user?.role === "admin";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setAppModuleEnabled("projects", true);
      // Flip the capability cache in place — revalidating would re-hit the
      // browser's 30 s HTTP cache and keep this screen up after the server
      // already said yes. The gate cache is invalidated server-side by the
      // PATCH, so the workspace's PM reads succeed immediately.
      //
      // Merge rather than replace (WARP-2578): the payload carries `crm` and
      // `contacts` too, and writing `{ projects: true }` alone blanked them for
      // every other reader of this cache key until the next probe — which is
      // 10 minutes away (refreshInterval) and cannot be revalidated into
      // place here, because that is the HTTP cache this flip exists to skip.
      //
      // The defaults spread is load-bearing, not belt-and-braces: with no
      // cache entry yet, `{ ...prev, projects: true }` would write the same
      // `undefined` flags this fixes. Both the shape and the pre-probe
      // fallbacks are imported rather than re-declared, so this component
      // cannot drift from the contract the hook serves.
      await mutate(
        "/api/capabilities",
        (prev: AppCapabilities | undefined): AppCapabilities => ({
          ...APP_CAPABILITY_DEFAULTS,
          ...prev,
          projects: true,
        }),
        { revalidate: false },
      );
    } catch {
      setError("Couldn't turn on Projects just now. Try again in a moment.");
      setBusy(false);
    }
  };

  return (
    <ShellPage icon={<FolderKanban size={15} />} label="Projects" title="Projects">
      <div className="pm-scope">
        <div className="pm-page">
          <div className="pm-surface" style={{ padding: 8 }}>
            <EmptyBlock
              icon="board"
              heading="Projects isn't enabled on this Droplet."
              body={
                canEnable
                  ? "Turn it on to start tracking work — you can turn it off anytime."
                  : "An owner or admin can turn it on."
              }
              cta={
                canEnable ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <button
                      className="pm-btn primary"
                      type="button"
                      onClick={() => void enable()}
                      disabled={busy}
                    >
                      <FolderKanban size={14} />
                      {busy ? "Turning on…" : "Turn on Projects"}
                    </button>
                    {error && (
                      <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--err)" }}>
                        {error}
                      </p>
                    )}
                  </div>
                ) : undefined
              }
            />
          </div>
        </div>
      </div>
    </ShellPage>
  );
}
