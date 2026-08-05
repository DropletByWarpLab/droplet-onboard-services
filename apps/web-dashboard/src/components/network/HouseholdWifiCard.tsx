"use client";

import { Info } from "lucide-react";
import useSWR from "swr";
import { fetchCurrentWifi } from "@/lib/api";
import type { CurrentWifi } from "@/lib/types";
import { ApWifiCard } from "@/components/network/ApWifiCard";
import {
  CURRENT_WIFI_KEY,
  WifiSettingsForm,
} from "@/components/network/WifiSettingsForm";

/**
 * The household Wi-Fi control — ONE editable surface for the home network,
 * chosen by where that Wi-Fi actually lives.
 *
 * WARP-1723 built this split and inlined it in WifiTab. WARP-1733 extracts it
 * verbatim, because inlined it existed only on the Advanced-mode Wi-Fi tab:
 * Simple mode — the home persona's view (ADR-002) — had no Wi-Fi name/password
 * control at all, so a household could change its Wi-Fi only by first
 * discovering the Simple/Advanced segmented control and then the right tab
 * inside it. Simple mode now mounts THIS component, not a copy of it. A second
 * editable Wi-Fi surface is exactly the bug WARP-1723 removed, and two copies
 * would be free to drift into disagreeing about which radio they write.
 *
 * GET /api/network/wifi/current (WARP-1714) resolves the source per deployment
 * shape:
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
 *     radio, so the router form owns the slot. (A separate approved AP is
 *     genuinely a SECOND network; its card is WifiTab's business, not this
 *     control's — see the `useHouseholdWifiSource` note below.)
 *   - `source: null` — no Wi-Fi could be read. The router form renders with
 *     its own honest "couldn't read" notice.
 *
 * The read shares WifiSettingsForm's SWR key (CURRENT_WIFI_KEY), so it adds no
 * extra fetch — including when both mount points are alive at once, which is
 * also why the two can never show different answers. A fetch ERROR (not
 * `source: null` — a failed read) falls back to the router form, exactly what
 * rendered before the split — never a permanent skeleton. But "exactly what
 * rendered before the split" IS the bug on the edge-router shape, so that
 * fallback carries an honest notice — see FailedReadNotice at the bottom.
 */
export function HouseholdWifiCard() {
  const { resolved, source, failedRead } = useHouseholdWifiSource();

  if (!resolved) {
    // Calm placeholder holding the household-Wi-Fi slot while the source
    // resolves — never both editable forms at once (the pre-split bug).
    //
    // Shape AND height mirror the form it becomes (UX + QA second pass):
    // the first cut drew a headline and two fields only (~168px) and then
    // became a ~350px form, so the tab jumped on every load — which live
    // bug WARP-1726's scroll clamp compounds. Fixed-height skeletons are
    // the house convention (see app/network/page.tsx NetworkPageSkeleton).
    return (
      <div className="card" role="status" style={{ minHeight: 300 }}>
        {/* A live region whose only content is an aria-label announces
            inconsistently across screen readers — carry real text. And ONLY
            the text: an aria-label repeating these same words is a double
            announcement in NVDA/JAWS (review nit 6, third pass). */}
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
    );
  }

  if (source === "ap") {
    // The AP hosts the household network, so its form takes the primary
    // slot — writes land where the Wi-Fi actually lives, and it wears
    // household copy (`slot="household"`) rather than presenting the home
    // network as an accessory one.
    return <ApWifiCard slot="household" />;
  }

  return (
    <>
      {/* A FAILED read, not a resolved `source: null` — the form below
          can't tell the user which radio it's about to write, so say it
          here. `source: null` is a resolved answer and WifiSettingsForm
          already carries its own honest notice for it; don't stack two. */}
      {failedRead ? <FailedReadNotice /> : null}
      {/* Issue #12: editable provisioning form so a user who skipped Wi-Fi
          during onboarding can set the SSID/password here — same write path
          as the setup wizard's InternetStep, against this Droplet's own
          radio. */}
      <WifiSettingsForm />
    </>
  );
}

/**
 * Where the household Wi-Fi lives, as one answer for every caller.
 *
 * HouseholdWifiCard picks its branch with this; WifiTab uses the same hook to
 * decide whether the AP's OWN network is a second card worth showing. Exported
 * rather than re-read inline (WARP-1733) for the reason WARP-1723 exported
 * AP_WIFI_KEY and AP_WIFI_SWR_OPTIONS: a "these surfaces can never disagree"
 * guarantee shouldn't rest on a key string and a refresh interval being
 * re-typed identically in several files. One hook, one key, one cadence — and
 * because SWR dedupes on the key, extra callers cost no extra fetch.
 */
export function useHouseholdWifiSource(): {
  /** The read has landed — as data OR as an error. Until then: the skeleton. */
  resolved: boolean;
  /** The resolved source, or null (both "nothing found" and "not resolved"). */
  source: CurrentWifi["source"] | null;
  /** The read FAILED. Distinct from a resolved `source: null`. */
  failedRead: boolean;
} {
  const { data, error } = useSWR<CurrentWifi>(CURRENT_WIFI_KEY, fetchCurrentWifi, {
    refreshInterval: 30_000,
  });
  return {
    resolved: data !== undefined || error !== undefined,
    source: data?.source ?? null,
    failedRead: error !== undefined,
  };
}

// ────────────────────────────────────────────────────────────────────
// FailedReadNotice (WARP-1723 review finding 1, third pass) — shown above
// the router form when the /wifi/current read FAILED.
//
// Falling back to WifiSettingsForm keeps the user able to edit, which is the
// right call — but on the edge-router shape that form saves through the ROUTER
// write path and reports success while nothing changes on air. That IS the bug
// WARP-1723 removed, quietly restored by the error branch. The form's own
// honesty notice can't cover for us here either: it's gated on
// `live && !live.ssid`, and `live` is undefined precisely because this same
// read (same SWR key) just failed. Without this line the user gets a bare,
// silently-wrong-write-path form and no explanation.
//
// `role="status"`, not `alert`: nothing the user did caused this, so it is
// announced politely rather than interrupting. Geometry is the page's own
// banner idiom (see the operation-status banners in app/network/page.tsx) at
// full text weight — the consequence is load-bearing, not supplementary — and
// it does not animate in: a transition here would draw the eye to a failure
// and buy nothing.
// ────────────────────────────────────────────────────────────────────
function FailedReadNotice() {
  return (
    <div role="status" className="card flex items-start gap-3">
      <Info
        size={16}
        className="mt-0.5 flex-shrink-0"
        style={{ color: "var(--text-muted)" }}
        aria-hidden="true"
      />
      <p className="type-subheadline flex-1" style={{ color: "var(--text)" }}>
        We couldn&apos;t read your current Wi-Fi settings just now. Saving here
        changes the Wi-Fi this Droplet broadcasts itself.
      </p>
    </div>
  );
}
