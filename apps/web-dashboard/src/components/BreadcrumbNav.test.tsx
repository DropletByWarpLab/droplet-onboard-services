/**
 * WARP-1267 (T15) — team breadcrumb: `prefixCrumb` renders a non-navigating
 * crumb before "My files" (used for team spaces — "Engineering / Platform / …"
 * even though Nextcloud mounts the team library flat, ADR-029 §D-3).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BreadcrumbNav } from "./BreadcrumbNav";

describe("BreadcrumbNav", () => {
  it("renders no prefix crumb by default", () => {
    render(<BreadcrumbNav path="/Docs" onNavigate={() => {}} />);
    expect(screen.queryByText("Engineering")).not.toBeInTheDocument();
  });

  it("renders a non-navigating prefix crumb when prefixCrumb is set", () => {
    render(
      <BreadcrumbNav path="/Docs" onNavigate={() => {}} prefixCrumb="Engineering" />
    );
    expect(screen.getByText("Engineering")).toBeInTheDocument();
    // Plain text, not a navigation button — clicking it must never fire onNavigate.
    expect(
      screen.queryByRole("button", { name: /^engineering$/i })
    ).not.toBeInTheDocument();
  });

  it("still navigates via the root crumb and path segments with a prefix crumb present", () => {
    const onNavigate = vi.fn();
    render(
      <BreadcrumbNav
        path="/Docs/2026"
        onNavigate={onNavigate}
        prefixCrumb="Engineering"
      />
    );
    screen.getByRole("button", { name: /my files/i }).click();
    expect(onNavigate).toHaveBeenCalledWith("/");
    screen.getByRole("button", { name: /^docs$/i }).click();
    expect(onNavigate).toHaveBeenCalledWith("/Docs");
  });
});
