"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  RefreshCw,
  Video,
  Plus,
  Radar,
  Server,
  LayoutGrid,
  Bell,
  User,
  Car,
  type LucideIcon,
} from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useCameras } from "@/lib/hooks/useCameras";
import { useCameraEvents } from "@/lib/hooks/useCameraEvents";
import { useCameraGroups } from "@/lib/hooks/useCameraGroups";
import { useCameraPins } from "@/lib/hooks/useCameraPins";
import { CameraGrid } from "@/components/cameras/CameraGrid";
import { CameraEvents } from "@/components/cameras/CameraEvents";
import { NetworkCameraList } from "@/components/cameras/NetworkCameraList";
import { CameraNotificationToast } from "@/components/cameras/CameraNotificationToast";
import { CameraSubnetCard } from "@/components/cameras/CameraSubnetCard";
import { AddCameraModal } from "@/components/cameras/AddCameraModal";
import { CameraGroupNav } from "@/components/cameras/CameraGroupNav";
import { CameraGroupEditor } from "@/components/cameras/CameraGroupEditor";
import { authFetch } from "@/lib/auth";
import { triggerCameraScan } from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import type { CameraGroupInfo, CameraInfo, DiscoveredCamera } from "@/lib/types";

export default function CamerasPage() {
  const {
    cameras,
    discovered,
    discoveryOnline,
    recentEvents,
    totalCameras,
    isLoading,
    isRefreshing,
    error,
    refresh,
    setDiscovered,
    acceptCamera,
    rejectCamera,
  } = useCameras();

  const { notifications, dismissNotification } = useCameraEvents();

  const { data: subnetConfig, mutate: mutateSubnet } = useSWR(
    "/api/cameras/subnet",
    async (url: string) => {
      const res = await authFetch(url);
      if (!res.ok) return null;
      return res.json();
    },
    { refreshInterval: 30_000 }
  );

  const router = useRouter();
  const [showAddModal, setShowAddModal] = useState(false);
  const [scanning, setScanning] = useState(false);
  // WARP-1847: the scan used to be fire-and-forget with an empty catch, so a
  // failed sweep and a clean sweep that found nothing looked identical (both:
  // nothing happened). Track the outcome and show it.
  const [lastScan, setLastScan] = useState<{ at: number; found: number } | null>(null);
  // Camera we found but can't stream — hands off to the manual form prefilled.
  const [credentialTarget, setCredentialTarget] = useState<DiscoveredCamera | null>(null);

  // Camera-group state. Selected pill drives the grid filter; null = "All
  // cameras" pseudo-group. Editor modal opens with either the group being
  // edited or null when creating a new one.
  const groupsHook = useCameraGroups();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorGroup, setEditorGroup] = useState<CameraGroupInfo | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<CameraGroupInfo | null>(null);
  const { toast } = useToast();

  // Per-user pinned cameras. The set drives the star icon on each card;
  // the array drives the order of the "Pinned" rail above the grid.
  const pinsHook = useCameraPins();

  const filteredCameras = useMemo(() => {
    if (!selectedGroupId) return cameras;
    const group = groupsHook.groups.find((g) => g.id === selectedGroupId);
    if (!group) return cameras; // group disappeared mid-render — fall back to All
    const memberSet = new Set(group.members.map((m) => m.cameraName));
    return cameras.filter((c) => memberSet.has(c.name));
  }, [cameras, groupsHook.groups, selectedGroupId]);

  // Pinned + unpinned split for the visible grid. Pinned cameras render
  // in pin sortOrder (server-controlled — most-recently-pinned first by
  // default; reorder endpoint exists for an explicit drag UI later).
  // Unpinned cameras keep their existing order. Dangling pins (camera
  // disappeared from Frigate) silently drop here so we don't crash on a
  // tombstoned name.
  const { pinnedCameras, unpinnedCameras } = useMemo(() => {
    const byName = new Map(filteredCameras.map((c) => [c.name, c]));
    const pinned = pinsHook.pins
      .map((p) => byName.get(p.cameraName))
      .filter((c): c is CameraInfo => Boolean(c));
    const pinnedNames = new Set(pinned.map((c) => c.name));
    const unpinned = filteredCameras.filter((c) => !pinnedNames.has(c.name));
    return { pinnedCameras: pinned, unpinnedCameras: unpinned };
  }, [filteredCameras, pinsHook.pins]);

  const handleTogglePin = async (cam: CameraInfo) => {
    try {
      await pinsHook.toggle(cam.name);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to update pin", "error");
    }
  };

  // WARP-1847 — one scan handler for every entry point (sub-nav chip, empty
  // state, list header, modal). The result is applied straight to the candidate
  // cache: the sweep is synchronous server-side, so the list it returns is
  // already current and there is nothing to poll for.
  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const result = await triggerCameraScan();
      setDiscovered({ cameras: result.cameras, discoveryOnline: result.discoveryOnline });
      setLastScan({ at: Date.now(), found: result.cameras.length });
      refresh();

      if (result.status === "scan_unavailable") {
        toast(
          result.message ??
            "Camera discovery isn't running, so we couldn't scan your network.",
          "error",
        );
      } else if (result.cameras.length === 0) {
        toast("Scan finished — no cameras found on your network.", "info");
      } else {
        const n = result.cameras.length;
        toast(`Found ${n} camera${n === 1 ? "" : "s"} on your network.`, "success");
      }
    } catch (e) {
      // Previously swallowed: an unreachable orchestrator looked exactly like a
      // clean scan that found nothing.
      toast(
        e instanceof Error && e.message
          ? `Couldn't scan your network: ${e.message}`
          : "Couldn't scan your network. Try again in a moment.",
        "error",
      );
    } finally {
      setScanning(false);
    }
  };

  const handleAcceptCandidate = async (cam: DiscoveredCamera) => {
    try {
      await acceptCamera(cam.id);
      toast(`Added ${cam.displayName || cam.name.replace(/_/g, " ")}.`, "success");
    } catch (e) {
      // The 422 body carries camera-discovery's own explanation (the stream
      // didn't verify — wrong path or credentials), which is the actionable bit.
      toast(
        e instanceof Error && e.message ? e.message : "Couldn't add that camera.",
        "error",
      );
      throw e;
    }
  };

  const handleRejectCandidate = async (cam: DiscoveredCamera) => {
    try {
      await rejectCamera(cam.id);
    } catch (e) {
      toast(
        e instanceof Error && e.message ? e.message : "Couldn't ignore that device.",
        "error",
      );
    }
  };

  const openCredentialsForm = (cam: DiscoveredCamera) => {
    setCredentialTarget(cam);
    setShowAddModal(true);
  };

  const closeAddModal = () => {
    setShowAddModal(false);
    setCredentialTarget(null);
  };

  // Click on a card → navigate to the dedicated fullscreen page at
  // /cameras/[name]. The dialog-style CameraDetailPanel that we used
  // before is intentionally retired here in favour of a real route, so
  // back/forward, deep links from the LLM tool surface, and external
  // notification links all land on the same view.
  const openCamera = (cam: CameraInfo) =>
    router.push(`/cameras/${encodeURIComponent(cam.name)}`);

  const openNewGroup = () => {
    setEditorGroup(null);
    setEditorOpen(true);
  };
  const openEditGroup = (group: CameraGroupInfo) => {
    setEditorGroup(group);
    setEditorOpen(true);
  };
  const handleDeleteGroup = (group: CameraGroupInfo) => {
    setDeleteGroupTarget(group);
  };

  const performDeleteGroup = async () => {
    const group = deleteGroupTarget;
    if (!group) return;
    try {
      await groupsHook.remove(group.id);
      // If the deleted group was selected, snap back to All.
      if (selectedGroupId === group.id) setSelectedGroupId(null);
      setDeleteGroupTarget(null);
      toast(`Deleted "${group.name}".`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to delete group", "error");
      throw e;
    }
  };

  if (isLoading) {
    return (
      <ShellPage icon={<Video size={15} />} label="Cameras" title="Cameras" sub="Loading your cameras…">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card aspect-video animate-pulse" style={{ background: "var(--surface-2)" }} />
          ))}
        </div>
      </ShellPage>
    );
  }

  if (error) {
    return (
      <ShellPage icon={<Video size={15} />} label="Cameras" title="Cameras">
        <div className="card">
          <div className="empty">
            <span className="ei"><Video size={24} /></span>
            <span className="eh">Camera service is offline</span>
            <span style={{ maxWidth: "44ch" }}>
              Make sure this Droplet is powered on and the camera service is
              running. Try again in a moment, or contact support if this persists.
            </span>
            <button
              onClick={refresh}
              disabled={isRefreshing}
              className="btn"
              type="button"
              style={{ marginTop: 8 }}
            >
              <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} />
              Retry
            </button>
          </div>
        </div>
      </ShellPage>
    );
  }

  // Header subtitle — tells the operator at a glance how the fleet's doing.
  const sub = totalCameras === 0
    ? "No cameras connected yet — add one or scan your network."
    : `${totalCameras} camera${totalCameras === 1 ? "" : "s"} connected.`;

  // Header actions — kept to the two operator-frequent ones (Add + Refresh).
  // The other nav targets (Birdseye / People / Plates / Notifications /
  // System / Scan) live in the sub-nav chip row — they're navigation.
  const actions = (
    <>
      <button onClick={() => setShowAddModal(true)} className="btn primary" type="button">
        <Plus size={15} />
        Add camera
      </button>
      <button
        onClick={refresh}
        disabled={isRefreshing}
        className="icon-btn"
        aria-label="Refresh cameras"
        title="Refresh"
        type="button"
      >
        <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} />
      </button>
    </>
  );

  return (
    <ShellPage
      icon={<Video size={15} />}
      label="Cameras"
      title="Cameras"
      sub={sub}
      actions={actions}
    >
      {/* Notifications — fixed-positioned toaster, renders outside flow */}
      <CameraNotificationToast
        notifications={notifications}
        onDismiss={dismissNotification}
      />

      {/* Secondary sub-nav (chip row) for the camera-related sub-routes —
          People / Plates / Notifications / System / Birdseye — plus the
          "Scan network" discovery action. */}
      <CamerasSubNav scanning={scanning} onScan={handleScan} />

      {/* Network isolation */}
      <CameraSubnetCard config={subnetConfig} onRefresh={() => mutateSubnet()} />

      {/* Group navigation rail — sits above the grid so the operator can
          slice their cameras by location/role without losing the page
          context. */}
      {totalCameras > 0 && (
        <div className="mb-4">
          <CameraGroupNav
            groups={groupsHook.groups}
            cameras={cameras}
            selectedGroupId={selectedGroupId}
            onSelect={setSelectedGroupId}
            onNewGroup={openNewGroup}
            onEditGroup={openEditGroup}
            onDeleteGroup={handleDeleteGroup}
          />
        </div>
      )}

      {/* What's on the network. WARP-1847: shown whenever there are candidates,
          and — when no cameras are set up at all — as the page's primary empty
          state, since "what can I add?" is the only question that matters then.
          It carries its own scanning / found-nothing / discovery-offline copy. */}
      {(discovered.length > 0 || totalCameras === 0) && (
        <NetworkCameraList
          cameras={discovered}
          discoveryOnline={discoveryOnline}
          scanning={scanning}
          lastScan={lastScan}
          onScan={handleScan}
          onAccept={handleAcceptCandidate}
          onReject={handleRejectCandidate}
          onEnterCredentials={openCredentialsForm}
        />
      )}

      {/* No cameras AND nothing found — offer the manual path alongside the
          list's own scan affordance. */}
      {totalCameras === 0 && discovered.length === 0 && (
        <div className="card">
          <div className="empty" style={{ padding: "34px 20px" }}>
            <span className="ei"><Video size={24} /></span>
            <span className="eh">Know your camera's details?</span>
            <span style={{ maxWidth: "44ch" }}>
              If your camera isn't on this Droplet's network — or you already have
              its stream address — you can add it by hand.
            </span>
            <div className="flex items-center justify-center gap-3" style={{ marginTop: 8 }}>
              <button onClick={() => setShowAddModal(true)} className="btn primary" type="button">
                <Plus size={16} />
                Add camera
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Camera grid — filtered by the selected group, then split into a
          "Pinned" section above and the rest below so an operator can
          float their priority cameras. The Pinned section is hidden if
          empty. */}
      {selectedGroupId && filteredCameras.length === 0 ? (
        <div className="card">
          <div className="empty">
            <span>No cameras in this group yet. Edit the group to add some.</span>
          </div>
        </div>
      ) : (
        <>
          {pinnedCameras.length > 0 && (
            <div className="mb-6">
              <div className="sect">
                <h2>Pinned</h2>
                <span className="sx">{pinnedCameras.length}</span>
              </div>
              <CameraGrid
                cameras={pinnedCameras}
                onCameraClick={openCamera}
                pinnedSet={pinsHook.pinnedSet}
                onTogglePin={handleTogglePin}
              />
            </div>
          )}
          {unpinnedCameras.length > 0 && (
            <>
              {pinnedCameras.length > 0 && (
                <div className="sect">
                  <h2>All cameras</h2>
                  <span className="sx">{unpinnedCameras.length}</span>
                </div>
              )}
              <CameraGrid
                cameras={unpinnedCameras}
                onCameraClick={openCamera}
                pinnedSet={pinsHook.pinnedSet}
                onTogglePin={handleTogglePin}
              />
            </>
          )}
        </>
      )}

      {/* Recent events */}
      {recentEvents.length > 0 && (
        <div className="mt-8">
          <CameraEvents events={recentEvents} />
        </div>
      )}

      {/* Add Camera Modal — opens on the discovered list when there is one, so
          "Add camera" answers "which camera?" before asking for an RTSP URL. */}
      {showAddModal && (
        <AddCameraModal
          onClose={closeAddModal}
          onAdded={refresh}
          cameras={discovered}
          discoveryOnline={discoveryOnline}
          scanning={scanning}
          onScan={handleScan}
          onAccept={handleAcceptCandidate}
          prefill={credentialTarget}
        />
      )}

      {/* Group editor — handles both create + edit flows. */}
      {editorOpen && (
        <CameraGroupEditor
          group={editorGroup}
          cameras={cameras}
          onClose={() => setEditorOpen(false)}
          onCreate={async (input) => {
            const created = await groupsHook.create(input);
            setSelectedGroupId(created.id);
          }}
          onSaveMeta={async (id, patch) => {
            const updated = await (
              patch.name !== undefined
                ? groupsHook.rename(id, patch.name)
                : patch.icon !== undefined
                  ? groupsHook.setIcon(id, patch.icon)
                  : Promise.resolve(null)
            );
            // Keep the in-modal group in sync so subsequent edits see the
            // latest server state.
            if (updated) setEditorGroup(updated);
          }}
          onAddMember={async (id, cameraName) => {
            const updated = await groupsHook.addMembers(id, [cameraName]);
            if (updated) setEditorGroup(updated);
          }}
          onRemoveMember={async (id, cameraName) => {
            const updated = await groupsHook.removeMember(id, cameraName);
            if (updated) setEditorGroup(updated);
          }}
        />
      )}

      <ConfirmDialog
        open={deleteGroupTarget !== null}
        onConfirm={performDeleteGroup}
        onCancel={() => setDeleteGroupTarget(null)}
        title={
          deleteGroupTarget
            ? `Delete group "${deleteGroupTarget.name}"?`
            : "Delete group?"
        }
        description={
          deleteGroupTarget
            ? `${deleteGroupTarget.members?.length ?? 0} camera${(deleteGroupTarget.members?.length ?? 0) === 1 ? "" : "s"} will become ungrouped. The cameras themselves are not removed.`
            : "Cameras are not removed."
        }
        confirmLabel="Delete group"
        variant="destructive"
      />
    </ShellPage>
  );
}

// ─────────────────────────────────────────────────────────────────
// Secondary sub-nav strip for /cameras/*. Renders a horizontal row of
// pill links + a "Scan" action button. Visually mirrors the redesign's
// chip-tab pattern: outlined pills with the active route filled-violet.
// ─────────────────────────────────────────────────────────────────

interface CamerasSubNavProps {
  scanning: boolean;
  onScan: () => void;
}

function CamerasSubNav({ scanning, onScan }: CamerasSubNavProps) {
  const pathname = usePathname();

  const items: Array<{ href: string; label: string; icon: LucideIcon; titleAttr: string }> = [
    { href: "/cameras/birdseye",      label: "Birdseye",      icon: LayoutGrid, titleAttr: "Auto-composited multi-camera view" },
    { href: "/cameras/people",        label: "People",        icon: User,       titleAttr: "Known faces (face recognition)" },
    { href: "/cameras/plates",        label: "Plates",        icon: Car,        titleAttr: "Detected license plates" },
    { href: "/cameras/notifications", label: "Notifications", icon: Bell,       titleAttr: "Per-camera notification preferences" },
    { href: "/cameras/system",        label: "System",        icon: Server,     titleAttr: "Recognition engine health" },
  ];

  const isActive = (href: string) => pathname === href;

  return (
    <div className="chiprow" style={{ overflowX: "auto" }}>
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.titleAttr}
            aria-current={active ? "page" : undefined}
            className={"chip" + (active ? " on" : "")}
          >
            <Icon size={14} strokeWidth={active ? 2 : 1.5} />
            <span>{item.label}</span>
          </Link>
        );
      })}

      {/* The Scan action lives in the sub-nav because the camera-discovery
          surfaces are right next to it conceptually. Bumped to the right
          with margin-left:auto so it doesn't crowd the navigation pills. */}
      <button
        onClick={onScan}
        disabled={scanning}
        className="chip"
        style={{ marginLeft: "auto" }}
        title="Scan the LAN for ONVIF cameras"
        type="button"
      >
        <Radar size={14} className={scanning ? "animate-pulse" : ""} />
        <span>{scanning ? "Scanning…" : "Scan network"}</span>
      </button>
    </div>
  );
}
