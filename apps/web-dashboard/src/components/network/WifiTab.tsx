"use client";

import useSWR from "swr";
import { fetchCurrentWifi } from "@/lib/api";
import type { CurrentWifi } from "@/lib/types";
import { ApWifiCard } from "@/components/network/ApWifiCard";
import { BandSteeringCard } from "@/components/network/BandSteeringCard";
import { CameraPrivacyCard } from "@/components/network/CameraPrivacyCard";
import { GuestWifiCard } from "@/components/network/GuestWifiCard";
import { RadioDetailCard } from "@/components/network/RadioDetailCard";
import { WifiChannelCard } from "@/components/network/WifiChannelCard";
import { WifiScanPanel } from "@/components/network/WifiScanPanel";
import {
  CURRENT_WIFI_KEY,
  WifiSettingsForm,
} from "@/components/network/WifiSettingsForm";

/**
 * Network → Wi-Fi tab. Extracted from app/network/page.tsx (WARP-1723) so the
 * single-editable-surface split below is render-testable — the page is a tower
 * of hooks, and a Next.js page route can't carry named exports.
 *
 * WARP-1723 — ONE editable surface for the household Wi-Fi, chosen by where
 * that Wi-Fi actually lives. GET /api/network/wifi/current (WARP-1714)
 * resolves it per deployment shape:
 *
 *   - `source: "ap"` — the edge-router shape. This Droplet's own radio hosts
 *     nothing (uci carries only a disabled placeholder); the household SSID
 *     exists only on the approved access point. The router-radio form used to
 *     render here anyway: it READ the AP's values but SAVED through the
 *     router write path (POST /api/network/wifi/ssid + /password), reporting
 *     "applied" while the network in the air never changed. On this shape the
 *     AP form (PUT /api/network/wifi/ap) IS the household form, and the
 *     router form doesn't render at all.
 *   - `source: "router"` — the household network lives on this Droplet's own
 *     radio. The router form keeps the household slot, and the AP card still
 *     renders further down: a router-hosted household network plus a separate
 *     approved AP are genuinely two networks.
 *   - `source: null` — no Wi-Fi could be read. The router form renders with
 *     its honest "couldn't read" notice; the AP card is dropped rather than
 *     stacking a redundant "not available" card beside that empty state.
 *
 * The read shares WifiSettingsForm's SWR key (CURRENT_WIFI_KEY), so it adds no
 * extra fetch. A fetch ERROR (not `source: null` — a failed read) falls back
 * to the router form, exactly what rendered before the split — never a
 * permanent skeleton.
 */
export function WifiTab() {
  const { data: currentWifi, error: currentWifiError } = useSWR<CurrentWifi>(
    CURRENT_WIFI_KEY,
    fetchCurrentWifi,
    { refreshInterval: 30_000 },
  );
  const resolved = currentWifi !== undefined || currentWifiError !== undefined;
  const source = currentWifi?.source ?? null;

  return (
    <div className="space-y-4">
      {!resolved ? (
        // Calm placeholder holding the household-Wi-Fi slot while the source
        // resolves — never both editable forms at once (the pre-split bug).
        //
        // Shape AND height mirror the form it becomes (UX + QA second pass):
        // the first cut drew a headline and two fields only (~168px) and then
        // became a ~350px form, so the tab jumped on every load — which live
        // bug WARP-1726's scroll clamp compounds. Fixed-height skeletons are
        // the house convention (see app/network/page.tsx NetworkPageSkeleton).
        <div
          className="card"
          role="status"
          aria-label="Loading Wi-Fi settings"
          style={{ minHeight: 300 }}
        >
          {/* A live region whose only content is an aria-label announces
              inconsistently across screen readers — carry real text. */}
          <span className="sr-only">Loading Wi-Fi settings…</span>
          <div className="animate-pulse space-y-4 max-w-md" aria-hidden="true">
            {/* headline */}
            <div
              className="w-32"
              style={{
                height: 16,
                background: "var(--surface-2)",
                borderRadius: "var(--radius-input)",
              }}
            />
            {/* subhead (two lines) */}
            <div
              style={{
                height: 32,
                background: "var(--surface-2)",
                borderRadius: "var(--radius-input)",
              }}
            />
            {/* network name + password */}
            <div
              style={{
                height: 42,
                background: "var(--surface-2)",
                borderRadius: "var(--radius-input)",
              }}
            />
            <div
              style={{
                height: 42,
                background: "var(--surface-2)",
                borderRadius: "var(--radius-input)",
              }}
            />
            {/* save button */}
            <div
              className="w-44"
              style={{
                height: 40,
                background: "var(--surface-2)",
                borderRadius: "var(--radius-input)",
              }}
            />
          </div>
        </div>
      ) : source === "ap" ? (
        // The AP hosts the household network, so its form takes the primary
        // slot — writes land where the Wi-Fi actually lives, and it wears
        // household copy (`slot="household"`) rather than presenting the home
        // network as an accessory one.
        <ApWifiCard slot="household" />
      ) : (
        // Issue #12: editable provisioning form so a user who skipped Wi-Fi
        // during onboarding can set the SSID/password here — same write path
        // as the setup wizard's InternetStep, against this Droplet's own radio.
        <WifiSettingsForm />
      )}

      {/* WARP-871: the channel write path (orchestrator route + routing) shipped
          at WARP-40 and api.ts already exported setWifiChannel, but the WiFi tab
          never surfaced a channel picker — the one lever for dodging a congested
          band. */}
      <WifiChannelCard />
      {/* Read-only host-radio detail (band/channel/width/country + a
          Broadcasting chip). Honest for the single combined-radio shape — no
          enable/disable toggle; every chip is a real iwinfo field or "not
          reported". */}
      <RadioDetailCard />

      {resolved && source === "router" ? (
        // WARP-1712 → WARP-1723: the external access point's OWN network name +
        // password, below the router's household form — two real networks, two
        // honest cards. This is the ONLY other mount of ApWifiCard; the
        // Coverage Extenders panel on the Devices tab now shows a read-only
        // reflection that links here instead of a second editable form. The
        // default `slot="secondary"` keeps this card's original copy verbatim.
        <ApWifiCard />
      ) : null}

      {/* WARP-1703: the external Droplet AP's 802.11k/v band-steering master
          switch. Honest unavailable state when no approved Droplet AP is
          online — same no-fake-toggle contract as UpnpCard. */}
      <BandSteeringCard />

      {/* Guest Wi-Fi — an isolated visitor network (own SSID + firewall zone). */}
      <GuestWifiCard />

      {/* Camera privacy — network isolation posture (honest, read-only) plus
          the live "block cameras from the internet" toggle. Sits with the
          everyday Wi-Fi/network controls per the design's Simple-mode layout. */}
      <CameraPrivacyCard />

      {/* WARP-816: the scanner lives in WifiScanPanel so it can distinguish the
          AP-mode "scanning unavailable while broadcasting" state (typed
          SCAN_UNSUPPORTED signal) from a genuine empty scan. */}
      <WifiScanPanel />
    </div>
  );
}
