"use client";

/**
 * WARP-2977 (ADR-059 §3.1) — /security, the command center.
 *
 * One stream for what the cameras saw, when a camera stopped reporting, and
 * (for owners and admins) network and sign-in warnings. Gated on the
 * `security` module by the nav-derived route guard; the rows inside are
 * filtered server-side by the viewer's camera grants.
 *
 * WARP-2977 P2b puts the site mode on top (ModeCard: its act-level controls
 * render only for people who hold act) and lets the feed narrow to one area
 * (`?zone=`). The area list is view-level and already filtered to what this
 * viewer may see.
 *
 * WARP-2978 (ADR-059 P3 §8, D32) — under the mode card, the alerts line and
 * two tabs: **Incidents** (the default: the feed grouped, IncidentList) and
 * **Everything** (the P2a feed, unchanged apart from its "In an incident"
 * links). The tab is in the URL (`?tab=everything`), so Back from an incident
 * returns to the tab it was opened from. Each tab's data is read only while
 * it is shown. The area picked is shared by both tabs.
 *
 * WARP-2981 (ADR-059 P6) — the header's one action opens the Security wall
 * (/security/wall), the read-only TV view. It is not in the nav.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Shield, Tv } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { ModeCard } from "@/components/security/ModeCard";
import { AlertsLine, SecurityFeed, kindsForView, type SecurityView } from "@/components/security/SecurityFeed";
import { COPY as LIST_COPY, IncidentList, type IncidentFilter } from "@/components/security/IncidentList";
import { fill } from "@/components/security/TimezoneSelect";
import {
  useCameraDisplayNames,
  useSecurityFeed,
  useSecurityHealth,
  useSecurityIncidentSummary,
  useSecurityIncidents,
  useSecurityMode,
  useSecurityZones,
} from "@/lib/hooks/useSecurity";
import { levelAtLeast, useModuleLevel } from "@/lib/hooks/useModuleGate";
import { useAuth } from "@/lib/auth";
import { deviceTimeZone } from "@/lib/security-time";
import type { SecurityHealthRow, SecurityZoneRef } from "@/lib/types";
import { SECURITY_WALL_PATH } from "@/lib/routing";
import { WALL_COPY } from "@/components/security/wall-status";

const PAGE_SUB = "What your cameras saw, whether they're reporting, and network warnings, in one place.";

const TAB_LABEL = { incidents: LIST_COPY.tabIncidents, everything: LIST_COPY.tabEverything } as const;
type Tab = keyof typeof TAB_LABEL;
const TABS: readonly Tab[] = ["incidents", "everything"];

type Area = SecurityZoneRef & { linkCount: number };

interface TabProps {
  zone: string | null;
  onZoneChange: (zone: string | null) => void;
  areas: Area[];
  canSeeThreats: boolean;
  cameraLabel: (name: string) => string;
  health: { sources: SecurityHealthRow[] | null; error?: Error; refresh: () => void };
  /** The tab's own refresh, for the page to call after a mode write. */
  refreshRef: React.MutableRefObject<() => void>;
}

export default function SecurityPage() {
  // useSearchParams needs a Suspense boundary on a statically rendered page.
  return (
    <Suspense fallback={null}>
      <SecurityCenter />
    </Suspense>
  );
}

function SecurityCenter() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const canSeeThreats = user?.role === "owner" || user?.role === "admin";
  // The URL owns the tab (WARP-3185): a same-route navigation — the sidebar's
  // Security link, an incident's way back — moves it, not only the first load.
  const urlTab: Tab = params.get("tab") === "everything" ? "everything" : "incidents";
  const [tab, setTab] = useState<Tab>(urlTab);
  useEffect(() => {
    setTab(urlTab);
  }, [urlTab]);
  const [zone, setZone] = useState<string | null>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ incidents: null, everything: null });
  const refreshTab = useRef<() => void>(() => {});

  const { zones } = useSecurityZones();
  // `links` is the viewer's VISIBLE active links — the set the server filters by —
  // so a count of 0 is an area nothing covers (the lists say so, never "quiet").
  const areas = useMemo(
    () => (zones ?? []).filter((z) => z.state === "active").map((z) => ({ id: z.id, name: z.name, linkCount: z.links.length })),
    [zones],
  );
  const health = useSecurityHealth();
  const cameraLabel = useCameraDisplayNames();
  // Whether after-hours alerts can fire; unknown (loading or failed) says nothing.
  const summary = useSecurityIncidentSummary();
  const attention = summary.summary ? summary.summary.openAlerts + summary.summary.openNotices : 0;

  const choose = useCallback(
    (next: Tab, focus = false) => {
      setTab(next);
      router.replace(next === "everything" ? "/security?tab=everything" : "/security", { scroll: false });
      if (focus) tabRefs.current[next]?.focus();
    },
    [router],
  );

  // The tabs pattern: arrows move (and select), Home/End jump; one tab stop.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = TABS.indexOf(tab);
    let to: number | null = null;
    if (e.key === "ArrowRight") to = (at + 1) % TABS.length;
    else if (e.key === "ArrowLeft") to = (at - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = TABS.length - 1;
    if (to === null) return;
    e.preventDefault();
    choose(TABS[to]!, true);
  };

  const tabProps: TabProps = { zone, onZoneChange: setZone, areas, canSeeThreats, cameraLabel, health, refreshRef: refreshTab };

  return (
    <ShellPage
      icon={<Shield size={15} />}
      label="Security"
      title="Security"
      sub={PAGE_SUB}
      actions={
        <Link href={SECURITY_WALL_PATH} className="btn" title={WALL_COPY.linkTitle}>
          <Tv size={15} aria-hidden="true" />
          {WALL_COPY.link}
        </Link>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* After a mode write ModeCard has already put the server's answer in
            the mode cache. The lists' useSWRInfinite keys are out of reach of
            a global mutate, so the page refreshes the shown tab — and the
            header, whose site_mode row the write may have moved. */}
        <ModeCard
          onModeChanged={() => {
            refreshTab.current();
            health.refresh();
          }}
        />
        <AlertsLine alertsReady={summary.summary ? summary.summary.alertsReady : null} />
        <div>
          <div className="tabstrip" role="tablist" aria-label={LIST_COPY.tabsLabel} style={{ marginBottom: 16 }}>
            {TABS.map((t) => (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[t] = el;
                }}
                type="button"
                role="tab"
                id={`security-tab-${t}`}
                aria-selected={tab === t}
                // Only the shown panel is mounted, so only its tab points at one.
                aria-controls={tab === t ? `security-panel-${t}` : undefined}
                aria-label={
                  t === "incidents" && attention > 0 ? fill(LIST_COPY.tabAttention, { label: TAB_LABEL[t], n: String(attention) }) : undefined
                }
                tabIndex={tab === t ? 0 : -1}
                className={`tab${tab === t ? " active" : ""}`}
                onClick={() => choose(t)}
                onKeyDown={onTabKey}
              >
                {TAB_LABEL[t]}
                {t === "incidents" && attention > 0 && <span className="tcount">{attention}</span>}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`security-panel-${tab}`} aria-labelledby={`security-tab-${tab}`}>
            {tab === "incidents" ? (
              <IncidentsTab {...tabProps} onShowEverything={() => choose("everything")} />
            ) : (
              <EverythingTab {...tabProps} />
            )}
          </div>
        </div>
      </div>
    </ShellPage>
  );
}

function IncidentsTab(props: TabProps & { onShowEverything: () => void }) {
  const [filter, setFilter] = useState<IncidentFilter>("attention");
  // An area removed (or no longer visible) since it was picked stops filtering.
  const activeZone = props.zone !== null && props.areas.some((a) => a.id === props.zone) ? props.zone : null;
  const query = useMemo(() => ({ state: filter, limit: 30, ...(activeZone ? { zone: activeZone } : {}) }), [filter, activeZone]);
  const list = useSecurityIncidents(query);
  const { mode } = useSecurityMode();
  const timezone = mode?.displayTimezone ?? deviceTimeZone() ?? "UTC";
  const { refreshRef } = props;
  const refresh = list.refresh;
  useEffect(() => {
    refreshRef.current = () => void refresh();
  }, [refreshRef, refresh]);

  return (
    <IncidentList
      incidents={list.incidents}
      isLoading={list.isLoading}
      error={list.error}
      hasMore={list.hasMore}
      isLoadingMore={list.isLoadingMore}
      onLoadMore={list.loadMore}
      onRetry={() => {
        void list.refresh();
        props.health.refresh();
      }}
      filter={filter}
      onFilterChange={setFilter}
      areas={props.areas}
      zone={activeZone}
      onZoneChange={props.onZoneChange}
      sources={props.health.sources}
      healthError={props.health.error}
      canSeeThreats={props.canSeeThreats}
      cameraLabel={props.cameraLabel}
      timezone={timezone}
      onShowEverything={props.onShowEverything}
    />
  );
}

function EverythingTab(props: TabProps) {
  const [view, setView] = useState<SecurityView>("all");
  const [includeLow, setIncludeLow] = useState(false);
  const canManageAreas = levelAtLeast(useModuleLevel("security"), "manage");
  // An area removed (or no longer visible) since it was picked stops
  // filtering: the feed falls back to all areas instead of a silent empty
  // page. Network rows never sit in an area, so that view never sends one.
  const activeZone = props.zone !== null && view !== "network" && props.areas.some((a) => a.id === props.zone) ? props.zone : null;

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
  const { refreshRef } = props;
  const refresh = feed.refresh;
  useEffect(() => {
    refreshRef.current = () => void refresh();
  }, [refreshRef, refresh]);

  return (
    <SecurityFeed
      sources={props.health.sources}
      healthError={props.health.error}
      events={feed.events}
      isLoading={feed.isLoading}
      error={feed.error}
      hasMore={feed.hasMore}
      isLoadingMore={feed.isLoadingMore}
      onLoadMore={feed.loadMore}
      onRetry={() => {
        feed.refresh();
        props.health.refresh();
      }}
      view={view}
      onViewChange={setView}
      includeLow={includeLow}
      onIncludeLowChange={setIncludeLow}
      canSeeThreats={props.canSeeThreats}
      cameraLabel={props.cameraLabel}
      areas={props.areas}
      canManageAreas={canManageAreas}
      zone={activeZone}
      onZoneChange={props.onZoneChange}
    />
  );
}
