"use client";

// Network "Devices" tab — extracted from app/network/page.tsx so it can be unit
// tested in isolation (WARP-873). A Next.js App Router page.tsx may only export
// the default page (+ reserved fields like `metadata`); a non-page named export
// such as DevicesTab fails `next build`, so this component lives in its own module.
import { useState } from "react";
import { Loader2, Monitor } from "lucide-react";
import { useNetworkDevices } from "@/lib/hooks/useNetworkDevices";
import { useNetworkGroups } from "@/lib/hooks/useNetworkGroups";
import { DeviceGridSection } from "@/components/network/DeviceGridSection";
import { DeviceDetailPanel } from "@/components/network/DeviceDetailPanel";
import { GroupManagerDialog } from "@/components/network/GroupManagerDialog";
import { CoverageExtendersPanel } from "@/components/network/CoverageExtendersPanel";
import type { EnrichedNetworkDevice } from "@/lib/types";

type DeviceSort = "name" | "lastSeen" | "vendor";

export function DevicesTab() {
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
  // WARP-873: with devices present, the only way every section is empty is an
  // active search that matched nothing (onlineOnly filters server-side, so it
  // empties `devices` instead). Distinguish that from the raw zero-devices case
  // so the search miss gets its own empty state rather than a blank area.
  const hasMatches = groupsWithMembers.length > 0 || ungrouped.length > 0;

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
          className="flex-1 min-w-[200px] px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-input)",
            color: "var(--text)",
          }}
        />
        <label className="flex items-center gap-2 type-subheadline text-[color:var(--text-muted)]">
          <input
            type="checkbox"
            checked={onlineOnly}
            onChange={(e) => setOnlineOnly(e.target.checked)}
            className="accent-[var(--brand)]"
          />
          Online only
        </label>
        <label className="flex items-center gap-2 type-subheadline text-[color:var(--text-muted)]">
          Sort by
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as DeviceSort)}
            aria-label="Sort devices"
            className="px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--text)",
            }}
          >
            <option value="name">Name</option>
            <option value="lastSeen">Last seen</option>
            <option value="vendor">Vendor</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => setGroupManagerOpen(true)}
          className="btn sm"
        >
          Manage groups
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-[color:var(--text-muted)]">
          <Loader2 size={20} className="animate-spin mr-2" />
          <span className="type-subheadline">Loading devices…</span>
        </div>
      )}

      {!isLoading && devices.length === 0 && (
        <div className="card text-center" style={{ padding: "48px 20px" }}>
          <Monitor size={32} className="mx-auto text-[color:var(--text-faint)] mb-3" />
          <h3 className="type-title-3 text-[color:var(--text)] mb-1">
            Your router hasn&apos;t seen any devices yet
          </h3>
          <p className="type-subheadline text-[color:var(--text-muted)] mb-4">
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

      {!isLoading && devices.length > 0 && !hasMatches && search.trim() !== "" && (
        <div className="card text-center" style={{ padding: "48px 20px" }}>
          <Monitor size={32} className="mx-auto text-[color:var(--text-faint)] mb-3" />
          <h3 className="type-title-3 text-[color:var(--text)] mb-1">
            No devices match &ldquo;{search}&rdquo;
          </h3>
          <p className="type-subheadline text-[color:var(--text-muted)] mb-4">
            Try a different name, IP, or vendor.
          </p>
          <button
            type="button"
            onClick={() => setSearch("")}
            className="btn ghost sm"
          >
            Clear search
          </button>
        </div>
      )}

      {!isLoading && devices.length > 0 && hasMatches && (
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
          className="fixed bottom-[calc(72px+env(safe-area-inset-bottom))] right-4 lg:bottom-4 z-50 bg-system-red text-white px-3 py-2 rounded shadow flex items-center gap-2"
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

