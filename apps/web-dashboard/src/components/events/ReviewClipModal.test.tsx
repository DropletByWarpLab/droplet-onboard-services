/**
 * WARP-3509 — the review clip modal on Frigate 0.17.
 *
 *  - a review that is still open has no clip yet: say "In progress" instead of
 *    pointing a <video> at a 404;
 *  - a finished review whose clip will not load falls back to its thumbnail
 *    with a plain notice, not a black box — an alert, with a Retry, since the
 *    person was waiting on that clip;
 *  - a thumbnail that will not load is a placeholder, not alt text;
 *  - the camera is named the way the household named it;
 *  - failing to mark the review viewed is a toast, not a crash — the clip still
 *    plays, and the card keeps its "New" state so the operator can see it did
 *    not stick;
 *  - it is a real dialog: the shared <Dialog> (role, aria-modal, label, focus,
 *    scroll lock, Escape), like the event modal, not a hand-rolled overlay.
 *
 * The modal is built on <Dialog>, which portals to document.body: query through
 * `screen` / `document`, not the render container.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import React from "react";
import { ReviewClipModal } from "./ReviewClipModal";
import { ToastProvider } from "@/components/Toast";
import type { ReviewItem } from "@/lib/types";

vi.mock("@/components/recordings/HlsPlayer", () => ({
  HlsPlayer: ({ src, onError }: { src: string; onError?: (message: string) => void }) =>
    <video src={src} onError={() => onError?.("recording unavailable")} />,
}));
afterEach(() => cleanup());

const NOW = Math.floor(Date.now() / 1000);

function makeReview(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "1791059989.433851-qrgete",
    camera: "warp_lab_office",
    startTime: NOW - 120,
    endTime: NOW - 60,
    severity: "alert",
    hasBeenReviewed: false,
    objects: ["person"],
    audio: [],
    zones: [],
    detectionIds: ["d1", "d2"],
    previewUrl: "/api/cameras/reviews/1791059989.433851-qrgete/preview",
    thumbnailUrl: "/api/cameras/reviews/1791059989.433851-qrgete/thumbnail",
    ...overrides,
  };
}

function renderModal(
  review: ReviewItem,
  props: Partial<React.ComponentProps<typeof ReviewClipModal>> = {},
) {
  return render(
    <ToastProvider>
      <ReviewClipModal review={review} onClose={vi.fn()} {...props} />
    </ToastProvider>,
  );
}

const video = () => document.querySelector("video");
const image = () => document.querySelector("img");
function failPlayback() {
  const original = video()!;
  fireEvent.error(original);
  const recording = video();
  if (recording && recording !== original) fireEvent.error(recording);
}

const IN_PROGRESS_COPY = /In progress/;
const PREVIEW_FAILED_COPY = /preview clip isn.t available right now/i;
const MARK_VIEWED_FAILED = "We couldn't mark that as viewed. Try again in a moment.";

describe("ReviewClipModal clip", () => {
  it("plays the preview clip of a finished review", () => {
    renderModal(makeReview());

    expect(video()!.getAttribute("src")).toBe(
      "/api/cameras/reviews/1791059989.433851-qrgete/preview",
    );
    expect(screen.queryByText(IN_PROGRESS_COPY)).toBeNull();
    expect(screen.queryByText(PREVIEW_FAILED_COPY)).toBeNull();
  });

  it("a review still in progress plays recordings and shows its notice without loading the preview", () => {
    renderModal(makeReview({ endTime: null }));

    expect(video()!.getAttribute("src")).toContain("/warp_lab_office/playback.m3u8");
    expect(image()).toBeNull();
    expect(screen.getByText(IN_PROGRESS_COPY)).toBeInTheDocument();
  });

  it("the 'In progress' notice is information, a status, not an alert", () => {
    renderModal(makeReview({ endTime: null }));

    expect(screen.getByRole("status").textContent).toMatch(IN_PROGRESS_COPY);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("falls back to the thumbnail, with a notice, when the preview clip fails to load", () => {
    renderModal(makeReview());

    failPlayback();

    expect(video()).toBeNull();
    expect(image()).not.toBeNull();
    expect(screen.getByText(PREVIEW_FAILED_COPY)).toBeInTheDocument();
    // A finished review is not "in progress" just because its clip is missing.
    expect(screen.queryByText(IN_PROGRESS_COPY)).toBeNull();
  });

  it("the failure notice is an alert in the shell's error ink, not a quiet status line", () => {
    renderModal(makeReview());

    failPlayback();

    const notice = screen.getByRole("alert");
    expect(notice.textContent).toMatch(PREVIEW_FAILED_COPY);
    expect(notice.className).toContain("text-[color:var(--danger-ink)]");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers Retry beside the failure, which tries the preview clip again", () => {
    renderModal(makeReview());
    failPlayback();
    expect(video()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    expect(video()!.getAttribute("src")).toBe("/api/cameras/reviews/1791059989.433851-qrgete/preview");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("offers no Retry while a review is still in progress: its clip does not exist yet", () => {
    renderModal(makeReview({ endTime: null }));

    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("uses recordings then the thumbnail when the review has no preview url at all", () => {
    renderModal(makeReview({ previewUrl: null }));
    expect(video()!.getAttribute("src")).toContain("playback.m3u8");
    failPlayback();

    expect(video()).toBeNull();
    expect(image()).not.toBeNull();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("a thumbnail that fails to load becomes a placeholder, and no alt text is left to print", () => {
    renderModal(makeReview({ endTime: null }), { cameraName: "Warp Lab Office" });
    failPlayback();

    fireEvent.error(image()!);

    expect(image()).toBeNull();
    expect(document.querySelector("[data-testid='thumb-fallback']")).not.toBeNull();
    expect(document.body.innerHTML).not.toContain("alert on Warp Lab Office");
    // The notice is the one place that says why there is nothing to watch.
    expect(screen.getByText(IN_PROGRESS_COPY)).toBeInTheDocument();
  });

  it("re-arms the clip when the modal moves to a different review", () => {
    const first = makeReview();
    const { rerender } = renderModal(first);
    failPlayback();
    expect(video()).toBeNull();

    rerender(
      <ToastProvider>
        <ReviewClipModal review={makeReview({ id: "1791060500.1-zzzzzz", previewUrl: "/p2" })} onClose={vi.fn()} />
      </ToastProvider>,
    );

    expect(video()!.getAttribute("src")).toBe("/p2");
  });
});

describe("ReviewClipModal is a real dialog (WARP-3509)", () => {
  it("has the dialog role, is modal, and is labelled by its heading", () => {
    renderModal(makeReview({ objects: ["person"], severity: "alert" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = screen.getByRole("heading", { level: 2 });
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.textContent).toContain("person");
  });

  it("closes on Escape, once, through the shared dialog", () => {
    const onClose = vi.fn();
    renderModal(makeReview(), { onClose });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from its Close button and from a click on the backdrop, but not from a click inside it", () => {
    const onClose = vi.fn();
    renderModal(makeReview(), { onClose });

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("moves focus into the dialog when it opens", async () => {
    renderModal(makeReview());

    await vi.waitFor(() => expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true));
  });

  it("locks the page behind it from scrolling, and gives the scroll back when it closes", () => {
    document.body.style.overflow = "";
    const { unmount } = renderModal(makeReview());
    expect(document.body.style.overflow).toBe("hidden");

    unmount();

    expect(document.body.style.overflow).toBe("");
  });

  it("keeps Tab inside the dialog: from the last control it wraps to the first", () => {
    renderModal(makeReview());
    const dialog = screen.getByRole("dialog");
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
    const first = controls[0];
    const last = controls[controls.length - 1];

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });

    expect(document.activeElement).toBe(first);
  });
});

describe("ReviewClipModal camera name", () => {
  it("names the camera by its display name in the details line", () => {
    renderModal(makeReview({ camera: "front_door" }), { cameraName: "Lobby" });

    expect(screen.getByText(/Lobby ·/)).toBeInTheDocument();
    expect(screen.queryByText(/front door/)).toBeNull();
  });

  it("falls back to the prettified key, never the raw lower-case key", () => {
    renderModal(makeReview({ camera: "warp_lab_office" }));

    expect(screen.getByText(/Warp Lab Office ·/)).toBeInTheDocument();
    expect(screen.queryByText(/warp lab office/)).toBeNull();
  });

  it("still links to the camera by its key", () => {
    renderModal(makeReview({ camera: "warp_lab_office" }), { cameraName: "Warp Lab Office" });

    expect(screen.getByRole("link", { name: /Open camera/ }).getAttribute("href")).toBe(
      "/cameras/warp_lab_office",
    );
  });
});

describe("ReviewClipModal mark viewed", () => {
  it("marks an unreviewed review viewed once, when it opens", () => {
    const onMarkViewed = vi.fn().mockResolvedValue(undefined);
    const review = makeReview();
    const { rerender } = renderModal(review, { onMarkViewed });
    // The page hands the modal a fresh arrow function on every render.
    rerender(
      <ToastProvider>
        <ReviewClipModal review={review} onClose={vi.fn()} onMarkViewed={(rv) => onMarkViewed(rv)} />
      </ToastProvider>,
    );

    expect(onMarkViewed).toHaveBeenCalledTimes(1);
    expect(onMarkViewed).toHaveBeenCalledWith(review);
  });

  it("leaves an already-reviewed review alone", () => {
    const onMarkViewed = vi.fn().mockResolvedValue(undefined);

    renderModal(makeReview({ hasBeenReviewed: true }), { onMarkViewed });

    expect(onMarkViewed).not.toHaveBeenCalled();
  });

  it("a failed mark-viewed shows a toast and the modal carries on", async () => {
    const onMarkViewed = vi.fn().mockRejectedValue(new Error("Failed to mark review viewed: 503"));
    const onClose = vi.fn();
    renderModal(makeReview(), { onMarkViewed, onClose });

    expect(await screen.findByText(MARK_VIEWED_FAILED)).toBeInTheDocument();
    // Not blocking, not a crash: still open, clip still there.
    expect(onClose).not.toHaveBeenCalled();
    expect(video()).not.toBeNull();
  });

  it("the toast never shows the raw error", async () => {
    const onMarkViewed = vi.fn().mockRejectedValue(new Error("Failed to mark review viewed: 503"));

    renderModal(makeReview(), { onMarkViewed });

    await screen.findByText(MARK_VIEWED_FAILED);
    expect(screen.queryByText(/503/)).toBeNull();
  });

  it("a successful mark-viewed shows no toast", async () => {
    const onMarkViewed = vi.fn().mockResolvedValue(undefined);

    renderModal(makeReview(), { onMarkViewed });

    await vi.waitFor(() => expect(onMarkViewed).toHaveBeenCalled());
    expect(screen.queryByText(MARK_VIEWED_FAILED)).toBeNull();
  });
});
