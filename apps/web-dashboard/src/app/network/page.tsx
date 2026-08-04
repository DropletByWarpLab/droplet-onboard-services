"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Gauge,
  Globe,
  Info,
  Loader2,
  Monitor,
  RefreshCw,
  Router,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";
import { useNetwork } from "@/lib/hooks/useNetwork";
import { useNetworkViewMode } from "@/lib/hooks/useNetworkViewMode";
import { SchedulesTab } from "@/components/network/SchedulesTab";
import { DevicesTab } from "@/components/network/DevicesTab";
import { PhoneHomeCard } from "@/components/network/PhoneHomeCard";
import { CameraPrivacyCard } from "@/components/network/CameraPrivacyCard";
import { AiAgentAccessCard } from "@/components/network/AiAgentAccessCard";
import { DhcpPoolForm } from "@/components/network/DhcpPoolForm";
import { DnsOverTlsCard } from "@/components/network/DnsOverTlsCard";
import { GuestWifiCard } from "@/components/network/GuestWifiCard";
import { InterfacesTable } from "@/components/network/InterfacesTable";
import { MaintenanceCards } from "@/components/network/MaintenanceCards";
import { BandSteeringCard } from "@/components/network/BandSteeringCard";
import { ApWifiCard } from "@/components/network/ApWifiCard";
import { RadioDetailCard } from "@/components/network/RadioDetailCard";
import { SystemControlsCard } from "@/components/network/SystemControlsCard";
import { UpnpCard } from "@/components/network/UpnpCard";
import { FirewallRuleForm, ZonePolicyEditor } from "@/components/network/FirewallRuleForm";
import { NetworkSimple } from "@/components/network/NetworkSimple";
import { SwitchPanel } from "@/components/network/switch/SwitchPanel";
import { WifiScanPanel } from "@/components/network/WifiScanPanel";
import { WifiSettingsForm } from "@/components/network/WifiSettingsForm";
import { WifiChannelCard } from "@/components/network/WifiChannelCard";
import { PortForwardForm } from "@/components/network/PortForwardForm";
import { DhcpReservationForm } from "@/components/network/DhcpReservationForm";
import { DnsServersForm } from "@/components/network/DnsServersForm";
import { StaticDnsCard } from "@/components/network/StaticDnsCard";
import {
  fetchNetworkOperation,
  getNetworkTopology,
  rebootRouter,
  type NetworkOperation,
  type NetworkTopology,
} from "@/lib/api";
import { parseNetworkTab, type Tab } from "./tab-url";
import {
  scrollToScheduleAnchor,
  scheduleHashFromEvent,
} from "./schedule-anchor-scroll";
import type {
  FirewallConfig,
  FirewallRedirect,
  FirewallRule,
  FirewallZone,
  NetworkOverview,
} from "@/lib/types";

// WARP-40: poll /network/operations/:id every second until terminal.
type OperationStatus =
  | { state: "idle" }
  | { state: "pending"; id: string }
  | { state: "applied"; id: string; finishedAt: number | null }
  // Neutral no-change terminal: the routing service refused the request (4xx,
  // auth/validation) before any router change. Distinct from "rolled_back",
  // which means a change WAS made and then reverted.
  | { state: "rejected"; id: string; reason: string | null }
  | { state: "rolled_back"; id: string; reason: string | null };

// WARP-39: user-facing strings keyed by the RouterError.code coming off the hook.
const ROUTER_ERROR_COPY: Record<string, { title: string; body: string }> = {
  UNREACHABLE: {
    title: "Router offline",
    body: "We can't reach the router. We'll keep retrying — check the routing service and the router LAN connection.",
  },
  TIMEOUT: {
    title: "Router slow to respond",
    body: "The router took too long to answer. This usually clears up on its own in a few seconds.",
  },
  AUTH: {
    title: "Credentials rejected",
    body: "The shared bearer token or OpenWrt password is wrong. Re-run ./scripts/setup.sh --sync-secrets and restart the routing container.",
  },
  ROLLED_BACK: {
    title: "Last change rolled back",
    body: "The router reverted to the previous configuration to protect connectivity.",
  },
  // WARP-44: ROUTING_MODE=disabled — the orchestrator isn't calling the
  // router. Copy is informational, not alarming.
  DISABLED: {
    title: "Router supervision disabled",
    body: "This deployment runs without router control. Set ROUTING_MODE=real in .env and restart to re-enable.",
  },
  UNKNOWN: {
    title: "Router unavailable",
    body: "Something unexpected happened talking to the router. Check the orchestrator and routing service logs.",
  },
};

// WARP-100: useSearchParams must be read under a Suspense boundary (Next.js
// app-router). Mirror the /knowledge pattern — a thin outer component holds
// the boundary, the inner component owns all the page logic.
export default function NetworkPage() {
  return (
    <Suspense fallback={<NetworkPageSkeleton />}>
      <NetworkPageInner />
    </Suspense>
  );
}

function NetworkPageSkeleton() {
  return (
    <ShellPage icon={<Router size={15} />} label="Network" title="Network">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card animate-pulse" style={{ height: 112, background: "var(--surface-2)" }} />
        ))}
      </div>
    </ShellPage>
  );
}

function NetworkPageInner() {
  const {
    overview,
    firewall,
    isLoading,
    isRefreshing,
    error,
    routerConnected,
    routerErrorCode,
    routerErrorMessage,
    refresh,
  } = useNetwork();
  const { user } = useAuth();
  const canAuthor = user?.role === "owner" || user?.role === "admin";

  // WARP-100: tab state lives in the URL (`/network?tab=schedules`) so
  // deep-links, browser back/forward, and the cross-tab jump from
  // DeviceDetailPanel all work. `activeTab` is derived from the URL; switching
  // tabs pushes a new history entry (router.push) so Back returns to the prior
  // tab. The name `setActiveTab` is preserved so every existing call site
  // (simple-mode snap-back, tab click, arrow-key nav, PrivacyTab) is unchanged.
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab: Tab = parseNetworkTab(searchParams?.get("tab"));
  const setActiveTab = useCallback(
    (next: Tab) => {
      if (next === activeTab) return;
      // Default to Overview (no ?tab) to keep the canonical URL clean.
      router.push(next === "overview" ? "/network" : `/network?tab=${next}`);
    },
    [router, activeTab],
  );
  // WARP-298 / PR #720 review (a11y): arrow-key tab nav must move focus to the
  // newly-activated tab — but `aria-selected`/`tabIndex` derive from the
  // URL-driven `activeTab`, which only updates after router.push re-renders.
  // Focusing synchronously in the keydown handler lands focus on a button that
  // still reads aria-selected=false, so an SR announces "not selected" during
  // the async gap. Instead, record the keyboard target here and focus it in an
  // effect once `activeTab` reflects it (see below), so the focused tab is
  // already selected at the moment it receives focus.
  const keyboardFocusTarget = useRef<Tab | null>(null);
  const [opStatus, setOpStatus] = useState<OperationStatus>({ state: "idle" });
  // WARP-871 follow-up: while an owner-initiated reboot is in flight the router
  // is expected to drop for ~30-90s, which makes the status SWR poll fail. Lift
  // the reboot-in-progress signal here (set by RouterRebootCard) so the
  // (error || !routerConnected) early return defers to the calm "restarting"
  // state during that window instead of flashing the alarming full-page error.
  const [rebooting, setRebooting] = useState(false);

  // WARP-612: Simple ⟷ Advanced mode (Droplet Design System). Most installs
  // default to Simple — the everyday Overview only — while Business installs
  // default to Advanced (the full OpenWrt tab surface). The persona default
  // re-syncs once `isBusiness` resolves (useWorkspace hydrates it from the
  // orchestrator after first paint) without clobbering an explicit user choice
  // — see useNetworkViewMode. Switching to Simple snaps the active panel back to
  // Overview so the hidden tab strip can't leave a power-user panel showing.
  const { isBusiness } = useWorkspace();
  const { mode, choose: chooseMode } = useNetworkViewMode(isBusiness);
  function switchMode(next: "simple" | "advanced") {
    chooseMode(next);
    if (next === "simple") setActiveTab("overview");
  }

  // WARP-40: poll the operation record until it reaches a terminal state.
  // Capped at 70s (safe-apply's 60s timeout + a little slack) so a lost
  // operation never keeps the banner spinning forever.
  useEffect(() => {
    if (opStatus.state !== "pending") return;
    const startedAt = Date.now();
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const op: NetworkOperation = await fetchNetworkOperation(opStatus.id);
        if (cancelled) return;
        if (op.state === "applied") {
          setOpStatus({ state: "applied", id: op.id, finishedAt: op.finishedAt });
          refresh();
        } else if (op.state === "rejected") {
          // Neutral no-change terminal — the router refused the request (4xx),
          // nothing was applied or reverted. Don't show the rollback alarm.
          setOpStatus({ state: "rejected", id: op.id, reason: op.reason });
          refresh();
        } else if (op.state === "rolled_back") {
          setOpStatus({ state: "rolled_back", id: op.id, reason: op.reason });
          refresh();
        } else if (op.state === "unknown") {
          // DASH-07: the orchestrator can't account for this op (404). It's
          // indeterminate, not a success — present it as unconfirmed (reusing
          // the rolled_back banner, our "don't trust the change" surface) and
          // re-check the device list rather than reporting "applied".
          setOpStatus({
            state: "rolled_back",
            id: op.id,
            reason: op.reason ?? "We couldn't confirm this change — re-check the device list.",
          });
          refresh();
        } else if (Date.now() - startedAt > 70_000) {
          // Router or operation record is gone. Present as rolled back so the
          // user doesn't trust a change we can't confirm.
          setOpStatus({ state: "rolled_back", id: opStatus.id, reason: "Timed out waiting for router" });
        }
      } catch {
        if (!cancelled) {
          setOpStatus({ state: "rolled_back", id: opStatus.id, reason: "Could not reach router" });
        }
      }
    };

    tick();
    const interval = setInterval(tick, 1_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [opStatus, refresh]);

  // WARP-100: after a jump to `/network?tab=schedules#schedule-<id>`, scroll the
  // matching ScheduleRow into view once the Schedules tab has mounted. Two ways
  // in, both handled here:
  //   • tab/mount change — the deps below re-run the effect (deep-link, or a
  //     cross-tab jump that switches the active tab to Schedules).
  //   • hash-only change — a second jump while ALREADY on Schedules pushes a new
  //     `#schedule-<id>` without changing `activeTab`, so the deps don't fire.
  //     A `hashchange` listener re-runs the bounded retry-scroll for the new
  //     target (PR #720 review blocker).
  // scrollToScheduleAnchor reads the live hash, polls briefly for the anchor
  // (SchedulesTab's list resolves via SWR), honours prefers-reduced-motion, and
  // returns a cleanup that cancels the loop + clears its pending timer.
  useEffect(() => {
    if (mode === "simple" || activeTab !== "schedules") return;
    if (typeof window === "undefined") return;

    let cleanup = scrollToScheduleAnchor();
    const onHashChange = (e: HashChangeEvent) => {
      cleanup();
      // Prefer the event's target hash (the same-tab jump dispatches a
      // synthetic event carrying it, because router.push commits the live hash
      // a tick later); fall back to window.location.hash for native nav.
      cleanup = scrollToScheduleAnchor(scheduleHashFromEvent(e));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      cleanup();
    };
  }, [activeTab, mode]);

  // WARP-298 / PR #720 review (a11y): once `activeTab` reflects the key-driven
  // selection, move focus to that tab button. Running this after activation
  // (not synchronously in the keydown handler) guarantees the button already
  // reads aria-selected={true} / tabIndex={0} at the moment it receives focus,
  // honouring the WAI-ARIA "move + activate" contract for an SR user.
  useEffect(() => {
    if (keyboardFocusTarget.current === null) return;
    if (keyboardFocusTarget.current !== activeTab) return;
    keyboardFocusTarget.current = null;
    document.getElementById(`network-tab-${activeTab}`)?.focus();
  }, [activeTab]);

  if (isLoading) {
    return (
      <ShellPage icon={<Router size={15} />} label="Network" title="Network">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card animate-pulse" style={{ height: 112, background: "var(--surface-2)" }} />
          ))}
        </div>
      </ShellPage>
    );
  }

  // WARP-871 follow-up: suppress the alarming full-page error while a reboot is
  // in progress — the dropped connection is expected and RouterRebootCard is
  // already showing the reassuring "restarting" banner. Once connectivity
  // returns the SWR poll clears `error`/sets `routerConnected` and normal
  // rendering resumes.
  if ((error || !routerConnected) && !rebooting) {
    // WARP-39: render per-code copy when available so the user can act on the
    // specific cause. Falls back to UNKNOWN text when the error didn't come
    // from the typed Result path (older SDK, unrelated failure, etc.).
    const copy = ROUTER_ERROR_COPY[routerErrorCode ?? "UNKNOWN"];
    // WARP-44: DISABLED is informational (explicit config), not a failure.
    // Don't use role="alert" or a retry button in that state.
    const isDisabled = routerErrorCode === "DISABLED";
    return (
      <ShellPage icon={<Router size={15} />} label="Network" title="Network">
        <div
          className="card text-center"
          style={{ padding: "48px 20px" }}
          role={isDisabled ? "status" : "alert"}
        >
          <WifiOff size={32} className="mx-auto mb-3" style={{ color: "var(--text-faint)" }} />
          <h2 className="type-title-3 mb-1" style={{ color: "var(--text)" }}>{copy.title}</h2>
          <p className="type-subheadline max-w-md mx-auto" style={{ color: "var(--text-muted)" }}>
            {copy.body}
          </p>
          {routerErrorMessage && !isDisabled && (
            <p className="type-caption-2 mt-3 font-mono" style={{ color: "var(--text-faint)" }}>
              {routerErrorMessage}
            </p>
          )}
          {!isDisabled && (
            <button
              onClick={refresh}
              className="btn ghost sm mt-4"
              disabled={isRefreshing}
              type="button"
            >
              {isRefreshing ? "Retrying…" : "Retry now"}
            </button>
          )}
        </div>
      </ShellPage>
    );
  }

  const tabs: { id: Tab; label: string; icon: typeof Globe }[] = [
    { id: "overview", label: "Overview", icon: Globe },
    { id: "privacy", label: "Privacy", icon: ShieldCheck },
    { id: "devices", label: "Devices", icon: Monitor },
    { id: "schedules", label: "Schedules", icon: CalendarClock },
    { id: "wifi", label: "WiFi", icon: Wifi },
    { id: "firewall", label: "Firewall", icon: Shield },
    { id: "system", label: "System", icon: Router },
  ];

  return (
    <ShellPage icon={<Router size={15} />} label="Network" title="Network">
      {/* Refresh action — sits next to the tab strip where the operator's
          eye lands, paired with the Simple/Advanced mode toggle. */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        {/* WARP-612: Simple / Advanced segmented control. Simple shows the
            everyday Overview; Advanced reveals the full OpenWrt tab surface. */}
        <div className="pills" role="group" aria-label="Network view mode">
          {([["simple", "Simple", Gauge], ["advanced", "Advanced", SlidersHorizontal]] as const).map(
            ([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => switchMode(id)}
                aria-pressed={mode === id}
                className={
                  "inline-flex items-center gap-1.5" + (mode === id ? " active" : "")
                }
              >
                <Icon size={14} />
                {label}
              </button>
            ),
          )}
        </div>
        <button
          onClick={refresh}
          disabled={isRefreshing}
          className="btn ghost"
          type="button"
        >
          <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* WARP-40: Operation-status banner — visible while a write is in flight
          or just after it completed. Auto-dismissed when the user clicks × or
          starts a new operation. */}
      {opStatus.state === "pending" && (
        <div
          role="status"
          className="card mb-4 flex items-center gap-3"
          style={{ borderColor: "var(--brand)", background: "var(--brand-subtle)" }}
        >
          <Loader2 size={18} className="animate-spin" style={{ color: "var(--brand)" }} />
          <div className="flex-1">
            <p className="type-subheadline font-medium" style={{ color: "var(--text)" }}>Applying change…</p>
            <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
              Waiting for the router to confirm the new configuration.
            </p>
          </div>
        </div>
      )}
      {opStatus.state === "applied" && (
        <div
          role="status"
          className="card mb-4 flex items-center gap-3"
          style={{ borderColor: "var(--success)", background: "color-mix(in srgb, var(--success) 7%, transparent)" }}
        >
          <CheckCircle2 size={18} className="text-system-green" />
          <p className="type-subheadline flex-1" style={{ color: "var(--text)" }}>Change applied.</p>
          <button
            onClick={() => setOpStatus({ state: "idle" })}
            className="btn ghost sm"
            aria-label="Dismiss"
            type="button"
          >
            Dismiss
          </button>
        </div>
      )}
      {opStatus.state === "rejected" && (
        <div role="status" className="card mb-4 flex items-center gap-3">
          <Info size={18} style={{ color: "var(--text-muted)" }} />
          <div className="flex-1">
            <p className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
              No change made
            </p>
            <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
              {opStatus.reason ??
                "The router rejected the request, so nothing was changed."}
            </p>
          </div>
          <button
            onClick={() => setOpStatus({ state: "idle" })}
            className="btn ghost sm"
            aria-label="Dismiss"
            type="button"
          >
            Dismiss
          </button>
        </div>
      )}
      {opStatus.state === "rolled_back" && (
        <div
          role="alert"
          className="card mb-4 flex items-center gap-3"
          style={{ borderColor: "#ef4444", background: "rgba(239,68,68,0.06)" }}
        >
          <XCircle size={18} className="text-system-red" />
          <div className="flex-1">
            <p className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
              Change rolled back
            </p>
            <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
              {opStatus.reason ?? "The router reverted to the previous configuration."}
            </p>
          </div>
          <button
            onClick={() => setOpStatus({ state: "idle" })}
            className="btn ghost sm"
            aria-label="Dismiss"
            type="button"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Tabs — WAI-ARIA tabs pattern (WARP-298). Arrow keys + Home/End
          move + activate; only the active tab is in the tab sequence. */}
      <div
        role="tablist"
        aria-label="Network view tabs"
        hidden={mode === "simple"}
        className="tabstrip"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`network-tab-${tab.id}`}
              aria-selected={active}
              aria-controls={`network-panel-${tab.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => {
                const i = tabs.findIndex((t) => t.id === activeTab);
                if (i === -1) return;
                const n = tabs.length;
                let next: number | null = null;
                switch (e.key) {
                  case "ArrowRight":
                  case "ArrowDown":
                    next = (i + 1) % n;
                    break;
                  case "ArrowLeft":
                  case "ArrowUp":
                    next = (i - 1 + n) % n;
                    break;
                  case "Home":
                    next = 0;
                    break;
                  case "End":
                    next = n - 1;
                    break;
                }
                if (next !== null) {
                  e.preventDefault();
                  // PR #720 review (a11y): record the target and let the
                  // post-activation effect focus it once `activeTab` (and so
                  // aria-selected/tabIndex) reflects the change — focusing
                  // synchronously here would land on a still-unselected button.
                  keyboardFocusTarget.current = tabs[next].id;
                  setActiveTab(tabs[next].id);
                }
              }}
              className={"tab" + (active ? " active" : "")}
            >
              <Icon size={16} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {mode === "simple" && (
        <NetworkSimple overview={overview} onOpenAdvanced={() => switchMode("advanced")} />
      )}

      {/* Tab Content — one tabpanel per tab, contents lazily mounted when the
          tab is active. In Simple mode the panels are hidden (via the wrapper)
          rather than unmounted, so the tabs' `aria-controls` always resolves to
          a panel that exists in the DOM and the tab subtree is preserved. */}
      <div hidden={mode === "simple"}>
      <div
        role="tabpanel"
        id="network-panel-overview"
        aria-labelledby="network-tab-overview"
        tabIndex={0}
        hidden={activeTab !== "overview"}
      >
        {activeTab === "overview" && <OverviewTab overview={overview} />}
      </div>
      <div
        role="tabpanel"
        id="network-panel-privacy"
        aria-labelledby="network-tab-privacy"
        tabIndex={0}
        hidden={activeTab !== "privacy"}
      >
        {activeTab === "privacy" && <PrivacyTab onManageGroups={() => setActiveTab("devices")} />}
      </div>
      <div
        role="tabpanel"
        id="network-panel-devices"
        aria-labelledby="network-tab-devices"
        tabIndex={0}
        hidden={activeTab !== "devices"}
      >
        {activeTab === "devices" && <DevicesTab />}
      </div>
      <div
        role="tabpanel"
        id="network-panel-schedules"
        aria-labelledby="network-tab-schedules"
        tabIndex={0}
        hidden={activeTab !== "schedules"}
      >
        {activeTab === "schedules" && <SchedulesTab />}
      </div>
      <div
        role="tabpanel"
        id="network-panel-wifi"
        aria-labelledby="network-tab-wifi"
        tabIndex={0}
        hidden={activeTab !== "wifi"}
      >
        {activeTab === "wifi" && <WifiTab />}
      </div>
      <div
        role="tabpanel"
        id="network-panel-firewall"
        aria-labelledby="network-tab-firewall"
        tabIndex={0}
        hidden={activeTab !== "firewall"}
      >
        {activeTab === "firewall" && (
          <FirewallTab firewall={firewall} canAuthor={canAuthor} onApplied={refresh} />
        )}
      </div>
      <div
        role="tabpanel"
        id="network-panel-system"
        aria-labelledby="network-tab-system"
        tabIndex={0}
        hidden={activeTab !== "system"}
      >
        {activeTab === "system" && (
          <SystemTab overview={overview} onRebootingChange={setRebooting} />
        )}
      </div>
      </div>
    </ShellPage>
  );
}

// --- Privacy Tab (WARP-613) ---
function PrivacyTab({ onManageGroups }: { onManageGroups: () => void }) {
  return (
    <div className="max-w-2xl">
      <PhoneHomeCard onManageGroups={onManageGroups} />
    </div>
  );
}

// --- Overview Tab ---
function OverviewTab({ overview }: { overview: NetworkOverview | undefined }) {
  const lan = overview?.interfaces?.lan;
  const wan = overview?.interfaces?.wan;
  const system = overview?.system;

  const lanIp = lan?.["ipv4-address"]?.[0]?.address ?? "N/A";
  const wanIp = wan?.["ipv4-address"]?.[0]?.address ?? "N/A";
  const wanProto = wan?.proto ?? "unknown";
  // Single-box hands the WAN uplink to the appliance host, so the in-box OpenWrt
  // reports the wan interface as `present:false`. That absence is the shipping
  // shape, NOT an outage — render it as an honest "handled upstream" state
  // rather than a red error/"N/A" that reads as the router being offline. A WAN
  // that is genuinely configured-but-down (`present:true, up:false`) still
  // surfaces as an error.
  const wanPresent = wan?.present !== false;
  const uptime = system?.resources?.uptime ?? 0;
  const uptimeHours = Math.floor(uptime / 3600);
  const uptimeDays = Math.floor(uptimeHours / 24);

  const memTotal = system?.resources?.memory?.total ?? 0;
  const memFree = system?.resources?.memory?.free ?? 0;
  const memUsedPct = memTotal > 0 ? Math.round(((memTotal - memFree) / memTotal) * 100) : 0;

  // WARP-871: best-effort deployment-posture badge (ADR-018). The routing
  // GET /network/topology read existed but was never surfaced; the badge tells
  // a primary router apart from a single-box sitting behind the home router.
  const [topology, setTopology] = useState<NetworkTopology | null>(null);
  useEffect(() => {
    let cancelled = false;
    getNetworkTopology().then((t) => {
      if (!cancelled) setTopology(t);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const postureLabel =
    topology?.posture === "PRIMARY_ROUTER"
      ? "Primary router"
      : topology?.posture === "DOWNSTREAM_ROUTER"
        ? "Downstream router"
        : null;

  return (
    <div className="space-y-6">
      {postureLabel && (
        <span className="badge muted">
          <Router size={12} aria-hidden="true" />
          {postureLabel}
        </span>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatusCard
          icon={Globe}
          title="WAN"
          value={wanPresent ? wanIp : "Provided by Droplet"}
          subtitle={wanPresent ? `Protocol: ${wanProto}` : "Internet handled by the appliance"}
          status={wanPresent ? (wan?.up ? "ok" : "error") : "ok"}
        />
        <StatusCard
          icon={Router}
          title="LAN"
          value={lanIp}
          subtitle={`${overview?.connectedDeviceCount ?? 0} devices`}
          status={lan?.up ? "ok" : "error"}
        />
        <StatusCard
          icon={Wifi}
          title="WiFi"
          value={overview?.wireless ? "Active" : "Inactive"}
          subtitle={Object.keys(overview?.wireless ?? {}).length + " radio(s)"}
          status={Object.keys(overview?.wireless ?? {}).length > 0 ? "ok" : "warning"}
        />
        <StatusCard
          icon={Monitor}
          title="Uptime"
          value={uptimeDays > 0 ? `${uptimeDays}d ${uptimeHours % 24}h` : `${uptimeHours}h`}
          subtitle={`Memory: ${memUsedPct}% used`}
          status="ok"
        />
      </div>

      {/* ADR-018 item 12 — managed-switch panel. Sits below the KPI strip
          (the design's "throughput chart" anchor doesn't exist on this tabbed
          page; Overview is only visible in Advanced mode — in Simple mode the
          wrapper div is hidden and NetworkSimple renders instead). Renders
          its own empty/loading/error states and self-gates RBAC. */}
      <SwitchPanel />
    </div>
  );
}

function StatusCard({
  icon: Icon,
  title,
  value,
  subtitle,
  status,
}: {
  icon: typeof Globe;
  title: string;
  value: string;
  subtitle: string;
  status: "ok" | "warning" | "error";
}) {
  const statusColor = status === "ok" ? "text-system-green" : status === "warning" ? "text-system-orange" : "text-system-red";
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={18} className={statusColor} />
        <span
          className="type-footnote font-medium uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          {title}
        </span>
      </div>
      <p className="type-title-3" style={{ color: "var(--text)" }}>{value}</p>
      <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>{subtitle}</p>
    </div>
  );
}


// --- WiFi Tab ---
function WifiTab() {
  return (
    <div className="space-y-4">
      {/* Issue #12: editable provisioning form so a user who skipped Wi-Fi
          during onboarding can set the SSID/password here — same write path as
          the setup wizard's InternetStep. WARP-1714: the form seeds the current
          SSID/password from /api/network/wifi/current, which resolves this
          Droplet's own radio OR the approved AP — on the edge-router shape the
          router hosts no AP at all, so reading it alone leaves the card blank. */}
      <WifiSettingsForm />

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

      {/* WARP-1712: the external access point's OWN network name + password.
          Sits directly under the router's Wi-Fi form so both halves of the
          household's wireless are set from one place. The same component is
          rendered inside the Coverage Extenders panel on the Devices tab —
          shared SWR key, so the two surfaces can never disagree. Honest
          unavailable state when no approved Droplet AP is online. */}
      <ApWifiCard />

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

// --- Firewall Tab ---
// A zone's input/output/forward policy chip — green for ACCEPT, red for the
// restrictive policies (REJECT/DROP). Mirrors the design's zone-policy chips
// (advanced Network · Firewall zones) and reuses the same status colors as the
// rule target chips below.
function PolicyChip({ policy }: { policy: string | undefined }) {
  const value = (policy ?? "—").toUpperCase();
  const accepting = value === "ACCEPT";
  return (
    <span
      className={`type-caption-2 font-mono px-1.5 py-0.5 rounded-sm ${
        value === "—"
          ? ""
          : accepting
            ? "text-system-green bg-system-green/10"
            : "text-system-red bg-system-red/10"
      }`}
      style={
        value === "—"
          ? { color: "var(--text-faint)", background: "var(--inset)" }
          : undefined
      }
    >
      {value}
    </span>
  );
}

function FirewallTab({
  firewall,
  canAuthor,
  onApplied,
}: {
  firewall: FirewallConfig | undefined;
  canAuthor: boolean;
  onApplied: () => void;
}) {
  // WARP-42: typed Object.entries — each entry is [sectionId, typed section]
  // instead of [string, any], so a missing `target` or a `proto` type change
  // on the routing side now fails compile.
  const { user } = useAuth();
  // Port-forwarding exposes a LAN service to WAN ingress — owner/admin only,
  // matching the orchestrator route guard (requireRoleOrMcpService("owner",
  // "admin")). Family-tier members see the read-only lists but not the form.
  const canEdit = user?.role === "owner" || user?.role === "admin";
  const zones: Array<[string, FirewallZone]> = firewall?.zones?.values
    ? Object.entries(firewall.zones.values)
    : [];
  const zoneNames = zones.map(([key, z]) => z.name ?? key);
  const rules: Array<[string, FirewallRule]> = firewall?.rules?.values
    ? Object.entries(firewall.rules.values)
    : [];
  const redirects: Array<[string, FirewallRedirect]> = firewall?.redirects?.values
    ? Object.entries(firewall.redirects.values)
    : [];

  return (
    <div className="space-y-4">
      {/* Zones — the foundational firewall structure (lan/wan/cameras/guest).
          Read-only: the box auto-manages zone policies; the UI reflects them so
          an owner can see, e.g., that the camera zone forwards to wan only. The
          zone data already ships in getFirewallConfig(); this surfaces it. */}
      <div className="card">
        <h3 className="type-headline mb-1" style={{ color: "var(--text)" }}>
          Zones ({zones.length})
        </h3>
        <p className="type-caption-1 mb-4" style={{ color: "var(--text-muted)" }}>
          Default input · output · forward policy per network zone. Managed by
          the box.
        </p>
        {zones.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full type-caption-1">
              <thead>
                <tr className="text-left" style={{ color: "var(--text-muted)" }}>
                  <th className="font-medium pb-2 pr-4">Zone</th>
                  <th className="font-medium pb-2 pr-4">Input</th>
                  <th className="font-medium pb-2 pr-4">Output</th>
                  <th className="font-medium pb-2 pr-4">Forward</th>
                  <th className="font-medium pb-2">Networks</th>
                  {canAuthor && <th className="font-medium pb-2 pl-4" />}
                </tr>
              </thead>
              <tbody>
                {zones.map(([key, zone]) => {
                  const nets = Array.isArray(zone.network)
                    ? zone.network.join(", ")
                    : zone.network;
                  return (
                    <tr key={key} style={{ borderTop: "1px solid var(--card-bd)" }}>
                      <td className="py-2 pr-4">
                        <span
                          className="type-subheadline font-medium"
                          style={{ color: "var(--text)" }}
                        >
                          {zone.name ?? key}
                        </span>
                        {zone.masq === "1" && (
                          <span
                            className="ml-2 type-caption-2 font-mono"
                            style={{ color: "var(--text-faint)" }}
                          >
                            masq
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <PolicyChip policy={zone.input} />
                      </td>
                      <td className="py-2 pr-4">
                        <PolicyChip policy={zone.output} />
                      </td>
                      <td className="py-2 pr-4">
                        <PolicyChip policy={zone.forward} />
                      </td>
                      <td className="py-2 font-mono" style={{ color: "var(--text-muted)" }}>
                        {nets || "—"}
                      </td>
                      {canAuthor && (
                        <td className="py-2 pl-4 align-top">
                          <ZonePolicyEditor
                            zone={zone.name ?? key}
                            input={zone.input}
                            output={zone.output}
                            forward={zone.forward}
                            onApplied={onApplied}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
            No firewall zones reported.
          </p>
        )}
      </div>

      {/* Firewall authoring (owner/admin) — add a traffic rule. Zone policies
          are edited inline per row above. Both are Tier-2 confirm-gated writes. */}
      {canAuthor && <FirewallRuleForm zones={zoneNames} onApplied={onApplied} />}

      <div className="card">
        <h3 className="type-headline mb-4" style={{ color: "var(--text)" }}>
          Firewall Rules ({rules.length})
        </h3>
        {rules.length > 0 ? (
          <div className="space-y-2">
            {rules.map(([key, rule]) => (
              <div
                key={key}
                className="flex items-center justify-between px-3 py-2 rounded-sm"
                style={{ background: "var(--inset)" }}
              >
                <div>
                  <p className="type-subheadline" style={{ color: "var(--text)" }}>
                    {rule.name ?? key}
                  </p>
                  <p className="type-caption-2" style={{ color: "var(--text-muted)" }}>
                    {rule.src ?? "*"} &rarr; {rule.dest ?? "*"} | Target: {rule.target ?? "—"}
                    {rule.src_mac ? ` | MAC: ${rule.src_mac}` : ""}
                  </p>
                </div>
                <span
                  className={`type-caption-1 ${
                    rule.target === "ACCEPT" ? "text-system-green" : "text-system-red"
                  }`}
                >
                  {rule.target ?? "—"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>No custom firewall rules.</p>
        )}
      </div>

      <div className="card">
        <h3 className="type-headline mb-4" style={{ color: "var(--text)" }}>
          Port Forwards ({redirects.length})
        </h3>
        {redirects.length > 0 ? (
          <div className="space-y-2">
            {redirects.map(([key, fwd]) => (
              <div
                key={key}
                className="flex items-center justify-between px-3 py-2 rounded-sm"
                style={{ background: "var(--inset)" }}
              >
                <div>
                  <p className="type-subheadline" style={{ color: "var(--text)" }}>
                    {fwd.name ?? key}
                  </p>
                  <p className="type-caption-2" style={{ color: "var(--text-muted)" }}>
                    :{fwd.src_dport ?? "—"} ({Array.isArray(fwd.proto) ? fwd.proto.join("/") : fwd.proto ?? "tcp"}) &rarr;{" "}
                    {fwd.dest_ip ?? "—"}:{fwd.dest_port ?? "—"}
                  </p>
                </div>
                <span
                  className={`type-caption-1 ${fwd.enabled === "1" ? "text-system-green" : ""}`}
                  style={fwd.enabled === "1" ? undefined : { color: "var(--text-faint)" }}
                >
                  {fwd.enabled === "1" ? "Active" : "Disabled"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>No port forwards configured.</p>
        )}
      </div>

      {/* WARP-871: the add-port-forward write path (orchestrator route +
          routing validator) shipped at NET-09, but the Firewall tab was
          read-only — the only ways to create one were the LLM tool or curl.
          Owner/admin only, matching the route guard. */}
      {canEdit && <PortForwardForm onApplied={onApplied} />}
      {/* UPnP / NAT-PMP — automatic port opening, off by default. Reflects the
          box's real state (read-only "not available" when miniupnpd is absent). */}
      <UpnpCard />
    </div>
  );
}

// --- System Tab ---
function SystemTab({
  overview,
  onRebootingChange,
}: {
  overview: NetworkOverview | undefined;
  onRebootingChange: (rebooting: boolean) => void;
}) {
  const board = overview?.system?.board;
  const resources = overview?.system?.resources;

  const uptime = resources?.uptime ?? 0;
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);

  const memTotal = resources?.memory?.total ?? 0;
  const memFree = resources?.memory?.free ?? 0;
  const memTotalMB = Math.round(memTotal / (1024 * 1024));
  const memFreeMB = Math.round(memFree / (1024 * 1024));

  const load = resources?.load ?? [0, 0, 0];
  const load1 = (load[0] / 65536).toFixed(2);
  const load5 = (load[1] / 65536).toFixed(2);
  const load15 = (load[2] / 65536).toFixed(2);

  // Static DHCP reservations shape the LAN's address map — owner/admin only,
  // matching the orchestrator route guard (requireRole("owner", "admin")).
  const { user } = useAuth();
  const canEdit = user?.role === "owner" || user?.role === "admin";

  return (
    <div className="space-y-4">
      <div className="card">
        <h3 className="type-headline mb-4" style={{ color: "var(--text)" }}>Hardware</h3>
        <div className="grid grid-cols-2 gap-y-3 gap-x-6">
          <InfoRow label="Model" value={board?.model ?? "Unknown"} />
          <InfoRow label="Hostname" value={board?.hostname ?? "Unknown"} />
          <InfoRow label="Kernel" value={board?.kernel ?? "Unknown"} />
          <InfoRow label="Architecture" value={board?.system ?? "Unknown"} />
          <InfoRow label="OpenWrt" value={board?.release?.version ?? "Unknown"} />
          <InfoRow label="Target" value={board?.release?.target ?? "Unknown"} />
        </div>
      </div>

      <div className="card">
        <h3 className="type-headline mb-4" style={{ color: "var(--text)" }}>Resources</h3>
        <div className="grid grid-cols-2 gap-y-3 gap-x-6">
          <InfoRow label="Uptime" value={`${days}d ${hours}h ${minutes}m`} />
          <InfoRow label="Load Average" value={`${load1} / ${load5} / ${load15}`} />
          <InfoRow label="Memory Total" value={`${memTotalMB} MB`} />
          <InfoRow label="Memory Free" value={`${memFreeMB} MB`} />
        </div>
      </div>

      {/* WARP-871: static DHCP reservations (owner/admin, Tier 1) were fully
          wired server-side but had no UI — the only ways to pin a device to an
          IP were the LLM tool or curl. */}
      {canEdit && <DhcpReservationForm />}

      {/* WARP-871: upstream/custom DNS resolvers. The routing /dhcp/dns write +
          openwrt.client.setDnsServers existed; this surfaces them via a new
          thin orchestrator route (POST /api/network/dns, Tier 1). */}
      {canEdit && <DnsServersForm />}

      {/* WARP-871: local DNS names (host-records). Routing /dhcp/hostnames had
          full CRUD; new orchestrator routes + this card surface it. */}
      {canEdit && <StaticDnsCard />}
      {/* System controls — hostname (Tier-2) + time-sync (Tier-1) are real;
          status-LED + Wi-Fi country render honest 'not available' rows on the
          single-box shape (no in-container LED surface; pinned host-hostapd
          country). */}
      <SystemControlsCard />

      {/* Interfaces — enumeration of every configured interface. KAN-10 adds the
          owner/admin Add/Edit + owner-only Restart write path: Tier-2/3 confirm,
          routing-side safe_apply auto-rollback, and an extra confirm before a
          write to the management interface. present:false rows render an honest
          'not on this box' state. */}
      <InterfacesTable canEdit={canEdit} isOwner={user?.role === "owner"} />

      {/* AI agent access — read-only droplet-ai RPC scopes from the live ACL.
          Rotate/Revoke are honest-gated (disabled): they'd need a coordinated
          secret refresh that self-locks-out the Network tab. */}
      <AiAgentAccessCard />

      {/* DHCP & DNS — the live LAN pool range + lease-time editor (Tier-2
          confirm) plus the honest DNS-over-TLS gate (no DoT forwarder on this
          build, so it renders inert rather than faking a toggle). */}
      <DhcpPoolForm />
      <DnsOverTlsCard />

      {/* WARP-871: the reboot endpoint (owner-only, Tier-3 confirmable) was
          fully wired server-side but had no UI path — the only ways to restart
          the router were the LLM tool or curl. */}
      <RouterRebootCard onRebootingChange={onRebootingChange} />

      {/* Maintenance — Firmware + Factory reset. Honest, informational,
          owner-only: the single-box runs OpenWrt in a container (no flashable
          router firmware; a container UCI reset would desync the host AP), so
          these explain the truth and point at the appliance-wide flows rather
          than fake a router-only sysupgrade / reset. */}
      <MaintenanceCards />
    </div>
  );
}

// --- Router reboot (WARP-871) ---
// Owner-only restart with a typed double-confirm. "reboot" is Tier 3 — the
// orchestrator answers the POST with a 202 + token, and the dashboard
// confirmation IS the consent (rebootRouter echoes it straight back).
function RouterRebootCard({
  onRebootingChange,
}: {
  onRebootingChange: (rebooting: boolean) => void;
}) {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "rebooting" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const triggerRef = useRef<HTMLButtonElement>(null);

  // WARP-871 follow-up: mirror the local "rebooting" state up to NetworkPage so
  // its (error || !routerConnected) early return defers to this card's calm
  // "restarting" banner during the expected ~30-90s outage. Reset on unmount
  // (e.g. tab switch mid-reboot) so a stale flag can't mask a real outage.
  const rebooting = status.kind === "rebooting";
  useEffect(() => {
    onRebootingChange(rebooting);
    return () => onRebootingChange(false);
  }, [rebooting, onRebootingChange]);

  if (!isOwner) return null;

  async function doReboot() {
    setStatus({ kind: "rebooting" });
    try {
      await rebootRouter();
      // Command accepted — clear rebooting flag so subsequent outages
      // (router going offline, coming back) are surfaced normally by the
      // SWR poll instead of being masked by a permanent rebooting=true.
      setStatus({ kind: "idle" });
    } catch (e) {
      setStatus({
        kind: "error",
        message:
          e instanceof Error ? e.message : "Couldn't restart the router. Try again.",
      });
    }
  }

  return (
    <div className="card">
      <h3 className="type-headline mb-1" style={{ color: "var(--text)" }}>Restart router</h3>
      <p className="type-subheadline mb-4" style={{ color: "var(--text-muted)" }}>
        Restarting the router drops every connected device for about a minute
        while it reboots. Wi-Fi and internet come back automatically.
      </p>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={status.kind === "rebooting"}
        className="btn ghost"
        style={{ color: "var(--danger)" }}
      >
        {status.kind === "rebooting" ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <RefreshCw size={16} />
        )}
        {status.kind === "rebooting" ? "Restarting…" : "Restart router"}
      </button>

      {status.kind === "rebooting" && (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex items-start gap-2 type-footnote bg-system-orange/10 rounded-sm px-3 py-2"
          style={{ color: "var(--text)" }}
        >
          <Info size={14} className="mt-0.5 flex-shrink-0 text-system-orange" aria-hidden="true" />
          <span>
            Router is restarting — devices will reconnect on their own in a
            minute or so.
          </span>
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

      <ConfirmDialog
        open={confirmOpen}
        triggerRef={triggerRef}
        title="Restart the router?"
        description="Every connected device — including this one — will lose its connection for about a minute while the router reboots."
        confirmLabel="Restart"
        variant="destructive"
        onConfirm={async () => {
          setConfirmOpen(false);
          await doReboot();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="type-subheadline" style={{ color: "var(--text)" }}>{value}</p>
    </div>
  );
}
