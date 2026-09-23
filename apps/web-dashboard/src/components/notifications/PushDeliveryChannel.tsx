"use client";

/**
 * WARP-2904 — the box-wide switch for the `web_push` off-LAN channel.
 *
 * Every phone or browser push the box sends is dialled through a push
 * service run by Google, Apple or Mozilla (whichever the subscribed browser
 * uses). The message text is encrypted to the device, but the dial itself —
 * that this box notified someone, and when — leaves the network, so it is an
 * off-LAN channel like weather or outbound mail: off until an owner or admin
 * turns it on. There is no generic off-LAN settings panel in the dashboard,
 * so the switch lives where someone turning push on actually looks.
 *
 * `null` channel state = unreadable: the card says so rather than guessing.
 */
import { useEffect, useState } from "react";
import { Globe, Loader2 } from "lucide-react";
import { fetchWebPushChannel, setWebPushChannel } from "@/lib/api";

type State = { kind: "loading" } | { kind: "unknown" } | { kind: "ready"; enabled: boolean };

export function PushDeliveryChannel() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWebPushChannel()
      .then((c) => setState(c ? { kind: "ready", enabled: c.enabled } : { kind: "unknown" }))
      .catch(() => setState({ kind: "unknown" }));
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setWebPushChannel(next);
      setState({ kind: "ready", enabled: next });
    } catch (e) {
      const status = (e as { status?: number }).status;
      setError(
        status === 403
          ? "Only an owner or admin can change this."
          : "We couldn't change push delivery right now. Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "loading") return null;

  const enabled = state.kind === "ready" && state.enabled;
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Globe size={14} style={{ color: "var(--text-muted)" }} />
            <h3 className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
              {state.kind === "unknown"
                ? "Push delivery: status unavailable"
                : enabled
                  ? "Push delivery is on for this Droplet"
                  : "Push delivery is off for this Droplet"}
            </h3>
          </div>
          <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
            Push notifications travel through a push service run by Google, Apple or
            Mozilla, depending on the browser. The message text is encrypted to your
            device, so that service can&apos;t read it. It does see that a
            notification was sent, and when.
          </p>
          {error && <p className="type-caption-1 mt-2 text-system-red">{error}</p>}
        </div>
        {state.kind === "ready" && (
          <button
            type="button"
            onClick={() => void toggle(!enabled)}
            disabled={busy}
            className={`${enabled ? "btn ghost" : "btn primary"} type-subheadline disabled:opacity-50 flex-shrink-0`}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {enabled ? "Turn off" : "Turn on"}
          </button>
        )}
      </div>
    </div>
  );
}
