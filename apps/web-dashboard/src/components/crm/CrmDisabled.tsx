"use client";

import { useState, type JSX } from "react";
import { Building2 } from "lucide-react";
import { mutate } from "swr";
import { ShellPage } from "@/components/shell/ShellPage";
import { EmptyBlock } from "@/components/projects/bits";
import { useAuth } from "@/lib/auth";
import { setAppModuleEnabled, type AppCapabilities } from "@/lib/api";
import { APP_CAPABILITY_DEFAULTS } from "@/lib/hooks/useAppCapabilities";

/**
 * WARP-2558 — the honest "module off" state for /customers.
 *
 * Deliberately a sibling of `ProjectsDisabled` rather than a generalisation of
 * it: the two differ in the module id they toggle, the glyph, and every string
 * a human reads. Folding them into one parameterised component would leave a
 * props bag whose only job is to carry copy, and the next surface would add a
 * third branch to it.
 *
 * The enable path lives here for the people who can act on it — an owner or
 * admin gets a working button (PATCH /api/admin/modules/crm, which the server
 * gates to exactly those roles) and everyone else gets copy with no dead
 * affordance. On success the /api/capabilities cache is flipped in place
 * rather than revalidated, because a revalidation re-hits the browser's 30 s
 * HTTP cache and keeps this screen up after the server has already said yes.
 *
 * WARP-2558 note: this no longer has to mention Projects. Until ADR-044 the
 * `crm` module carried `requires: "projects"`, so "off" could mean either
 * "CRM is off" or "its parent is off" and the copy could not tell the reader
 * which. The edge is gone; off means off.
 */
export function CrmDisabled(): JSX.Element {
  const { user } = useAuth();
  const canEnable = user?.role === "owner" || user?.role === "admin";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setAppModuleEnabled("crm", true);
      // Merge rather than replace: the capabilities payload carries `projects`
      // and `contacts` too, and writing `{ crm: true }` alone would blank them
      // for every other reader of this cache key until the next probe.
      //
      // The shape and the pre-probe fallbacks are both imported rather than
      // re-declared — a local `{ projects, crm, contacts }` type and a
      // hand-copied `?? true` / `?? false` are two ways for this component to
      // drift from the contract the hook actually serves.
      await mutate(
        "/api/capabilities",
        (prev: AppCapabilities | undefined): AppCapabilities => ({
          ...APP_CAPABILITY_DEFAULTS,
          ...prev,
          crm: true,
        }),
        { revalidate: false },
      );
    } catch {
      setError("Couldn't turn on Customers just now. Try again in a moment.");
      setBusy(false);
    }
  };

  return (
    <ShellPage icon={<Building2 size={15} />} label="Customers" title="Customers">
      <div className="pm-scope">
        <div className="pm-page">
          <div className="pm-surface" style={{ padding: 8 }}>
            <EmptyBlock
              icon="building"
              heading="Customers isn't enabled on this Droplet."
              body={
                canEnable
                  ? "Turn it on to keep track of the people and companies you work with — you can turn it off anytime."
                  : "An owner or admin can turn it on."
              }
              cta={
                canEnable ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <button
                      className="pm-btn primary"
                      type="button"
                      onClick={() => void enable()}
                      disabled={busy}
                    >
                      <Building2 size={14} />
                      {busy ? "Turning on…" : "Turn on Customers"}
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
