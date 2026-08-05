"use client";

import { ApWifiCard } from "@/components/network/ApWifiCard";
import { BandSteeringCard } from "@/components/network/BandSteeringCard";
import { CameraPrivacyCard } from "@/components/network/CameraPrivacyCard";
import { GuestWifiCard } from "@/components/network/GuestWifiCard";
import {
  HouseholdWifiCard,
  useHouseholdWifiSource,
} from "@/components/network/HouseholdWifiCard";
import { RadioDetailCard } from "@/components/network/RadioDetailCard";
import { WifiChannelCard } from "@/components/network/WifiChannelCard";
import { WifiScanPanel } from "@/components/network/WifiScanPanel";

/**
 * Network → Wi-Fi tab. Extracted from app/network/page.tsx (WARP-1723) so the
 * single-editable-surface split below is render-testable — the page is a tower
 * of hooks, and a Next.js page route can't carry named exports.
 *
 * The household Wi-Fi control itself moved out again at WARP-1733, into
 * HouseholdWifiCard, so Simple mode can mount the SAME control instead of
 * growing a second editable Wi-Fi surface (the bug WARP-1723 removed). Read
 * that file for the `source`-based choice between the AP form, the router
 * form, the skeleton and the failed-read fallback. What stays here is what
 * this TAB owns: the household slot's placement, the AP's own second network,
 * and the power-user cards below.
 */
export function WifiTab() {
  // The same read the household card makes (shared SWR key, so no extra
  // fetch) — the tab needs it for one decision of its own: whether the AP's
  // OWN network is a second card worth showing.
  const { resolved, source, failedRead } = useHouseholdWifiSource();

  return (
    <div className="space-y-4">
      {/* `headingLevel="h3"` is this panel's own answer, passed explicitly
          rather than left to the default: since WARP-1733 the control has two
          mounts whose outlines differ (Simple mode reads it as a sibling of
          the h2 Internet hero and passes "h2"), so the level belongs at each
          call site where it can be read against the surrounding headings.
          Here it IS a subsection of the Wi-Fi tab panel — same level as every
          card below it. */}
      <HouseholdWifiCard headingLevel="h3" />

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

      {resolved && (source === "router" || failedRead) ? (
        // WARP-1712 → WARP-1723: the external access point's OWN network name +
        // password, below the router's household form — two real networks, two
        // honest cards. This is the ONLY other mount of ApWifiCard; the
        // Coverage Extenders panel on the Devices tab now shows a read-only
        // reflection that links here instead of a second editable form, and
        // Simple mode (WARP-1733) mounts the household card only. The default
        // `slot="secondary"` keeps this card's original copy verbatim.
        //
        // Also rendered on a FAILED wifi/current read (review nit 4, third
        // pass). The first cut treated that error like `source: null` and
        // dropped the card, but this card is self-sufficient — its own read,
        // its own honesty states — so a transient failure here would take away
        // a working control. On a router-shape household with a real extender
        // that strands the extender's Wi-Fi editor entirely: the Devices panel
        // is read-only since WARP-1723, so its "Change in Wi-Fi settings" link
        // would land on a tab that can't edit what it promised.
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
