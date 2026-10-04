"use client";
/**
 * WARP-3691 — the inline media a turn's tool calls produced, rendered beneath
 * the message text (same placement as RunCard).
 *
 * Only one live feed per message may connect on its own; with several, each
 * waits for a click.
 */
import type { ChatMedia, MediaCall } from "./media-split";
import { CameraClipCard } from "./CameraClipCard";
import { CameraLiveCard } from "./CameraLiveCard";
import { CameraSnapshotCard } from "./CameraSnapshotCard";
import { FileMediaCard } from "./FileMediaCard";

function MediaCard({ media, autoStartLive }: { media: ChatMedia; autoStartLive: boolean }) {
  switch (media.kind) {
    case "camera_snapshot":
      return <CameraSnapshotCard media={media} />;
    case "camera_live":
      return <CameraLiveCard media={media} autoStart={autoStartLive} />;
    case "camera_clip":
      return <CameraClipCard media={media} />;
    case "file":
      return <FileMediaCard media={media} />;
    default:
      return null;
  }
}

export function ToolMediaCards({ calls }: { calls: MediaCall[] }) {
  if (calls.length === 0) return null;
  const liveCount = calls.reduce((n, c) => n + c.media.filter((m) => m.kind === "camera_live").length, 0);
  return (
    <div className="flex flex-col gap-2 mt-2" data-testid="tool-media-cards">
      {calls.flatMap(({ call, media }) =>
        media.map((m, i) => (
          <MediaCard key={`${call.id}:${i}`} media={m} autoStartLive={liveCount === 1} />
        )),
      )}
    </div>
  );
}
