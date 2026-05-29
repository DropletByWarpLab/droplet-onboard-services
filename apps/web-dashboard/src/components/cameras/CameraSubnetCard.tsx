"use client";

import { useState } from "react";
import { Shield, ShieldCheck, ShieldOff, Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

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
  const [teardownOpen, setTeardownOpen] = useState(false);
  const { toast } = useToast();

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
        toast(data.error || "Couldn't set up the camera subnet. Try again in a moment.", "error");
      }
      onRefresh();
    } catch {
      toast("Couldn't reach the routing service. Try again in a moment.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function performTeardown() {
    setLoading(true);
    try {
      const res = await authFetch("/api/cameras/subnet", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.error || "Couldn't remove the camera subnet. Try again in a moment.", "error");
        throw new Error(data.error || "Teardown failed");
      }
      setTeardownOpen(false);
      onRefresh();
    } catch (e) {
      // If we already toasted above, this throw just keeps the dialog open
      // so the user can retry. The catch is otherwise a network-error path.
      if (e instanceof Error && e.message !== "Teardown failed") {
        toast("Couldn't reach the routing service. Try again in a moment.", "error");
      }
      throw e;
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
                onClick={() => setTeardownOpen(true)}
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

      <ConfirmDialog
        open={teardownOpen}
        onConfirm={performTeardown}
        onCancel={() => setTeardownOpen(false)}
        title="Remove camera subnet isolation?"
        description="Cameras will move back to the main LAN. Anyone on your network will be able to reach the camera feeds directly until you re-enable isolation."
        confirmLabel="Disable isolation"
        variant="destructive"
      />
    </div>
  );
}
