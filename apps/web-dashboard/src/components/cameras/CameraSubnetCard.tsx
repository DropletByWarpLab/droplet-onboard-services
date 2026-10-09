"use client";

import { useState } from "react";
import { Shield, ShieldCheck, ShieldOff, Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { confirmCameraCommand } from "@/lib/api";

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

/** Shape of the Tier-2 handshake the orchestrator answers with on a 202. */
interface ConfirmationRequired {
  confirmationToken?: string;
}

// confirmCameraCommand surfaces the server's `reason` as the Error message
// (no code), so expiry / replay / operation mismatch is matched on its text.
const TOKEN_REJECTED = /expired|invalid|mismatch/i;

export function CameraSubnetCard({ config, onRefresh }: CameraSubnetCardProps) {
  const [loading, setLoading] = useState(false);
  const [teardownOpen, setTeardownOpen] = useState(false);
  // Token minted by the setup route (60 s lifetime) while the user decides.
  const [pendingSetupToken, setPendingSetupToken] = useState<string | null>(null);
  const { toast } = useToast();

  const isEnabled = config?.enabled ?? false;
  // The routing service was unreachable when the config was read: we don't
  // know the real state, so don't present "not isolated" or offer a change.
  const routerError = !isEnabled && Boolean(config?.error);

  async function handleSetup() {
    setLoading(true);
    try {
      const res = await authFetch("/api/cameras/subnet/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok && res.status !== 202) {
        const data = await res.json().catch(() => ({}));
        toast(data.error || "Couldn't set up the camera subnet. Try again in a moment.", "error");
        onRefresh();
        return;
      }
      if (res.status === 202) {
        // Tier 2: nothing has happened yet. Hold the token and ask the user.
        const data = (await res.json().catch(() => ({}))) as ConfirmationRequired;
        if (!data.confirmationToken) {
          toast("Couldn't set up the camera subnet. Try again in a moment.", "error");
          return;
        }
        setPendingSetupToken(data.confirmationToken);
        return;
      }
      onRefresh();
    } catch {
      toast("Couldn't reach the routing service. Try again in a moment.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function performSetupConfirm() {
    const token = pendingSetupToken;
    if (!token) return;
    try {
      await confirmCameraCommand(token, "camera_subnet_setup");
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (TOKEN_REJECTED.test(message)) {
        // The 60 s window closed (or the token was already used): start over.
        setPendingSetupToken(null);
        toast("Confirmation expired, try again", "error");
        return;
      }
      toast(message || "Couldn't set up the camera subnet. Try again in a moment.", "error");
      throw e; // keep the dialog open so the user can retry
    }
    setPendingSetupToken(null);
    onRefresh();
  }

  function cancelSetup() {
    setPendingSetupToken(null);
  }

  async function performTeardown() {
    setLoading(true);
    try {
      const res = await authFetch("/api/cameras/subnet", { method: "DELETE" });
      if (!res.ok && res.status !== 202) {
        const data = await res.json().catch(() => ({}));
        toast(data.error || "Couldn't remove the camera subnet. Try again in a moment.", "error");
        throw new Error(data.error || "Teardown failed");
      }
      if (res.status === 202) {
        // The user already confirmed in the destructive dialog that invoked
        // us, so complete the Tier-2 handshake without asking a second time.
        const data = (await res.json().catch(() => ({}))) as ConfirmationRequired;
        if (!data.confirmationToken) {
          toast("Couldn't remove the camera subnet. Try again in a moment.", "error");
          throw new Error("Teardown failed");
        }
        try {
          await confirmCameraCommand(data.confirmationToken, "camera_subnet_teardown");
        } catch (e) {
          const message = e instanceof Error ? e.message : "";
          toast(
            TOKEN_REJECTED.test(message)
              ? "Confirmation expired, try again"
              : message || "Couldn't remove the camera subnet. Try again in a moment.",
            "error",
          );
          throw new Error("Teardown failed");
        }
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
    <div className="card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {isEnabled ? (
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: "rgba(34,197,94,0.14)" }}
            >
              <ShieldCheck size={20} style={{ color: "var(--success)" }} />
            </div>
          ) : (
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: "rgba(217,163,92,0.16)" }}
            >
              <Shield size={20} className="text-[#d9a35c] dark:text-[#e6b873]" />
            </div>
          )}
          <div>
            <h3 className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
              Network Isolation
            </h3>
            <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
              {isEnabled
                ? `Cameras isolated on ${config?.subnet || "192.168.100.0"}/${config?.netmask === "255.255.255.0" ? "24" : config?.netmask} (VLAN 100)`
                : routerError
                  ? "Router not reachable — isolation can't be changed right now"
                  : "Cameras on main LAN — not isolated"}
            </p>
          </div>
        </div>

        <div>
          {loading ? (
            <div className="btn ghost">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : isEnabled ? (
            <button
              onClick={() => setTeardownOpen(true)}
              className="btn ghost"
              style={{ color: "var(--danger-ink)" }}
            >
              <ShieldOff size={16} />
              <span className="type-subheadline">Disable</span>
            </button>
          ) : (
            <button
              onClick={handleSetup}
              className="btn primary"
              disabled={routerError}
            >
              <ShieldCheck size={16} />
              <span className="type-subheadline">Enable Isolation</span>
            </button>
          )}
        </div>
      </div>

      {isEnabled && (
        <div
          className="mt-3 pt-3 grid grid-cols-3 gap-3"
          style={{ borderTop: "1px solid var(--card-bd)" }}
        >
          <div>
            <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>Subnet</p>
            <p className="type-footnote" style={{ color: "var(--text)" }}>{config?.subnet}/24</p>
          </div>
          <div>
            <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>Firewall</p>
            <p className="type-footnote" style={{ color: "var(--success)" }}>Isolated</p>
          </div>
          <div>
            <p className="type-caption-2" style={{ color: "var(--text-faint)" }}>DHCP</p>
            <p className="type-footnote" style={{ color: "var(--text)" }}>
              {config?.dhcp_pool ? "Active" : "Configured"}
            </p>
          </div>
        </div>
      )}

      {!isEnabled && (
        <p
          className="mt-3 pt-3 type-caption-1"
          style={{ borderTop: "1px solid var(--card-bd)", color: "var(--text-faint)" }}
        >
          Enable isolation to put cameras on a separate VLAN (192.168.100.0/24).
          Users on the main network won&apos;t be able to access camera feeds directly —
          only through the Droplet dashboard.
        </p>
      )}

      <ConfirmDialog
        open={pendingSetupToken !== null}
        onConfirm={performSetupConfirm}
        onCancel={cancelSetup}
        title="Move cameras to an isolated network?"
        description="Your cameras will move to a separate network (VLAN 100, 192.168.100.0/24). Their feeds will only be reachable through Droplet. This can take up to a minute, and the router rolls back automatically if connectivity is lost."
        confirmLabel="Enable isolation"
        variant="neutral"
      />

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
