/**
 * WARP-3691 — inline media cards in chat: which tool calls become cards, the
 * /api/ URL guard, live-feed connection discipline, and error copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatToolCall } from "@/lib/types";

const authFetch = vi.fn();
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  authFetch: (...a: unknown[]) => authFetch(...a),
}));

import { ChatMessage } from "@/components/ChatMessage";
import { mediaOf, splitMediaCalls } from "@/components/chat/media/media-split";

const SNAP = {
  kind: "camera_snapshot",
  camera: "front",
  snapshotUrl: "/api/cameras/front/snapshot",
  liveUrl: "/api/cameras/front/live",
};
const LIVE = (camera: string) => ({
  kind: "camera_live",
  camera,
  liveUrl: `/api/cameras/${camera}/live`,
  snapshotUrl: `/api/cameras/${camera}/snapshot`,
});
const FILE = {
  kind: "file",
  path: "/Pics/cat.png",
  name: "cat.png",
  mimeType: "image/png",
  size: 2048,
  previewUrl: "/api/files/download?path=%2FPics%2Fcat.png&disposition=inline",
  downloadUrl: "/api/files/download?path=%2FPics%2Fcat.png",
  thumbnailUrl: "/api/files/thumbnail?path=%2FPics%2Fcat.png&x=512&y=512",
};

function call(over: Partial<ChatToolCall> & { data?: unknown }): ChatToolCall {
  return { id: "c1", name: "get_camera_snapshot", args: {}, ok: true, ...over };
}

function renderMsg(toolCalls: ChatToolCall[]) {
  return render(
    <ChatMessage message={{ id: "a1", role: "assistant", content: "Here you go.", toolCalls }} />,
  );
}

describe("splitMediaCalls", () => {
  it("makes cards of successful calls with valid media, chips of everything else", () => {
    const calls = [
      call({ id: "ok", data: { media: SNAP } }),
      call({ id: "failed", ok: false, data: { media: SNAP } }),
      call({ id: "pending", ok: undefined }),
      call({ id: "approval", status: "confirmation_required", data: { media: SNAP } }),
      call({ id: "nomedia", name: "list_files", data: { items: [] } }),
      call({ id: "run", name: "start_agent_run", data: { runId: "r1" } }),
    ];
    const { chipCalls, mediaCalls } = splitMediaCalls(calls, (c) => c.id === "run");
    expect(mediaCalls.map((m) => m.call.id)).toEqual(["ok"]);
    expect(chipCalls.map((c) => c.id)).toEqual(["failed", "pending", "approval", "nomedia"]);
  });

  it("reads the MCP-wrapped result shape and a media list", () => {
    expect(mediaOf(call({ data: { data: { media: [SNAP, LIVE("back")] } } }))).toHaveLength(2);
  });

  it("treats a call whose only media is unsafe as a plain chip", () => {
    const bad = call({ data: { media: { ...SNAP, snapshotUrl: "https://evil.example/x.jpg" } } });
    expect(mediaOf(bad)).toEqual([]);
    expect(splitMediaCalls([bad]).chipCalls).toHaveLength(1);
  });
});

describe("ChatMessage media cards", () => {
  beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it("renders a snapshot card (not a chip) with refresh, go-live and a camera link", () => {
    renderMsg([call({ data: { camera: "front", snapshot_url: SNAP.snapshotUrl, media: SNAP } })]);
    expect(screen.getByTestId("camera-snapshot-card")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-call-chips")).toBeNull();
    const img = screen.getByAltText("Snapshot from front") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/cameras/front/snapshot");
    expect(screen.getByRole("button", { name: /refresh snapshot from front/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /go live/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open front camera page/i })).toHaveAttribute("href", "/cameras/front");
  });

  it("Refresh re-requests the snapshot with a cache-buster", () => {
    renderMsg([call({ data: { media: SNAP } })]);
    fireEvent.click(screen.getByRole("button", { name: /refresh snapshot from front/i }));
    const img = screen.getByAltText("Snapshot from front") as HTMLImageElement;
    expect(img.getAttribute("src")).toMatch(/^\/api\/cameras\/front\/snapshot\?t=\d+$/);
  });

  it("Go live swaps in the MJPEG feed and Back to snapshot closes it", () => {
    renderMsg([call({ data: { media: SNAP } })]);
    expect(screen.queryByAltText("Live view of front")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /go live/i }));
    const live = screen.getByAltText("Live view of front") as HTMLImageElement;
    expect(live.getAttribute("src")).toBe("/api/cameras/front/live");
    fireEvent.click(screen.getByRole("button", { name: /back to snapshot/i }));
    expect(screen.queryByAltText("Live view of front")).toBeNull();
  });

  it("keeps the chip for a failed call and for one without media", () => {
    renderMsg([
      call({ id: "f", ok: false, message: "camera_not_found" }),
      call({ id: "n", name: "list_cameras", data: { cameras: [] } }),
    ]);
    expect(screen.queryByTestId("tool-media-cards")).toBeNull();
    expect(screen.getByTestId("tool-call-chips").querySelectorAll("[data-tool-call-id]")).toHaveLength(2);
  });

  it("never puts an off-origin URL into the page", () => {
    renderMsg([
      call({ data: { media: [{ ...SNAP, snapshotUrl: "https://evil.example/x.jpg" }, { ...SNAP, snapshotUrl: "//evil.example/x.jpg" }] } }),
    ]);
    expect(screen.queryByTestId("tool-media-cards")).toBeNull();
    expect(document.querySelector("img[src*='evil']")).toBeNull();
  });

  it("shows the access-denied copy when the snapshot 404s", async () => {
    authFetch.mockResolvedValue(new Response(null, { status: 404 }));
    renderMsg([call({ data: { media: SNAP } })]);
    fireEvent.error(screen.getByAltText("Snapshot from front"));
    expect(await screen.findByText("Camera unavailable or you don't have access")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("falls back to a generic message on a non-404 failure", async () => {
    authFetch.mockResolvedValue(new Response(null, { status: 502 }));
    renderMsg([call({ data: { media: SNAP } })]);
    fireEvent.error(screen.getByAltText("Snapshot from front"));
    expect(await screen.findByText(/couldn't load the camera image/i)).toBeInTheDocument();
  });

  it("file card: image thumbnail, open + download, and file cards for non-images", () => {
    renderMsg([
      call({ id: "f1", name: "show_file", data: { name: "cat.png", media: FILE } }),
      call({
        id: "f2",
        name: "show_file",
        data: {
          media: {
            kind: "file",
            name: "plan.pdf",
            mimeType: "application/pdf",
            size: 4096,
            previewUrl: "/api/files/download?path=%2Fplan.pdf&disposition=inline",
            downloadUrl: "/api/files/download?path=%2Fplan.pdf",
          },
        },
      }),
    ]);
    const cards = screen.getAllByTestId("file-media-card");
    expect(cards).toHaveLength(2);
    const img = screen.getByAltText("cat.png") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(FILE.thumbnailUrl);
    const dl = screen.getAllByRole("link", { name: /download/i });
    expect(dl[0]).toHaveAttribute("href", FILE.downloadUrl);
    expect(screen.getByText("plan.pdf")).toBeInTheDocument();
    expect(screen.getByText(/application\/pdf · 4 KB/)).toBeInTheDocument();
  });

  it("does not draw an SVG as an image (server will not serve it inline)", () => {
    renderMsg([
      call({
        name: "show_file",
        data: {
          media: {
            kind: "file",
            name: "logo.svg",
            mimeType: "image/svg+xml",
            previewUrl: "/api/files/download?path=%2Flogo.svg&disposition=inline",
            downloadUrl: "/api/files/download?path=%2Flogo.svg",
          },
        },
      }),
    ]);
    expect(screen.queryByAltText("logo.svg")).toBeNull();
    expect(screen.getByText("logo.svg")).toBeInTheDocument();
  });

  it("clip card mounts no player until play is pressed", () => {
    renderMsg([
      call({
        name: "list_clips",
        data: {
          media: {
            kind: "camera_clip",
            camera: "front",
            eventId: "e1",
            clipUrl: "/api/cameras/clips/event/e1",
            thumbnailUrl: "/api/cameras/events/e1/thumbnail",
            label: "person",
          },
        },
      }),
    ]);
    expect(document.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /play clip/i }));
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe("/api/cameras/clips/event/e1");
  });
});

describe("live feed connection discipline", () => {
  type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
  let observers: Array<{ cb: IOCallback; disconnect: ReturnType<typeof vi.fn> }>;
  const OriginalIO = globalThis.IntersectionObserver;

  beforeEach(() => {
    observers = [];
    authFetch.mockResolvedValue(new Response(null, { status: 200 }));
    class FakeIO {
      cb: IOCallback;
      disconnect = vi.fn();
      constructor(cb: IOCallback) {
        this.cb = cb;
        observers.push(this);
      }
      observe() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    globalThis.IntersectionObserver = FakeIO as unknown as typeof IntersectionObserver;
  });
  afterEach(() => {
    globalThis.IntersectionObserver = OriginalIO;
  });

  const setVisible = (i: number, visible: boolean) =>
    act(() => observers[i].cb([{ isIntersecting: visible }]));

  it("a lone feed connects only while visible, and releases the stream when scrolled away", () => {
    renderMsg([call({ name: "get_camera_live_url", data: { media: LIVE("front") } })]);
    // Not yet on screen: poster only, no connection.
    expect(screen.queryByAltText("Live view of front")).toBeNull();
    setVisible(0, true);
    const live = screen.getByAltText("Live view of front") as HTMLImageElement;
    expect(live.getAttribute("src")).toBe("/api/cameras/front/live");
    setVisible(0, false);
    expect(screen.queryByAltText("Live view of front")).toBeNull();
    expect(screen.getByRole("button", { name: /play live view of front/i })).toBeInTheDocument();
    // …and reconnects when it comes back.
    setVisible(0, true);
    expect(screen.getByAltText("Live view of front")).toBeInTheDocument();
  });

  it("clears the stream src on unmount", () => {
    const { unmount } = renderMsg([call({ name: "get_camera_live_url", data: { media: LIVE("front") } })]);
    setVisible(0, true);
    const live = screen.getByAltText("Live view of front") as HTMLImageElement;
    unmount();
    expect(live.getAttribute("src") ?? "").toBe(""); // no longer the stream URL
  });

  it("with several feeds in one message none autoplay; each starts on click", () => {
    renderMsg([
      call({ id: "a", name: "get_camera_live_url", data: { media: LIVE("front") } }),
      call({ id: "b", name: "get_camera_live_url", data: { media: LIVE("back") } }),
    ]);
    observers.forEach((_o, i) => setVisible(i, true));
    expect(screen.queryByAltText("Live view of front")).toBeNull();
    expect(screen.queryByAltText("Live view of back")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /play live view of back/i }));
    expect(screen.getByAltText("Live view of back")).toBeInTheDocument();
    expect(screen.queryByAltText("Live view of front")).toBeNull();
  });

  it("explains a dead feed with the access copy (probing the snapshot route, not the stream)", async () => {
    authFetch.mockResolvedValue(new Response(null, { status: 404 }));
    renderMsg([call({ name: "get_camera_live_url", data: { media: LIVE("front") } })]);
    setVisible(0, true);
    fireEvent.error(screen.getByAltText("Live view of front"));
    await waitFor(() =>
      expect(screen.getByText("Camera unavailable or you don't have access")).toBeInTheDocument(),
    );
    expect(String(authFetch.mock.calls[0][0])).toContain("/api/cameras/front/snapshot");
  });
});
