"use client";

import { useState } from "react";
import useSWR from "swr";
import { Camera, ShieldOff, Users } from "lucide-react";
import { ToggleSwitch } from "@/components/smart-home/ToggleSwitch";

// WARP-613 / ADR-012. Home-user surface for the phone-home egress block:
// one master switch + per-scope rows (Cameras + each device group). The
// orchestrator persists desired state; the egress reconciler enforces it on
// the router within one tick, so the UI is declarative — toggle, revalidate.

interface PhoneHomeGroup {
  id: string;
  name: string;
  blockPhoneHome: boolean;
}

interface PhoneHomeState {
  enabled: boolean;
  cameras: boolean;
  groups: PhoneHomeGroup[];
}

const fetcher = async (url: string): Promise<PhoneHomeState> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export function PhoneHomeCard() {
  const { data, mutate, isLoading } = useSWR<PhoneHomeState>(
    "/api/network/phone-home",
    fetcher,
    { refreshInterval: 30_000 },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enabled = data?.enabled ?? false;
  const cameras = data?.cameras ?? false;
  const groups = data?.groups ?? [];

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await mutate();
    } catch {
      setError("Couldn't save that change — please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function patch(body: { enabled?: boolean; cameras?: boolean }) {
    const r = await fetch("/api/network/phone-home", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(String(r.status));
  }

  async function patchGroup(id: string, blockPhoneHome: boolean) {
    const r = await fetch(`/api/network/groups/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockPhoneHome }),
    });
    if (!r.ok) throw new Error(String(r.status));
  }

  return (
    <div className="dp-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <ShieldOff size={20} className="text-accent mt-0.5" aria-hidden="true" />
          <div>
            <h3 className="type-headline text-label-primary">Block phone home</h3>
            <p className="type-footnote text-label-tertiary mt-0.5 max-w-md">
              Stop cameras, IoT, and smart-home devices from sending data to the
              maker&apos;s cloud. They keep working on your network and stay on
              time — they just can&apos;t reach the internet.
            </p>
          </div>
        </div>
        <ToggleSwitch
          on={enabled}
          disabled={isLoading || busy === "master"}
          onToggle={() => withBusy("master", () => patch({ enabled: !enabled }))}
        />
      </div>

      {/* Scopes — only meaningful while the master switch is on. */}
      <div
        className={`mt-4 divide-y divide-separator border-t border-separator ${
          enabled ? "" : "opacity-50"
        }`}
      >
        <ScopeRow
          icon={Camera}
          label="Cameras"
          hint="Every camera on the isolated camera network"
          on={cameras}
          disabled={!enabled || busy === "cameras"}
          onToggle={() => withBusy("cameras", () => patch({ cameras: !cameras }))}
        />
        {groups.map((g) => (
          <ScopeRow
            key={g.id}
            icon={Users}
            label={g.name}
            hint="Devices you've added to this group"
            on={g.blockPhoneHome}
            disabled={!enabled || busy === `group:${g.id}`}
            onToggle={() =>
              withBusy(`group:${g.id}`, () => patchGroup(g.id, !g.blockPhoneHome))
            }
          />
        ))}
        {groups.length === 0 && (
          <p className="type-footnote text-label-tertiary py-3">
            Group your IoT and smart-home devices under the Devices tab to block
            them by group.
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="type-caption-1 text-system-red mt-3">
          {error}
        </p>
      )}
    </div>
  );
}

function ScopeRow({
  icon: Icon,
  label,
  hint,
  on,
  disabled,
  onToggle,
}: {
  icon: typeof Camera;
  label: string;
  hint: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <Icon size={16} className="text-label-tertiary shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="type-subheadline text-label-primary truncate">{label}</p>
          <p className="type-caption-2 text-label-tertiary truncate">{hint}</p>
        </div>
      </div>
      <ToggleSwitch on={on} disabled={disabled} onToggle={onToggle} />
    </div>
  );
}
