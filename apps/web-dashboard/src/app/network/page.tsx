"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Globe,
  Home,
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
import { useNetworkDevices } from "@/lib/hooks/useNetworkDevices";
import { useNetworkGroups } from "@/lib/hooks/useNetworkGroups";
import { useNetworkViewMode } from "@/lib/hooks/useNetworkViewMode";
import { DeviceGridSection } from "@/components/network/DeviceGridSection";
import { DeviceDetailPanel } from "@/components/network/DeviceDetailPanel";
import { GroupManagerDialog } from "@/components/network/GroupManagerDialog";
import { SchedulesTab } from "@/components/network/SchedulesTab";
import { CoverageExtendersPanel } from "@/components/network/CoverageExtendersPanel";
import { PhoneHomeCard } from "@/components/network/PhoneHomeCard";
import { CameraPrivacyCard } from "@/components/network/CameraPrivacyCard";
import { GuestWifiCard } from "@/components/network/GuestWifiCard";
import { MaintenanceCards } from "@/components/network/MaintenanceCards";
import { UpnpCard } from "@/components/network/UpnpCard";
import { NetworkSimple } from "@/components/network/NetworkSimple";
import { SwitchPanel } from "@/components/network/switch/SwitchPanel";
import { WifiScanPanel } from "@/components/network/WifiScanPanel";
import { WifiSettingsForm } from "@/components/network/WifiSettingsForm";
import {
  fetchNetworkOperation,
  rebootRouter,
  type NetworkOperation,
} from "@/lib/api";
import type {
  EnrichedNetworkDevice,
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

type Tab = "overview" | "privacy" | "devices" | "schedules" | "wifi" | "firewall" | "system";

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

export default function NetworkPage() {
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
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [opStatus, setOpStatus] = useState<OperationStatus>({ state: "idle" });
  // WARP-871 follow-up: while an owner-initiated reboot is in flight the router
  // is expected to drop for ~30-90s, which makes the status SWR poll fail. Lift
  // the reboot-in-progress signal here (set by RouterRebootCard) so the
  // (error || !routerConnected) early return defers to the calm "restarting"
  // state during that window instead of flashing the alarming full-page error.
  const [rebooting, setRebooting] = useState(false);

  // WARP-612: Simple ⟷ Advanced mode (Droplet Design System). Home installs
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
          <WifiOff size={32} className="mx-auto text-label-quaternary mb-3" />
          <h2 className="type-title-3 text-label-primary mb-1">{copy.title}</h2>
          <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
            {copy.body}
          </p>
          {routerErrorMessage && !isDisabled && (
            <p className="type-caption-2 text-label-quaternary mt-3 font-mono">
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
        <div
          className="inline-flex rounded-md bg-surface-secondary p-0.5"
          role="group"
          aria-label="Network view mode"
        >
          {([["simple", "Simple", Home], ["advanced", "Advanced", SlidersHorizontal]] as const).map(
            ([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => switchMode(id)}
                aria-pressed={mode === id}
                className={[
                  "inline-flex items-center gap-1.5 px-3 h-8 rounded type-subheadline transition-colors",
                  mode === id
                    ? "bg-surface-primary text-label-primary shadow-sm"
                    : "text-label-tertiary hover:text-label-secondary",
                ].join(" ")}
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
          <Loader2 size={18} className="animate-spin text-system-blue" />
          <div className="flex-1">
            <p className="type-subheadline text-label-primary font-medium">Applying change…</p>
            <p className="type-footnote text-label-tertiary">
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
          <p className="type-subheadline text-label-primary flex-1">Change applied.</p>
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
          <Info size={18} className="text-label-tertiary" />
          <div className="flex-1">
            <p className="type-subheadline text-label-primary font-medium">
              No change made
            </p>
            <p className="type-footnote text-label-tertiary">
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
            <p className="type-subheadline text-label-primary font-medium">
              Change rolled back
            </p>
            <p className="type-footnote text-label-tertiary">
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
                  setActiveTab(tabs[next].id);
                  document
                    .getElementById(`network-tab-${tabs[next].id}`)
                    ?.focus();
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
        {activeTab === "firewall" && <FirewallTab firewall={firewall} />}
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
  const uptime = system?.resources?.uptime ?? 0;
  const uptimeHours = Math.floor(uptime / 3600);
  const uptimeDays = Math.floor(uptimeHours / 24);

  const memTotal = system?.resources?.memory?.total ?? 0;
  const memFree = system?.resources?.memory?.free ?? 0;
  const memUsedPct = memTotal > 0 ? Math.round(((memTotal - memFree) / memTotal) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatusCard
          icon={Globe}
          title="WAN"
          value={wanIp}
          subtitle={`Protocol: ${wanProto}`}
          status={wan?.up ? "ok" : "error"}
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
        <span className="type-footnote text-label-tertiary font-medium uppercase tracking-wider">
          {title}
        </span>
      </div>
      <p className="type-title-3 text-label-primary">{value}</p>
      <p className="type-caption-1 text-label-tertiary mt-0.5">{subtitle}</p>
    </div>
  );
}

// --- Devices Tab (WARP-83: sectioned 3-col card grid) ---
type DeviceSort = "name" | "lastSeen" | "vendor";

function DevicesTab() {
  const [search, setSearch] = useState("");
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [sort, setSort] = useState<DeviceSort>("name");
  // WARP-84: render a detail panel off this state.
  const [openMac, setOpenMac] = useState<string | null>(null);
  // WARP-86 follow-up: unified error UX for card-level block/unblock failures.
  // The detail panel surfaces its own toast inline; here the card is hover-only
  // so a `title` tooltip would vanish the moment the row hides. A floating
  // toast pinned to the viewport survives the hover-out.
  const [toast, setToast] = useState<string | null>(null);
  // WARP-85: group manager dialog visibility.
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);

  const devicesSwr = useNetworkDevices({ onlineOnly });
  const groupsSwr = useNetworkGroups();

  const devices = devicesSwr.data?.devices ?? [];
  const groups = groupsSwr.data?.groups ?? [];

  // Search filter (case-insensitive contains on displayName, hostname, vendor, IP).
  const filtered = devices.filter((d) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [d.displayName, d.hostname, d.vendor, d.lastIp].some((v) =>
      (v ?? "").toLowerCase().includes(q),
    );
  });

  function sortFn(a: EnrichedNetworkDevice, b: EnrichedNetworkDevice) {
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (sort === "name") {
      return (a.displayName ?? a.hostname ?? "").localeCompare(b.displayName ?? b.hostname ?? "");
    }
    if (sort === "lastSeen") {
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    }
    if (sort === "vendor") {
      return (a.vendor ?? "").localeCompare(b.vendor ?? "");
    }
    return 0;
  }
  const sorted = filtered.slice().sort(sortFn);

  // Bucket by group; a device may belong to multiple groups and appear in each.
  const byGroup = new Map<string, EnrichedNetworkDevice[]>();
  for (const d of sorted) {
    if (d.groups.length === 0) {
      byGroup.set("__ungrouped", [...(byGroup.get("__ungrouped") ?? []), d]);
    } else {
      for (const g of d.groups) {
        byGroup.set(g.id, [...(byGroup.get(g.id) ?? []), d]);
      }
    }
  }

  const groupsWithMembers = groups
    .filter((g) => (byGroup.get(g.id) ?? []).length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const ungrouped = byGroup.get("__ungrouped") ?? [];

  const isLoading = !devicesSwr.data && devicesSwr.isLoading;

  return (
    <div>
      {/* WARP-446: coverage extenders panel — auto-discovered + approved
          AP listing. Renders above the devices grid so the operator sees
          AWAITING_APPROVAL action-items before scanning the device list. */}
      <div className="mb-6">
        <CoverageExtendersPanel />
      </div>

      {/* Header controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search devices…"
          aria-label="Search devices"
          className="dp-input flex-1 min-w-[200px]"
        />
        <label className="flex items-center gap-2 type-subheadline text-label-secondary">
          <input
            type="checkbox"
            checked={onlineOnly}
            onChange={(e) => setOnlineOnly(e.target.checked)}
            className="accent-accent"
          />
          Online only
        </label>
        <label className="flex items-center gap-2 type-subheadline text-label-secondary">
          Sort by
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as DeviceSort)}
            aria-label="Sort devices"
            className="dp-input"
          >
            <option value="name">Name</option>
            <option value="lastSeen">Last seen</option>
            <option value="vendor">Vendor</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => setGroupManagerOpen(true)}
          className="dp-btn-secondary text-sm"
        >
          Manage groups
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-label-tertiary">
          <Loader2 size={20} className="animate-spin mr-2" />
          <span className="type-subheadline">Loading devices…</span>
        </div>
      )}

      {!isLoading && devices.length === 0 && (
        <div className="card text-center" style={{ padding: "48px 20px" }}>
          <Monitor size={32} className="mx-auto text-label-quaternary mb-3" />
          <h3 className="type-title-3 text-label-primary mb-1">
            Your router hasn&apos;t seen any devices yet
          </h3>
          <p className="type-subheadline text-label-tertiary mb-4">
            Devices will appear as soon as the router reports them.
          </p>
          <button
            type="button"
            onClick={() => devicesSwr.mutate()}
            className="btn ghost sm"
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && devices.length > 0 && (
        <>
          {groupsWithMembers.map((g) => (
            <DeviceGridSection
              key={g.id}
              group={g}
              devices={byGroup.get(g.id) ?? []}
              onOpen={(d) => setOpenMac(d.mac)}
              onError={setToast}
            />
          ))}
          {ungrouped.length > 0 && (
            <DeviceGridSection
              group={{ id: "__ungrouped", name: "Ungrouped" }}
              devices={ungrouped}
              onOpen={(d) => setOpenMac(d.mac)}
              onError={setToast}
            />
          )}
        </>
      )}

      {openMac && (
        <DeviceDetailPanel mac={openMac} onClose={() => setOpenMac(null)} />
      )}

      {toast && (
        <div
          role="alert"
          className="fixed bottom-4 right-4 bg-system-red text-white px-3 py-2 rounded shadow flex items-center gap-2 z-50"
        >
          <span className="type-subheadline">{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss toast"
            className="ml-1 opacity-80 hover:opacity-100"
          >
            ×
          </button>
        </div>
      )}

      <GroupManagerDialog
        open={groupManagerOpen}
        onClose={() => setGroupManagerOpen(false)}
      />
    </div>
  );
}

// --- WiFi Tab ---
function WifiTab() {
  return (
    <div className="space-y-4">
      {/* Issue #12: editable provisioning form so a user who skipped Wi-Fi
          during onboarding can set the SSID/password here — same write path as
          the setup wizard's InternetStep. */}
      <WifiSettingsForm />

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
          ? "text-label-quaternary bg-surface-secondary/60"
          : accepting
            ? "text-system-green bg-system-green/10"
            : "text-system-red bg-system-red/10"
      }`}
    >
      {value}
    </span>
  );
}

function FirewallTab({ firewall }: { firewall: FirewallConfig | undefined }) {
  // WARP-42: typed Object.entries — each entry is [sectionId, typed section]
  // instead of [string, any], so a missing `target` or a `proto` type change
  // on the routing side now fails compile.
  const zones: Array<[string, FirewallZone]> = firewall?.zones?.values
    ? Object.entries(firewall.zones.values)
    : [];
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
        <h3 className="type-headline text-label-primary mb-1">
          Zones ({zones.length})
        </h3>
        <p className="type-caption-1 text-label-tertiary mb-4">
          Default input · output · forward policy per network zone. Managed by
          the box.
        </p>
        {zones.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full type-caption-1">
              <thead>
                <tr className="text-label-tertiary text-left">
                  <th className="font-medium pb-2 pr-4">Zone</th>
                  <th className="font-medium pb-2 pr-4">Input</th>
                  <th className="font-medium pb-2 pr-4">Output</th>
                  <th className="font-medium pb-2 pr-4">Forward</th>
                  <th className="font-medium pb-2">Networks</th>
                </tr>
              </thead>
              <tbody>
                {zones.map(([key, zone]) => {
                  const nets = Array.isArray(zone.network)
                    ? zone.network.join(", ")
                    : zone.network;
                  return (
                    <tr key={key} className="border-t border-separator/60">
                      <td className="py-2 pr-4">
                        <span className="type-subheadline text-label-primary font-medium">
                          {zone.name ?? key}
                        </span>
                        {zone.masq === "1" && (
                          <span className="ml-2 type-caption-2 text-label-quaternary font-mono">
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
                      <td className="py-2 text-label-tertiary font-mono">
                        {nets || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="type-subheadline text-label-tertiary">
            No firewall zones reported.
          </p>
        )}
      </div>

      <div className="card">
        <h3 className="type-headline text-label-primary mb-4">
          Firewall Rules ({rules.length})
        </h3>
        {rules.length > 0 ? (
          <div className="space-y-2">
            {rules.map(([key, rule]) => (
              <div
                key={key}
                className="flex items-center justify-between px-3 py-2 rounded-sm bg-surface-secondary/50"
              >
                <div>
                  <p className="type-subheadline text-label-primary">
                    {rule.name ?? key}
                  </p>
                  <p className="type-caption-2 text-label-tertiary">
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
          <p className="type-subheadline text-label-tertiary">No custom firewall rules.</p>
        )}
      </div>

      <div className="card">
        <h3 className="type-headline text-label-primary mb-4">
          Port Forwards ({redirects.length})
        </h3>
        {redirects.length > 0 ? (
          <div className="space-y-2">
            {redirects.map(([key, fwd]) => (
              <div
                key={key}
                className="flex items-center justify-between px-3 py-2 rounded-sm bg-surface-secondary/50"
              >
                <div>
                  <p className="type-subheadline text-label-primary">
                    {fwd.name ?? key}
                  </p>
                  <p className="type-caption-2 text-label-tertiary">
                    :{fwd.src_dport ?? "—"} ({Array.isArray(fwd.proto) ? fwd.proto.join("/") : fwd.proto ?? "tcp"}) &rarr;{" "}
                    {fwd.dest_ip ?? "—"}:{fwd.dest_port ?? "—"}
                  </p>
                </div>
                <span className={`type-caption-1 ${fwd.enabled === "1" ? "text-system-green" : "text-label-quaternary"}`}>
                  {fwd.enabled === "1" ? "Active" : "Disabled"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="type-subheadline text-label-tertiary">No port forwards configured.</p>
        )}
      </div>

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

  return (
    <div className="space-y-4">
      <div className="card">
        <h3 className="type-headline text-label-primary mb-4">Hardware</h3>
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
        <h3 className="type-headline text-label-primary mb-4">Resources</h3>
        <div className="grid grid-cols-2 gap-y-3 gap-x-6">
          <InfoRow label="Uptime" value={`${days}d ${hours}h ${minutes}m`} />
          <InfoRow label="Load Average" value={`${load1} / ${load5} / ${load15}`} />
          <InfoRow label="Memory Total" value={`${memTotalMB} MB`} />
          <InfoRow label="Memory Free" value={`${memFreeMB} MB`} />
        </div>
      </div>

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
      <h3 className="type-headline text-label-primary mb-1">Restart router</h3>
      <p className="type-subheadline text-label-tertiary mb-4">
        Restarting the router drops every connected device for about a minute
        while it reboots. Wi-Fi and internet come back automatically.
      </p>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={status.kind === "rebooting"}
        className="dp-btn-secondary flex items-center gap-2 text-system-red"
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
          className="mt-4 flex items-start gap-2 type-footnote text-label-primary bg-system-orange/10 rounded-sm px-3 py-2"
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
      <p className="type-caption-1 text-label-tertiary">{label}</p>
      <p className="type-subheadline text-label-primary">{value}</p>
    </div>
  );
}
