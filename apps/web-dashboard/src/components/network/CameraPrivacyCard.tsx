"use client";

import { useState } from "react";
import useSWR from "swr";
import { Lock, ShieldCheck, Globe } from "lucide-react";
import { authFetch } from "@/lib/auth";
import { useSwitch } from "@/lib/hooks/useSwitch";
import { ToggleSwitch } from "@/components/smart-home/ToggleSwitch";

/**
 * Camera privacy (Droplet Design System · Network · Simple). Two honest camera
 * controls in one plain-language place:
 *
 *  1. Network isolation — REFLECTIVE ONLY. There is no orchestrator write path
 *     for camera VLAN isolation yet (network-vlan.routes is a placeholder), and
 *     the §6 camera-safe rule forbids implying isolation that isn't real. So we
 *     show the honest posture from the switch's `vlan_profile` and never render
 *     an interactive control that would strand a camera.
 *  2. Internet block — LIVE. Wired to the same `/api/network/phone-home`
 *     `cameras` flag the Privacy → Phone-home card owns (shared SWR key, so the
 *     two stay in sync). Blocking still allows firmware updates + time sync.
 */

const PHONE_HOME_KEY = "/api/network/phone-home";

interface CamerasScope {
  desired: boolean;
  applied: boolean;
}
interface PhoneHomeView {
  cameras: CamerasScope & { count: number | null };
}

const fetchPhoneHome = async (url: string): Promise<PhoneHomeView> => {
  const r = await authFetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export function CameraPrivacyCard() {
  const { status, connected } = useSwitch();
  const { data, isLoading, mutate } = useSWR<PhoneHomeView>(
    PHONE_HOME_KEY,
    fetchPhoneHome,
    { refreshInterval: 15000 },
  );
  const [saving, setSaving] = useState(false);

  const isolated = connected && status?.vlan_profile === "segmented";
  const cameras = data?.cameras;
  const blocked = cameras?.desired ?? false;
  const blockPending = cameras != null && cameras.desired !== cameras.applied;
  const cameraCount = cameras?.count ?? null;

  async function toggleBlock() {
    if (!data) return;
    const next = !data.cameras.desired;
    setSaving(true);
    // Optimistic — keep both this card and the Phone-home card responsive.
    mutate(
      { ...data, cameras: { ...data.cameras, desired: next, applied: false } },
      false,
    );
    try {
      const r = await authFetch(PHONE_HOME_KEY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameras: next }),
      });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      // Roll the optimistic update back to server truth.
      mutate();
    } finally {
      setSaving(false);
      mutate();
    }
  }

  return (
    <div className="card">
      <h3 className="type-headline mb-1" style={{ color: "var(--text)" }}>Camera privacy</h3>
      <p className="type-subheadline mb-4" style={{ color: "var(--text-muted)" }}>
        Keep your cameras local. Reads stay on your Droplet.
      </p>

      {/* 1 — network isolation posture (read-only, honest) */}
      <div
        className="flex items-start gap-3 py-3"
        style={{ borderTop: "1px solid var(--card-bd)" }}
      >
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
            isolated
              ? "bg-system-green/15 text-system-green"
              : "bg-system-blue/15 text-system-blue"
          }`}
        >
          {isolated ? <Lock size={18} /> : <ShieldCheck size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
            Keep cameras on their own network
          </p>
          {isolated ? (
            <p className="type-caption-1 text-system-green mt-0.5">
              Cameras isolated on{" "}
              <span className="font-mono">VLAN 100</span> — only your Droplet can
              reach them.
            </p>
          ) : (
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              Cameras share the main network. Isolation becomes available after
              router setup.
            </p>
          )}
        </div>
        <span
          className={`type-caption-2 font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${
            isolated
              ? "bg-system-green/15 text-system-green"
              : "bg-system-blue/15 text-system-blue"
          }`}
        >
          {isolated ? "Isolated" : "Pending setup"}
        </span>
      </div>

      {/* 2 — block cameras from the internet (live toggle) */}
      <div
        className="flex items-start gap-3 py-3"
        style={{ borderTop: "1px solid var(--card-bd)" }}
      >
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "var(--card-inner)", color: "var(--text-muted)" }}
        >
          <Globe size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
            Block cameras from the internet
          </p>
          <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
            Allow only firmware updates and time sync
            {cameraCount != null ? ` · ${cameraCount} camera${cameraCount === 1 ? "" : "s"}` : ""}
            {blockPending ? " · applying…" : ""}
          </p>
        </div>
        <ToggleSwitch
          on={blocked}
          onToggle={toggleBlock}
          disabled={isLoading || saving || !data}
          ariaLabel="Block cameras from the internet"
        />
      </div>
    </div>
  );
}
