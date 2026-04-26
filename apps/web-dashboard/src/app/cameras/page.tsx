"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { RefreshCw, Video, Plus, Radar, Server, LayoutGrid } from "lucide-react";
import { useCameras } from "@/lib/hooks/useCameras";
import { useCameraEvents } from "@/lib/hooks/useCameraEvents";
import { useCameraGroups } from "@/lib/hooks/useCameraGroups";
import { useCameraPins } from "@/lib/hooks/useCameraPins";
import { CameraGrid } from "@/components/cameras/CameraGrid";
import { CameraEvents } from "@/components/cameras/CameraEvents";
import { CameraDiscoveryBanner } from "@/components/cameras/CameraDiscoveryBanner";
import { CameraNotificationToast } from "@/components/cameras/CameraNotificationToast";
import { CameraSubnetCard } from "@/components/cameras/CameraSubnetCard";
import { AddCameraModal } from "@/components/cameras/AddCameraModal";
import { CameraGroupNav } from "@/components/cameras/CameraGroupNav";
import { CameraGroupEditor } from "@/components/cameras/CameraGroupEditor";
import { authFetch } from "@/lib/auth";
import { triggerCameraScan } from "@/lib/api";
import type { CameraGroupInfo, CameraInfo } from "@/lib/types";

export default function CamerasPage() {
  const {
    cameras,
    discovered,
    recentEvents,
    totalCameras,
    isLoading,
    isRefreshing,
    error,
    refresh,
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

  // Camera-group state. Selected pill drives the grid filter; null = "All
  // cameras" pseudo-group. Editor modal opens with either the group being
  // edited or null when creating a new one.
  const groupsHook = useCameraGroups();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorGroup, setEditorGroup] = useState<CameraGroupInfo | null>(null);

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
      alert(e instanceof Error ? e.message : "Failed to toggle pin");
    }
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
  const handleDeleteGroup = async (group: CameraGroupInfo) => {
    if (!confirm(`Delete group "${group.name}"? Cameras themselves are not removed.`)) return;
    try {
      await groupsHook.remove(group.id);
      // If the deleted group was selected, snap back to All.
      if (selectedGroupId === group.id) setSelectedGroupId(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete group");
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="space-y-2">
          <div className="h-8 w-48 bg-surface-secondary rounded animate-pulse" />
          <div className="h-4 w-32 bg-surface-secondary rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="dp-card aspect-video animate-pulse bg-surface-secondary" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="dp-card text-center py-12">
          <Video size={32} className="mx-auto text-label-quaternary mb-3" />
          <h2 className="type-title-3 text-label-primary mb-1">
            Frigate NVR Not Connected
          </h2>
          <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
            Make sure Frigate is running. Check the Docker compose configuration
            or visit the health endpoint for details.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Notifications */}
      <CameraNotificationToast
        notifications={notifications}
        onDismiss={dismissNotification}
      />

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="type-large-title text-label-primary">Cameras</h1>
          <p className="type-subheadline text-label-tertiary mt-1">
            {totalCameras > 0
              ? `${totalCameras} camera${totalCameras !== 1 ? "s" : ""} connected`
              : "No cameras found"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddModal(true)}
            className="dp-btn-primary flex items-center gap-2 px-3 py-2 rounded-lg"
          >
            <Plus size={16} />
            <span className="type-subheadline">Add Camera</span>
          </button>
          <button
            onClick={async () => {
              setScanning(true);
              try {
                await triggerCameraScan();
                refresh();
              } catch { /* scan service may not be running */ }
              setScanning(false);
            }}
            disabled={scanning}
            className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
          >
            <Radar size={16} className={scanning ? "animate-pulse" : ""} />
            <span className="type-subheadline">Scan</span>
          </button>
          <button
            onClick={() => router.push("/cameras/birdseye")}
            className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
            title="Auto-composited multi-camera view"
          >
            <LayoutGrid size={16} />
            <span className="type-subheadline">Birdseye</span>
          </button>
          <button
            onClick={() => router.push("/cameras/system")}
            className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
            title="Frigate engine health"
          >
            <Server size={16} />
            <span className="type-subheadline">System</span>
          </button>
          <button
            onClick={refresh}
            disabled={isRefreshing}
            className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
          >
            <RefreshCw
              size={16}
              className={isRefreshing ? "animate-spin" : ""}
            />
            <span className="type-subheadline">Refresh</span>
          </button>
        </div>
      </div>

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

      {/* Discovery banner */}
      <CameraDiscoveryBanner
        cameras={discovered}
        onAccept={acceptCamera}
        onReject={rejectCamera}
        onAcceptAll={() => {
          discovered.forEach((cam) => acceptCamera(cam.id));
        }}
      />

      {/* Empty state */}
      {totalCameras === 0 && discovered.length === 0 && (
        <div className="dp-card text-center py-12">
          <Video size={32} className="mx-auto text-label-quaternary mb-3" />
          <h2 className="type-title-3 text-label-primary mb-1">
            No Cameras Yet
          </h2>
          <p className="type-subheadline text-label-tertiary max-w-md mx-auto mb-4">
            Frigate NVR is running and ready. Add a camera manually with its
            RTSP URL, or scan your network to auto-discover ONVIF cameras.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => setShowAddModal(true)}
              className="dp-btn-primary flex items-center gap-2 px-4 py-2.5 rounded-lg"
            >
              <Plus size={16} />
              Add Camera
            </button>
            <button
              onClick={async () => {
                setScanning(true);
                try { await triggerCameraScan(); refresh(); } catch {}
                setScanning(false);
              }}
              disabled={scanning}
              className="dp-btn-secondary flex items-center gap-2 px-4 py-2.5 rounded-lg"
            >
              <Radar size={16} className={scanning ? "animate-pulse" : ""} />
              Scan Network
            </button>
          </div>
        </div>
      )}

      {/* Camera grid — filtered by the selected group, then split into a
          "Pinned" section above and the rest below so an operator can
          float their priority cameras. The Pinned section is hidden if
          empty. */}
      {selectedGroupId && filteredCameras.length === 0 ? (
        <div className="dp-card text-center py-10">
          <p className="type-subheadline text-label-tertiary">
            No cameras in this group yet. Edit the group to add some.
          </p>
        </div>
      ) : (
        <>
          {pinnedCameras.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <h2 className="type-title-3 text-label-primary">Pinned</h2>
                <span className="type-caption-2 text-label-tertiary">
                  {pinnedCameras.length}
                </span>
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
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="type-title-3 text-label-primary">All cameras</h2>
                  <span className="type-caption-2 text-label-tertiary">
                    {unpinnedCameras.length}
                  </span>
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

      {/* Add Camera Modal */}
      {showAddModal && (
        <AddCameraModal
          onClose={() => setShowAddModal(false)}
          onAdded={refresh}
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
    </div>
  );
}
