"use client";

import { useState } from "react";
import { Shield, ShieldCheck, ShieldOff, Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth";

interface SubnetConfig {
  enabled: boolean;
  subnet?: string;
  netmask?: string;
  firewall_zone?: Record<string, unknown>;
  dhcp_pool?: Record<string, unknown>;
  error?: string;
}

interface CameraSubnetCardProps {
  config: SubnetConfig | null;
  onRefresh: () => void;
}

export function CameraSubnetCard({ config, onRefresh }: CameraSubnetCardProps) {
  const [loading, setLoading] = useState(false);

  const isEnabled = config?.enabled ?? false;

  async function handleSetup() {
    setLoading(true);
    try {
      const res = await authFetch("/api/cameras/subnet/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Failed to set up camera subnet");
      }
      onRefresh();
    } catch {
      alert("Failed to connect to routing service");
    } finally {
      setLoading(false);
    }
  }

  async function handleTeardown() {
    if (!confirm("Remove camera subnet isolation? Cameras will move to the main LAN.")) {
      return;
    }
    setLoading(true);
    try {
      const res = await authFetch("/api/cameras/subnet", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Failed to remove camera subnet");
      }
      onRefresh();
    } catch {
      alert("Failed to connect to routing service");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="dp-card mb-6">
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isEnabled ? (
              <div className="w-10 h-10 rounded-full bg-system-green/10 flex items-center justify-center">
                <ShieldCheck size={20} className="text-system-green" />
              </div>
            ) : (
              <div className="w-10 h-10 rounded-full bg-system-orange/10 flex items-center justify-center">
                <Shield size={20} className="text-system-orange" />
              </div>
            )}
            <div>
              <h3 className="type-subheadline text-label-primary font-medium">
                Network Isolation
              </h3>
              <p className="type-caption-1 text-label-tertiary">
                {isEnabled
                  ? `Cameras isolated on ${config?.subnet || "192.168.100.0"}/${config?.netmask === "255.255.255.0" ? "24" : config?.netmask} (VLAN 100)`
                  : "Cameras on main LAN — not isolated"}
              </p>
            </div>
          </div>

          <div>
            {loading ? (
              <div className="dp-btn-secondary px-3 py-2 rounded-lg">
                <Loader2 size={16} className="animate-spin" />
              </div>
            ) : isEnabled ? (
              <button
                onClick={handleTeardown}
                className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg text-system-red hover:bg-system-red/10"
              >
                <ShieldOff size={16} />
                <span className="type-subheadline">Disable</span>
              </button>
            ) : (
              <button
                onClick={handleSetup}
                className="dp-btn-primary flex items-center gap-2 px-3 py-2 rounded-lg"
              >
                <ShieldCheck size={16} />
                <span className="type-subheadline">Enable Isolation</span>
              </button>
            )}
          </div>
        </div>

        {isEnabled && (
          <div className="mt-3 pt-3 border-t border-separator grid grid-cols-3 gap-3">
            <div>
              <p className="type-caption-2 text-label-quaternary">Subnet</p>
              <p className="type-footnote text-label-primary">{config?.subnet}/24</p>
            </div>
            <div>
              <p className="type-caption-2 text-label-quaternary">Firewall</p>
              <p className="type-footnote text-system-green">Isolated</p>
            </div>
            <div>
              <p className="type-caption-2 text-label-quaternary">DHCP</p>
              <p className="type-footnote text-label-primary">
                {config?.dhcp_pool ? "Active" : "Configured"}
              </p>
            </div>
          </div>
        )}

        {!isEnabled && (
          <p className="mt-3 pt-3 border-t border-separator type-caption-1 text-label-quaternary">
            Enable isolation to put cameras on a separate VLAN (192.168.100.0/24).
            Users on the main network won&apos;t be able to access camera feeds directly —
            only through the Droplet dashboard.
          </p>
        )}
      </div>
    </div>
  );
}
