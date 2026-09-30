"use client";

import { useEffect, useState } from "react";
import { ToggleSwitch } from "@/components/smart-home/ToggleSwitch";
import { useToast } from "@/components/Toast";
import { authFetch, useAuth } from "@/lib/auth";
import { Sect } from "@/components/shell/primitives";

/**
 * Settings -> "Personal drives" (owner only).
 *
 * The owner switch for POST /api/storage/network-drive/personal: whether
 * owners, admins and staff (the `family` tier, labelled "Staff" on screen) may
 * map their own Droplet drive in Finder or File Explorer. OFF by default.
 * The flag is `Workspace.personalDriveEnabled`
 * (GET /api/settings/workspace reads it, the owner-only PUT
 * /api/settings/workspace/personal-drive writes it).
 *
 * The copy states what the owner is agreeing to: a mounted drive talks to
 * Nextcloud directly, so it skips two orchestrator controls. Keep that
 * sentence plain — it is the disclosure behind the switch.
 *
 * Optimistic like the Features switches: flip locally, PUT, put it back and
 * show the error line on failure. Renders NOTHING for any role but owner (the
 * PUT is owner-only server-side as well).
 */

const LOAD_ERROR_LINE = "Couldn't load this setting.";
const TOGGLE_ERROR_LINE = "That didn't apply — the switch was put back. Try again.";

export function PersonalDriveCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isOwner = user?.role === "owner";

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/settings/workspace");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { personalDriveEnabled?: boolean };
        if (!cancelled) setEnabled(body.personalDriveEnabled === true);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  if (!isOwner) return null;

  const handleToggle = async () => {
    if (enabled === null || pending) return;
    const next = !enabled;
    setToggleError(null);
    setPending(true);
    setEnabled(next);
    try {
      const res = await authFetch("/api/settings/workspace/personal-drive", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast(`Personal drives turned ${next ? "on" : "off"}`);
    } catch {
      setEnabled(!next);
      setToggleError(TOGGLE_ERROR_LINE);
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label="Personal drives">
      <Sect title="Personal drives" extra="Applies to everyone on this Droplet" />
      <div className="card" style={{ padding: 0 }}>
        <div className="rows">
          <div className="lrow" style={{ padding: "12px 16px", alignItems: "center" }}>
            <span className="rt">
              <span className="nm">Let people map their own drive</span>
              <span className="sub">
                {loadFailed
                  ? LOAD_ERROR_LINE
                  : "Owners, admins and staff members can put their own files in Finder or File Explorer with a personal login. Guests can't."}
              </span>
            </span>
            {!loadFailed && (
              <span style={{ marginLeft: "auto" }}>
                <ToggleSwitch
                  on={enabled === true}
                  onToggle={() => void handleToggle()}
                  disabled={enabled === null || pending}
                  ariaLabel="Let people map their own drive"
                />
              </span>
            )}
          </div>
          <div className="lrow" style={{ padding: "12px 16px" }}>
            <span className="rt">
              <span className="sub">
                Files opened or copied through Finder or File Explorer are not
                recorded as downloads in the activity log, and the per-file
                upload size limit does not apply there. Turning this off signs
                everyone out of their personal drive and stops new logins.
                Drive logins made before this update are not signed out
                automatically; each person can remove theirs from Paired
                devices.
              </span>
            </span>
          </div>
        </div>
      </div>
      {toggleError ? (
        <p
          role="alert"
          className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
          style={{ margin: "8px 0 0" }}
        >
          {toggleError}
        </p>
      ) : null}
    </section>
  );
}
