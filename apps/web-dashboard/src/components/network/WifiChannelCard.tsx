"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RadioTower } from "lucide-react";
import {
  fetchWifiSettings,
  fetchNetworkOperation,
  setWifiChannel,
  RouterStatusError,
  routerUnreachableNotice,
} from "@/lib/api";
import type { NetworkCommandResult } from "@/lib/types";

/**
 * WARP-871 — WiFi channel selector for the Network → WiFi tab.
 *
 * The orchestrator route (POST /api/network/wifi/channel, Tier 1) and the
 * routing POST /wireless/channel have shipped since WARP-40, and api.ts already
 * exported setWifiChannel — but NOTHING in the Network page called it, so the
 * WiFi tab let you rename the network and change its password yet never pick a
 * channel (the only lever for dodging a congested airspace).
 *
 * Rather than trust the orchestrator route's `radio0` default (which does not
 * exist on the single-box AP radio), we read the LIVE radio section + its
 * current channel from GET /api/network/wifi and post the real section name.
 * Channel changes restart the radio, so we poll the operation for the
 * safe-apply outcome and reuse WifiSettingsForm's calm error ladder.
 */

type RadioInfo = {
  section: string;
  band: "2g" | "5g";
  channel: string; // current channel or "auto"
};

// US, non-DFS channel sets — broad device support, no radar-vacate surprises.
// The live current channel is merged in below so a DFS/edge channel already in
// use still shows up selected.
const CHANNELS_2G = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];
const CHANNELS_5G = ["36", "40", "44", "48", "149", "153", "157", "161"];

type Status =
  | { kind: "loading" }
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "applied" }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string };

/** Pick the AP radio out of the WirelessStatus map and read its band + channel. */
function parsePrimaryRadio(status: Record<string, unknown>): RadioInfo | null {
  const entries = Object.entries(status ?? {});
  if (entries.length === 0) return null;
  // Prefer a radio that is broadcasting an AP; otherwise take the first radio.
  const apEntry =
    entries.find(([, r]) => {
      const ifaces = (r as { interfaces?: { config?: { mode?: string } }[] })
        ?.interfaces;
      return Array.isArray(ifaces) && ifaces.some((i) => i?.config?.mode === "ap");
    }) ?? entries[0];

  const [section, radio] = apEntry;
  const cfg = (radio as { config?: { channel?: number | string } })?.config;
  const rawChannel = cfg?.channel;
  const channel =
    rawChannel === undefined || rawChannel === null || rawChannel === "auto"
      ? "auto"
      : String(rawChannel);
  // 2.4 GHz channels are 1–14; everything else is 5 GHz.
  const num = parseInt(channel, 10);
  const band: "2g" | "5g" = !Number.isNaN(num) && num <= 14 ? "2g" : "5g";
  return { section, band, channel };
}

export function WifiChannelCard() {
  const [radio, setRadio] = useState<RadioInfo | null>(null);
  const [selected, setSelected] = useState<string>("auto");
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const wifi = await fetchWifiSettings();
        if (cancelled) return;
        const info = parsePrimaryRadio(wifi);
        if (!info) {
          setStatus({
            kind: "notice",
            message: "No Wi-Fi radio is reporting a channel yet.",
          });
          return;
        }
        setRadio(info);
        setSelected(info.channel);
        setStatus({ kind: "idle" });
      } catch (e) {
        if (cancelled) return;
        if (routerUnreachableNotice(e, "Network")) {
          setStatus({
            kind: "notice",
            message:
              "Your router isn't reachable right now — try again in a moment.",
          });
        } else {
          setStatus({
            kind: "notice",
            message: "Couldn't read the current Wi-Fi channel.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Channel options for the detected band, with the live current channel merged
  // in so a DFS/edge channel already in use is still selectable.
  const baseChannels = radio?.band === "2g" ? CHANNELS_2G : CHANNELS_5G;
  const channelOptions = Array.from(
    new Set([
      ...baseChannels,
      ...(radio && radio.channel !== "auto" ? [radio.channel] : []),
    ]),
  ).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  async function pollOperation(operationId: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const op = await fetchNetworkOperation(operationId);
      if (op.state === "applied") return;
      if (op.state === "rejected") {
        throw new Error(
          op.reason ??
            "The router didn't accept that channel, so nothing was changed.",
        );
      }
      if (op.state === "rolled_back" || op.state === "unknown") {
        throw new Error(
          op.reason ??
            "The channel change didn't take. The router kept its previous channel.",
        );
      }
      if (Date.now() - startedAt > 70_000) {
        throw new Error("Timed out waiting for the router to change channel.");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async function handleSave() {
    if (!radio) return;
    setStatus({ kind: "saving" });
    try {
      const result: NetworkCommandResult = await setWifiChannel(
        selected,
        radio.section,
      );
      // Tier 1: applies immediately and answers 200 with operationId. Poll it
      // for the safe-apply outcome (a bad channel can drop the radio).
      if (result.operationId) {
        await pollOperation(result.operationId);
      }
      setRadio({ ...radio, channel: selected });
      setStatus({ kind: "applied" });
    } catch (e) {
      if (routerUnreachableNotice(e, "Network")) {
        setStatus({
          kind: "notice",
          message:
            "Your router isn't reachable right now — try again in a moment.",
        });
      } else if (
        e instanceof RouterStatusError &&
        (e.status === 400 || e.status === 422) &&
        e.message.trim().length > 0
      ) {
        setStatus({ kind: "error", message: e.message });
      } else if (
        !(e instanceof RouterStatusError) &&
        e instanceof Error &&
        e.message.trim().length > 0
      ) {
        setStatus({ kind: "error", message: e.message });
      } else {
        setStatus({
          kind: "notice",
          message: "Couldn't change the channel right now. Try again shortly.",
        });
      }
    }
  }

  const saving = status.kind === "saving";
  const dirty = !!radio && selected !== radio.channel;

  return (
    <div className="card">
      <h3 className="type-headline text-[color:var(--text)] mb-1">WiFi channel</h3>
      <p className="type-subheadline text-[color:var(--text-muted)] mb-4">
        Pick the channel your Droplet broadcasts on. Switch channels if a
        neighbouring network is crowding yours. Automatic lets the router choose
        the clearest one. Changing this restarts the radio and briefly drops
        every device.
      </p>

      {status.kind === "loading" ? (
        <div className="flex items-center gap-2 type-subheadline text-[color:var(--text-muted)]">
          <Loader2 size={16} className="animate-spin" />
          Reading current channel…
        </div>
      ) : (
        radio && (
          <div className="space-y-4 max-w-md">
            <div>
              <label
                htmlFor="wifi-channel"
                className="type-subheadline text-[color:var(--text-muted)] block mb-1.5"
              >
                Channel{" "}
                <span className="text-[color:var(--text-muted)]">
                  ({radio.band === "2g" ? "2.4 GHz" : "5 GHz"})
                </span>
              </label>
              <div className="relative">
                <RadioTower
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]"
                  aria-hidden="true"
                />
                <select
                  id="wifi-channel"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors pl-10"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                  disabled={saving}
                >
                  <option value="auto">Automatic</option>
                  {channelOptions.map((c) => (
                    <option key={c} value={c}>
                      Channel {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              className="btn primary"
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              {saving ? "Applying…" : "Save channel"}
            </button>
          </div>
        )
      )}

      {status.kind === "applied" && (
        <div
          role="status"
          className="mt-4 flex items-start gap-2 type-footnote text-[color:var(--text)] bg-system-green/10 rounded-sm px-3 py-2"
        >
          <CheckCircle2
            size={14}
            className="mt-0.5 flex-shrink-0 text-system-green"
            aria-hidden="true"
          />
          <span>Channel updated. Devices will reconnect on their own.</span>
        </div>
      )}

      {status.kind === "notice" && (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex items-start gap-2 type-footnote text-[color:var(--text)] bg-system-orange/10 rounded-sm px-3 py-2"
        >
          <AlertCircle
            size={14}
            className="mt-0.5 flex-shrink-0 text-system-orange"
            aria-hidden="true"
          />
          <span>{status.message}</span>
        </div>
      )}

      {status.kind === "error" && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{status.message}</span>
        </div>
      )}
    </div>
  );
}
