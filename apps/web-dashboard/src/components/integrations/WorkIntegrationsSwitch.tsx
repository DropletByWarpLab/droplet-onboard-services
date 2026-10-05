"use client";

/**
 * WARP-3532 — the owner's switch for the `work_integrations` off-LAN channel
 * (ADR-069 §9): may work updates leave this network?
 *
 * Off by default. With it off, a webhook on the box's own LAN (a local n8n, Home
 * Assistant) still works, and anything else waits, marked "Blocked by egress
 * setting", until the owner turns this on. Owner-only to change (the box 403s
 * admins); an admin sees the state. Shaped exactly like `PlaceLookupSwitch`, the
 * precedent for an owner-only egress switch, and for the same reasons: an
 * unreadable state is shown as unreadable, never guessed.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { fetchWorkIntegrationsChannel, setWorkIntegrationsChannel } from "@/lib/api";

export const WORK_INTEGRATIONS_LABEL = "Send work updates outside your network";

export function WorkIntegrationsSwitch() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const visible = isOwner || user?.role === "admin";
  // undefined = still loading; null = the box couldn't tell us. Never guess.
  const [enabled, setEnabled] = useState<boolean | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    fetchWorkIntegrationsChannel()
      .then((c) => setEnabled(c ? c.enabled : null))
      .catch(() => setEnabled(null));
  }, [visible]);

  if (!visible || enabled === undefined) return null;
  const unreadable = enabled === null;

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setWorkIntegrationsChannel(next);
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
          disabled={!isOwner || busy || unreadable}
          onChange={(e) => void toggle(e.target.checked)}
          className="mt-1"
        />
        <span className="min-w-0">
          <span className="type-subheadline block" style={{ color: "var(--text)" }}>
            {WORK_INTEGRATIONS_LABEL}
          </span>
          <span className="type-caption-1 block" style={{ color: "var(--text-muted)" }}>
            {unreadable
              ? "Couldn’t read this setting. Reload the page to try again."
              : !isOwner
                ? "Only the owner can change this."
                : enabled
                  ? "On: work updates can go to Slack, Teams, Discord, Google Chat and other addresses on the internet. What leaves is the work item’s key, title, state, who changed it and a link back."
                  : "Off: Droplet sends only to addresses on your own network, such as a local n8n or Home Assistant. Anything for the internet waits here until you turn this on."}
          </span>
          {!unreadable && !isOwner && (
            <span className="type-caption-1 block" style={{ color: "var(--text-muted)" }}>
              {enabled
                ? "It is on."
                : "It is off, so anything for the internet is waiting."}
            </span>
          )}
          {error && <span className="type-caption-1 block mt-1 text-system-red">{error}</span>}
        </span>
      </label>
    </div>
  );
}
