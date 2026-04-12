"use client";

import { useState } from "react";
import useSWR from "swr";
import { RefreshCw, Video, ExternalLink } from "lucide-react";
import { useCameras } from "@/lib/hooks/useCameras";
import { useCameraEvents } from "@/lib/hooks/useCameraEvents";
import { CameraGrid } from "@/components/cameras/CameraGrid";
import { CameraEvents } from "@/components/cameras/CameraEvents";
import { CameraDiscoveryBanner } from "@/components/cameras/CameraDiscoveryBanner";
import { CameraDetailPanel } from "@/components/cameras/CameraDetailPanel";
import { CameraNotificationToast } from "@/components/cameras/CameraNotificationToast";
import { CameraSubnetCard } from "@/components/cameras/CameraSubnetCard";
import { authFetch } from "@/lib/auth";
import type { CameraInfo } from "@/lib/types";

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
    enableCam,
    disableCam,
    removeCam,
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

  const [selectedCamera, setSelectedCamera] = useState<CameraInfo | null>(null);

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
          <a
            href="/frigate/"
            target="_blank"
            rel="noopener noreferrer"
            className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
          >
            <ExternalLink size={16} />
            <span className="type-subheadline">Advanced</span>
          </a>
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
          <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
            Connect RTSP or ONVIF cameras to your network. They&apos;ll be
            automatically discovered and configured for recording and AI
            detection.
          </p>
        </div>
      )}

      {/* Camera grid */}
      <CameraGrid cameras={cameras} onCameraClick={setSelectedCamera} />

      {/* Recent events */}
      {recentEvents.length > 0 && (
        <div className="mt-8">
          <CameraEvents events={recentEvents} />
        </div>
      )}

      {/* Detail panel */}
      {selectedCamera && (
        <CameraDetailPanel
          camera={selectedCamera}
          onEnable={enableCam}
          onDisable={disableCam}
          onRemove={removeCam}
          onClose={() => setSelectedCamera(null)}
        />
      )}
    </div>
  );
}
