import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StarButton } from "@/components/FileManager/StarButton";

vi.mock("@/lib/api", () => ({
  toggleFavorite: vi.fn().mockResolvedValue(undefined),
}));

import { toggleFavorite } from "@/lib/api";

describe("StarButton", () => {
  beforeEach(() => {
    vi.mocked(toggleFavorite).mockClear();
    vi.mocked(toggleFavorite).mockResolvedValue(undefined);
  });

  it("renders empty when favorited=false", () => {
    const { container } = render(<StarButton path="/foo.txt" favorited={false} />);
    const star = container.querySelector("svg");
    expect(star).toHaveAttribute("fill", "none");
  });

  it("renders filled when favorited=true", () => {
    const { container } = render(<StarButton path="/foo.txt" favorited={true} />);
    const star = container.querySelector("svg");
    expect(star).toHaveAttribute("fill", "currentColor");
  });

  it("resyncs fill when favorited prop flips from false to true", () => {
    // Regression test for the bug where adding to favorites left the star
    // visually empty until a page refresh. Without the useEffect sync in
    // StarButton, the local `current` state captured only the initial
    // `favorited=false` prop and never updated when the parent eventually
    // revalidated its SWR cache and passed `favorited=true` back down.
    const { container, rerender } = render(
      <StarButton path="/foo.txt" favorited={false} />
    );
    expect(container.querySelector("svg")).toHaveAttribute("fill", "none");

    rerender(<StarButton path="/foo.txt" favorited={true} />);
    expect(container.querySelector("svg")).toHaveAttribute("fill", "currentColor");
  });

  it("resyncs fill when favorited prop flips from true to false", () => {
    const { container, rerender } = render(
      <StarButton path="/foo.txt" favorited={true} />
    );
    expect(container.querySelector("svg")).toHaveAttribute("fill", "currentColor");

    rerender(<StarButton path="/foo.txt" favorited={false} />);
    expect(container.querySelector("svg")).toHaveAttribute("fill", "none");
  });

  it("optimistically flips on click and fires onToggle on success", async () => {
    const onToggle = vi.fn();
    const { container } = render(
      <StarButton path="/foo.txt" favorited={false} onToggle={onToggle} />
    );

    fireEvent.click(screen.getByRole("button"));

    // Optimistic flip happens synchronously before the await.
    expect(container.querySelector("svg")).toHaveAttribute("fill", "currentColor");

    await waitFor(() => expect(onToggle).toHaveBeenCalledWith(true));
    expect(toggleFavorite).toHaveBeenCalledWith("/foo.txt", true);
  });

  it("reverts on API failure", async () => {
    vi.mocked(toggleFavorite).mockRejectedValueOnce(new Error("network"));
    const { container } = render(<StarButton path="/foo.txt" favorited={false} />);

    fireEvent.click(screen.getByRole("button"));
    // Optimistic flip first
    expect(container.querySelector("svg")).toHaveAttribute("fill", "currentColor");

    // Then reverts after the rejected await resolves
    await waitFor(() =>
      expect(container.querySelector("svg")).toHaveAttribute("fill", "none")
    );
  });
});
