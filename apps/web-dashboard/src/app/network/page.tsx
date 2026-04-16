"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Globe,
  Loader2,
  Monitor,
  RefreshCw,
  Router,
  Shield,
  Signal,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import { useNetwork } from "@/lib/hooks/useNetwork";
import {
  blockNetworkDevice,
  unblockNetworkDevice,
  setWifiSsid,
  setWifiChannel,
  scanWifiNetworks,
  confirmNetworkCommand,
  fetchNetworkOperation,
  type NetworkOperation,
} from "@/lib/api";
import type { ConnectedDevice, FirewallConfig, NetworkCommandResult, NetworkOverview, WirelessScanResult } from "@/lib/types";

// WARP-40: poll /network/operations/:id every second until terminal.
type OperationStatus =
  | { state: "idle" }
  | { state: "pending"; id: string }
  | { state: "applied"; id: string; finishedAt: number | null }
  | { state: "rolled_back"; id: string; reason: string | null };

type Tab = "overview" | "devices" | "wifi" | "firewall" | "system";

export default function NetworkPage() {
  const { overview, devices, firewall, isLoading, isRefreshing, error, routerConnected, refresh } =
    useNetwork();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [pendingConfirm, setPendingConfirm] = useState<NetworkCommandResult | null>(null);
  const [opStatus, setOpStatus] = useState<OperationStatus>({ state: "idle" });

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
        } else if (op.state === "rolled_back") {
          setOpStatus({ state: "rolled_back", id: op.id, reason: op.reason });
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
      <div className="p-6 space-y-6">
        <div className="space-y-2">
          <div className="h-8 w-48 bg-surface-secondary rounded animate-pulse" />
          <div className="h-4 w-32 bg-surface-secondary rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="dp-card h-28 animate-pulse bg-surface-secondary" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !routerConnected) {
    return (
      <div className="p-6">
        <div className="dp-card text-center py-12">
          <WifiOff size={32} className="mx-auto text-label-quaternary mb-3" />
          <h2 className="type-title-3 text-label-primary mb-1">
            Router Not Connected
          </h2>
          <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
            The OpenWrt routing service is unreachable. Make sure the routing
            service is running and the router is accessible at the configured IP.
          </p>
        </div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; icon: typeof Globe }[] = [
    { id: "overview", label: "Overview", icon: Globe },
    { id: "devices", label: "Devices", icon: Monitor },
    { id: "wifi", label: "WiFi", icon: Wifi },
    { id: "firewall", label: "Firewall", icon: Shield },
    { id: "system", label: "System", icon: Router },
  ];

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="type-large-title text-label-primary">Network</h1>
          <p className="type-subheadline text-label-tertiary mt-1">
            {overview?.connectedDeviceCount ?? 0} device{(overview?.connectedDeviceCount ?? 0) !== 1 ? "s" : ""} on network
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={isRefreshing}
          className="dp-button-secondary flex items-center gap-2"
        >
          <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Confirmation Banner */}
      {pendingConfirm?.requiresConfirmation && (
        <div className="dp-card mb-4 border-system-orange bg-system-orange/5 flex items-center justify-between">
          <div>
            <p className="type-subheadline text-label-primary font-medium">
              Confirmation Required
            </p>
            <p className="type-footnote text-label-tertiary">
              {pendingConfirm.reason}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPendingConfirm(null)}
              className="dp-button-secondary text-sm"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                if (pendingConfirm.confirmationToken && pendingConfirm.operation) {
                  const { operationId } = await confirmNetworkCommand(
                    pendingConfirm.confirmationToken,
                    pendingConfirm.operation,
                  );
                  setPendingConfirm(null);
                  // WARP-40: start polling the apply/rollback status.
                  if (operationId) {
                    setOpStatus({ state: "pending", id: operationId });
                  } else {
                    refresh();
                  }
                }
              }}
              className="dp-button-primary text-sm"
            >
              Confirm
            </button>
          </div>
        </div>
      )}

      {/* WARP-40: Operation-status banner — visible while a write is in flight
          or just after it completed. Auto-dismissed when the user clicks × or
          starts a new operation. */}
      {opStatus.state === "pending" && (
        <div
          role="status"
          className="dp-card mb-4 border-system-blue bg-system-blue/5 flex items-center gap-3"
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
          className="dp-card mb-4 border-system-green bg-system-green/5 flex items-center gap-3"
        >
          <CheckCircle2 size={18} className="text-system-green" />
          <p className="type-subheadline text-label-primary flex-1">Change applied.</p>
          <button
            onClick={() => setOpStatus({ state: "idle" })}
            className="dp-button-secondary text-sm"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}
      {opStatus.state === "rolled_back" && (
        <div
          role="alert"
          className="dp-card mb-4 border-system-red bg-system-red/5 flex items-center gap-3"
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
            className="dp-button-secondary text-sm"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-separator">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                flex items-center gap-2 px-4 py-2.5 type-subheadline transition-colors
                border-b-2 -mb-px
                ${active
                  ? "border-accent text-accent font-medium"
                  : "border-transparent text-label-tertiary hover:text-label-secondary"
                }
              `}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      {activeTab === "overview" && <OverviewTab overview={overview} />}
      {activeTab === "devices" && (
        <DevicesTab
          devices={devices}
          onBlock={async (mac, name) => {
            const result = await blockNetworkDevice(mac, name);
            if (result.requiresConfirmation) {
              setPendingConfirm(result);
            } else {
              refresh();
            }
          }}
          onUnblock={async (mac) => {
            const result = await unblockNetworkDevice(mac);
            if (result.requiresConfirmation) {
              setPendingConfirm(result);
            } else {
              refresh();
            }
          }}
        />
      )}
      {activeTab === "wifi" && <WifiTab />}
      {activeTab === "firewall" && <FirewallTab firewall={firewall} />}
      {activeTab === "system" && <SystemTab overview={overview} />}
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
    <div className="dp-card">
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

// --- Devices Tab ---
function DevicesTab({
  devices,
  onBlock,
  onUnblock,
}: {
  devices: ConnectedDevice[];
  onBlock: (mac: string, name?: string) => Promise<void>;
  onUnblock: (mac: string) => Promise<void>;
}) {
  if (devices.length === 0) {
    return (
      <div className="dp-card text-center py-12">
        <Monitor size={32} className="mx-auto text-label-quaternary mb-3" />
        <h3 className="type-title-3 text-label-primary mb-1">No Devices Found</h3>
        <p className="type-subheadline text-label-tertiary">
          No devices are currently connected to the network.
        </p>
      </div>
    );
  }

  return (
    <div className="dp-card overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-separator">
            <th className="text-left type-footnote text-label-tertiary font-medium px-4 py-3">Hostname</th>
            <th className="text-left type-footnote text-label-tertiary font-medium px-4 py-3">IP Address</th>
            <th className="text-left type-footnote text-label-tertiary font-medium px-4 py-3">MAC Address</th>
            <th className="text-left type-footnote text-label-tertiary font-medium px-4 py-3">Type</th>
            <th className="text-left type-footnote text-label-tertiary font-medium px-4 py-3">Signal</th>
            <th className="text-right type-footnote text-label-tertiary font-medium px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.macaddr} className="border-b border-separator last:border-0 hover:bg-surface-secondary/50">
              <td className="px-4 py-3 type-subheadline text-label-primary">
                {device.hostname || "Unknown"}
              </td>
              <td className="px-4 py-3 type-subheadline text-label-secondary font-mono text-sm">
                {device.ipaddr}
              </td>
              <td className="px-4 py-3 type-caption-1 text-label-tertiary font-mono">
                {device.macaddr}
              </td>
              <td className="px-4 py-3">
                {device.isWireless ? (
                  <span className="inline-flex items-center gap-1 type-caption-1 text-accent">
                    <Wifi size={12} /> WiFi
                  </span>
                ) : (
                  <span className="type-caption-1 text-label-tertiary">Wired</span>
                )}
              </td>
              <td className="px-4 py-3 type-caption-1 text-label-tertiary">
                {device.signal ? `${device.signal} dBm` : "-"}
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  onClick={() => onBlock(device.macaddr, device.hostname)}
                  className="type-caption-1 text-system-red hover:underline"
                >
                  Block
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- WiFi Tab ---
function WifiTab() {
  const [scanResults, setScanResults] = useState<WirelessScanResult[] | null>(null);
  const [scanning, setScanning] = useState(false);

  async function handleScan() {
    setScanning(true);
    try {
      const results = await scanWifiNetworks();
      setScanResults(results);
    } catch {
      // ignore
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="dp-card">
        <h3 className="type-headline text-label-primary mb-4">WiFi Settings</h3>
        <p className="type-subheadline text-label-tertiary">
          WiFi configuration is available through the SSID, password, and channel
          controls. Use the API or AI chat to modify settings.
        </p>
      </div>

      <div className="dp-card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="type-headline text-label-primary">Nearby Networks</h3>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="dp-button-secondary flex items-center gap-2 text-sm"
          >
            <Signal size={14} className={scanning ? "animate-pulse" : ""} />
            {scanning ? "Scanning..." : "Scan"}
          </button>
        </div>

        {scanResults && scanResults.length > 0 ? (
          <div className="space-y-2">
            {scanResults.map((network, i) => (
              <div
                key={`${network.bssid}-${i}`}
                className="flex items-center justify-between px-3 py-2 rounded-sm bg-surface-secondary/50"
              >
                <div className="flex items-center gap-3">
                  <Wifi
                    size={16}
                    className={
                      network.signal > -50
                        ? "text-system-green"
                        : network.signal > -70
                        ? "text-system-orange"
                        : "text-system-red"
                    }
                  />
                  <div>
                    <p className="type-subheadline text-label-primary">
                      {network.ssid || "(Hidden)"}
                    </p>
                    <p className="type-caption-2 text-label-tertiary">
                      Ch {network.channel} | {network.encryption.enabled ? "Encrypted" : "Open"}
                    </p>
                  </div>
                </div>
                <span className="type-caption-1 text-label-tertiary">
                  {network.signal} dBm
                </span>
              </div>
            ))}
          </div>
        ) : scanResults ? (
          <p className="type-subheadline text-label-tertiary">No networks found.</p>
        ) : (
          <p className="type-subheadline text-label-tertiary">
            Click Scan to search for nearby WiFi networks.
          </p>
        )}
      </div>
    </div>
  );
}

// --- Firewall Tab ---
function FirewallTab({ firewall }: { firewall: FirewallConfig | undefined }) {
  const rules = firewall?.rules?.values ? Object.entries(firewall.rules.values) : [];
  const redirects = firewall?.redirects?.values ? Object.entries(firewall.redirects.values) : [];

  return (
    <div className="space-y-4">
      <div className="dp-card">
        <h3 className="type-headline text-label-primary mb-4">
          Firewall Rules ({rules.length})
        </h3>
        {rules.length > 0 ? (
          <div className="space-y-2">
            {rules.map(([key, rule]: [string, any]) => (
              <div
                key={key}
                className="flex items-center justify-between px-3 py-2 rounded-sm bg-surface-secondary/50"
              >
                <div>
                  <p className="type-subheadline text-label-primary">
                    {rule.name || key}
                  </p>
                  <p className="type-caption-2 text-label-tertiary">
                    {rule.src} &rarr; {rule.dest || "*"} | Target: {rule.target}
                    {rule.src_mac ? ` | MAC: ${rule.src_mac}` : ""}
                  </p>
                </div>
                <span
                  className={`type-caption-1 ${
                    rule.target === "ACCEPT" ? "text-system-green" : "text-system-red"
                  }`}
                >
                  {rule.target}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="type-subheadline text-label-tertiary">No custom firewall rules.</p>
        )}
      </div>

      <div className="dp-card">
        <h3 className="type-headline text-label-primary mb-4">
          Port Forwards ({redirects.length})
        </h3>
        {redirects.length > 0 ? (
          <div className="space-y-2">
            {redirects.map(([key, fwd]: [string, any]) => (
              <div
                key={key}
                className="flex items-center justify-between px-3 py-2 rounded-sm bg-surface-secondary/50"
              >
                <div>
                  <p className="type-subheadline text-label-primary">
                    {fwd.name || key}
                  </p>
                  <p className="type-caption-2 text-label-tertiary">
                    :{fwd.src_dport} ({fwd.proto}) &rarr; {fwd.dest_ip}:{fwd.dest_port}
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
    </div>
  );
}

// --- System Tab ---
function SystemTab({ overview }: { overview: NetworkOverview | undefined }) {
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
      <div className="dp-card">
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

      <div className="dp-card">
        <h3 className="type-headline text-label-primary mb-4">Resources</h3>
        <div className="grid grid-cols-2 gap-y-3 gap-x-6">
          <InfoRow label="Uptime" value={`${days}d ${hours}h ${minutes}m`} />
          <InfoRow label="Load Average" value={`${load1} / ${load5} / ${load15}`} />
          <InfoRow label="Memory Total" value={`${memTotalMB} MB`} />
          <InfoRow label="Memory Free" value={`${memFreeMB} MB`} />
        </div>
      </div>
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
