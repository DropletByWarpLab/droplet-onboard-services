/**
 * WARP-3509 — the review clip modal on Frigate 0.17.
 *
 *  - a review that is still open has no clip yet: say "In progress" instead of
 *    pointing a <video> at a 404;
 *  - a finished review whose clip will not load falls back to its thumbnail
 *    with a plain notice, not a black box;
 *  - a thumbnail that will not load is a placeholder, not alt text;
 *  - the camera is named the way the household named it;
 *  - failing to mark the review viewed is a toast, not a crash — the clip still
 *    plays, and the card keeps its "New" state so the operator can see it did
 *    not stick.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import React from "react";
import { ReviewClipModal } from "./ReviewClipModal";
import { ToastProvider } from "@/components/Toast";
import type { ReviewItem } from "@/lib/types";

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

const IN_PROGRESS_COPY = /In progress/;
const PREVIEW_FAILED_COPY = /preview clip isn.t available right now/i;
const MARK_VIEWED_FAILED = "We couldn't mark that as viewed. Try again in a moment.";

describe("ReviewClipModal clip", () => {
  it("plays the preview clip of a finished review", () => {
    const { container } = renderModal(makeReview());

    expect(container.querySelector("video")!.getAttribute("src")).toBe(
      "/api/cameras/reviews/1791059989.433851-qrgete/preview",
    );
    expect(screen.queryByText(IN_PROGRESS_COPY)).toBeNull();
    expect(screen.queryByText(PREVIEW_FAILED_COPY)).toBeNull();
  });

  it("a review still in progress shows its thumbnail and an 'In progress' notice, not a video", () => {
    const { container } = renderModal(makeReview({ endTime: null }));

    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")!.getAttribute("src")).toBe(
      "/api/cameras/reviews/1791059989.433851-qrgete/thumbnail",
    );
    expect(screen.getByText(IN_PROGRESS_COPY)).toBeInTheDocument();
  });

  it("falls back to the thumbnail, with a notice, when the preview clip fails to load", () => {
    const { container } = renderModal(makeReview());

    fireEvent.error(container.querySelector("video")!);

    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).not.toBeNull();
    expect(screen.getByText(PREVIEW_FAILED_COPY)).toBeInTheDocument();
    // A finished review is not "in progress" just because its clip is missing.
    expect(screen.queryByText(IN_PROGRESS_COPY)).toBeNull();
  });

  it("uses the thumbnail when the review has no preview url at all", () => {
    const { container } = renderModal(makeReview({ previewUrl: null }));

    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("a thumbnail that fails to load becomes a placeholder, and no alt text is left to print", () => {
    const { container } = renderModal(makeReview({ endTime: null }), { cameraName: "Warp Lab Office" });

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-testid='thumb-fallback']")).not.toBeNull();
    expect(container.innerHTML).not.toContain("alert on Warp Lab Office");
    // The notice is the one place that says why there is nothing to watch.
    expect(screen.getByText(IN_PROGRESS_COPY)).toBeInTheDocument();
  });

  it("re-arms the clip when the modal moves to a different review", () => {
    const first = makeReview();
    const { container, rerender } = renderModal(first);
    fireEvent.error(container.querySelector("video")!);
    expect(container.querySelector("video")).toBeNull();

    rerender(
      <ToastProvider>
        <ReviewClipModal review={makeReview({ id: "1791060500.1-zzzzzz", previewUrl: "/p2" })} onClose={vi.fn()} />
      </ToastProvider>,
    );

    expect(container.querySelector("video")!.getAttribute("src")).toBe("/p2");
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
    const { container } = renderModal(makeReview(), { onMarkViewed, onClose });

    expect(await screen.findByText(MARK_VIEWED_FAILED)).toBeInTheDocument();
    // Not blocking, not a crash: still open, clip still there.
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector("video")).not.toBeNull();
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
