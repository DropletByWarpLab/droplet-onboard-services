"use client";

/**
 * WARP-2977 (ADR-059 §3.1) — /security, the command center's feed.
 *
 * One stream for what the cameras saw, when a camera stopped reporting, and
 * (for owners and admins) network and sign-in warnings. Gated on the
 * `security` module by the nav-derived route guard; the rows inside are
 * filtered server-side by the viewer's camera grants.
 *
 * WARP-2977 P2b puts the site mode on top (ModeCard: its act-level controls
 * render only for people who hold act) and lets the feed narrow to one area
 * (`?zone=`). The area list is view-level and already filtered to what this
 * viewer may see. Incidents and alerts are P3.
 */
import { useMemo, useState } from "react";
import { Shield } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { ModeCard } from "@/components/security/ModeCard";
import { SecurityFeed, kindsForView, type SecurityView } from "@/components/security/SecurityFeed";
import { useCameraDisplayNames, useSecurityFeed, useSecurityHealth, useSecurityZones } from "@/lib/hooks/useSecurity";
import { levelAtLeast, useModuleLevel } from "@/lib/hooks/useModuleGate";
import { useAuth } from "@/lib/auth";

const PAGE_SUB = "What your cameras saw, whether they're reporting, and network warnings, in one place.";

export default function SecurityPage() {
  const { user } = useAuth();
  const canSeeThreats = user?.role === "owner" || user?.role === "admin";
  const [view, setView] = useState<SecurityView>("all");
  const [includeLow, setIncludeLow] = useState(false);
  const [zone, setZone] = useState<string | null>(null);

  const canManageAreas = levelAtLeast(useModuleLevel("security"), "manage");

  const { zones } = useSecurityZones();
  // `links` is the viewer's VISIBLE active links — the set the server filters by —
  // so a count of 0 is an area nothing covers (the feed says so, never "quiet").
  const areas = useMemo(
    () =>
      (zones ?? [])
        .filter((z) => z.state === "active")
        .map((z) => ({ id: z.id, name: z.name, linkCount: z.links.length })),
    [zones],
  );
  // An area removed (or no longer visible) since it was picked stops
  // filtering: the feed falls back to all areas instead of a silent empty
  // page. Network rows never sit in an area, so that view never sends one.
  const activeZone = zone !== null && view !== "network" && areas.some((a) => a.id === zone) ? zone : null;

  const filter = useMemo(
    () => ({
      kinds: kindsForView(view, includeLow),
      includeLow,
      limit: 50,
      ...(activeZone ? { zone: activeZone } : {}),
    }),
    [view, includeLow, activeZone],
  );
  const feed = useSecurityFeed(filter);
  const health = useSecurityHealth();
  const cameraLabel = useCameraDisplayNames();

  return (
    <ShellPage icon={<Shield size={15} />} label="Security" title="Security" sub={PAGE_SUB}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* After a mode write ModeCard has already put the server's answer in
            the mode cache. The feed's useSWRInfinite keys are out of reach of
            a global mutate, so the page refreshes them — and the header,
            whose site_mode row the write may have moved. */}
        <ModeCard
          onModeChanged={() => {
            feed.refresh();
            health.refresh();
          }}
        />
        <SecurityFeed
          sources={health.sources}
          healthError={health.error}
          events={feed.events}
          isLoading={feed.isLoading}
          error={feed.error}
          hasMore={feed.hasMore}
          isLoadingMore={feed.isLoadingMore}
          onLoadMore={feed.loadMore}
          onRetry={() => {
            feed.refresh();
            health.refresh();
          }}
          view={view}
          onViewChange={setView}
          includeLow={includeLow}
          onIncludeLowChange={setIncludeLow}
          canSeeThreats={canSeeThreats}
          cameraLabel={cameraLabel}
          areas={areas}
          canManageAreas={canManageAreas}
          zone={activeZone}
          onZoneChange={setZone}
        />
      </div>
    </ShellPage>
  );
}
