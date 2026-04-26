"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Laptop,
  Plus,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react";
import {
  fetchDeviceClients,
  revokeDeviceClient,
} from "@/lib/api";
import type { DeviceClientInfo } from "@/lib/types";

const PLATFORM_ICON = {
  android: Smartphone,
  ios: Smartphone,
  macos: Laptop,
  windows: Laptop,
  linux: Laptop,
  other: Laptop,
} as const;

function fmtRel(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const ms = Date.now() - t;
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/**
 * Paired clients page (Phase 7.1) — lists every mobile / desktop
 * device that's claimed a pairing code, with a revoke button per
 * row. Revoking flips DeviceClient.status to 'revoked' on the
 * server; the device's session token stops working on the next
 * orchestrator request.
 */
export default function DeviceClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<DeviceClientInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchDeviceClients();
      setClients(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load clients");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleRevoke = async (client: DeviceClientInfo) => {
    if (!confirm(`Revoke "${client.deviceName}"? It will need to pair again.`)) return;
    setRevoking(client.id);
    try {
      await revokeDeviceClient(client.id);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Revoke failed");
    } finally {
      setRevoking(null);
    }
  };

  const active = (clients ?? []).filter((c) => c.status === "active");
  const revoked = (clients ?? []).filter((c) => c.status !== "active");

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => router.push("/devices")}
          className="p-2 -ml-2 rounded-full hover:bg-surface-secondary"
          aria-label="Back to devices"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="type-large-title text-label-primary">
            Paired devices
          </h1>
          <p className="type-subheadline text-label-tertiary mt-0.5">
            Mobile + desktop apps that have an active session with this Droplet.
          </p>
        </div>
        <button
          onClick={() => router.push("/devices/pair")}
          className="dp-btn-primary flex items-center gap-2 px-3 py-2 rounded-lg"
        >
          <Plus size={16} />
          <span className="type-subheadline">Pair</span>
        </button>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <div className="dp-card p-4 mb-3 text-system-red">
          <p className="type-subheadline">{error}</p>
        </div>
      )}

      {loading && !clients ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="dp-card h-16 animate-pulse bg-surface-secondary"
            />
          ))}
        </div>
      ) : active.length === 0 && revoked.length === 0 ? (
        <div className="dp-card text-center py-12">
          <Smartphone size={32} className="mx-auto text-label-quaternary mb-3" />
          <h2 className="type-title-3 text-label-primary mb-1">
            No paired devices yet
          </h2>
          <p className="type-subheadline text-label-tertiary max-w-md mx-auto mb-4">
            Pair the Droplet app on your phone or laptop to get push
            notifications, offline-capable file access, and quick chat
            shortcuts.
          </p>
          <button
            onClick={() => router.push("/devices/pair")}
            className="dp-btn-primary inline-flex items-center gap-2 px-4 py-2 rounded-lg"
          >
            <Plus size={14} />
            Pair a device
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {active.length > 0 && (
            <ClientList
              title="Active"
              clients={active}
              revoking={revoking}
              onRevoke={handleRevoke}
            />
          )}
          {revoked.length > 0 && (
            <ClientList
              title="Revoked"
              clients={revoked}
              revoking={revoking}
              onRevoke={handleRevoke}
              dim
            />
          )}
        </div>
      )}
    </div>
  );
}

function ClientList({
  title,
  clients,
  revoking,
  onRevoke,
  dim,
}: {
  title: string;
  clients: DeviceClientInfo[];
  revoking: string | null;
  onRevoke: (c: DeviceClientInfo) => void;
  dim?: boolean;
}) {
  return (
    <div>
      <h2 className="type-caption-2 text-label-tertiary uppercase tracking-wide mb-2">
        {title} · {clients.length}
      </h2>
      <ul className="dp-card divide-y divide-separator">
        {clients.map((c) => {
          const Icon =
            PLATFORM_ICON[c.platform as keyof typeof PLATFORM_ICON] ?? Laptop;
          return (
            <li
              key={c.id}
              className={`flex items-center gap-3 p-3 ${dim ? "opacity-60" : ""}`}
            >
              <div className="w-9 h-9 rounded-full bg-surface-secondary flex items-center justify-center flex-shrink-0">
                <Icon size={16} className="text-label-secondary" />
              </div>
              <div className="flex-1 min-w-0">
                <span className="type-subheadline text-label-primary truncate block">
                  {c.deviceName}
                </span>
                <span className="type-caption-2 text-label-tertiary">
                  {c.platform} · last seen {fmtRel(c.lastSeen)}
                  {c.appVersion ? ` · v${c.appVersion}` : ""}
                </span>
              </div>
              {c.status === "active" && (
                <button
                  onClick={() => onRevoke(c)}
                  disabled={revoking === c.id}
                  className="p-2 rounded-lg text-label-tertiary hover:text-system-red hover:bg-system-red/10 disabled:opacity-50"
                  title="Revoke this device"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
