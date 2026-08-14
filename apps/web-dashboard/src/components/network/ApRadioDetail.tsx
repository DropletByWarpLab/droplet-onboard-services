"use client";

import useSWR from "swr";
import { Loader2 } from "lucide-react";
import { fetchApWirelessDetail, type ApRadioInfo, type ApWirelessDetail } from "@/lib/api";

/**
 * Live radio detail for one Droplet access point (WARP-1712).
 *
 * Renders inside an ONLINE Coverage Extenders card so the AP reads as network
 * infrastructure an operator can actually inspect — model, firmware, uptime,
 * and per-radio band / channel / width / link / connected devices — rather
 * than a name and a status pill.
 *
 * Every value is read live off the AP (the orchestrator dials it per request),
 * so this can never disagree with the Wi-Fi form above it. Fields the AP
 * doesn't report render as "not reported" rather than a fabricated default —
 * the RadioDetailCard honesty contract.
 */

/** Whole units only — an operator wants "3 days", not "3d 4h 12m 6s". */
function formatUptime(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return days === 1 ? "1 day" : `${days} days`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return hours === 1 ? "1 hour" : `${hours} hours`;
  const mins = Math.floor(seconds / 60);
  return mins <= 1 ? "just started" : `${mins} minutes`;
}

/** '2g' → '2.4 GHz'. Unknown values pass through so a 6 GHz AP isn't mislabelled. */
function bandLabel(band: string | null): string {
  if (!band) return "Radio";
  const map: Record<string, string> = {
    "2g": "2.4 GHz",
    "5g": "5 GHz",
    "6g": "6 GHz",
  };
  return map[band.toLowerCase()] ?? band;
}

function RadioRow({ radio }: { radio: ApRadioInfo }) {
  // The live channel/width iwinfo reports beats the configured value — with
  // `channel=auto` the configured one carries no information at all.
  const channel = radio.live_channel ?? (radio.channel === "auto" ? null : radio.channel);
  const width = radio.live_htmode ?? radio.htmode;

  const facts: string[] = [];
  if (channel !== null && channel !== undefined) facts.push(`Channel ${channel}`);
  if (width) facts.push(String(width));
  if (radio.clients !== null) {
    facts.push(radio.clients === 1 ? "1 device" : `${radio.clients} devices`);
  }

  const offline = radio.disabled || radio.up === false;

  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <div className="min-w-0">
        <span className="type-footnote font-medium" style={{ color: "var(--text)" }}>
          {bandLabel(radio.band)}
        </span>
        {radio.ssid ? (
          <span
            className="type-footnote ml-2 truncate"
            style={{ color: "var(--text-muted)" }}
          >
            {radio.ssid}
          </span>
        ) : null}
      </div>
      <span
        className="type-footnote text-right shrink-0"
        style={{ color: offline ? "var(--text-faint)" : "var(--text-muted)" }}
      >
        {offline ? "Off" : facts.length > 0 ? facts.join(" · ") : "Not reported"}
      </span>
    </div>
  );
}

export function ApRadioDetail({ mac }: { mac: string }) {
  const { data, error, isLoading } = useSWR<ApWirelessDetail>(
    `/api/aps/${mac}/wireless`,
    () => fetchApWirelessDetail(mac),
    { refreshInterval: 30000 },
  );

  if (isLoading && !data) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 type-footnote pt-2"
        style={{ color: "var(--text-muted)" }}
      >
        <Loader2 size={12} className="animate-spin" aria-hidden /> Reading radios…
      </div>
    );
  }

  // A detail read that fails must never blank the card the operator came for —
  // the status, model and controls above stay useful without it.
  if (error || !data?.supported) return null;

  const uptime = formatUptime(data.device?.uptime_seconds ?? null);
  const meta = [data.device?.firmware, uptime ? `up ${uptime}` : null].filter(
    (v): v is string => Boolean(v),
  );

  return (
    <div
      className="pt-3 mt-1"
      style={{ borderTop: "1px solid var(--card-bd)" }}
      aria-label="Access point radios"
    >
      {meta.length > 0 ? (
        <p className="type-footnote mb-1" style={{ color: "var(--text-muted)" }}>
          {meta.join(" · ")}
        </p>
      ) : null}
      {data.radios.map((radio) => (
        <RadioRow key={radio.section} radio={radio} />
      ))}
    </div>
  );
}
