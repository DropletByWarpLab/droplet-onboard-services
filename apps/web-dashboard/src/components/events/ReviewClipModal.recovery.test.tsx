import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReviewItem } from "@/lib/types";
import { ReviewClipModal } from "./ReviewClipModal";
import { MediaThumbnail } from "./MediaThumbnail";

vi.mock("@/components/recordings/HlsPlayer", () => ({
  HlsPlayer: ({ src, onError }: { src: string; onError: (message: string) => void }) =>
    <button data-src={src} onClick={() => onError("Missing recording")}>Recording player</button>,
}));
vi.mock("@/components/Dialog", () => ({ Dialog: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const review: ReviewItem = {
  id: "r1", camera: "warp_lab_office", startTime: 1791210000, endTime: 1791210060,
  severity: "alert", hasBeenReviewed: true, objects: ["person"], audio: [], zones: [],
  detectionIds: ["ev1"], previewUrl: "/api/cameras/reviews/r1/preview", thumbnailUrl: "/thumb.webp",
};

describe("review playback recovery", () => {
  it("keeps an ongoing recording stable on rerender and refreshes its window on retry", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue((review.startTime + 600) * 1000);
    const active = { ...review, endTime: null };
    const { container, rerender } = render(<ReviewClipModal review={active} onClose={vi.fn()} />);
    const player = screen.getByRole("button", { name: "Recording player" });
    const initialUrl = player.getAttribute("data-src");
    now.mockReturnValue((review.startTime + 660) * 1000);
    rerender(<ReviewClipModal review={{ ...active }} onClose={vi.fn()} />);
    expect(player).toHaveAttribute("data-src", initialUrl);
    fireEvent.click(player);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("button", { name: "Recording player" })).toHaveAttribute("data-src", expect.stringContaining(`before=${review.startTime + 660}`));
  });
  it("plays the actual recording when the preview cannot be loaded", () => {
    const { container } = render(<ReviewClipModal review={review} onClose={vi.fn()} />);
    fireEvent.error(container.querySelector("video")!);
    const player = screen.getByRole("button", { name: "Recording player" });
    expect(player.getAttribute("data-src")).toBe("/api/cameras/warp_lab_office/playback.m3u8?after=1791210000&before=1791210060");
    fireEvent.click(player);
    expect(screen.getByRole("alert")).toHaveTextContent("The preview clip isn't available right now");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(container.querySelector("video")).toHaveAttribute("src", review.previewUrl);
  });
  it("does not carry a failed clip over to a different review", () => {
    const { container, rerender } = render(<ReviewClipModal review={review} onClose={vi.fn()} />);
    fireEvent.error(container.querySelector("video")!);
    fireEvent.click(screen.getByRole("button", { name: "Recording player" }));
    rerender(<ReviewClipModal review={{ ...review, id: "r2", previewUrl: "/preview2" }} onClose={vi.fn()} />);
    expect(container.querySelector("video")).toHaveAttribute("src", "/preview2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("shows unavailable image copy and retries a changed image URL", () => {
    const { container, rerender } = render(<MediaThumbnail src="/missing" alt="Camera event" />);
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "Camera event: thumbnail unavailable");
    rerender(<MediaThumbnail src="/new-image" alt="Camera event" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "/new-image");
  });
});
