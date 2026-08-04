"use client";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { EnrichedNetworkDevice, DeviceGroupRef } from "@/lib/types";
import { DeviceCard } from "./DeviceCard";

interface Props {
  group:
    | DeviceGroupRef
    | { id: "__ungrouped"; name: "Ungrouped" }
    // WARP-1715: the household's own APs, sectioned off from client devices.
    | { id: "__infrastructure"; name: "Network infrastructure" };
  devices: EnrichedNetworkDevice[];
  onOpen: (device: EnrichedNetworkDevice) => void;
  // Forwarded to each DeviceCard so block/unblock errors can bubble up to
  // the page-level toast (see DevicesTab).
  onError?: (message: string) => void;
}

const LS_KEY = "droplet.network.sections";

function loadState(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(LS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function saveState(id: string, expanded: boolean) {
  if (typeof window === "undefined") return;
  const s = loadState();
  s[id] = expanded;
  window.localStorage.setItem(LS_KEY, JSON.stringify(s));
}

export function DeviceGridSection({ group, devices, onOpen, onError }: Props) {
  const [expanded, setExpanded] = useState<boolean>(true);

  useEffect(() => {
    const stored = loadState()[group.id];
    if (typeof stored === "boolean") setExpanded(stored);
  }, [group.id]);

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    saveState(group.id, next);
  }

  return (
    <section aria-labelledby={`section-${group.id}`} className="mb-6">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-2 mb-3 text-[color:var(--text)]"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={`w-4 h-4 transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <h2 id={`section-${group.id}`} className="type-title-3">
          {group.name}
        </h2>
        <span className="type-footnote text-[color:var(--text-muted)]">{devices.length}</span>
      </button>
      {expanded && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {devices.map((d) => (
            <DeviceCard key={d.mac} device={d} onOpen={onOpen} onError={onError} />
          ))}
        </div>
      )}
    </section>
  );
}
