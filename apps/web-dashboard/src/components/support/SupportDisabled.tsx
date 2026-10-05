"use client";

import { useState, type JSX } from "react";
import { LifeBuoy } from "lucide-react";
import { mutate } from "swr";
import { ShellPage } from "@/components/shell/ShellPage";
import { EmptyBlock } from "@/components/projects/bits";
import { useAuth } from "@/lib/auth";
import { setAppModuleEnabled, type AppCapabilities } from "@/lib/api";
import { APP_CAPABILITY_DEFAULTS } from "@/lib/hooks/useAppCapabilities";
import "@/app/projects/projects.css";

/** Honest "module off" state, the ProjectsDisabled pattern (WARP-1306): rendered
 *  when the orchestrator explicitly reports Support switched off — no support
 *  request fires from here. An owner or admin gets a working "Turn on Support"
 *  (the same module-toggles write the server gates to owner/admin) and the
 *  capability cache is flipped in place so the desk renders at once; everyone
 *  else keeps the honest copy with no dead affordance. */
export function SupportDisabled(): JSX.Element {
  const { user } = useAuth();
  const canEnable = user?.role === "owner" || user?.role === "admin";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setAppModuleEnabled("support", true);
      // Merge, never replace (WARP-2578): the payload carries the other flags
      // too, and the defaults spread covers a cache with no entry yet.
      await mutate(
        "/api/capabilities",
        (prev: AppCapabilities | undefined): AppCapabilities => ({
          ...APP_CAPABILITY_DEFAULTS,
          ...prev,
          support: true,
        }),
        { revalidate: false },
      );
    } catch {
      setError("Couldn't turn on Support just now. Try again in a moment.");
      setBusy(false);
    }
  };

  return (
    <ShellPage icon={<LifeBuoy size={15} />} label="Support" title="Support">
      <div className="pm-scope">
        <div className="pm-page">
          <div className="pm-surface" style={{ padding: 8 }}>
            <EmptyBlock
              icon="inbox"
              heading="Support isn't enabled on this Droplet."
              body={
                canEnable
                  ? "Turn it on to handle customer requests as tickets — you can turn it off anytime."
                  : "An owner or admin can turn it on."
              }
              cta={
                canEnable ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <button className="pm-btn primary" type="button" onClick={() => void enable()} disabled={busy}>
                      <LifeBuoy size={14} />
                      {busy ? "Turning on…" : "Turn on Support"}
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
