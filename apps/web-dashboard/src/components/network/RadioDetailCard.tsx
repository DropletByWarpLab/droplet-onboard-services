"use client";

import useSWR from "swr";
import { Radio } from "lucide-react";
import { fetchRadioDetail, type RadioDetail } from "@/lib/api";

/**
 * Wireless radio (Droplet Design System · Network · Wi-Fi).
 *
 * Read-only, honest for the single-box single-host-radio shape. The design
 * depicts a multi-band router with per-radio enable/disable; the shipping
 * single-box has ONE combined host hostapd radio that can't be turned off
 * independently (doing so would kill the only AP and this dashboard's own
 * reachability), so there is NO enable/disable toggle here.
 *
 * Every chip is backed by a real iwinfo field or shows "not reported" — we never
 * render the design's fabricated channel/width/country literals. The
 * Broadcasting / Not-broadcasting chip is derived from the real radio mode. The
 * mt76 transmit-power-cap note appears ONLY when a genuinely low txpower is read
 * (it's a real driver-regulatory condition on this hardware), never
 * unconditionally — so the card stays honest on boxes without the cap.
 */
// mt76 TX-power cap threshold (dBm). Below this we surface the known
// driver-regulatory cap note; above it the radio is at normal power.
const TX_CAP_DBM = 5;

function Chip({ label }: { label: string }) {
  return (
    <span className="type-caption-1 font-mono px-2 py-0.5 rounded-sm bg-[var(--card-inner)] text-[color:var(--text-muted)]">
      {label}
    </span>
  );
}

export function RadioDetailCard() {
  const { data, isLoading } = useSWR<RadioDetail>(
    "/api/network/wifi/radio",
    fetchRadioDetail,
    { refreshInterval: 30000 },
  );

  const broadcasting = data?.broadcasting ?? false;
  const txCapped = data?.txpower != null && data.txpower <= TX_CAP_DBM;

  return (
    <div className="card">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-[var(--card-inner)] text-[color:var(--text-muted)]">
          <Radio size={18} aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="type-headline text-[color:var(--text)]">Wireless radio</h3>
            {!isLoading && (
              <span
                className={`type-caption-2 font-medium px-2 py-0.5 rounded-full ${
                  broadcasting
                    ? "bg-system-green/10 text-system-green"
                    : "bg-[var(--card-inner)] text-[color:var(--text-muted)]"
                }`}
              >
                {broadcasting ? "Broadcasting" : "Not broadcasting"}
              </span>
            )}
          </div>
          <p className="type-caption-1 text-[color:var(--text-muted)] mt-0.5">
            This Droplet uses one combined Wi-Fi radio; it can&apos;t be turned
            off separately.
          </p>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 mt-3">
            <RadioRow label="Channel" value={data?.channel != null ? `Channel ${data.channel}` : null} />
            <RadioRow label="Width" value={data?.htmode ?? null} />
            <RadioRow label="Country" value={data?.country ?? null} />
            <RadioRow
              label="Transmit power"
              value={data?.txpower != null ? `${data.txpower} dBm` : null}
            />
          </dl>

          {txCapped && (
            <p className="type-caption-1 text-[color:var(--text-muted)] mt-3">
              Transmit power is capped low by the wireless driver&apos;s
              regulatory limits on this hardware, which can reduce range.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function RadioRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="type-caption-1 text-[color:var(--text-muted)]">{label}</dt>
      <dd>
        {value != null ? (
          <Chip label={value} />
        ) : (
          <span className="type-caption-1 text-[color:var(--text-faint)]">Not reported</span>
        )}
      </dd>
    </div>
  );
}
