"use client";

/**
 * WARP-3912 — the owner/admin switch for the `remote_mcp` off-LAN channel
 * (ADR-043 section 4, ADR-072 section 1): may the assistant use the outside
 * services an owner or admin connected?
 *
 * Shaped like `WorkIntegrationsSwitch`, the precedent for an egress switch. The
 * difference is who may flip it: the channel is admin-level (`requiresAdmin`),
 * not owner-only, so owners and admins both get the control and everyone else
 * sees nothing and triggers no request. Turning it off is the safe direction
 * and the box tears sessions down at once, so, like the neighbouring egress
 * switches, it does not ask for confirmation.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { fetchRemoteMcpChannel, setRemoteMcpChannel } from "@/lib/api";

export const REMOTE_MCP_LABEL = "Connected MCP servers";

export function RemoteMcpSwitch() {
  const { user } = useAuth();
  const visible = user?.role === "owner" || user?.role === "admin";
  // undefined = still loading; null = the box couldn't tell us. Never guess.
  const [enabled, setEnabled] = useState<boolean | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    fetchRemoteMcpChannel()
      .then((c) => setEnabled(c ? c.enabled : null))
      .catch(() => setEnabled(null));
  }, [visible]);

  if (!visible || enabled === undefined) return null;
  const unreadable = enabled === null;

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setRemoteMcpChannel(next);
      setEnabled(next);
    } catch {
      setError("That didn’t change. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={busy || unreadable}
          onChange={(e) => void toggle(e.target.checked)}
          className="mt-1"
        />
        <span className="min-w-0">
          <span className="type-subheadline block" style={{ color: "var(--text)" }}>
            {REMOTE_MCP_LABEL}
          </span>
          <span className="type-caption-1 block" style={{ color: "var(--text-muted)" }}>
            {unreadable
              ? "Couldn’t read this setting. Reload the page to try again."
              : enabled
                ? "On: the assistant can use the outside services an owner or admin connected (Atlassian today). Turning it off disconnects them immediately and stops any call in progress."
                : "Off: the assistant cannot reach any outside service, even one that is connected. Turn this on to let it use the services an owner or admin connected (Atlassian today)."}
          </span>
          {error && <span className="type-caption-1 block mt-1 text-system-red">{error}</span>}
        </span>
      </label>
    </div>
  );
}
