"use client";

/**
 * WARP-3264 — the owner's switch for the `place_lookup` off-LAN channel.
 *
 * With it off (the default) the event form's place field suggests only this
 * workspace's rooms and the person's own previously used places; nothing
 * leaves the box. With it on, the typed text also goes to OpenStreetMap.
 * Owner-only to change (the box 403s admins); admins see the state.
 * Renders nothing for anyone else, like LocationsCard above it.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { fetchPlaceLookupChannel, setPlaceLookupChannel } from "@/lib/api";

export const PLACE_LOOKUP_LABEL =
  "Look up places online (sends the place you type to OpenStreetMap)";

export function PlaceLookupSwitch() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const visible = isOwner || user?.role === "admin";
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    fetchPlaceLookupChannel()
      .then((c) => setEnabled(c ? c.enabled : null))
      .catch(() => setEnabled(null));
  }, [visible]);

  if (!visible || enabled === null) return null;

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setPlaceLookupChannel(next);
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
          checked={enabled}
          disabled={!isOwner || busy}
          onChange={(e) => void toggle(e.target.checked)}
          className="mt-1"
        />
        <span className="min-w-0">
          <span className="type-subheadline block" style={{ color: "var(--text)" }}>
            {PLACE_LOOKUP_LABEL}
          </span>
          <span className="type-caption-1 block" style={{ color: "var(--text-muted)" }}>
            {isOwner
              ? "Off: the place field suggests only your rooms and places already used on this Droplet."
              : "Only the owner can change this."}
          </span>
          {error && <span className="type-caption-1 block mt-1 text-system-red">{error}</span>}
        </span>
      </label>
    </div>
  );
}
